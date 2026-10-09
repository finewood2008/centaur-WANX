"""Read the current owner's Zhijun context through native domain services."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from typing import Any

from octop.i18n import tr
from octop.infra.agents.memory.zhijun_recall import _native_record, recall_record
from octop.infra.agents.personal_ontology import read_personal_ontology
from octop.infra.agents.teams.brainstorm_types import ContextResult, SourceReference
from octop.infra.db.services import SharedServices
from octop.infra.errors import OctopError
from octop.infra.knowledge.retrieve import retrieve_context


def _matches(query: str, text: str) -> int:
    parts = re.findall(r"[a-z0-9]{2,}|[\u4e00-\u9fff]+", query.lower())
    words = {part for part in parts if len(part) > 1}
    words.update(part[i : i + 2] for part in parts if len(part) > 2 for i in range(len(part) - 1))
    return sum(word in text.lower() for word in words)


def _version(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _memory_content(memory: Any, record: dict[str, Any], path: str) -> str:
    """Use native content rather than the virtual file's record envelope."""
    parts = path.strip("/").split("/")
    key = parts[-1].removesuffix(".md")
    if parts[0] in {"atom", "atoms"}:
        atom = memory.get_atom(key)
        if atom:
            return str(atom.assertion)
    elif parts[0] in {"raw", "raw_events"}:
        raw = memory.get_raw(key)
        if raw:
            return str(raw.content)
    elif parts[0] in {"page", "pages"}:
        page = memory.get_entity_page(key)
        if page:
            return str(page.summary_markdown)
    return str(record.get("content") or record.get("text") or record.get("excerpt") or "")


def _memory_title(
    memory: Any, path: str, thread_repo: Any, agent_id: str, user_id: int, default: str
) -> str:
    parts = path.strip("/").split("/")
    key = parts[-1].removesuffix(".md")
    raw = None
    if parts[0] in {"atom", "atoms"}:
        atom = memory.get_atom(key)
        if atom and atom.quote_event_id:
            raw = memory.get_raw(atom.quote_event_id)
    elif parts[0] in {"raw", "raw_events"}:
        raw = memory.get_raw(key)
    elif parts[0] in {"page", "pages"}:
        page = memory.get_entity_page(key)
        if page and page.headline:
            return str(page.headline)
    if raw and raw.thread_id:
        thread = thread_repo.get(raw.thread_id)
        if thread and thread.agent_id == agent_id and thread.user_id == user_id and thread.title:
            return str(thread.title)
    return default


def _knowledge_excerpts(text: str, citations: list[dict[str, Any]], locale: str) -> dict[str, str]:
    """Associate the existing native retrieval sections with their documents."""
    markers: list[tuple[int, int, str]] = []
    body = text.split("<!--octop-kb-citations:", 1)[0].rstrip()
    for citation in citations:
        header = tr(
            "knowledge.retrieval.citation",
            locale,
            name=citation["kb_name"],
            filename=citation["filename"],
            ordinal="ORDINAL",
        )
        pattern = re.escape(header).replace("ORDINAL", r"\d+")
        markers.extend(
            (match.start(), match.end(), str(citation["doc_id"]))
            for match in re.finditer(pattern, body)
        )
    markers.sort()
    excerpts: dict[str, str] = {}
    for index, (_, start, doc_id) in enumerate(markers):
        end = markers[index + 1][0] if index + 1 < len(markers) else len(body)
        quote = body[start:end].strip()
        if quote:
            excerpts[doc_id] = "\n\n".join(filter(None, [excerpts.get(doc_id), quote]))
    return excerpts


async def owned_zhijun_context(
    registry: Any, user_id: int, query: str, *, excluded: list[str], locale: str
) -> ContextResult:
    loop = asyncio.get_running_loop()
    row = await loop.run_in_executor(None, registry.get_application_profile, user_id, "zhijun")
    result = ContextResult()
    if row is None:
        result.notices.append(tr("brainstorm.no_zhijun", locale))
        return result
    # The caller supplies the authenticated user, never a client-selected source owner.
    if row.user_id != user_id or row.application_id != "zhijun":
        raise PermissionError("context ownership mismatch")
    blocked = set(excluded)
    try:
        harness = registry.get_agent(row.agent_id)
    except OctopError:
        harness = None
    runtime = getattr(harness, "_memory_runtime", None)
    memory, service = getattr(runtime, "memory", None), getattr(runtime, "service", None)
    if memory is not None and service is not None:

        def recall() -> list[SourceReference]:
            data = service.search(query, max_results=12)
            if data.get("error"):
                raise RuntimeError("memory lookup failed")
            sources = []
            for hit in data.get("hits", []):
                path = str(hit.get("path") or "")
                sid = "memory:" + path
                if not path or sid in blocked:
                    continue
                record = service.get(path)
                if record.get("error"):
                    continue
                provenance = _native_record(memory, record, path)
                text = (_memory_content(memory, record, path) or str(hit.get("snippet") or ""))[
                    :2000
                ]
                if text:
                    sources.append(
                        SourceReference(
                            id=sid,
                            kind="memory",
                            title=_memory_title(
                                memory,
                                path,
                                registry._repos.thread_repo,
                                row.agent_id,
                                user_id,
                                tr("brainstorm.source_labels.memory", locale),
                            ),
                            text=text,
                            version=_version(text),
                            provenance=str(provenance.get("statement_kind")),
                        )
                    )
            return sources

        try:
            result.sources.extend(await loop.run_in_executor(None, recall))
        except (RuntimeError, OSError, ValueError, OctopError):
            result.notices.append(tr("brainstorm.memory_unavailable", locale))
    else:
        result.notices.append(tr("brainstorm.memory_unavailable", locale))
    try:
        ontology = await read_personal_ontology(registry, user_id, check_changes=False)
        for claim in ontology.claims:
            if claim.state != "confirmed" or not claim.evidence_valid:
                continue
            sid = "ontology:" + claim.id
            if sid in blocked or not _matches(query, claim.statement + claim.conditions):
                continue
            record = recall_record(claim.model_dump(), kind="ontology")
            result.sources.append(
                SourceReference(
                    id=sid,
                    kind="ontology",
                    title=claim.title,
                    text=claim.statement,
                    version=str(claim.version),
                    provenance=str(record["statement_kind"]),
                )
            )
    except (RuntimeError, OSError, ValueError, OctopError):
        result.notices.append(tr("brainstorm.ontology_unavailable", locale))
    bases = await loop.run_in_executor(
        None, lambda: registry._repos.knowledge_repo.list_visible(user_id, application_id="zhijun")
    )
    try:
        knowledge = await retrieve_context(
            SharedServices(paths=registry._paths, config=registry._config, repos=registry._repos),
            user_id=user_id,
            is_admin=False,
            query=query,
            knowledge_base_ids=[b.id for b in bases if b.owner_user_id == user_id],
            application_id="zhijun",
            locale=locale,
            excluded_document_ids=[
                sid.rsplit(":", 1)[-1] for sid in blocked if sid.startswith("knowledge:")
            ],
        )
        marker = re.search(r"<!--octop-kb-citations:(\[.*?\])-->", knowledge, re.DOTALL)
        citations = json.loads(marker.group(1)) if marker else []
        excerpts = _knowledge_excerpts(knowledge, citations, locale)
        for citation in citations:
            result.sources.append(
                SourceReference(
                    id=f"knowledge:{citation['kb_id']}:{citation['doc_id']}",
                    kind="knowledge",
                    title=citation["filename"],
                    text=excerpts.get(citation["doc_id"], ""),
                    version=_version(knowledge),
                    provenance="source_quote",
                )
            )
        if knowledge and not excerpts:
            result.text = knowledge.split("<!--octop-kb-citations:", 1)[0].rstrip()
    except (RuntimeError, OSError, ValueError, OctopError):
        result.notices.append(tr("brainstorm.knowledge_unavailable", locale))
    threads = await loop.run_in_executor(
        None,
        lambda: registry._repos.thread_repo.list_by_agent_user(
            agent_id=row.agent_id, user_id=user_id, limit=20
        ),
    )

    def history() -> list[SourceReference]:
        sources = []
        for thread in threads:
            if registry._repos.thread_message_repo.projection_status(thread.thread_id) != "ready":
                continue
            messages, _ = registry._repos.thread_message_repo.page(
                thread.thread_id, limit=100, offset=0
            )
            for message in messages:
                sid = f"history:{thread.thread_id}:{message.seq}"
                if sid in blocked:
                    continue
                wire = json.loads(message.message_json)
                content = (wire.get("data") or wire).get("content", "")
                text = (
                    content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)
                )
                if _matches(query, text):
                    sources.append(
                        SourceReference(
                            id=sid,
                            kind="history",
                            title=thread.title or tr("brainstorm.source_labels.history", locale),
                            text=text[:1200],
                            version=str(message.created_at),
                            provenance="user_statement"
                            if message.role in {"human", "user"}
                            else "assistant_reply",
                        )
                    )
        return sorted(sources, key=lambda source: _matches(query, source.text), reverse=True)[:6]

    result.sources.extend(await loop.run_in_executor(None, history))
    result.text = "\n\n".join(
        [
            *(
                f"[{tr('brainstorm.source_labels.' + source.kind, locale)}; {source.title}; "
                f"{tr('brainstorm.source_provenance.' + source.provenance, locale)}] {source.text}"
                for source in result.sources
                if source.text
            ),
            result.text,
        ]
    )[:14000]
    return result

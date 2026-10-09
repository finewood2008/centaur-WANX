"""Source-bound current context over native memory, without copying source stores."""

from __future__ import annotations

import asyncio
import re
from dataclasses import asdict
from datetime import UTC, datetime
from typing import Any

from octop.infra.agents.ontology_types import (
    Kind,
    OntologyContextEdit,
    OntologyContextLink,
    OntologyContextNode,
    OntologyEvidence,
    OntologyGraphCoverage,
    OntologyResult,
    OntologyVersion,
    PersonalOntology,
)
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.ulid import new_ulid


def normalized(text: str) -> str:
    return re.sub(r"[\s，。！？、,.!?：:；;‘’“”「」]", "", text).lower()


def inactive_sources(doc: PersonalOntology) -> set[str]:
    sources = set(doc.graph_retired_sources)
    disabled = {n.id for n in doc.nodes if n.state == "withdrawn" and not n.merged_into}
    dependent = {
        link.source for link in doc.links if link.kind == "about" and link.target in disabled
    }
    for node in doc.nodes:
        if node.id not in disabled | dependent:
            continue
        if node.kind == "fact":
            sources.update("atom:" + aid for aid in node.native_ids)
        elif node.kind == "episode":
            sources.update("raw:" + e.event_id for e in node.evidence)
    return sources


def classify_declaration(text: str) -> Kind:
    if re.search(
        r"希望你|先听|听我|回应我|陪我|希望.*(理清|讨论)|不要.*(分析|追问|建议)|不急着.*(分析|建议)",
        text,
    ):
        return "response"
    if re.search(r"希望成为|想成为|希望自己|想让自己", text):
        return "aspiration"
    if re.search(r"不愿.*交给|不能替|不想.*交给|我的边界|不能.*代替", text):
        return "boundary"
    if re.search(r"我现在|我最近|这段时间|这一阶段", text):
        return "situation"
    return "principle"


def _pages(memory: Any, name: str) -> tuple[list[dict[str, Any]], bool]:
    from octop_memory.application import dashboard_data

    items: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = getattr(dashboard_data, name)(
            memory, {"limit": 200, "offset": offset, "order": "asc", "include_deprecated": False}
        )
        items.extend(page["items"])
        offset += len(page["items"])
        if not page["has_more"] or not page["items"]:
            # The native dashboard adapter currently caps its underlying query at 10,000.
            # Never claim exhaustive coverage when that cap might have been reached.
            if page["total"] >= 10_000 and callable(getattr(memory, name, None)):
                bound = 20_000
                while True:
                    records = getattr(memory, name)(limit=bound)
                    if len(records) < bound:
                        from octop.infra.agents.memory_maintenance_store import _json

                        full = [_json(asdict(record)) for record in records]
                        if name == "list_atoms":
                            for row in full:
                                candidate = memory.get_candidate(row["candidate_id"])
                                row["kind"] = candidate.candidate_type if candidate else None
                        return full, True
                    bound *= 2
            return items, not page["has_more"] and page["total"] < 10_000


def _projection(
    memory: Any, uid: int
) -> tuple[list[OntologyContextNode], list[OntologyContextLink], OntologyGraphCoverage]:
    from octop.infra.agents.personal_ontology import _digest, _personal_text

    if memory is None:
        return [], [], OntologyGraphCoverage(complete=False)
    atoms, complete = _pages(memory, "list_atoms")
    entities, entity_complete = (
        _pages(memory, "list_entities")
        if callable(getattr(memory, "list_entities", None))
        else ([], True)
    )
    episodes, episode_complete = (
        _pages(memory, "list_episodes")
        if callable(getattr(memory, "list_episodes", None))
        else ([], True)
    )
    coverage = OntologyGraphCoverage(
        atoms=len(atoms),
        entities=len(entities),
        episodes=len(episodes),
        complete=complete and entity_complete and episode_complete,
    )
    nodes: dict[str, OntologyContextNode] = {}
    links: list[OntologyContextLink] = []
    entity_sources: dict[str, list[OntologyEvidence]] = {}
    event_facts: dict[str, set[str]] = {}
    audit = (
        memory.list_journal(limit=100_000)
        if callable(getattr(memory, "list_journal", None))
        else []
    )
    declarations = {
        j.target_atom_id: j
        for j in audit
        if j.actor == "user" and j.action in {"create", "user_edit"}
    }

    def evidence(
        event: Any, quote: str, atom: dict[str, Any] | None = None
    ) -> OntologyEvidence | None:
        text = _personal_text(event, uid)
        if not text or not quote or quote not in text:
            coverage.unavailable_sources += 1
            return None
        return OntologyEvidence(
            atom_id=str((atom or {}).get("id", "")),
            event_id=event.id,
            quote=quote,
            timestamp=event.timestamp.isoformat(),
            raw_hash=_digest(event.content),
            atom_hash=_digest(atom) if atom else "",
            experience_id=f"{getattr(event, 'session_id', '') or event.thread_id}:{event.timestamp.date()}",
        )

    for atom in atoms:
        candidate = memory.get_candidate(atom["candidate_id"])
        if candidate is None:
            coverage.unavailable_sources += 1
            continue
        raw = memory.get_raw(candidate.quote_event_id)
        source: OntologyEvidence | None
        declaration = declarations.get(atom["id"])
        if declaration and declaration.after.get("assertion") == atom["assertion"]:
            source = OntologyEvidence(
                source_type="owner_declaration",
                atom_id=atom["id"],
                event_id=raw.id if raw else "",
                quote=atom["assertion"],
                timestamp=declaration.timestamp.isoformat(),
                atom_hash=_digest(atom),
            )
        else:
            source = evidence(raw, atom.get("verbatim_quote", ""), atom)
        if source is None:
            continue
        subject = str(atom.get("entity_id") or getattr(candidate, "subject_entity_name", ""))
        key = "fact:" + _digest([subject, normalized(atom["assertion"])])[:24]
        node = nodes.get(key)
        if node is None:
            node = OntologyContextNode(
                id=key,
                kind="fact",
                title=atom["assertion"][:60],
                statement=atom["assertion"],
                version="",
                occurred_at=atom.get("occurred_at", ""),
                source_kind="self_report" if declaration else "native",
            )
            nodes[key] = node
        else:
            coverage.duplicate_sources += 1
        node.native_ids.append(atom["id"])
        if not any(
            e.event_id == source.event_id and e.quote == source.quote for e in node.evidence
        ):
            node.evidence.append(source)
        event_facts.setdefault(source.event_id, set()).add(key)
        if atom.get("entity_id"):
            entity_sources.setdefault("entity:" + atom["entity_id"], []).append(source)
            links.append(
                OntologyContextLink(
                    id="about:" + atom["id"],
                    source=key,
                    target="entity:" + atom["entity_id"],
                    kind="about",
                    evidence_ids=[atom["id"]],
                    state="confirmed",
                )
            )
    coverage.verifiable_facts = len(nodes)
    for entity in entities:
        if entity["entity_type"] not in {"Person", "Project"}:
            continue
        key = "entity:" + entity["id"]
        sources = entity_sources.get(key, [])
        if not sources:
            continue
        nodes[key] = OntologyContextNode(
            id=key,
            kind="person" if entity["entity_type"] == "Person" else "project",
            title=entity["canonical_name"],
            statement=entity["canonical_name"],
            version="",
            aliases=entity.get("aliases", []),
            native_ids=[entity["id"]],
            evidence=sources,
        )
    named: dict[str, set[str]] = {}
    for node in nodes.values():
        if node.kind in {"person", "project"}:
            for name in [node.title, *node.aliases]:
                named.setdefault(name, set()).add(node.id)
    for episode in episodes:
        raw = memory.get_raw(
            episode.get("quote_event_id") or next(iter(episode.get("raw_event_ids", [])), "")
        )
        source = evidence(raw, episode.get("verbatim_quote", ""))
        if source is None:
            continue
        key = "episode:" + episode["id"]
        nodes[key] = OntologyContextNode(
            id=key,
            kind="episode",
            title=episode["summary"][:60],
            statement=episode["summary"],
            version="",
            native_ids=[episode["id"]],
            evidence=[source],
            emotion=episode.get("emotion", ""),
            occurred_at=episode["occurred_at"],
        )
        for fact_id in event_facts.get(source.event_id, set()):
            links.append(
                OntologyContextLink(
                    id=f"experienced:{key}:{fact_id}",
                    source=key,
                    target=fact_id,
                    kind="experienced",
                    description="共用原话来源",
                    state="confirmed",
                    evidence_ids=[source.event_id],
                )
            )
        for name in episode.get("people", []) + episode.get("topics", []):
            matches = list(named.get(name, set()))
            if len(matches) == 1:
                links.append(
                    OntologyContextLink(
                        id=f"related:{key}:{matches[0]}",
                        source=key,
                        target=matches[0],
                        kind="related",
                        description="经历中的同名线索，尚待核对",
                        source_kind="inference",
                        evidence_ids=[source.event_id],
                    )
                )
    links = [link for link in links if link.source in nodes and link.target in nodes]
    for node in nodes.values():
        node.version = _digest(node.model_dump(exclude={"version"}))[:32]
    return list(nodes.values()), links, coverage


async def hydrate_graph(document: PersonalOntology, memory: Any, uid: int) -> PersonalOntology:
    """A read verifies live sources; it never writes or calls a model."""
    from octop.infra.agents.personal_ontology import _digest

    projected, links, coverage = await asyncio.to_thread(_projection, memory, uid)
    doc = document.model_copy(deep=True)
    fresh = {n.id: n for n in projected}
    saved = {n.id: n for n in doc.nodes}
    retired = set(doc.graph_retired)
    for nid, node in saved.items():
        if not node.owner_edited:
            continue
        current = fresh.get(nid)
        # Owner edits survive synthesis and source re-extraction. Unedited source summaries do not.
        if current:
            if node.source_kind != "self_report":
                node.evidence = current.evidence
            node.native_ids = sorted(set(node.native_ids + current.native_ids))
        elif any(
            (old := memory.get_atom(aid)) and getattr(old, "superseded_by", None)
            for aid in node.native_ids
            if node.kind == "fact"
        ):
            # A later explicit edit in the native UI supersedes this older projection.
            node.state = "withdrawn"
        elif (
            node.kind == "fact"
            and node.native_ids
            and all(
                not (atom := memory.get_atom(aid)) or getattr(atom, "deprecated_at", None)
                for aid in node.native_ids
            )
        ):
            # Removing a native fact also removes its current display overlay. A
            # separate owner-declared principle without that native identity remains.
            node.evidence_valid = False
        elif node.source_kind != "self_report":
            node.evidence_valid = False
        fresh[nid] = node
    for nid in retired:
        fresh.pop(nid, None)
    doc.nodes = list(fresh.values())
    stopped = inactive_sources(doc)
    for node in doc.nodes:
        for evidence in node.evidence:
            evidence.available = not (
                "atom:" + evidence.atom_id in stopped or "raw:" + evidence.event_id in stopped
            )
        if (
            node.kind in {"person", "project"}
            and node.source_kind != "self_report"
            and not any(e.available for e in node.evidence)
        ):
            node.evidence_valid = False
        if (
            node.source_kind != "self_report"
            and node.kind in {"fact", "episode"}
            and any(
                "atom:" + e.atom_id in stopped or "raw:" + e.event_id in stopped
                for e in node.evidence
            )
        ):
            node.evidence_valid = False
    for claim in doc.claims:
        if claim.source_kind != "self_report" and any(
            "atom:" + e.atom_id in stopped or "raw:" + e.event_id in stopped for e in claim.evidence
        ):
            claim.evidence_valid = False
    # A corrected fact suppresses duplicate re-extractions of the old wording in this subject.
    # Restrict suppression to the same native subject, never to equal text in another person.
    about = {link.source: link.target for link in links if link.kind == "about"}
    blocked = {
        (about.get(n.id), normalized(str(h.value.get("statement", ""))))
        for n in doc.nodes
        if n.owner_edited and n.kind == "fact"
        for h in n.history
        if h.reason in {"correct", "change"} and about.get(n.id)
    }
    doc.nodes = [
        n
        for n in doc.nodes
        if n.owner_edited
        or not (n.kind == "fact" and (about.get(n.id), normalized(n.statement)) in blocked)
    ]
    active = {
        n.id: n for n in doc.nodes if n.state == "active" and n.evidence_valid and not n.merged_into
    }
    aliases = {n.id: n.merged_into for n in doc.nodes if n.merged_into}
    all_links = {link.id: link for link in links}
    for stored in document.links:
        native = all_links.get(stored.id)
        if native:
            # A merge redirects a view, not the native relationship itself. Rebuild
            # endpoints from the source so undo can restore both original branches.
            all_links[stored.id] = stored.model_copy(
                update={"source": native.source, "target": native.target}
            )
        else:
            all_links[stored.id] = stored
    for claim in doc.claims:
        if claim.state not in {"draft", "confirmed"} or not claim.evidence_valid:
            continue
        eids = {e.atom_id for e in claim.evidence if e.available and e.atom_id}
        raw_ids = {e.event_id for e in claim.evidence if e.available and e.event_id}
        related = {
            n.id
            for n in active.values()
            if eids.intersection(n.native_ids)
            or (n.kind == "episode" and any(e.event_id in raw_ids for e in n.evidence))
        }
        related.update(claim.context_ids)
        for nid in related:
            key = f"evidence:{claim.id}:{nid}"
            all_links.setdefault(
                key,
                OntologyContextLink(
                    id=key,
                    source=claim.id,
                    target=nid,
                    kind="evidence",
                    description="共同的原话依据"
                    if nid not in claim.context_ids
                    else "本人关联的处境",
                    source_kind="native" if nid not in claim.context_ids else "self_report",
                    state="confirmed",
                    evidence_ids=sorted(eids),
                ),
            )
    claim_versions = {
        c.id: c.version
        for c in doc.claims
        if c.evidence_valid and c.state in {"draft", "confirmed"}
    }
    versions = {**{n.id: n.version for n in active.values()}, **claim_versions}
    result_links = []
    for link in all_links.values():
        link = link.model_copy(deep=True)
        link.source = aliases.get(link.source, link.source)
        link.target = aliases.get(link.target, link.target)
        if link.source == link.target or link.source not in versions or link.target not in versions:
            continue
        old_versions = (link.source_version, link.target_version)
        if (
            link.source_kind != "native"
            and link.state == "confirmed"
            and (
                (link.source_version and link.source_version != versions[link.source])
                or (link.target_version and link.target_version != versions[link.target])
            )
        ):
            link.state = "draft"
        link.source_version = versions[link.source]
        link.target_version = versions[link.target]
        if link.version == "legacy" or (
            all(old_versions) and old_versions != (link.source_version, link.target_version)
        ):
            link.version = _digest(link.model_dump(exclude={"version"}))[:32]
        result_links.append(link)
    # Owner-confirmed person/project names update the associated display, never raw quotes.
    for link in result_links:
        source, target = active.get(link.source), active.get(link.target)
        if (
            link.kind == "about"
            and source
            and target
            and not source.owner_edited
            and target.owner_edited
            and target.kind in {"person", "project"}
        ):
            for alias in target.aliases:
                if alias and alias != target.title and alias in source.statement:
                    source.statement = source.statement.replace(alias, target.title)
                    source.title = source.statement[:60]
            source.version = _digest(source.model_dump(exclude={"version", "history"}))[:32]
    for link in result_links:
        link.source_version = (
            active[link.source].version if link.source in active else versions[link.source]
        )
        link.target_version = (
            active[link.target].version if link.target in active else versions[link.target]
        )
    doc.links = result_links
    doc.graph_coverage = coverage
    doc.graph_fingerprint = _digest([n.model_dump(exclude={"history"}) for n in projected])
    doc.schema_version = max(3, doc.schema_version)
    return doc


def node_payload(node: OntologyContextNode) -> dict[str, Any]:
    """A native summary remains an extraction, even if its quote is a user message."""
    return {
        **node.model_dump(exclude={"history"}),
        "statement_kind": "user_statement" if node.source_kind == "self_report" else "inference",
        "confirmation": "user_confirmed" if node.source_kind == "self_report" else "unconfirmed",
        "evidence_origin": "owner_declaration"
        if node.source_kind == "self_report"
        else "model_extraction",
    }


async def edit_context_node(
    registry: Any, uid: int, nid: str | None, body: OntologyContextEdit
) -> OntologyResult:
    from octop.infra.agents.personal_ontology import (
        _digest,
        _lock,
        _owned,
        _read,
        _save,
        read_personal_ontology,
    )

    row = _owned(registry, uid)
    harness = registry.get_agent(row.agent_id)
    async with _lock(registry, row.agent_id):
        doc = await read_personal_ontology(registry, uid, check_changes=False)
        if body.action == "add" and body.request_id:
            generated_id = "self:" + _digest([uid, body.request_id])[:32]
            existing = next((n for n in doc.nodes if n.id == generated_id), None)
            if existing:
                return OntologyResult(status="ready", ontology=doc, changed_id=existing.id)
            if generated_id in doc.graph_retired:
                raise OctopError.localized(ErrorCode.NOT_FOUND)
        node = next((n for n in doc.nodes if n.id == nid), None)
        version_ok = (
            body.expected_version == node.version
            if node and body.expected_version
            else body.revision == doc.revision
        )
        if not version_ok:
            return OntologyResult(status="stale", ontology=doc)
        if body.action == "add":
            if nid is not None or not body.statement:
                raise OctopError.localized(ErrorCode.FORBIDDEN)
            node = OntologyContextNode(
                id=generated_id if body.request_id else new_ulid(),
                kind=body.kind,
                title=body.title or body.statement[:60],
                statement=body.statement,
                version=new_ulid(),
                state="withdrawn",
            )
            doc.nodes.append(node)
        if node is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        previous = node.version
        node.history.append(
            OntologyVersion(
                version=previous,
                at=datetime.now(UTC).isoformat(),
                reason=body.action,
                value=node.model_dump(exclude={"history"}),
            )
        )
        node.version = new_ulid()
        node.owner_edited = True
        if body.action == "purge":
            doc.graph_retired = sorted(set(doc.graph_retired + [node.id]))
            doc.graph_retired_sources = sorted(
                set(
                    doc.graph_retired_sources
                    + [
                        ("raw:" + e.event_id if node.kind == "episode" else "atom:" + e.atom_id)
                        for e in node.evidence
                        if e.event_id and (node.kind == "episode" or e.atom_id)
                    ]
                )
            )
            doc.nodes.remove(node)
            doc.links = [link for link in doc.links if node.id not in {link.source, link.target}]
            for claim in doc.claims:
                claim.context_ids = [i for i in claim.context_ids if i != node.id]
        elif body.action == "restore":
            old = next((h for h in node.history if h.version == body.restore_version), None)
            if old is None:
                raise OctopError.localized(ErrorCode.NOT_FOUND)
            merge_info = old.value.get("merge_revision")
            if merge_info:
                counterpart = next((n for n in doc.nodes if n.id == merge_info["id"]), None)
                if counterpart is None or counterpart.version != merge_info["after"]:
                    return OntologyResult(
                        status="stale", ontology=await read_personal_ontology(registry, uid)
                    )
                target_old = next(
                    (h for h in counterpart.history if h.version == merge_info["before"]), None
                )
                if target_old is None:
                    raise OctopError.localized(ErrorCode.NOT_FOUND)
                old_target = OntologyContextNode.model_validate(target_old.value)
                old_target.history = counterpart.history + [
                    OntologyVersion(
                        version=counterpart.version,
                        at=datetime.now(UTC).isoformat(),
                        reason="restore_merge",
                        value=counterpart.model_dump(exclude={"history"}),
                    )
                ]
                old_target.version, old_target.owner_edited = new_ulid(), True
                doc.nodes[doc.nodes.index(counterpart)] = old_target
            restored = OntologyContextNode.model_validate(old.value)
            restored.version, restored.history, restored.owner_edited = (
                node.version,
                node.history,
                True,
            )
            doc.nodes[doc.nodes.index(node)] = restored
            node = restored
        elif body.action == "disable":
            node.state = "withdrawn"
        elif body.action == "pin":
            node.core = body.core
        elif body.action == "merge":
            target = next((n for n in doc.nodes if n.id == body.merge_target), None)
            if (
                target is None
                or target.id == node.id
                or target.kind != node.kind
                or target.state != "active"
                or target.merged_into
                or body.merge_target_version != target.version
                or node.kind not in {"person", "project", "fact"}
            ):
                return OntologyResult(status="stale", ontology=await _read(harness.workspace))
            target.history.append(
                OntologyVersion(
                    version=target.version,
                    at=datetime.now(UTC).isoformat(),
                    reason="merge",
                    value=target.model_dump(exclude={"history"}),
                )
            )
            target.version = new_ulid()
            node.history[-1].value["merge_revision"] = {
                "id": target.id,
                "before": target.history[-1].version,
                "after": target.version,
            }
            target.owner_edited = True
            target.source_kind = "self_report"
            target.aliases = sorted(set(target.aliases + node.aliases + [node.title]))
            target.native_ids = sorted(set(target.native_ids + node.native_ids))
            target.evidence.extend(e for e in node.evidence if e not in target.evidence)
            node.merged_into = target.id
            node.state = "withdrawn"
        else:
            if not body.statement:
                raise OctopError.localized(ErrorCode.FORBIDDEN)
            old_title = node.title
            node.kind, node.statement = body.kind, body.statement
            node.title = body.title or body.statement[:60]
            node.conditions, node.time_scope = body.conditions, body.time_scope
            node.aliases, node.core = body.aliases, body.core
            if node.kind in {"person", "project"} and old_title != node.title:
                node.aliases = sorted(set(node.aliases + [old_title]))
            node.source_kind, node.state, node.evidence_valid = "self_report", "active", True
            node.changed = body.action == "change"
        for related in body.related_ids:
            target = next((n for n in doc.nodes if n.id == related and n.state == "active"), None)
            if target is None or target.id == node.id:
                raise OctopError.localized(ErrorCode.NOT_FOUND)
            doc.links.append(
                OntologyContextLink(
                    id=new_ulid(),
                    source=node.id,
                    target=target.id,
                    kind="related",
                    source_kind="self_report",
                    state="confirmed",
                    version=new_ulid(),
                    source_version=node.version,
                    target_version=target.version,
                )
            )
        await _save(harness.workspace, doc)
    return OntologyResult(
        status="ready",
        ontology=await read_personal_ontology(registry, uid),
        changed_id=node.id,
        previous_version=previous,
    )


def current_native_record(
    doc: PersonalOntology, value: dict[str, Any], path: str
) -> dict[str, Any]:
    """Old source quotes remain inspectable but carry their current corrections."""
    from octop.infra.agents.personal_ontology import _digest

    native_id = path.strip("/").split("/")[-1].removesuffix(".md")
    if "atom:" + native_id in inactive_sources(doc) or "raw:" + native_id in inactive_sources(doc):
        return {**value, "historical_source": True, "current_use": False, "current_context": []}
    corrected = [
        n
        for n in doc.nodes
        if (n.owner_edited or n.kind in {"fact", "episode"})
        and (native_id in n.native_ids or any(e.event_id == native_id for e in n.evidence))
    ]
    if corrected:
        return {
            **value,
            "historical_source": True,
            "current_context": [
                node_payload(n)
                for n in corrected
                if n.state == "active" and n.evidence_valid and not n.merged_into
            ],
            "current_use": any(
                n.state == "active" and n.evidence_valid and not n.merged_into for n in corrected
            ),
        }
    if (
        "fact:"
        + _digest([value.get("entity_id", ""), normalized(str(value.get("assertion", "")))])[:24]
        in doc.graph_retired
    ):
        return {**value, "historical_source": True, "current_use": False, "current_context": []}
    return value

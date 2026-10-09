"""Retrieve readable knowledge-base chunks for one chat turn."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import Any

from octop.i18n import tr
from octop.infra.knowledge.citations import append_citations_marker, citations_from_ranked
from octop.infra.knowledge.embed import embed_knowledge_texts
from octop.infra.knowledge.gate import assert_knowledge_usable
from octop.infra.knowledge.index import Hit, KnowledgeIndex
from octop.infra.knowledge.params import get_advanced_settings

DEFAULT_RETRIEVAL_K = 8
DEFAULT_CONTEXT_CHAR_BUDGET = 6000

logger = logging.getLogger(__name__)


async def retrieve_context(
    services: Any,
    *,
    user_id: int,
    is_admin: bool,
    query: str | None,
    knowledge_base_ids: Sequence[str],
    k: int | None = None,
    char_budget: int | None = None,
    locale: str = "en",
    visible_bases: Sequence[Any] | None = None,
    application_id: str = "wanx",
    excluded_document_ids: Sequence[str] = (),
) -> str:
    """Return formatted readable context, skipping unavailable or failed retrieval."""
    if not (query or "").strip() or not knowledge_base_ids:
        return ""
    settings = get_advanced_settings(services.settings_repo.get)
    k = settings["retrieval_k"] if k is None else k
    char_budget = settings["context_char_budget"] if char_budget is None else char_budget
    if k <= 0 or char_budget <= 0:
        return ""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(
            None,
            lambda: _retrieve_context_sync(
                services,
                user_id=user_id,
                is_admin=is_admin,
                query=query,
                knowledge_base_ids=knowledge_base_ids,
                k=k,
                char_budget=char_budget,
                locale=locale,
                visible_bases=visible_bases,
                application_id=application_id,
                excluded_document_ids=excluded_document_ids,
            ),
        )
    except Exception:
        if application_id == "zhijun":
            raise
        logger.warning("knowledge retrieval skipped for user=%s", user_id, exc_info=True)
        return ""


def _retrieve_context_sync(
    services: Any,
    *,
    user_id: int,
    is_admin: bool,
    query: str | None,
    knowledge_base_ids: Sequence[str],
    k: int,
    char_budget: int,
    locale: str,
    visible_bases: Sequence[Any] | None,
    application_id: str = "wanx",
    excluded_document_ids: Sequence[str] = (),
) -> str:
    if application_id == "zhijun":
        assert_knowledge_usable(services.settings_repo.get, application_id=application_id)
    else:
        assert_knowledge_usable(
            services.settings_repo.get, getattr(services, "provider_repo", None)
        )
    query_vectors = None
    if application_id != "zhijun":
        query_vectors = embed_knowledge_texts(services, [(query or "").strip()])
        if not query_vectors:
            return ""

    visible = visible_bases
    if visible is None:
        visible = (
            services.knowledge_repo.list_all(application_id=application_id)
            if is_admin and application_id == "wanx"
            else services.knowledge_repo.list_visible(user_id, application_id=application_id)
        )
    visible_by_id = {
        base.id: base
        for base in visible
        if getattr(base, "application_id", "wanx") == application_id
        and (application_id == "wanx" or base.owner_user_id == user_id)
    }
    selected_ids = _unique_ids(knowledge_base_ids)

    ranked: list[tuple[Any, Hit, Any]] = []
    local_queries: dict[str, list[float]] = {}
    for kb_id in selected_ids:
        base = visible_by_id.get(kb_id)
        if base is None:
            continue
        selected_model = (services.settings_repo.get("knowledge_embedding_model") or "").strip()
        if application_id == "zhijun" and base.embedding_model != selected_model:
            raise RuntimeError("knowledge index is awaiting the platform model update")
        if application_id == "zhijun":
            if base.embedding_model not in local_queries:
                vectors = embed_knowledge_texts(
                    services,
                    [(query or "").strip()],
                    application_id=application_id,
                    model=base.embedding_model,
                )
                if not vectors:
                    raise RuntimeError("knowledge local embedding returned no vectors")
                local_queries[base.embedding_model] = vectors[0]
            query_vector = local_queries[base.embedding_model]
        else:
            assert query_vectors is not None
            query_vector = query_vectors[0]
        ready_documents = {
            document.id: document
            for document in services.knowledge_repo.list_documents(kb_id)
            if document.status == "ready"
            and not document.is_dir
            and document.id not in excluded_document_ids
        }
        for hit in KnowledgeIndex(kb_id).search(
            query_vector, k=k, embedding_model=selected_model, document_ids=ready_documents.keys()
        ):
            document = ready_documents.get(hit.doc_id)
            if document is not None:
                ranked.append((base, hit, document))

    ranked.sort(key=lambda item: item[1].score, reverse=True)
    return _format_context(ranked[:k], char_budget=char_budget, locale=locale)


def _unique_ids(ids: Sequence[str]) -> list[str]:
    return list(dict.fromkeys(str(kb_id).strip() for kb_id in ids if str(kb_id).strip()))


def _format_context(
    ranked: Sequence[tuple[Any, Hit, Any]], *, char_budget: int, locale: str
) -> str:
    sections: list[str] = []
    remaining = char_budget
    for base, hit, document in ranked:
        citation = tr(
            "knowledge.retrieval.citation",
            locale,
            name=base.name,
            filename=document.filename,
            ordinal=hit.ordinal + 1,
        )
        if remaining <= len(citation):
            break
        text = hit.text.strip()[: remaining - len(citation)]
        if not text:
            continue
        section = f"{citation}{text}"
        sections.append(section)
        remaining -= len(section)
    if not sections:
        return ""
    body = tr("knowledge.retrieval.preamble", locale) + "\n\n" + "\n\n".join(sections)
    return append_citations_marker(body, citations_from_ranked(ranked))

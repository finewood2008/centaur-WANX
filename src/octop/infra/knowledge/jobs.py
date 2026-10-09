"""In-process document indexing jobs."""

from __future__ import annotations

import asyncio
import hashlib
from contextlib import suppress
from dataclasses import replace
from typing import Any

from octop.infra.knowledge.chunk import chunk_text_with_offsets
from octop.infra.knowledge.embed import embed_knowledge_texts
from octop.infra.knowledge.files import document_path
from octop.infra.knowledge.gate import assert_knowledge_usable, get_capability
from octop.infra.knowledge.index import DocumentSnapshot, KnowledgeIndex
from octop.infra.knowledge.ocr import load_ocr_config, optional_ocr_extractor
from octop.infra.knowledge.params import get_advanced_settings
from octop.infra.knowledge.parse import parse_document

INDEX_CONCURRENCY = 2
_index_semaphore: asyncio.Semaphore | None = None
_index_loops: dict[int, asyncio.AbstractEventLoop] = {}
_index_tasks: dict[tuple[int, str, str], asyncio.Task[None]] = {}


def reset_index_semaphore_for_tests() -> None:
    """Drop the cached semaphore so tests can change INDEX_CONCURRENCY."""
    global _index_semaphore
    _index_semaphore = None
    _index_loops.clear()
    _index_tasks.clear()


def _get_index_semaphore() -> asyncio.Semaphore:
    global _index_semaphore
    if _index_semaphore is None:
        _index_semaphore = asyncio.Semaphore(INDEX_CONCURRENCY)
    return _index_semaphore


def process_document(services: Any, kb_id: str, doc_id: str) -> None:
    """Synchronously parse, embed, and atomically replace one document's chunks."""
    repo = services.knowledge_repo
    document = repo.get_document(doc_id)
    base = repo.get_base(kb_id, application_id=None)
    if document is None or document.kb_id != kb_id or base is None:
        raise LookupError("knowledge document or base not found")
    if document.is_dir:
        return
    if not repo.update_document_if_current(
        doc_id,
        expected_content_hash=document.content_hash,
        expected_status=document.status,
        status="processing",
    ):
        return
    try:
        scope = base.application_id
        if scope == "zhijun":
            assert_knowledge_usable(services.settings_repo.get, application_id=scope)
        else:
            assert_knowledge_usable(
                services.settings_repo.get, getattr(services, "provider_repo", None)
            )
        path = document_path(kb_id, doc_id, document.filename)
        content_hash = hashlib.sha256(path.read_bytes()).hexdigest()
        if not document.content_hash:
            if not repo.update_document_if_current(
                doc_id,
                expected_content_hash="",
                expected_status="processing",
                status="processing",
                content_hash=content_hash,
            ):
                return
            document = replace(document, content_hash=content_hash)
        if document.content_hash and content_hash != document.content_hash:
            repo.update_document_if_current(
                doc_id,
                expected_content_hash=document.content_hash,
                expected_status="processing",
                status="pending",
                content_hash=content_hash,
            )
            return
        ocr_config = load_ocr_config(services.settings_repo.get, application_id=scope)
        ocr = (
            optional_ocr_extractor(services, application_id=scope)
            if scope == "zhijun"
            else optional_ocr_extractor(services)
        )
        snapshot = DocumentSnapshot.from_text(parse_document(path, ocr=ocr), content_hash)
        knobs = get_advanced_settings(services.settings_repo.get)
        ranges = chunk_text_with_offsets(
            snapshot.text, size=knobs["chunk_size"], overlap=knobs["chunk_overlap"]
        )
        chunks = [text for _, _, text in ranges]
        if not snapshot.text or not chunks:
            raise ValueError("knowledge document has no extractable text")
        embeddings = (
            embed_knowledge_texts(
                services, chunks, application_id=scope, model=base.embedding_model
            )
            if scope == "zhijun"
            else embed_knowledge_texts(services, chunks)
        )
        current = repo.get_base(kb_id, application_id=None)
        current_document = repo.get_document(doc_id)
        current_knobs = get_advanced_settings(services.settings_repo.get)
        if (
            current is None
            or current_document is None
            or current_document.kb_id != kb_id
            or current_document.content_hash != document.content_hash
            or current_document.status != "processing"
            or current.embedding_model != base.embedding_model
            or any(current_knobs[key] != knobs[key] for key in ("chunk_size", "chunk_overlap"))
            or load_ocr_config(services.settings_repo.get, application_id=scope) != ocr_config
        ):
            # A model switch already queued replacement work. Do not publish this old job.
            return
        if hashlib.sha256(path.read_bytes()).hexdigest() != content_hash:
            # A file changed while parsing or embedding; no mixed snapshot is published.
            repo.update_document_if_current(
                doc_id,
                expected_content_hash=document.content_hash,
                expected_status="processing",
                status="pending",
            )
            return
        KnowledgeIndex(kb_id).replace_doc_chunks(
            doc_id,
            chunks,
            embeddings,
            metadata=[
                {
                    "embedding_model": base.embedding_model,
                    "source_version": snapshot.source_version,
                    "start": start,
                    "end": end,
                }
                for start, end, _ in ranges
            ],
            snapshot=snapshot,
        )
        dimension = len(embeddings[0]) if embeddings else 0
        published = repo.update_document_if_current(
            doc_id,
            expected_content_hash=document.content_hash,
            expected_status="processing",
            status="ready",
            content_hash=content_hash,
            chunk_count=len(chunks),
        )
        if published and dimension and base.embedding_dim != dimension:
            repo.update_base(kb_id, embedding_dim=dimension)
    except Exception as exc:
        if repo.update_document_if_current(
            doc_id,
            expected_content_hash=document.content_hash,
            expected_status="processing",
            status="failed",
            error_message=str(exc),
        ):
            raise


def enqueue_index_document(services: Any, kb_id: str, doc_id: str) -> asyncio.Task[None]:
    """Schedule CPU- and I/O-bound indexing outside the event loop."""
    loop = asyncio.get_running_loop()
    identity = id(getattr(services, "knowledge_repo", services))
    _index_loops[identity] = loop
    key = (identity, kb_id, doc_id)
    existing = _index_tasks.get(key)
    if existing is not None and not existing.done():
        return existing
    sem = _get_index_semaphore()

    async def _run() -> None:
        async with sem:
            while True:
                await loop.run_in_executor(None, process_document, services, kb_id, doc_id)
                repo = getattr(services, "knowledge_repo", None)
                document = repo.get_document(doc_id) if repo is not None else None
                if document is None or document.status != "pending":
                    break

    task = asyncio.create_task(_run())
    _index_tasks[key] = task

    def discard(done: asyncio.Task[None]) -> None:
        if _index_tasks.get(key) is done:
            _index_tasks.pop(key, None)

    task.add_done_callback(discard)
    return task


def request_document_reprocessing(services: Any, kb_id: str, doc_id: str) -> None:
    """Queue native processing from a synchronous source read, including executor reads."""
    loop: asyncio.AbstractEventLoop | None
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = _index_loops.get(id(getattr(services, "knowledge_repo", services)))
    if loop is not None and not loop.is_closed():
        loop.call_soon_threadsafe(enqueue_index_document, services, kb_id, doc_id)


def reindex_all_documents(services: Any, embedding_model: str) -> None:
    """Reset every index to use ``embedding_model`` and schedule fresh work."""
    documents = services.knowledge_repo.reindex_all_documents(embedding_model)
    for document in documents:
        enqueue_index_document(services, document.kb_id, document.id)


def resume_pending_index_jobs(services: Any) -> None:
    """Resume pending work and jobs interrupted by a prior process shutdown."""
    with suppress(RuntimeError):
        _index_loops[id(getattr(services, "knowledge_repo", services))] = asyncio.get_running_loop()
    if getattr(services, "settings_repo", None) is not None:
        capability = get_capability(
            services.settings_repo.get, getattr(services, "provider_repo", None)
        )
        if capability["usable"]:
            services.knowledge_repo.reindex_all_documents(
                capability["selected_model"], only_outdated=True
            )
    documents = services.knowledge_repo.resume_pending_documents()
    for document in documents:
        enqueue_index_document(services, document.kb_id, document.id)

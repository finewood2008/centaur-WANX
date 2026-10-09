"""Complete, versioned source reading for historical-material understanding."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.knowledge import KnowledgeRepo
from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.db.repos.users import UserRepo
from octop.infra.knowledge import jobs
from octop.infra.knowledge import service as service_module
from octop.infra.knowledge.files import write_document
from octop.infra.knowledge.index import DocumentSnapshot, KnowledgeIndex
from octop.infra.knowledge.service import KnowledgeService


@pytest.fixture
def materials(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "home"))
    pool = SqlitePool(tmp_path / "test.db")
    run_migrations(pool)
    services = SimpleNamespace(
        knowledge_repo=KnowledgeRepo(pool),
        settings_repo=SettingsRepo(pool),
        user_repo=UserRepo(pool),
    )
    owner = services.user_repo.create(username="owner", password_hash="h", role="user")
    other = services.user_repo.create(username="other", password_hash="h", role="admin")
    monkeypatch.setattr(service_module, "assert_knowledge_usable", lambda *_a, **_k: None)
    monkeypatch.setattr(jobs, "assert_knowledge_usable", lambda *_a, **_k: None)
    monkeypatch.setattr(
        jobs, "embed_knowledge_texts", lambda _s, texts, **_k: [[1.0, 0.0] for _ in texts]
    )
    service = KnowledgeService(services, application_id="zhijun")
    base = service.create_base(owner_user_id=owner, name="Personal history")
    yield service, base, owner, other
    pool.close()


def _upload(materials, text: str, name: str = "history.md"):
    service, base, owner, _ = materials
    return service.upload_document(
        base.id,
        actor_user_id=owner,
        filename=name,
        content_type="text/markdown",
        content=text.encode(),
    )


def test_reads_entire_large_unicode_source_without_preview_truncation(materials, monkeypatch):
    service, base, owner, _ = materials
    canonical = "经历甲🙂\n" * 50_001
    canonical = canonical.strip()
    doc = _upload(materials, canonical)
    assert doc.content_hash == hashlib.sha256(canonical.encode()).hexdigest()
    jobs.process_document(service._services, base.id, doc.id)
    monkeypatch.setattr(service_module, "parse_document", lambda *_a, **_k: pytest.fail("reparsed"))
    text, start, version = "", 0, None
    while True:
        page = service.read_document_text_page(
            base.id,
            doc.id,
            actor_user_id=owner,
            start=start,
            source_version=version,
        )
        assert page["status"] == "ready"
        version = version or page["source_version"]
        assert page["source_version"] == version
        assert page["end"] - page["start"] == len(page["text"])
        text += page["text"]
        if not page["has_more"]:
            assert page["next_start"] is None
            break
        start = page["next_start"]
    assert len(text) > 200_000 and text == canonical
    assert page["total_chars"] == len(canonical)
    for hit in KnowledgeIndex(base.id).search([1.0, 0.0], 20):
        assert canonical[hit.metadata["start"] : hit.metadata["end"]] == hit.text


def test_pagination_checks_ownership_and_does_not_include_folders(materials):
    service, base, owner, other = materials
    service.create_folder(base.id, actor_user_id=owner, path="notes")
    ids = {_upload(materials, str(i), f"notes/{i}.md").id for i in range(5)}
    first = service.list_documents_page(base.id, actor_user_id=owner, limit=2)
    second = service.list_documents_page(
        base.id, actor_user_id=owner, limit=2, cursor=first["next_cursor"]
    )
    third = service.list_documents_page(
        base.id, actor_user_id=owner, limit=2, cursor=second["next_cursor"]
    )
    assert first["total"] == 5
    assert first["has_more"] and second["has_more"] and not third["has_more"]
    assert {row["id"] for page in (first, second, third) for row in page["items"]} == ids
    with pytest.raises(PermissionError):
        service.list_documents_page(base.id, actor_user_id=other, is_admin=True)
    with pytest.raises(PermissionError):
        service.read_document_text_page(
            base.id, next(iter(ids)), actor_user_id=other, is_admin=True
        )
    with pytest.raises(LookupError):
        KnowledgeService(service._services).list_documents_page(
            base.id, actor_user_id=owner, is_admin=True
        )
    another = service.create_base(owner_user_id=owner, name="Other")
    with pytest.raises(LookupError):
        service.read_document_text_page(another.id, next(iter(ids)), actor_user_id=owner)


def test_source_version_survives_embedding_and_chunk_changes_but_not_edit(materials):
    service, base, owner, _ = materials
    doc = _upload(materials, "我的过去。" * 300)
    jobs.process_document(service._services, base.id, doc.id)
    initial = service.read_document_text_page(base.id, doc.id, actor_user_id=owner)
    repo = service._services.knowledge_repo
    repo.update_base(base.id, embedding_model="another-local-model")
    service._services.settings_repo.set("knowledge_chunk_size", "100")
    service._services.settings_repo.set("knowledge_chunk_overlap", "20")
    service.reindex_document(base.id, doc.id, actor_user_id=owner)
    assert (
        service.read_document_text_page(base.id, doc.id, actor_user_id=owner)["status"]
        == "unavailable"
    )
    jobs.process_document(service._services, base.id, doc.id)
    reindexed = service.read_document_text_page(base.id, doc.id, actor_user_id=owner)
    assert reindexed["source_version"] == initial["source_version"]
    edited = service.update_text_document(base.id, doc.id, actor_user_id=owner, content="现在变了")
    assert edited.content_hash == hashlib.sha256("现在变了".encode()).hexdigest()
    jobs.process_document(service._services, base.id, doc.id)
    stale = service.read_document_text_page(
        base.id, doc.id, actor_user_id=owner, source_version=initial["source_version"]
    )
    assert stale["status"] == "stale" and stale["text"] == ""
    assert stale["source_version"] != initial["source_version"]


def test_legacy_snapshot_absence_queues_processing_once(materials, monkeypatch):
    service, base, owner, _ = materials
    doc = _upload(materials, "历史资料")
    repo = service._services.knowledge_repo
    repo.update_document(doc.id, status="ready", chunk_count=1)
    KnowledgeIndex(base.id).replace_doc_chunks(doc.id, ["历史资料"], [[1.0, 0.0]])
    queued = []
    monkeypatch.setattr(
        service_module,
        "request_document_reprocessing",
        lambda _s, kb, doc: queued.append((kb, doc)),
    )
    for _ in range(2):
        page = service.read_document_text_page(base.id, doc.id, actor_user_id=owner)
        assert page["status"] == "unavailable" and not page["text"]
    assert queued == [(base.id, doc.id)]
    assert repo.get_document(doc.id).status == "pending"
    jobs.process_document(service._services, base.id, doc.id)
    assert (
        service.read_document_text_page(base.id, doc.id, actor_user_id=owner)["text"] == "历史资料"
    )


def test_edit_during_source_read_or_indexing_never_returns_old_text_as_current(
    materials, monkeypatch
):
    service, base, owner, _ = materials
    doc = _upload(materials, "old body")
    jobs.process_document(service._services, base.id, doc.id)
    original = KnowledgeIndex.read_snapshot_page

    def change_while_reading(index, doc_id, **kwargs):
        result = original(index, doc_id, **kwargs)
        service.update_text_document(base.id, doc.id, actor_user_id=owner, content="new body")
        return result

    monkeypatch.setattr(KnowledgeIndex, "read_snapshot_page", change_while_reading)
    page = service.read_document_text_page(base.id, doc.id, actor_user_id=owner)
    assert page["status"] in {"unavailable", "stale"} and page["text"] == ""
    monkeypatch.setattr(KnowledgeIndex, "read_snapshot_page", original)

    def change_while_embedding(_services, texts, **_kwargs):
        service.update_text_document(base.id, doc.id, actor_user_id=owner, content="third body")
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(jobs, "embed_knowledge_texts", change_while_embedding)
    jobs.process_document(service._services, base.id, doc.id)
    assert service._services.knowledge_repo.get_document(doc.id).status == "pending"
    assert service.read_document_text_page(base.id, doc.id, actor_user_id=owner)["text"] == ""


def test_snapshot_and_chunks_roll_back_together(materials):
    service, base, _, _ = materials
    index = KnowledgeIndex(base.id)
    old = DocumentSnapshot.from_text("old", "original")
    index.replace_doc_chunks("document", ["old"], [[1.0, 0.0]], snapshot=old)
    with sqlite3.connect(index.path) as conn:
        conn.execute(
            "CREATE TRIGGER reject_snapshot BEFORE UPDATE ON document_snapshots BEGIN SELECT RAISE(ABORT, 'snapshot write failed'); END"
        )
    with pytest.raises(sqlite3.IntegrityError, match="snapshot write failed"):
        index.replace_doc_chunks(
            "document", ["new"], [[0.0, 1.0]], snapshot=DocumentSnapshot.from_text("new", "changed")
        )
    assert index.search([1.0, 0.0], 1)[0].text == "old"
    assert (
        index.read_snapshot_page("document", start=0, limit=12_000).source_version
        == old.source_version
    )


def test_external_original_change_invalidates_read_and_indexes_new_version(materials, monkeypatch):
    service, base, owner, _ = materials
    doc = _upload(materials, "first")
    jobs.process_document(service._services, base.id, doc.id)
    old = service.read_document_text_page(base.id, doc.id, actor_user_id=owner)
    write_document(base.id, doc.id, doc.filename, b"second")
    monkeypatch.setattr(service_module, "request_document_reprocessing", lambda *_a: None)
    changed = service.read_document_text_page(
        base.id, doc.id, actor_user_id=owner, source_version=old["source_version"]
    )
    assert changed["status"] == "stale" and not changed["text"]
    jobs.process_document(service._services, base.id, doc.id)
    new = service.read_document_text_page(base.id, doc.id, actor_user_id=owner)
    assert new["text"] == "second" and new["source_version"] != old["source_version"]


async def test_legacy_read_from_executor_queues_native_reprocessing(materials):
    service, base, owner, _ = materials
    doc = _upload(materials, "legacy source")
    repo = service._services.knowledge_repo
    repo.update_document(doc.id, status="ready")
    jobs.reset_index_semaphore_for_tests()
    jobs.resume_pending_index_jobs(service._services)
    # The ontology domain constructs a fresh SharedServices proxy over the same repos.
    proxy = KnowledgeService(SimpleNamespace(**vars(service._services)), application_id="zhijun")
    page = await asyncio.to_thread(
        proxy.read_document_text_page,
        base.id,
        doc.id,
        actor_user_id=owner,
    )
    assert page["status"] == "unavailable"
    for _ in range(100):
        if repo.get_document(doc.id).status == "ready":
            break
        await asyncio.sleep(0.01)
    assert repo.get_document(doc.id).status == "ready"
    restored = service.read_document_text_page(base.id, doc.id, actor_user_id=owner)
    assert restored["status"] == "ready" and restored["text"] == "legacy source"


def test_manifest_exposes_changed_extraction_without_reading_body(materials, monkeypatch):
    service, base, owner, _ = materials
    document = _upload(materials, "same original bytes")
    jobs.process_document(service._services, base.id, document.id)
    old = service.list_documents_page(base.id, actor_user_id=owner)["items"][0]
    service.reindex_document(base.id, document.id, actor_user_id=owner)
    monkeypatch.setattr(jobs, "parse_document", lambda *_a, **_k: "changed extraction")
    jobs.process_document(service._services, base.id, document.id)
    with service._repo._db.transaction() as conn:
        conn.execute(
            "UPDATE knowledge_documents SET updated_at = ? WHERE document_id = ?",
            (old["updated_at"], document.id),
        )
    monkeypatch.setattr(
        KnowledgeIndex, "read_snapshot_page", lambda *_a, **_k: pytest.fail("manifest read body")
    )
    current = service.list_documents_page(base.id, actor_user_id=owner)["items"][0]
    assert current["content_hash"] == old["content_hash"]
    assert current["updated_at"] == old["updated_at"]
    assert current["source_version"] != old["source_version"]
    assert current["extracted_hash"] != old["extracted_hash"]
    assert current["total_chars"] == len("changed extraction")


def test_nul_in_extracted_text_does_not_stall_character_pagination(materials):
    service, base, owner, _ = materials
    document = _upload(materials, "甲\x00乙🙂丙")
    jobs.process_document(service._services, base.id, document.id)
    first = service.read_document_text_page(base.id, document.id, actor_user_id=owner, limit=2)
    assert first["text"] == "甲�" and first["next_start"] == 2
    second = service.read_document_text_page(
        base.id,
        document.id,
        actor_user_id=owner,
        start=first["next_start"],
        source_version=first["source_version"],
    )
    assert second["text"] == "乙🙂丙" and not second["has_more"]

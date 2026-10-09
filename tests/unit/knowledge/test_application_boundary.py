"""Shared platform configuration preserves private knowledge domains."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from langgraph.config import var_child_runnable_config

from octop.infra.db import migrate
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.knowledge import KnowledgeRepo
from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.db.repos.users import UserRepo
from octop.infra.knowledge import embed, gate, jobs, local, ocr, retrieve, tools
from octop.infra.knowledge.citations import CITATIONS_MARKER_PREFIX
from octop.infra.knowledge.files import write_document
from octop.infra.knowledge.service import KnowledgeService

MODEL = "BAAI/bge-small-zh-v1.5"


@pytest.fixture
def services(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "home"))
    pool = SqlitePool(tmp_path / "test.db")
    migrate.run_migrations(pool)
    result = SimpleNamespace(
        knowledge_repo=KnowledgeRepo(pool),
        settings_repo=SettingsRepo(pool),
        user_repo=UserRepo(pool),
        pool=pool,
    )
    monkeypatch.setattr(local, "is_model_downloaded", lambda model: model == MODEL)
    monkeypatch.setattr(gate, "is_model_downloaded", lambda model: model == MODEL)
    monkeypatch.setattr(gate, "local_embedding_deps_available", lambda: True)
    monkeypatch.setattr(gate, "embedding_prerequisites_ok_for_model", lambda model: model == MODEL)
    monkeypatch.setattr(embed, "embed_texts", lambda _model, texts: [[1.0, 0.0] for _ in texts])
    result.settings_repo.set("knowledge_bases_enabled", "true")
    result.settings_repo.set("knowledge_embedding_backend", "onnx")
    result.settings_repo.set("knowledge_embedding_model", MODEL)
    result.settings_repo.set("knowledge_ocr_enabled", "true")
    result.settings_repo.set("knowledge_ocr_backend", "onnx")
    result.settings_repo.set("knowledge_ocr_model", "rapidocr")
    result.settings_repo.set("onnx_local_service", json.dumps({"enabled": True, "model": MODEL}))
    yield result
    pool.close()


def test_private_domains_and_names_are_independent(services) -> None:
    repo = services.knowledge_repo
    owner = services.user_repo.create(username="owner", password_hash="hash", role="admin")
    other = services.user_repo.create(username="other", password_hash="hash", role="user")
    wanx = repo.create_base(owner_user_id=owner, name="系统资料", shared=True, default_open=True)
    zhijun = KnowledgeService(services, "zhijun")
    private = zhijun.create_base(owner_user_id=owner, name="系统资料", default_open=True)
    assert private.application_id == "zhijun"
    assert private.embedding_model == MODEL
    assert not private.shared
    assert {base.id for base in repo.list_visible(owner)} == {wanx.id}
    assert {base.id for base in repo.list_all()} == {wanx.id}
    assert {base.id for base in repo.list_visible(owner, "zhijun")} == {private.id}
    assert len(repo.list_all(application_id=None)) == 2
    assert repo.get_base(private.id) is None
    assert repo.get_base(wanx.id, "zhijun") is None
    with pytest.raises(LookupError):
        KnowledgeService(services).get_readable_base(private.id, actor_user_id=owner, is_admin=True)
    with pytest.raises(LookupError):
        zhijun.get_readable_base(wanx.id, actor_user_id=owner, is_admin=True)
    with pytest.raises(PermissionError):
        zhijun.get_readable_base(private.id, actor_user_id=other, is_admin=True)
    with pytest.raises(PermissionError):
        zhijun.create_base(owner_user_id=owner, name="sharing", shared=True)
    with pytest.raises(PermissionError):
        zhijun.update_base(private.id, actor_user_id=owner, shared=True)
    # Even a malformed host-created shared flag cannot expose another user's private library.
    repo.update_base(private.id, shared=True)
    assert repo.list_visible(other, "zhijun") == []


def test_capability_uses_exact_platform_selection_without_fallback(services, monkeypatch) -> None:
    before = services.settings_repo.get("knowledge_embedding_backend")
    result = gate.get_capability(services.settings_repo.get, application_id="zhijun")
    assert result["usable"]
    assert result["backend"] == "onnx"
    assert result["selected_model"] == MODEL
    assert result["provider_id"] == ""
    assert services.settings_repo.get("knowledge_embedding_backend") == before
    services.settings_repo.set("knowledge_embedding_model", "not-downloaded")
    result = gate.get_capability(services.settings_repo.get, application_id="zhijun")
    assert result["selected_model"] == "not-downloaded"
    assert not result["usable"]
    assert local.local_embedding_model(services.settings_repo.get) == ""


def test_index_query_preview_stay_local_and_do_not_cross_domain(services, monkeypatch) -> None:
    owner = services.user_repo.create(username="owner", password_hash="hash", role="admin")
    service = KnowledgeService(services, "zhijun")
    private = service.create_base(owner_user_id=owner, name="private")
    document = service.upload_document(
        private.id,
        actor_user_id=owner,
        filename="synthetic.txt",
        content_type="text/plain",
        content="合成知君资料：示例书房于周五开放。".encode(),
    )
    forbidden = services.knowledge_repo.create_base(owner_user_id=owner, name="WANX", shared=True)
    # Any attempted remote dispatch would fail this test, including through a forged KB ID.
    monkeypatch.setattr(embed, "_embed_remote_batched", lambda *_a: pytest.fail("remote embedding"))
    monkeypatch.setattr(ocr, "_RemoteOcr", lambda *_a: pytest.fail("remote OCR"))
    jobs.process_document(services, private.id, document.id)
    assert services.knowledge_repo.get_document(document.id).status == "ready"
    context = asyncio.run(
        retrieve.retrieve_context(
            services,
            user_id=owner,
            is_admin=True,
            query="何时开放",
            application_id="zhijun",
            knowledge_base_ids=[private.id, forbidden.id],
            visible_bases=services.knowledge_repo.list_all(None),
        )
    )
    assert "示例书房" in context
    assert CITATIONS_MARKER_PREFIX in context
    assert forbidden.name not in context
    assert (
        "示例书房" in service.preview_document(private.id, document.id, actor_user_id=owner)["text"]
    )
    # A platform model switch rebuilds both domains without moving any documents.
    services.knowledge_repo.reindex_all_documents("new-cloud-model")
    assert (
        services.knowledge_repo.get_base(private.id, "zhijun").embedding_model == "new-cloud-model"
    )
    assert services.knowledge_repo.get_document(document.id).status == "pending"
    assert services.knowledge_repo.get_document(document.id).kb_id == private.id
    assert services.settings_repo.get("knowledge_embedding_backend") == "onnx"


def test_missing_stored_local_model_fails_instead_of_falling_back(services, monkeypatch) -> None:
    owner = services.user_repo.create(username="owner", password_hash="hash", role="user")
    private = KnowledgeService(services, "zhijun").create_base(owner_user_id=owner, name="private")
    document = services.knowledge_repo.create_document(
        kb_id=private.id,
        filename="synthetic.txt",
        content_type="text/plain",
        byte_size=1,
    )
    write_document(private.id, document.id, document.filename, b"synthetic fact")
    services.knowledge_repo.update_base(private.id, embedding_model="unavailable-model")
    monkeypatch.setattr(embed, "_embed_remote_batched", lambda *_a: pytest.fail("remote embedding"))
    with pytest.raises(RuntimeError, match="not downloaded"):
        jobs.process_document(services, private.id, document.id)
    assert services.knowledge_repo.get_document(document.id).status == "failed"


def test_scoped_ocr_always_requires_native_local_runtime(services, monkeypatch) -> None:
    config = ocr.load_ocr_config(services.settings_repo.get, application_id="zhijun")
    assert config.backend == "onnx"
    assert config.model == "rapidocr"
    assert not config.provider_id
    monkeypatch.setattr(ocr, "local_ocr_deps_available", lambda: False)
    assert not ocr.get_ocr_capability(services.settings_repo.get, application_id="zhijun")["usable"]
    with pytest.raises(RuntimeError, match="local OCR prerequisites"):
        ocr.require_ocr_extractor(services, application_id="zhijun")


def test_remote_platform_configuration_is_visible_but_never_dispatched(services, monkeypatch):
    services.settings_repo.set("knowledge_embedding_backend", "remote")
    services.settings_repo.set("knowledge_embedding_model", "remote-model")
    services.settings_repo.set("knowledge_ocr_backend", "remote")
    services.settings_repo.set("knowledge_ocr_model", "remote-ocr")
    result = gate.get_capability(services.settings_repo.get, application_id="zhijun")
    assert result["backend"] == "remote"
    assert result["selected_model"] == "remote-model"
    assert not result["usable"]
    assert not local.local_embedding_model(services.settings_repo.get)
    assert (
        ocr.load_ocr_config(services.settings_repo.get, application_id="zhijun").model
        == "remote-ocr"
    )
    with pytest.raises(RuntimeError, match="local OCR prerequisites"):
        ocr.require_ocr_extractor(services, application_id="zhijun")
    monkeypatch.setattr(embed, "_embed_remote_batched", lambda *_a: pytest.fail("remote embedding"))
    with pytest.raises(RuntimeError, match="not downloaded"):
        embed.embed_knowledge_texts(services, ["private"], application_id="zhijun")


def test_startup_repairs_old_private_model_without_resetting_current_wanx(services, monkeypatch):
    owner = services.user_repo.create(username="owner", password_hash="hash", role="user")
    private = services.knowledge_repo.create_base(
        owner_user_id=owner, name="private", application_id="zhijun", embedding_model="old-model"
    )
    wanx = services.knowledge_repo.create_base(
        owner_user_id=owner, name="wanx", embedding_model=MODEL
    )
    private_doc = services.knowledge_repo.create_document(
        kb_id=private.id, filename="a.txt", content_type="text/plain", byte_size=1, status="ready"
    )
    wanx_doc = services.knowledge_repo.create_document(
        kb_id=wanx.id, filename="b.txt", content_type="text/plain", byte_size=1, status="ready"
    )
    queued = []
    monkeypatch.setattr(
        jobs, "enqueue_index_document", lambda _s, kb, doc: queued.append((kb, doc))
    )
    jobs.resume_pending_index_jobs(services)
    assert queued == [(private.id, private_doc.id)]
    assert services.knowledge_repo.get_base(private.id, "zhijun").embedding_model == MODEL
    assert services.knowledge_repo.get_document(wanx_doc.id).status == "ready"
    jobs.resume_pending_index_jobs(services)
    assert services.knowledge_repo.get_base(private.id, "zhijun").embedding_model == MODEL


async def test_query_rejects_old_model_and_old_vectors_even_with_same_dimension(services):
    from octop.infra.knowledge.index import KnowledgeIndex

    owner = services.user_repo.create(username="owner", password_hash="hash", role="user")
    base = services.knowledge_repo.create_base(
        owner_user_id=owner, name="private", application_id="zhijun", embedding_model="old-model"
    )
    doc = services.knowledge_repo.create_document(
        kb_id=base.id, filename="a.txt", content_type="text/plain", byte_size=1, status="ready"
    )
    kwargs = {
        "user_id": owner,
        "is_admin": False,
        "query": "fact",
        "knowledge_base_ids": [base.id],
        "application_id": "zhijun",
    }
    with pytest.raises(RuntimeError, match="awaiting"):
        await retrieve.retrieve_context(services, **kwargs)
    services.knowledge_repo.update_base(base.id, embedding_model=MODEL)
    KnowledgeIndex(base.id).replace_doc_chunks(
        doc.id, ["outdated fact"], [[1.0, 0.0]], metadata=[{"embedding_model": "old-model"}]
    )
    assert await retrieve.retrieve_context(services, **kwargs) == ""
    KnowledgeIndex(base.id).replace_doc_chunks(
        doc.id, ["current fact"], [[1.0, 0.0]], metadata=[{"embedding_model": MODEL}]
    )
    assert "current fact" in await retrieve.retrieve_context(services, **kwargs)


async def test_retrieval_uses_platform_policy_when_tool_omits_limits(services, monkeypatch):
    services.settings_repo.set("knowledge_retrieval_k", "3")
    services.settings_repo.set("knowledge_context_char_budget", "900")

    def capture(_services, **kwargs):
        assert kwargs["k"] == 3
        assert kwargs["char_budget"] == 900
        return "source"

    monkeypatch.setattr(retrieve, "_retrieve_context_sync", capture)
    assert (
        await retrieve.retrieve_context(
            services, user_id=1, is_admin=False, query="fact", knowledge_base_ids=["kb"]
        )
        == "source"
    )


async def test_knowledge_tool_wraps_only_successful_sources(services, monkeypatch) -> None:
    async def context(*_args, **kwargs):
        assert kwargs["application_id"] == "zhijun"
        assert kwargs["k"] is None  # Platform retrieval policy is resolved downstream.
        return "synthetic context with source"

    monkeypatch.setattr(tools, "retrieve_context", context)
    tool = tools.build_knowledge_tools(services, application_id="zhijun")[0]
    token = var_child_runnable_config.set(
        {"configurable": {"user": "1", "knowledge_base_ids": ["kb"]}}
    )
    try:
        result = json.loads(await tool.ainvoke({"query": "source"}))
        assert result == {"ok": True, "content": "synthetic context with source", "empty": False}

        async def failed(*_args, **_kwargs):
            raise RuntimeError("local dependency unavailable")

        monkeypatch.setattr(tools, "retrieve_context", failed)
        assert json.loads(await tool.ainvoke({"query": "source"})) == {
            "ok": False,
            "error": "knowledge_unavailable",
        }
    finally:
        var_child_runnable_config.reset(token)


def test_v20_upgrade_preserves_existing_documents_and_foreign_keys(tmp_path, monkeypatch) -> None:
    pool = SqlitePool(tmp_path / "legacy.db")
    discover = migrate._discover
    with monkeypatch.context() as patch:
        patch.setattr(
            migrate,
            "_discover",
            lambda dialect="sqlite": [(v, p) for v, p in discover(dialect) if v <= 20],
        )
        migrate.run_migrations(pool)
    repo = KnowledgeRepo(pool)
    owner = UserRepo(pool).create(username="owner", password_hash="hash", role="user")
    # Model a pre-21 row using SQL because the current repo now requires application_id.
    with pool.connect() as conn:
        conn.execute(
            "INSERT INTO knowledge_bases(knowledge_base_id,owner_user_id,name,created_at,updated_at) VALUES ('legacy',?,'same-name',1,1)",
            (owner,),
        )
    document = repo.create_document(
        kb_id="legacy",
        filename="old.txt",
        content_type="text/plain",
        byte_size=5,
        status="ready",
        content_hash="old-hash",
    )
    migrate.run_migrations(pool)
    migrate.run_migrations(pool)
    legacy = repo.get_base("legacy")
    assert legacy.application_id == "wanx"
    assert repo.get_document(document.id) == document
    assert (
        repo.create_base(owner_user_id=owner, name="same-name", application_id="zhijun").id
        != "legacy"
    )
    with pool.connect() as conn:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 23
    pool.close()

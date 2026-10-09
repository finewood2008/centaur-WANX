"""Native knowledge API keeps personal libraries private and processes locally."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from octop.infra.knowledge import embed, gate, local, ocr
from tests.support.auth import TEST_PASSWORD

MODEL = "BAAI/bge-small-zh-v1.5"


@pytest.fixture
def local_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(local, "is_model_downloaded", lambda model: model == MODEL)
    monkeypatch.setattr(gate, "is_model_downloaded", lambda model: model == MODEL)
    monkeypatch.setattr(gate, "local_embedding_deps_available", lambda: True)
    monkeypatch.setattr(gate, "embedding_prerequisites_ok_for_model", lambda model: model == MODEL)
    monkeypatch.setattr(embed, "embed_texts", lambda _model, texts: [[1.0, 0.0] for _ in texts])
    monkeypatch.setattr(embed, "_embed_remote_batched", lambda *_a: pytest.fail("remote embedding"))
    monkeypatch.setattr(ocr, "_RemoteOcr", lambda *_a: pytest.fail("remote OCR"))


async def test_versioned_source_pages_have_typed_native_responses_and_application_acl(
    env: Any, local_ready: None
) -> None:
    from octop.infra.knowledge import jobs
    from octop.infra.knowledge.service import KnowledgeService

    client, server, wanx_auth = env
    server.services.settings_repo.set("knowledge_bases_enabled", "true")
    server.services.settings_repo.set("knowledge_embedding_backend", "onnx")
    server.services.settings_repo.set("knowledge_embedding_model", MODEL)
    login = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    owner = login.json()["user"]["id"]
    service = KnowledgeService(server.services, application_id="zhijun")
    base = service.create_base(owner_user_id=owner, name="Reading history")
    doc = service.upload_document(
        base.id,
        actor_user_id=owner,
        filename="history.md",
        content_type="text/markdown",
        content=("本人过往经历。" * 2000).encode(),
    )
    jobs.process_document(server.services, base.id, doc.id)
    directory = f"/api/knowledge-bases/{base.id}/documents/page"
    page = await client.get(directory, headers=auth, params={"limit": 1})
    assert page.status_code == 200, page.text
    assert page.json()["items"][0]["document_id"] == doc.id
    assert page.json()["total"] == 1 and not page.json()["has_more"]
    source = f"/api/knowledge-bases/{base.id}/documents/{doc.id}/text/page"
    first = await client.get(source, headers=auth, params={"limit": 100})
    assert first.status_code == 200 and first.json()["status"] == "ready"
    second = await client.get(
        source,
        headers=auth,
        params={
            "start": first.json()["next_start"],
            "source_version": first.json()["source_version"],
        },
    )
    assert second.json()["start"] == 100 and second.json()["status"] == "ready"
    stale = await client.get(source, headers=auth, params={"source_version": "old-version"})
    assert stale.json()["status"] == "stale" and not stale.json()["text"]
    for path in (directory, source):
        assert (await client.get(path, headers=wanx_auth)).status_code == 404
    schema = client._octop_app.openapi()
    for path in (
        "/api/knowledge-bases/{kb_id}/documents/page",
        "/api/knowledge-bases/{kb_id}/documents/{doc_id}/text/page",
    ):
        route = schema["paths"][path]["get"]
        assert route["summary"] and route["description"]
        assert "$ref" in route["responses"]["200"]["content"]["application/json"]["schema"]


async def test_native_knowledge_crud_and_sources_are_application_scoped(
    env: Any, local_ready: None
) -> None:
    client, server, wanx_auth = env
    server.services.settings_repo.set("knowledge_bases_enabled", "true")
    server.services.settings_repo.set("knowledge_embedding_backend", "onnx")
    server.services.settings_repo.set("knowledge_embedding_model", MODEL)
    server.services.settings_repo.set(
        "onnx_local_service", '{"enabled":true,"model":"' + MODEL + '"}'
    )
    server.services.settings_repo.set("knowledge_ocr_enabled", "true")
    server.services.settings_repo.set("knowledge_ocr_backend", "onnx")
    login = await client.post(
        "/api/auth/login",
        json={
            "username": "admin",
            "password": TEST_PASSWORD,
            "application_id": "zhijun",
        },
    )
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    user_id = login.json()["user"]["id"]
    old = server.services.knowledge_repo.create_base(
        owner_user_id=user_id,
        name="系统资料",
        shared=True,
        default_open=True,
    )
    created = await client.post(
        "/api/knowledge-bases",
        headers=auth,
        json={
            "name": "系统资料",
            "default_open": True,
            "shared": False,
        },
    )
    assert created.status_code == 201, created.text
    base = created.json()
    kb_id = base["knowledge_base_id"]
    assert base["application_id"] == "zhijun"
    assert base["embedding_model"] == MODEL
    assert not base["shared"]
    assert {
        row["knowledge_base_id"]
        for row in (await client.get("/api/knowledge-bases", headers=auth)).json()
    } == {kb_id}
    assert {
        row["knowledge_base_id"]
        for row in (await client.get("/api/knowledge-bases", headers=wanx_auth)).json()
    } == {old.id}
    assert (await client.get("/api/knowledge-bases/default-open", headers=auth)).json() == {
        "knowledge_base_ids": [kb_id]
    }
    assert (await client.get(f"/api/knowledge-bases/{old.id}", headers=auth)).status_code == 404
    assert (await client.get(f"/api/knowledge-bases/{kb_id}", headers=wanx_auth)).status_code == 404
    assert (
        await client.patch(f"/api/knowledge-bases/{kb_id}", headers=auth, json={"shared": True})
    ).status_code == 403
    assert (
        await client.patch(
            f"/api/knowledge-bases/{kb_id}", headers=auth, json={"application_id": "wanx"}
        )
    ).status_code == 422
    capability = (await client.get("/api/knowledge-bases/capability", headers=auth)).json()
    assert capability["backend"] == "onnx"
    assert capability["selected_model"] == MODEL
    assert capability["usable"]
    assert capability["ocr"]["backend"] == "onnx"
    uploaded = await client.post(
        f"/api/knowledge-bases/{kb_id}/documents",
        headers=auth,
        files={
            "upload": ("synthetic.txt", "合成系统资料：茶室下午开放。".encode(), "text/plain"),
        },
    )
    assert uploaded.status_code == 201, uploaded.text
    document_id = uploaded.json()["document_id"]
    for _ in range(100):
        document = server.services.knowledge_repo.get_document(document_id)
        if document.status in {"ready", "failed"}:
            break
        await asyncio.sleep(0.01)
    assert document.status == "ready", document.error_message
    preview_path = f"/api/knowledge-bases/{kb_id}/documents/{document_id}/preview"
    preview = await client.get(preview_path, headers=auth)
    assert preview.status_code == 200
    assert "茶室" in preview.json()["text"]
    assert (await client.get(preview_path, headers=wanx_auth)).status_code == 404
    file_path = f"/api/knowledge-bases/{kb_id}/documents/{document_id}/file"
    assert (await client.get(file_path, headers=auth)).status_code == 200
    assert (await client.get(file_path, headers=wanx_auth)).status_code == 404
    assert (
        await client.post(preview_path.replace("/preview", "/reindex"), headers=wanx_auth)
    ).status_code == 404
    assert server.services.settings_repo.get("knowledge_embedding_backend") == "onnx"
    assert server.services.settings_repo.get("knowledge_ocr_backend") == "onnx"
    assert (await client.delete(f"/api/knowledge-bases/{kb_id}", headers=auth)).status_code == 204


async def test_registration_empty_permissions_can_own_private_knowledge(
    env: Any, local_ready: None
) -> None:
    client, server, _auth = env
    server.services.settings_repo.set(
        "onnx_local_service", '{"enabled":true,"model":"' + MODEL + '"}'
    )
    server.services.settings_repo.set("knowledge_bases_enabled", "true")
    server.services.settings_repo.set("knowledge_embedding_model", MODEL)
    registered = await client.post(
        "/api/auth/register", json={"username": "knowledge-user", "password": TEST_PASSWORD}
    )
    assert registered.status_code == 201
    assert registered.json()["user"]["permissions"] == []
    auth = {"Authorization": f"Bearer {registered.json()['access_token']}"}
    created = await client.post("/api/knowledge-bases", headers=auth, json={"name": "我的资料"})
    assert created.status_code == 201, created.text
    assert created.json()["owner_user_id"] == registered.json()["user"]["id"]
    assert (await client.get("/api/zhijun/profile", headers=auth)).json() == {"profile": None}


async def test_missing_local_runtime_is_real_unavailable(env: Any, monkeypatch) -> None:
    client, server, _auth = env
    server.services.settings_repo.set("knowledge_bases_enabled", "true")
    monkeypatch.setattr(gate, "embedding_prerequisites_ok_for_model", lambda _model: False)
    monkeypatch.setattr(gate, "local_embedding_deps_available", lambda: False)
    login = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    capability = (await client.get("/api/knowledge-bases/capability", headers=auth)).json()
    assert not capability["usable"]
    response = await client.post("/api/knowledge-bases", headers=auth, json={"name": "blocked"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "KNOWLEDGE_PREREQUISITES_FAILED"
    assert server.services.knowledge_repo.list_all("zhijun") == []


async def test_public_knowledge_openapi_has_typed_sources(env: Any) -> None:
    from octop.api.app import build_app

    _client, server, _auth = env
    schema = build_app(server).openapi()
    schemas = schema["components"]["schemas"]
    application_scope = schemas["KnowledgeBaseResponse"]["properties"]["application_id"]
    assert application_scope["type"] == "string"
    assert "enum" not in application_scope  # Registered products extend beyond legacy scopes.
    assert schemas["KnowledgeBaseResponse"]["properties"]["embedding_model"]["description"]
    assert schemas["KnowledgeDocumentResponse"]["properties"]["status"]["description"]
    assert {"id", "kb_id", "application_id", "filename", "text"} <= schemas[
        "KnowledgePreviewResponse"
    ]["properties"].keys()
    operation = schema["paths"]["/api/knowledge-bases/{kb_id}/documents"]["post"]
    assert operation["responses"]["201"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "KnowledgeDocumentResponse"
    )
    capability = schema["paths"]["/api/knowledge-bases/capability"]["get"]
    assert capability["responses"]["200"]["content"]["application/json"]["schema"]["$ref"].endswith(
        "KnowledgeCapabilityResponse"
    )


async def test_wanx_model_and_policy_update_reindexes_private_libraries(
    env: Any, local_ready: None, monkeypatch
):
    from octop.api.routers import knowledge_bases
    from octop.infra.knowledge import jobs

    client, server, wanx_auth = env
    settings = server.services.settings_repo
    settings.set("knowledge_bases_enabled", "true")
    settings.set("knowledge_embedding_model", MODEL)
    next_model = "BAAI/bge-base-en-v1.5"
    monkeypatch.setattr(
        gate, "embedding_prerequisites_ok_for_model", lambda model: model in {MODEL, next_model}
    )
    monkeypatch.setattr(gate, "require_embedding_prerequisites_for_model", lambda model: model)
    monkeypatch.setattr(local, "is_model_downloaded", lambda model: model in {MODEL, next_model})

    async def ready(**_kwargs):
        return "ready"

    monkeypatch.setattr(knowledge_bases, "ensure_local_embedding_deps_async", ready)
    login = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    owner = login.json()["user"]["id"]
    repo = server.services.knowledge_repo
    base = repo.create_base(
        owner_user_id=owner, name="private", application_id="zhijun", embedding_model=MODEL
    )
    wanx = repo.create_base(owner_user_id=owner, name="wanx", embedding_model=MODEL)
    uploaded = await client.post(
        f"/api/knowledge-bases/{base.id}/documents",
        headers=auth,
        files={"upload": ("note.txt", b"synthetic fact " * 100, "text/plain")},
    )
    assert uploaded.status_code == 201
    doc_id = uploaded.json()["document_id"]
    for _ in range(100):
        if repo.get_document(doc_id).status == "ready":
            break
        await asyncio.sleep(0.01)
    assert repo.get_document(doc_id).status == "ready"
    queued = []
    monkeypatch.setattr(
        jobs, "enqueue_index_document", lambda _s, kb, doc: queued.append((kb, doc))
    )
    changed = await client.put(
        "/api/knowledge-bases/feature",
        headers=wanx_auth,
        json={
            "enabled": True,
            "model": next_model,
            "chunk_size": 400,
            "chunk_overlap": 80,
            "retrieval_k": 3,
            "context_char_budget": 900,
        },
    )
    assert changed.status_code == 200, changed.text
    assert repo.get_base(base.id, "zhijun").embedding_model == next_model
    assert repo.get_base(wanx.id).embedding_model == next_model
    assert repo.get_document(doc_id).status == "pending"
    assert queued == [(base.id, doc_id)]
    native = changed.json()
    personal = (await client.get("/api/knowledge-bases/capability", headers=auth)).json()
    for key in (
        "selected_model",
        "backend",
        "feature_enabled",
        "chunk_size",
        "chunk_overlap",
        "retrieval_k",
        "context_char_budget",
        "ocr",
    ):
        assert personal[key] == native[key]
    jobs.process_document(server.services, base.id, doc_id)
    assert repo.get_document(doc_id).status == "ready"
    assert repo.get_document(doc_id).chunk_count > 3
    assert (
        await client.get(f"/api/knowledge-bases/{base.id}", headers=wanx_auth)
    ).status_code == 404
    assert (await client.get(f"/api/knowledge-bases/{wanx.id}", headers=auth)).status_code == 404
    created = await client.post("/api/knowledge-bases", headers=auth, json={"name": "after switch"})
    assert created.status_code == 201, created.text
    assert created.json()["embedding_model"] == next_model
    queued.clear()
    updated = await client.put(
        "/api/knowledge-bases/feature",
        headers=wanx_auth,
        json={"enabled": True, "model": next_model, "retrieval_k": 2},
    )
    assert updated.status_code == 200
    assert not queued  # Retrieval-only changes do not rebuild document embeddings.
    disabled = await client.put(
        "/api/knowledge-bases/feature",
        headers=wanx_auth,
        json={"enabled": False, "model": next_model},
    )
    assert disabled.status_code == 200
    assert not (await client.get("/api/knowledge-bases/capability", headers=auth)).json()["usable"]


async def test_personal_archive_is_account_bound_and_idempotent_without_runtime(
    env: Any, monkeypatch
) -> None:
    client, server, wanx_auth = env
    monkeypatch.setattr(gate, "embedding_prerequisites_ok_for_model", lambda _model: False)
    monkeypatch.setattr(gate, "local_embedding_deps_available", lambda: False)
    login = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    first = await client.post("/api/knowledge-bases/personal", headers=auth)
    assert first.status_code == 200, first.text
    second = await client.post("/api/knowledge-bases/personal", headers=auth)
    assert second.json()["id"] == first.json()["id"]
    assert first.json()["application_id"] == "zhijun"
    assert first.json()["shared"] is False
    assert first.json()["default_open"] is True
    assert len(server.services.knowledge_repo.list_all("zhijun")) == 1
    denied = await client.post("/api/knowledge-bases/personal", headers=wanx_auth)
    assert denied.status_code == 403


async def test_personal_archive_reuses_existing_material_and_enforces_single_owner_archive(
    env: Any,
) -> None:
    client, server, _auth = env
    login = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}
    owner = login.json()["user"]["id"]
    repo = server.services.knowledge_repo
    original = repo.create_base(owner_user_id=owner, name="已有资料", application_id="zhijun")
    response = await client.post("/api/knowledge-bases/personal", headers=auth)
    assert response.json()["id"] == original.id
    from octop.infra.knowledge.service import KnowledgeService

    duplicate = KnowledgeService(server.services, application_id="zhijun").personal_base(
        owner_user_id=owner
    )
    assert duplicate.id == original.id
    assert len(repo.list_all("zhijun")) == 1

"""Compile a real Builder artifact and exercise three real WANX HTTP identities."""

from typing import Any
from uuid import uuid4

from octop.infra.knowledge.files import document_path
from tests.support.auth import create_agent, create_provider, create_user


async def test_published_builder_reports_are_private_and_admin_can_aggregate(
    env_with_provider: Any,
) -> None:
    c, server, admin = env_with_provider
    svc = c._octop_app.state.app_studio
    provider = await create_provider(
        c,
        admin,
        name="report-embedding",
        api_key="synthetic-only",
        base_url="https://example.invalid/v1",
        models=[{"id": "text-embedding-3-small", "embedding": True}],
    )
    r = await c.put(
        "/api/knowledge-bases/feature",
        headers=admin,
        json={
            "enabled": True,
            "backend": "remote",
            "provider_id": str(provider["id"]),
            "model": "text-embedding-3-small",
        },
    )
    assert r.status_code == 200, r.text
    alice = await create_user(c, admin, username="report_alice", permissions=["knowledge_bases"])
    bob = await create_user(
        c, admin, username="report_bob", permissions=["knowledge_bases", "terminal"]
    )
    me = {
        name: (await c.get("/api/auth/me", headers=auth)).json()
        for name, auth in [("admin", admin), ("alice", alice), ("bob", bob)]
    }
    p = (
        await c.post(
            "/api/app-studio/projects",
            headers=admin,
            json={
                "name": "私有报告验收",
                "goal": "员工仅本人报告，管理员汇总",
                "operationId": uuid4().hex,
            },
        )
    ).json()
    owner = f"wanx:{me['admin']['id']}"
    # A clearly identified fixed fixture, compiled by the normal trusted compiler.
    # This test does not claim that an LLM generated the example or completed a PRD interview.
    from wanx_studio.contracts import digest

    def seed(project: dict[str, Any]) -> None:
        project["solution"].update(capabilities=["reports"], acceptance=["本人隔离与管理员汇总"])
        project["confirmation"] = {
            "hash": digest(project["solution"]),
            "decisionsHash": digest(project["decisions"]),
        }
        project["tasks"].append(
            {
                "id": "report_fixture",
                "executor": "fixed-test-fixture",
                "state": "running",
                "solutionHash": digest(project["solution"]),
                "events": [],
            }
        )

    svc.store.mutate(owner, p["id"], uuid4().hex, {"action": "fixed-report-fixture"}, seed)
    source = svc.project_root / "examples" / "private-reports"
    files = {str(f.relative_to(source)): f.read_text() for f in source.rglob("*") if f.is_file()}
    p = await svc.add_artifact(owner, p["id"], "report_fixture", files)
    artifact = p["artifacts"][-1]
    r = await c.post(
        f"/api/app-studio/projects/{p['id']}/accept",
        headers=admin,
        json={
            "operationId": uuid4().hex,
            "artifactHash": artifact["hash"],
            "criteria": [0],
            "confirmedByUser": True,
        },
    )
    assert r.status_code == 200, r.text
    r = await c.post(
        "/api/admin/applications",
        headers=admin,
        json={"application_id": p["appId"], "name": "报告验收"},
    )
    assert r.status_code == 201, r.text
    deployment = {
        "enabled": False,
        "configuration": {
            "studio_team": {
                "projectId": p["id"],
                "artifactHash": artifact["hash"],
                "audience": "all",
            }
        },
    }
    url = f"/api/admin/applications/{p['appId']}/deployment"
    assert (await c.put(url, headers=admin, json=deployment)).status_code == 200
    r = await c.post(
        f"/api/app-studio/projects/{p['id']}/installed",
        headers=admin,
        json={
            "operationId": uuid4().hex,
            "artifactHash": artifact["hash"],
            "applicationId": p["appId"],
            "version": artifact["version"],
        },
    )
    assert r.status_code == 200, r.text
    deployment["enabled"] = True
    assert (await c.put(url, headers=admin, json=deployment)).status_code == 200
    tokens = {}
    for name, auth in [("admin", admin), ("alice", alice), ("bob", bob)]:
        r = await c.post(
            f"/api/app-studio/apps/{p['appId']}/runtime",
            headers=auth,
            json={"artifactHash": artifact["hash"], "environment": "production"},
        )
        assert r.status_code == 200, r.text
        tokens[name] = r.json()["session"]

    async def invoke(name: str, method: str, params: dict[str, Any], expected: int = 200) -> Any:
        auth = {"admin": admin, "alice": alice, "bob": bob}[name]
        response = await c.post(
            f"/api/app-studio/runtime/{tokens[name]}/invoke",
            headers=auth,
            json={"method": "reports." + method, "params": params},
        )
        assert response.status_code == expected, (name, method, response.status_code, response.text)
        return response.json()

    a_request = {"title": "周报", "content": "ALICE_PRIVATE_REPORT", "operationId": uuid4().hex}
    a = await invoke("alice", "save", a_request)
    b = await invoke(
        "bob",
        "save",
        {"title": "周报", "content": "BOB_PRIVATE_REPORT", "operationId": uuid4().hex},
    )
    assert (await invoke("alice", "save", a_request))["id"] == a["id"]
    assert (await invoke("alice", "list", {}))["total"] == 1
    assert (await invoke("bob", "list", {}))["items"][0]["id"] == b["id"]
    assert {item["id"] for item in (await invoke("admin", "list", {}))["items"]} == {
        a["id"],
        b["id"],
    }
    assert (await invoke("admin", "get", {"id": a["id"]}))["content"] == "ALICE_PRIVATE_REPORT"
    assert (await invoke("admin", "get", {"id": b["id"]}))["content"] == "BOB_PRIVATE_REPORT"
    await invoke("bob", "get", {"id": a["id"]}, 403)
    await invoke("alice", "get", {"id": b["id"]}, 403)
    await invoke(
        "bob", "save", {"id": a["id"], "content": "tamper", "expectedHash": a["contentHash"]}, 403
    )
    await invoke("bob", "delete", {"id": a["id"], "expectedHash": a["contentHash"]}, 403)
    await invoke("bob", "list", {"ownerUserId": me["alice"]["id"], "is_admin": True}, 409)
    await invoke(
        "admin",
        "save",
        {"id": a["id"], "content": "impersonation", "expectedHash": a["contentHash"]},
        403,
    )
    updated = await invoke(
        "alice",
        "save",
        {"id": a["id"], "content": "ALICE_UPDATED", "expectedHash": a["contentHash"]},
    )
    await invoke(
        "alice", "save", {"id": a["id"], "content": "stale", "expectedHash": a["contentHash"]}, 409
    )
    assert (await invoke("admin", "get", {"id": a["id"]}))["content"] == "ALICE_UPDATED"
    assert updated["contentHash"] != a["contentHash"]
    doc = server.services.knowledge_repo.get_document(a["id"])
    library_url = f"/api/knowledge-bases/{doc.kb_id}"
    assert (await c.patch(library_url, headers=alice, json={"shared": True})).status_code == 403
    assert (await c.patch(library_url, headers=admin, json={"shared": True})).status_code == 403
    assert (await c.delete(library_url, headers=alice)).status_code == 403
    native_content = library_url + f"/documents/{a['id']}/content"
    assert (await c.get(native_content, headers=bob)).status_code == 403
    assert (await c.get(native_content, headers=admin)).json()["text"] == "ALICE_UPDATED"
    aid = await create_agent(c, bob)
    for unsafe_workspace in [str(server.paths.root), str(server.paths.knowledge_dir)]:
        attempted = await c.post(
            "/api/agents",
            headers=bob,
            json={"name": "unsafe workspace", "config": {"workspace_dir": unsafe_workspace}},
        )
        assert attempted.status_code == 403, attempted.text
    private_path = document_path(doc.kb_id, doc.id, doc.filename)
    endpoint = f"/api/agents/{aid}/workspace/file"
    for absolute in [str(private_path), private_path.as_uri()]:
        r = await c.get(endpoint, headers=bob, params={"path": absolute})
        assert r.status_code == 403, r.text
    assert (await c.post(f"/api/agents/{aid}/stop", headers=bob)).status_code == 204
    assert (
        await c.get(endpoint, headers=bob, params={"path": str(private_path)})
    ).status_code == 403
    assert (await c.get(f"/api/agents/{aid}/terminal/context", headers=bob)).status_code == 403
    # Scope, session ownership, revocation, and live role changes stay authoritative.
    # Simulate a separate trusted preview context without changing publication metadata.
    preview = svc.open_runtime(owner, p["id"], artifact["hash"], "preview")["session"]
    result = await c.post(
        f"/api/app-studio/runtime/{preview}/invoke",
        headers=admin,
        json={"method": "reports.get", "params": {"id": a["id"]}},
    )
    assert result.status_code == 403
    r = await c.post(
        f"/api/app-studio/runtime/{tokens['alice']}/invoke",
        headers=bob,
        json={"method": "reports.list", "params": {}},
    )
    assert r.status_code == 401
    assert (
        await c.patch(f"/api/users/{me['bob']['id']}", headers=admin, json={"role": "admin"})
    ).status_code == 200
    assert (await invoke("bob", "list", {}))["total"] == 2
    assert (
        await c.patch(f"/api/users/{me['bob']['id']}", headers=admin, json={"role": "user"})
    ).status_code == 200
    assert (await invoke("bob", "list", {}))["total"] == 1
    await invoke("bob", "get", {"id": a["id"]}, 403)
    assert (
        await c.patch(f"/api/users/{me['alice']['id']}", headers=admin, json={"disabled": True})
    ).status_code == 200
    await invoke("alice", "list", {}, 403)

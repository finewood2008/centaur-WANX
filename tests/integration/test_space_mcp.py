"""Official MCP SDK against real WANX auth and storage, without Agent branding."""

import secrets
from contextlib import asynccontextmanager
from uuid import uuid4

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from octop.infra.personal_space.mcp_access import SpaceMcp
from tests.support.auth import create_user

BASE = "/api/_client/space-mcp"


@asynccontextmanager
async def session(client, key):
    app = client._octop_app
    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app),
            base_url="http://test",
            headers={"Authorization": "Bearer " + key},
        ) as http,
        streamable_http_client("http://test/mcp/space", http_client=http) as (
            read,
            write,
            _,
        ),
        ClientSession(read, write) as s,
    ):
        init = await s.initialize()
        assert init.serverInfo.name == "wanx-space"
        yield s


async def issue(client, headers, destination="personal"):
    key = secrets.token_urlsafe(32)
    body = {
        "operation_id": uuid4().hex,
        "credential": key,
        "name": "通用测试接入",
        "destination": destination,
    }
    r = await client.post(BASE + "/connections", headers=headers, json=body)
    assert r.status_code == 200, r.text
    assert "credential" not in r.text
    return r.json()["id"], key, body


async def test_official_client_memory_roundtrip_and_permissions(env):
    client, server, admin = env
    alice = await create_user(client, admin, username="mcp_alice")
    bob = await create_user(client, admin, username="mcp_bob")
    aid, key, body = await issue(client, alice)
    actor = (await client.get("/api/auth/me", headers=alice)).json()["id"]
    store = SpaceMcp(server.paths.root, actor, "Alice").storage("personal")
    folder = store.mkdir("", "记忆归档")["id"]
    other = store.mkdir("", "未授权")["id"]
    r = await client.post(
        BASE + f"/connections/{aid}/grants",
        headers=alice,
        json={"domain": "personal", "root": folder, "purpose": "output"},
    )
    assert r.status_code == 200, r.text
    gid = r.json()["id"]
    app = client._octop_app
    async with app.state.space_mcp.session_manager.run(), session(client, key) as s:
        assert {t.name for t in (await s.list_tools()).tools} == {
            "space_access",
            "space",
            "space_read_text",
            "space_write_text",
            "space_archive_memory",
        }
        assert (await s.list_resources()).resources
        assert (await s.list_prompts()).prompts[0].name == "import_accessible_memory"
        prompt = await s.get_prompt("import_accessible_memory", {})
        assert "隐藏推理" in prompt.messages[0].content.text
        assert key not in prompt.model_dump_json()
        args = {
            "grant_id": "",
            "operation_id": uuid4().hex,
            "title": "合成记忆",
            "source": "合成会话",
            "coverage": "只导出可见测试会话，无法读取其他历史",
            "sections": [{"title": "偏好", "content": "合成偏好：简明回答。"}],
        }
        saved = await s.call_tool("space_archive_memory", args)
        assert not saved.isError, saved
        value = saved.structuredContent
        assert value["saved"] is True
        assert (await s.call_tool("space_archive_memory", args)).structuredContent == value
        assert (
            await s.call_tool("space_archive_memory", {**args, "title": "改变同一个请求"})
        ).isError
        overview = (await client.get(BASE, headers=alice, params={"destination": "company"})).json()
        assert any(a["id"] == value["archive_id"] for a in overview["archives"])
        fid = value["file"]["id"]
        text = await s.call_tool("space_read_text", {"target": fid})
        assert "合成偏好" in text.structuredContent["text"]
        assert (await s.call_tool("space_access", {})).structuredContent["workspace"]["root"]
        assert (
            await s.call_tool("space", {"action": "list", "grant_id": gid, "target": other})
        ).isError
        assert (
            await s.call_tool("space", {"action": "trash", "grant_id": gid, "target": fid})
        ).isError
        assert (
            await client.get(BASE + f"/archives/{value['archive_id']}", headers=bob)
        ).status_code == 404
        assert (
            await client.get(BASE + f"/archives/{value['archive_id']}", headers=alice)
        ).status_code == 200
        assert (
            await client.delete(BASE + f"/connections/{aid}/grants/{gid}", headers=alice)
        ).status_code == 200
        assert (await s.call_tool("space_read_text", {"grant_id": gid, "target": fid})).isError
        assert not (await s.call_tool("space_read_text", {"target": fid})).isError
    # This key authenticates without a WANX login cookie/JWT, but cannot survive revocation.
    assert (await client.delete(BASE + f"/connections/{aid}", headers=alice)).status_code == 200
    assert (await client.post(BASE + "/connections", headers=alice, json=body)).status_code == 409
    assert (
        await client.post("/mcp/space", headers={"Authorization": "Bearer " + key}, json={})
    ).status_code == 401
    assert (await client.post("/mcp/space", json={})).status_code == 401
    assert (
        await client.post("/mcp/space", headers={"Origin": "https://evil.invalid"}, json={})
    ).status_code == 403


async def test_readonly_downgrade_account_disable_and_company_sharing(env):
    client, server, admin = env
    bob = await create_user(client, admin, username="mcp_reader")
    aid, key, _ = await issue(client, admin, "company")
    actor = (await client.get("/api/auth/me", headers=admin)).json()["id"]
    authority = SpaceMcp(server.paths.root, actor, "Admin", admin=True)
    root = authority.storage("company").mkdir("", "公司记忆")["id"]
    grant = authority.authorize(aid, "company", root, "output")["id"]
    async with (
        client._octop_app.state.space_mcp.session_manager.run(),
        session(client, key) as s,
    ):
        args = {
            "grant_id": "",
            "operation_id": uuid4().hex,
            "title": "公司合成记录",
            "source": "测试",
            "coverage": "可见测试",
            "sections": [{"title": "项目", "content": "仅测试数据"}],
        }
        result = await s.call_tool("space_archive_memory", args)
        assert not result.isError, result
        rid = result.structuredContent["archive_id"]
        assert (await client.get(BASE + f"/archives/{rid}", headers=bob)).status_code == 200
        authority.authorize(aid, "company", root, "reference")
        denied = await s.call_tool(
            "space_write_text",
            {"grant_id": grant, "operation_id": uuid4().hex, "name": "no.txt", "text": "no"},
        )
        assert denied.isError
    assert (
        await client.get(
            BASE + f"/connections/{aid}/prompt", headers=bob, params={"grant_id": grant}
        )
    ).status_code == 403
    # Key owner is a real normal account; disabling it rejects protocol initialization.
    user_aid, user_key, _ = await issue(client, bob)
    uid = (await client.get("/api/auth/me", headers=bob)).json()["id"]
    assert (
        await client.patch(f"/api/users/{uid}", headers=admin, json={"disabled": True})
    ).status_code == 200
    assert (
        await client.post("/mcp/space", headers={"Authorization": "Bearer " + user_key}, json={})
    ).status_code == 401


async def test_real_tcp_official_javascript_client(env, monkeypatch, tmp_path):
    """Independent JS SDK, real HTTP listener; no desktop broker running."""
    import asyncio
    import os
    import socket
    from pathlib import Path

    import pytest
    import uvicorn

    script = os.environ.get("WANX_MCP_STANDARD_CLIENT")
    if not script or not Path(script).is_file():
        pytest.skip("Set WANX_MCP_STANDARD_CLIENT to independent official JS client script")
    client, server, admin = env
    aid, key, _ = await issue(client, admin)
    gid = ""
    app = client._octop_app
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]
    transport_server = uvicorn.Server(
        uvicorn.Config(app, log_level="critical", access_log=False, lifespan="off")
    )
    async with app.state.space_mcp.session_manager.run():
        task = asyncio.create_task(transport_server.serve(sockets=[sock]))
        try:
            for _ in range(100):
                if transport_server.started:
                    break
                await asyncio.sleep(0.02)
            assert transport_server.started
            process = await asyncio.create_subprocess_exec(
                "node",
                script,
                env={
                    **os.environ,
                    "MCP_TEST_URL": f"http://127.0.0.1:{port}/mcp/space",
                    "MCP_TEST_KEY": key,
                    "MCP_TEST_GRANT": gid,
                },
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out, err = await asyncio.wait_for(process.communicate(), 60)
            assert process.returncode == 0, err.decode()[-3000:]
            assert b"STANDARD_CLIENT_OK" in out
            inspector = os.environ.get("WANX_MCP_INSPECTOR")
            if inspector:
                import json

                config = tmp_path / "mcp-inspector.json"
                config.write_text(
                    json.dumps(
                        {
                            "mcpServers": {
                                "space": {
                                    "url": f"http://127.0.0.1:{port}/mcp/space",
                                    "headers": {"Authorization": "Bearer " + key},
                                }
                            }
                        }
                    )
                )
                config.chmod(0o600)
                process = await asyncio.create_subprocess_exec(
                    "node",
                    inspector,
                    "--cli",
                    "--transport",
                    "http",
                    "--server-url",
                    f"http://127.0.0.1:{port}/mcp/space",
                    "--header",
                    "Authorization: Bearer " + key,
                    "--method",
                    "tools/list",
                    env={**os.environ, "MCP_INSPECTOR_SECRET_STORE": "memory"},
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                out, err = await asyncio.wait_for(process.communicate(), 60)
                assert process.returncode == 0, err.decode()[-2000:]
                assert b"space_archive_memory" in out

        finally:
            transport_server.should_exit = True
            await asyncio.wait_for(task, 10)
            sock.close()


async def test_space_and_starlink_keys_are_independent(env):
    client, server, admin = env
    _, key, _ = await issue(client, admin)
    for url, token in [("/mcp/starlink", key), ("/mcp/space", "xg_" + "a" * 40)]:
        assert (
            await client.post(url, headers={"Authorization": "Bearer " + token}, json={})
        ).status_code == 401


async def test_company_disks_with_two_real_users_admin_and_standard_mcp(env):
    client, _, admin = env
    alice = await create_user(client, admin, username="disk_alice")
    bob = await create_user(client, admin, username="disk_bob")
    aid, key, _ = await issue(client, alice, "company")
    bid, bkey, _ = await issue(client, bob, "company")
    url = BASE + f"/drives/{aid}/files"
    async with client._octop_app.state.space_mcp.session_manager.run(), session(client, key) as s:
        access = (await s.call_tool("space_access", {})).structuredContent
        disk = access["workspace"]
        assert disk["space_id"] != "personal"
        for headers in (alice, bob, admin):
            r = await client.get(BASE + "/drives", headers=headers)
            assert {aid, bid} <= {d["connection_id"] for d in r.json()}
            listing = await client.post(url, headers=headers, json={"action": "list", "params": {}})
            assert listing.status_code == 200
            assert len(listing.json()["items"]) == 4
        for action, params in [
            ("mkdir", {"name": "forged"}),
            ("upload-create", {"id": uuid4().hex, "name": "forged", "size": 1}),
        ]:
            assert (
                await client.post(url, headers=bob, json={"action": action, "params": params})
            ).status_code == 403
        assert (
            await client.post(
                url, headers=admin, json={"action": "mkdir", "params": {"name": "admin manages"}}
            )
        ).status_code == 200
        saved = await s.call_tool(
            "space_write_text", {"operation_id": uuid4().hex, "name": "own.txt", "text": "own disk"}
        )
        assert not saved.isError, saved
        fid = saved.structuredContent["id"]
        async with session(client, bkey) as other:
            assert (await other.call_tool("space_read_text", {"target": fid})).isError
        # Pause fences both the own-disk and supplementary-grant paths.
        assert (
            await client.post(
                BASE + f"/connections/{aid}/manage", headers=admin, json={"action": "pause"}
            )
        ).status_code == 200
        assert (
            await client.post("/mcp/space", headers={"Authorization": "Bearer " + key}, json={})
        ).status_code == 401
        assert (
            await client.post(url, headers=bob, json={"action": "stat", "params": {"id": fid}})
        ).status_code == 200
    # Disabled owner cannot reconnect even with an otherwise-valid key.
    uid = (await client.get("/api/auth/me", headers=alice)).json()["id"]
    await client.post(BASE + f"/connections/{aid}/manage", headers=admin, json={"action": "resume"})
    await client.patch(f"/api/users/{uid}", headers=admin, json={"disabled": True})
    assert (
        await client.post("/mcp/space", headers={"Authorization": "Bearer " + key}, json={})
    ).status_code == 401

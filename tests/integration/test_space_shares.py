"""Real WANX users/storage, anonymous HTTP consumers, no MCP client/configuration."""

import base64
import hashlib
import io
import logging
import secrets
import zipfile
from uuid import uuid4

import pytest

from octop.api.routers.space_shares import RedactShareTokens
from octop.infra.personal_space.mcp_access import SpaceMcp
from octop.infra.personal_space.shares import SpaceShares
from tests.support.auth import create_user

BASE = "/api/_client/space-shares"


def archive_bytes():
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("synthetic.txt", "合成资料")
    return stream.getvalue()


def hub(server, actor):
    return SpaceShares(
        server.paths.root,
        actor.id,
        actor.username,
        admin=actor.role == "admin",
        resolve_user=server.user_manager.get_by_id,
    )


async def make(client, auth, root, **kw):
    body = {"operation_id": uuid4().hex, "root": root, **kw}
    r = await client.post(BASE, headers=auth, json=body)
    assert r.status_code == 200, r.text
    return r.json(), body


async def post(client, url, action, **kw):
    return await client.post(url, json={"action": action, **kw})


async def write(client, url, target, data, *, expected=None, name="测试.txt"):
    uid = uuid4().hex
    common = {"target": target, "upload_id": uid}
    begin = await post(
        client, url, "begin-write", **common, size=len(data), name=name, expected=expected
    )
    assert begin.status_code == 200, begin.text
    chunk = await post(
        client,
        url,
        "write-chunk",
        **common,
        offset=0,
        data=base64.b64encode(data).decode(),
        digest=hashlib.sha256(data).hexdigest(),
    )
    assert chunk.status_code == 200, chunk.text
    result = await post(
        client, url, "commit-write", **common, digest=hashlib.sha256(data).hexdigest()
    )
    assert result.status_code == 200, result.text
    return result.json()


async def setup(env):
    client, server, admin = env
    alice_auth = await create_user(client, admin, username="share_alice")
    bob_auth = await create_user(client, admin, username="share_bob")
    alice = server.user_manager.get("share_alice")
    bob = server.user_manager.get("share_bob")
    store = hub(server, alice).storage("personal")
    root = store.mkdir("", "分享合成目录")["id"]
    return client, server, admin, alice_auth, bob_auth, alice, bob, store, root


async def test_anonymous_http_tree_binary_roundtrip_and_versions(env):
    client, server, admin, auth, _, alice, _, store, root = await setup(env)
    share, body = await make(client, auth, root, permission="write", days=7)
    url = share["path"]
    repeated = await client.post(BASE, headers=auth, json=body)
    assert repeated.json()["path"] == url
    assert len((await client.get(BASE, headers=auth)).json()) == 1
    assert "path" not in (await client.get(BASE, headers=auth)).json()[0]
    assert (await client.get(BASE + "/" + share["id"], headers=auth)).json()["path"] == url
    assert (await client.get(url)).status_code == 200
    assert "text/html" in (await client.get(url)).headers["content-type"]
    desc = (await client.get(url, headers={"Accept": "application/json"})).json()
    assert desc["resource"]["id"] == root and desc["permission"] == "write"
    # A file created AFTER the share is immediately available, without a grant.
    sub = (await post(client, url, "mkdir", parent=root, name="新增子目录")).json()["id"]
    for name, data in [
        ("说明.txt", "合成记忆，不含用户隐私".encode()),
        (
            "图片.png",
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVakAAAAASUVORK5CYII="
            ),
        ),
        ("归档.zip", archive_bytes()),
    ]:
        meta = await write(client, url, sub, data, name=name)
        r = await client.get(url, params={"action": "read", "target": meta["id"]})
        assert (
            r.content == data and r.headers["x-content-sha256"] == hashlib.sha256(data).hexdigest()
        )
        changed = await write(client, url, meta["id"], data + b"-v2", expected=meta["version"])
        assert changed["version"] == meta["version"] + 1
        assert store.metadata(meta["id"])["previous_digest"] == hashlib.sha256(data).hexdigest()
        stale = await post(
            client,
            url,
            "begin-write",
            target=meta["id"],
            expected=meta["version"],
            upload_id=uuid4().hex,
            size=0,
        )
        assert stale.status_code == 409
    assert (
        len(
            (
                await client.get(url, params={"format": "json", "action": "list", "target": sub})
            ).json()["items"]
        )
        == 3
    )
    assert (await client.get(BASE, headers=auth)).json()[0]["last_used"]
    # Recreate request-local objects / clients: no owner JWT is required by the link.
    assert hub(server, alice).token(share["id"]) in url
    assert (await client.get(url + "?format=json")).status_code == 200


@pytest.mark.parametrize("permission", ["read", "write"])
async def test_scope_methods_and_single_file(env, permission):
    client, _, _, auth, _, _, _, store, root = await setup(env)
    other = store.mkdir("", "未分享")["id"]
    share, _ = await make(client, auth, root, permission=permission)
    url = share["path"]
    for action in ["trash", "move", "restore", "purge", "restore-version"]:
        assert (await post(client, url, action, target=root)).status_code == 403
    assert (await client.get(url, params={"action": "stat", "target": other})).status_code == 403
    if permission == "read":
        for action in ["begin-write", "write-chunk", "commit-write", "mkdir", "cancel-write"]:
            assert (await post(client, url, action, target=root)).status_code == 403
    else:
        entry = await write(client, url, root, b"one")
        single, _ = await make(client, auth, entry["id"], permission="write")
        assert (
            await client.get(single["path"], params={"action": "stat", "target": root})
        ).status_code == 403
        await write(client, single["path"], entry["id"], b"two", expected=entry["version"])
        assert (
            await post(client, single["path"], "mkdir", target=entry["id"], name="no")
        ).status_code >= 400


async def test_revocation_expiry_disable_and_upload_commit(env):
    client, server, _, auth, _, alice, _, _, root = await setup(env)
    s, _ = await make(client, auth, root, permission="write")
    uid = uuid4().hex
    assert (
        await post(
            client, s["path"], "begin-write", upload_id=uid, target=root, name="未完成.txt", size=0
        )
    ).status_code == 200
    assert (await client.delete(BASE + "/" + s["id"], headers=auth)).status_code == 200
    assert (
        await post(
            client,
            s["path"],
            "commit-write",
            upload_id=uid,
            target=root,
            digest=hashlib.sha256(b"").hexdigest(),
        )
    ).status_code == 403
    assert (await client.get(s["path"])).status_code == 403
    expired, _ = await make(client, auth, root)
    with hub(server, alice).db() as db:
        db.execute("UPDATE http_shares SET expires=1 WHERE id=?", (expired["id"],))
    assert (await client.get(expired["path"])).status_code == 410
    active, _ = await make(client, auth, root)
    await server.user_manager.disable(alice.username)
    assert (await client.get(active["path"])).status_code == 403


async def test_creator_isolation_and_company_disk_roles(env):
    client, server, admin, auth, bob_auth, alice, bob, _, root = await setup(env)
    share, _ = await make(client, auth, root)
    assert (await client.get(BASE, headers=bob_auth)).json() == []
    assert (await client.get(BASE + "/" + share["id"], headers=bob_auth)).status_code == 404
    assert (await client.delete(BASE + "/" + share["id"], headers=bob_auth)).status_code == 404
    denied = await client.post(
        BASE, headers=bob_auth, json={"operation_id": uuid4().hex, "root": root}
    )
    assert denied.status_code == 404
    # True company dedicated disk owned by Alice, visible to Bob but only owner/admin write.

    mcp = SpaceMcp(server.paths.root, alice.id, "Alice")
    mcp.issue(
        {
            "operation_id": uuid4().hex,
            "credential": secrets.token_urlsafe(32),
            "name": "公司专属盘",
            "destination": "company",
        }
    )
    disk = mcp.drives()[0]
    folder = mcp.storage("company").mkdir(disk["root"], "资料")["id"]
    for h in [auth, bob_auth, admin]:
        s, _ = await make(client, h, folder, domain="company", space_id=disk["id"])
        assert (await client.get(s["path"] + "?format=json")).status_code == 200
    rejected = await client.post(
        BASE,
        headers=bob_auth,
        json={
            "operation_id": uuid4().hex,
            "root": folder,
            "space_id": disk["id"],
            "domain": "company",
            "permission": "write",
        },
    )
    assert rejected.status_code == 403
    for h in [auth, admin]:
        s, _ = await make(
            client, h, folder, domain="company", space_id=disk["id"], permission="write"
        )
        await write(client, s["path"], folder, b"company")
    with mcp.db() as db:
        db.execute("DELETE FROM space_mcp_drives WHERE space_id=?", (disk["id"],))
    assert (await client.get(s["path"])).status_code == 403


async def test_rename_move_trash_and_cross_disk(env):
    client, _, _, auth, _, _, _, store, root = await setup(env)
    share, _ = await make(client, auth, root)
    outer = store.mkdir("", "外层")["id"]
    store.move(root, outer, "新名称")
    assert (await client.get(share["path"] + "?format=json")).json()["resource"]["name"] == "新名称"
    sub = store.mkdir(root, "移出")["id"]
    store.move(sub, outer, "移出")
    assert (
        await client.get(share["path"], params={"action": "stat", "target": sub})
    ).status_code == 403
    store.trash(root)
    assert (await client.get(share["path"])).status_code == 404
    store.restore(root)
    assert (await client.get(share["path"])).status_code == 403
    new_share, _ = await make(client, auth, root)
    disk = store.approve("crossdisk-test", "临时盘")
    store.transfer(root, disk["root"], disk["space_id"])
    store.transfer(root, outer, "personal")
    assert (await client.get(new_share["path"])).status_code == 403


def test_access_log_redacts_capabilities():
    record = logging.LogRecord(
        "uvicorn.access",
        20,
        "",
        1,
        "%s %s %s %s %s",
        ("client", "GET", "/space-links/secret-token?format=json", "1.1", 200),
        None,
    )
    RedactShareTokens().filter(record)
    assert "secret-token" not in record.getMessage()


async def test_read_only_remains_read_only_through_legacy_routes_and_role_change(env):
    client, server, admin, auth, _, alice, _, store, root = await setup(env)
    shared, _ = await make(client, auth, root)
    # A share token is neither a WANX JWT nor an MCP Key.
    token = shared["path"].split("/")[-1]
    assert (
        await client.post(
            "/api/personal-space/folders",
            json={"name": "blocked"},
            headers={"Authorization": "Bearer " + token},
        )
    ).status_code == 401
    assert (
        await client.post(
            "/api/personal-space/agent-access",
            json={"action": "mkdir", "target": root, "name": "blocked"},
            headers={"X-Space-Link": token},
        )
    ).status_code == 401
    # Role checks use the creator's CURRENT role at upload commit.
    company = hub(server, server.user_manager.get_by_id(1)).storage("company")
    folder = company.mkdir("", "公司管理员回写")["id"]
    link, _ = await make(client, admin, folder, domain="company", permission="write")
    uid = uuid4().hex
    assert (
        await post(
            client,
            link["path"],
            "begin-write",
            target=folder,
            upload_id=uid,
            name="待写.txt",
            size=0,
        )
    ).status_code == 200
    admin_user = server.user_manager.get_by_id(1)
    await server.user_manager.set_role(admin_user.username, "user")
    assert (
        await post(
            client,
            link["path"],
            "commit-write",
            target=folder,
            upload_id=uid,
            digest=hashlib.sha256(b"").hexdigest(),
        )
    ).status_code == 403
    assert company.listing(folder)["items"] == []


async def test_box_file_engine_does_not_require_newer_legacy_helper(env, monkeypatch):
    from octop.infra.personal_space.links import SpaceLinks

    monkeypatch.delattr(SpaceLinks, "_creation_target")
    client, _, _, auth, _, _, _, _, root = await setup(env)
    shared, _ = await make(client, auth, root, permission="write")
    response = await post(client, shared["path"], "mkdir", parent=root, name="兼容目录")
    assert response.status_code == 200
    assert (await client.get(shared["path"], params={"format": "json"})).status_code == 200


async def test_remove_inactive_share_keeps_revocation_files_and_owner_boundary(env):
    client, server, admin, auth, bob_auth, alice, _, store, root = await setup(env)
    share, body = await make(client, auth, root, permission="write")
    url, sid = share["path"], share["id"]
    # An active capability must first be explicitly revoked.
    assert (await client.post(BASE + f"/{sid}/dismiss", headers=auth)).status_code == 409
    assert (await client.get(url)).status_code == 200
    for other in (bob_auth, admin):
        assert (await client.post(BASE + f"/{sid}/dismiss", headers=other)).status_code == 404
    assert (await client.delete(BASE + "/" + sid, headers=auth)).status_code == 200
    for _ in range(2):
        assert (await client.post(BASE + f"/{sid}/dismiss", headers=auth)).status_code == 200
    assert (await client.get(BASE, headers=auth)).json() == []
    # A new authority/client observes the removal, but the old token stays denied.
    assert hub(server, alice).list_shares() == []
    assert (await client.get(url)).status_code == 403
    assert store.metadata(root)["kind"] == "folder"
    repeated = await client.post(BASE, headers=auth, json=body)
    assert repeated.json()["state"] == "revoked"
    assert repeated.json()["path"] == url
    assert (await client.get(BASE, headers=auth)).json() == []
    assert (await client.get(url)).status_code == 403


async def test_remove_expired_share_does_not_revive_on_retries(env):
    client, server, _, auth, _, alice, _, store, root = await setup(env)
    share, body = await make(client, auth, root, days=7)
    with hub(server, alice).db() as db:
        db.execute(
            "UPDATE http_shares SET created=?,expires=? WHERE id=?",
            (share["created"] - 8 * 86400, share["created"] - 86400, share["id"]),
        )
    assert (await client.get(share["path"])).status_code == 410
    assert (await client.post(BASE + f"/{share['id']}/dismiss", headers=auth)).status_code == 200
    assert (await client.get(BASE, headers=auth)).json() == []
    assert (await client.get(share["path"])).status_code == 403
    replayed = await client.post(BASE, headers=auth, json=body)
    assert replayed.status_code == 200 and replayed.json()["state"] == "revoked"
    assert (await client.get(share["path"])).status_code == 403
    assert store.metadata(root)["kind"] == "folder"


async def test_previous_share_registry_initializes_cleanup_without_losing_records(env):
    client, server, _, auth, _, alice, _, _, root = await setup(env)
    share, _ = await make(client, auth, root)
    assert (await client.delete(BASE + "/" + share["id"], headers=auth)).status_code == 200
    with hub(server, alice).db() as db:
        db.execute("DROP TABLE http_share_dismissals")
    restored = hub(server, alice)
    records = restored.list_shares()
    assert len(records) == 1 and records[0]["id"] == share["id"]
    assert records[0]["state"] == "revoked"
    restored.dismiss_share(share["id"])
    assert restored.list_shares() == []
    assert (await client.get(share["path"])).status_code == 403

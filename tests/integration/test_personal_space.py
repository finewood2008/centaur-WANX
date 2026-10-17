"""Use real login tokens and the full middleware stack for private files."""

from __future__ import annotations

import hashlib
from typing import Any

from tests.support.auth import TEST_PASSWORD, create_user


async def test_personal_files_are_isolated_by_authenticated_user_and_application(env: Any) -> None:
    client, _server, owner = env
    other = await create_user(client, owner, username="other")
    prefix = "/api/personal-space"
    assert (await client.get(f"{prefix}/files")).status_code == 401
    assert (await client.get(f"{prefix}/overview", headers=owner)).json()["protocolVersion"] == 1
    item_id = "b" * 32
    digest = hashlib.sha256(b"private").hexdigest()
    assert (
        await client.post(
            f"{prefix}/uploads",
            headers=owner,
            json={"id": item_id, "name": "private.txt", "size": 7},
        )
    ).status_code == 200
    assert (
        await client.put(
            f"{prefix}/uploads/{item_id}?offset=0",
            headers={**owner, "x-content-sha256": digest},
            content=b"private",
        )
    ).status_code == 200
    assert (
        await client.post(
            f"{prefix}/uploads/{item_id}/complete", headers=owner, json={"digest": digest}
        )
    ).status_code == 200
    assert (await client.get(f"{prefix}/files", headers=other)).json()["items"] == []
    for suffix in ("", "/content"):
        assert (
            await client.get(f"{prefix}/files/{item_id}{suffix}", headers=other)
        ).status_code == 404
    assert (
        await client.patch(
            f"{prefix}/files/{item_id}", headers=other, json={"parent": "", "name": "stolen.txt"}
        )
    ).status_code == 404
    assert (await client.delete(f"{prefix}/files/{item_id}", headers=other)).status_code == 404
    assert (
        await client.get(f"{prefix}/files/{item_id}/content", headers=owner)
    ).content == b"private"
    login = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": TEST_PASSWORD, "application_id": "zhijun"},
    )
    assert login.status_code == 200
    application = {"Authorization": f"Bearer {login.json()['access_token']}"}
    # v1 shares this same user's drive across applications without per-app grants.
    assert (await client.get(f"{prefix}/files", headers=application)).status_code == 200
    assert (
        await client.get(f"{prefix}/files/{item_id}/content", headers=application)
    ).content == b"private"

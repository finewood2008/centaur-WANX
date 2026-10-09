"""Native channel persistence stays behind the signed private profile scope."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from octop.api.routers import channels
from octop.infra.gateway.gateway import ChannelCreateSpec
from octop.infra.users.identity import User
from tests.integration.test_application_isolation import isolated as _isolation_fixture

isolated = _isolation_fixture


async def test_private_weixin_routes_persist_same_profile_and_never_expose_credentials(
    isolated: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, server, wanx, zhijun, wanx_id, profile_id = isolated
    gw = server.app_runtime.gateway
    monkeypatch.setattr(gw, "_safe_register_channel", AsyncMock())
    result = SimpleNamespace(
        connected=True,
        account_id="private-bot",
        bot_token="PRIVATE-TOKEN",
        base_url="https://ilinkai.weixin.qq.com",
        user_id="own-weixin",
        message="",
    )
    login = SimpleNamespace(
        fetch_qr_code=AsyncMock(
            return_value=SimpleNamespace(
                qrcode="native-token", qrcode_img_content="https://weixin.qq.com/qr"
            )
        ),
        wait_for_login=AsyncMock(return_value=result),
    )
    monkeypatch.setattr(channels, "_get_weixin_qr_login", lambda: lambda: login)
    base = f"/api/agents/{profile_id}/channels"
    for auth, aid in [(wanx, profile_id), (zhijun, wanx_id)]:
        assert (
            await client.post(f"/api/agents/{aid}/channels/weixin/qrcode/generate", headers=auth)
        ).status_code == 404
    qr = (await client.post(base + "/weixin/qrcode/generate", headers=zhijun)).json()
    assert qr["qrcode_token"] != "native-token"
    bound = await client.post(
        base + "/weixin/qrcode/poll", headers=zhijun, json={"qrcode_token": qr["qrcode_token"]}
    )
    assert bound.status_code == 200, bound.text
    data = bound.json()
    cid = data["channel_id"]
    assert data == {"status": "success", "channel_id": cid}
    row = gw.get_channel(cid)
    assert row.agent_id == profile_id
    assert json.loads(row.config_json)["owner_weixin_user_id"] == "own-weixin"
    repeated = await client.post(
        base + "/weixin/qrcode/poll", headers=zhijun, json={"qrcode_token": qr["qrcode_token"]}
    )
    assert repeated.json() == data
    # A fresh QR updates the same native channel name rather than creating another.
    qr2 = (await client.post(base + "/weixin/qrcode/generate", headers=zhijun)).json()
    assert (
        await client.post(
            base + "/weixin/qrcode/poll", headers=zhijun, json={"qrcode_token": qr2["qrcode_token"]}
        )
    ).json()["channel_id"] == cid
    assert len(gw.list_channels(profile_id)) == 1
    detail = await client.get(base + f"/{cid}", headers=zhijun)
    assert "config" not in detail.json() and "PRIVATE-TOKEN" not in detail.text
    assert (
        await client.post(
            base, headers=zhijun, json={"name": "bypass", "kind": "weixin", "config": {}}
        )
    ).status_code == 404
    assert (
        await client.patch(
            base + f"/{cid}", headers=zhijun, json={"config": {"owner_weixin_user_id": "stranger"}}
        )
    ).status_code == 403
    paused = await client.patch(base + f"/{cid}", headers=zhijun, json={"enabled": False})
    assert paused.status_code == 200 and paused.json()["enabled"] is False
    assert gw.get_channel(cid).enabled == 0
    assert (await client.get(f"/api/agents/{wanx_id}/channels", headers=wanx)).json() == []
    schema = client._octop_app.openapi()["paths"][
        base.replace(profile_id, "{agent_id}") + "/weixin/qrcode/poll"
    ]["post"]
    assert (
        schema["summary"]
        and "$ref" in schema["responses"]["200"]["content"]["application/json"]["schema"]
    )


async def test_personal_permission_does_not_grant_host_channel_administration() -> None:
    user = User(1, "personal", "user", None, permissions=[], application_id="zhijun")
    assert await channels._personal_channel_user(user) is user
    from dataclasses import replace

    from octop.infra.errors import OctopError

    with pytest.raises(OctopError):
        await channels._personal_channel_user(replace(user, application_id="wanx"))


async def test_non_weixin_rows_hidden_and_unavailable_even_with_profile_id(
    isolated: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, server, _wanx, zhijun, _wanx_id, profile_id = isolated
    gw = server.app_runtime.gateway
    monkeypatch.setattr(gw, "_safe_register_channel", AsyncMock())
    owner = server.app_runtime.agent_registry.get_row(profile_id).user_id
    row = await gw.create_channel(
        ChannelCreateSpec(
            channel_id="other-channel",
            agent_id=profile_id,
            user_id=owner,
            kind="telegram",
            name="legacy",
            config={},
        )
    )
    base = f"/api/agents/{profile_id}/channels"
    assert (await client.get(base, headers=zhijun)).json() == []
    assert (await client.get(base + f"/{row.channel_id}", headers=zhijun)).status_code == 404
    assert (
        await client.patch(base + f"/{row.channel_id}", headers=zhijun, json={"enabled": True})
    ).status_code == 404

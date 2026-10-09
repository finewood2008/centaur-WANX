"""Private QR credentials and sender filtering precede the native memory pipeline."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from octop_gateway.models import ChannelSubject, InboundMessage, MessageEvent, TextContent

from octop.infra.errors import OctopError
from octop.infra.gateway.channels.zhijun_weixin import (
    ZhijunWeixinBindings,
    assert_weixin_channel,
    private_weixin_processor,
)


def _login(**overrides: object) -> SimpleNamespace:
    result = SimpleNamespace(
        connected=True,
        account_id="bot",
        bot_token="PRIVATE",
        base_url="https://ilinkai.weixin.qq.com",
        user_id="owner",
        message="",
    )
    for key, value in overrides.items():
        setattr(result, key, value)
    return SimpleNamespace(
        fetch_qr_code=AsyncMock(
            return_value=SimpleNamespace(
                qrcode="native-qr", qrcode_img_content="https://weixin.qq.com/qr"
            )
        ),
        wait_for_login=AsyncMock(return_value=result),
    )


async def test_private_login_is_scoped_idempotent_and_keeps_credentials_server_side() -> None:
    gateway = SimpleNamespace(
        create_channel=AsyncMock(return_value=SimpleNamespace(channel_id="saved"))
    )
    broker = ZhijunWeixinBindings(gateway)  # type: ignore[arg-type]
    login = _login()
    qr = await broker.generate("profile", 1, login)
    assert qr["qrcode_token"] != "native-qr"
    for aid, uid in [("wanx", 1), ("profile", 2)]:
        with pytest.raises(OctopError):
            await broker.poll(qr["qrcode_token"], aid, uid)
    responses = await asyncio.gather(
        *(broker.poll(qr["qrcode_token"], "profile", 1) for _ in range(3))
    )
    assert responses == [{"status": "success", "channel_id": "saved"}] * 3
    login.wait_for_login.assert_awaited_once_with("native-qr")
    gateway.create_channel.assert_awaited_once()
    spec = gateway.create_channel.call_args.args[0]
    assert (spec.agent_id, spec.user_id, spec.kind) == ("profile", 1, "weixin")
    assert spec.config["owner_weixin_user_id"] == "owner"
    assert spec.config["accounts"][0]["token"] == "PRIVATE"
    assert "PRIVATE" not in str(responses)


@pytest.mark.parametrize(
    "overrides",
    [
        {"user_id": None},
        {"bot_token": ""},
        {"base_url": "http://localhost"},
        {"base_url": "https://evil.test"},
    ],
)
async def test_incomplete_confirmation_never_binds(overrides: dict[str, object]) -> None:
    gateway = SimpleNamespace(create_channel=AsyncMock())
    broker = ZhijunWeixinBindings(gateway)  # type: ignore[arg-type]
    qr = await broker.generate("profile", 1, _login(**overrides))
    with pytest.raises(OctopError):
        await broker.poll(qr["qrcode_token"], "profile", 1)
    gateway.create_channel.assert_not_called()


async def test_save_failure_can_retry_confirmed_credentials_without_another_scan() -> None:
    gateway = SimpleNamespace(
        create_channel=AsyncMock(
            side_effect=[RuntimeError("write failed"), SimpleNamespace(channel_id="saved")]
        )
    )
    broker = ZhijunWeixinBindings(gateway)  # type: ignore[arg-type]
    login = _login()
    qr = await broker.generate("profile", 1, login)
    with pytest.raises(RuntimeError):
        await broker.poll(qr["qrcode_token"], "profile", 1)
    assert (await broker.poll(qr["qrcode_token"], "profile", 1))["channel_id"] == "saved"
    login.wait_for_login.assert_awaited_once()


async def test_new_qr_invalidates_old_in_flight_confirmation() -> None:
    gateway = SimpleNamespace(create_channel=AsyncMock())
    broker = ZhijunWeixinBindings(gateway)  # type: ignore[arg-type]
    login = _login()
    entered = asyncio.Event()
    finish = asyncio.Event()

    async def wait(_: str) -> object:
        entered.set()
        await finish.wait()
        return _login().wait_for_login.return_value

    login.wait_for_login.side_effect = wait
    old = await broker.generate("profile", 1, login)
    task = asyncio.create_task(broker.poll(old["qrcode_token"], "profile", 1))
    await entered.wait()
    await broker.generate("profile", 1, _login())
    finish.set()
    with pytest.raises(OctopError):
        await task
    gateway.create_channel.assert_not_called()


async def test_expired_or_restart_nonce_requires_new_qr() -> None:
    gateway = SimpleNamespace(create_channel=AsyncMock())
    broker = ZhijunWeixinBindings(gateway)  # type: ignore[arg-type]
    qr = await broker.generate("profile", 1, _login())
    broker.sessions[qr["qrcode_token"]].expires = 0
    with pytest.raises(OctopError):
        await broker.poll(qr["qrcode_token"], "profile", 1)
    with pytest.raises(OctopError):
        await ZhijunWeixinBindings(gateway).poll(qr["qrcode_token"], "profile", 1)  # type: ignore[arg-type]


async def test_strangers_groups_and_cross_profile_messages_never_reach_native_capture() -> None:
    captured: list[InboundMessage] = []

    async def native(message: InboundMessage) -> AsyncIterator[MessageEvent]:
        captured.append(message)
        yield MessageEvent.completed()

    process = private_weixin_processor(native, agent_id="profile", owner_id="owner")
    for subject, tenant, metadata in [
        ("stranger", "profile", {}),
        ("owner", "wanx", {}),
        ("owner", "profile", {"is_group": True}),
    ]:
        message = InboundMessage(
            channel_id="weixin-channel",
            channel_type="weixin",
            tenant_id=tenant,
            channel_subject=ChannelSubject(subject_id=subject),
            session_id=subject,
            content=[TextContent(text="private")],
            metadata=metadata,
        )
        assert [event async for event in process(message)] == []
    assert not captured
    own = InboundMessage(
        channel_id="weixin-channel",
        channel_type="weixin",
        tenant_id="profile",
        channel_subject=ChannelSubject(subject_id="owner"),
        session_id="owner",
        content=[TextContent(text="my experience")],
    )
    assert len([event async for event in process(own)]) == 1
    assert captured == [own]
    with pytest.raises(OctopError):
        private_weixin_processor(native, agent_id="profile", owner_id="")


def test_only_enable_toggle_is_exposed() -> None:
    row = SimpleNamespace(kind="weixin")
    assert_weixin_channel(row, {"enabled"})
    for changes in [{"enabled", "config"}, {"name"}, set()]:
        with pytest.raises(OctopError):
            assert_weixin_channel(row, changes)
    with pytest.raises(OctopError):
        assert_weixin_channel(SimpleNamespace(kind="feishu"))


def test_proactive_recipient_must_still_match_the_current_weixin_binding() -> None:
    from octop.infra.gateway.channels.zhijun_weixin import assert_private_weixin_recipient

    config = {"owner_weixin_user_id": "current-owner"}
    assert_private_weixin_recipient(config, ChannelSubject(subject_id="current-owner"))
    for subject in [
        ChannelSubject(subject_id="previous-owner"),
        ChannelSubject(subject_id="current-owner", chat_type="group"),
    ]:
        with pytest.raises(OctopError):
            assert_private_weixin_recipient(config, subject)

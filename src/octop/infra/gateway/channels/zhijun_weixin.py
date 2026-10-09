"""Owner-bound WeChat login and ingress for a private Zhijun profile."""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

from octop_gateway.models import InboundMessage, MessageEvent

from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.ulid import new_ulid

if TYPE_CHECKING:
    from octop.infra.gateway.gateway import Gateway


@dataclass
class _Login:
    agent_id: str
    user_id: int
    login: Any
    qr: str
    expires: float
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    credentials: Any = None
    channel_id: str | None = None


class ZhijunWeixinBindings:
    """Keep credentials server-side; only a scoped nonce leaves this broker."""

    def __init__(self, gateway: Gateway) -> None:
        self.gateway = gateway
        self.sessions: dict[str, _Login] = {}

    async def generate(self, agent_id: str, user_id: int, login: Any) -> dict[str, Any]:
        result = await login.fetch_qr_code()
        now = time.monotonic()
        self.sessions = {
            key: value
            for key, value in self.sessions.items()
            if value.expires > now and (value.agent_id, value.user_id) != (agent_id, user_id)
        }
        nonce = secrets.token_urlsafe(32)
        self.sessions[nonce] = _Login(agent_id, user_id, login, result.qrcode, now + 300)
        return {"qrcode_token": nonce, "qrcode_url": result.qrcode_img_content}

    def _session(self, nonce: str, agent_id: str, user_id: int) -> _Login:
        state = self.sessions.get(nonce)
        if state is None or (state.agent_id, state.user_id) != (agent_id, user_id):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if state.expires <= time.monotonic():
            del self.sessions[nonce]
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return state

    async def poll(self, nonce: str, agent_id: str, user_id: int) -> dict[str, Any]:
        state = self._session(nonce, agent_id, user_id)
        async with state.lock:
            self._session(nonce, agent_id, user_id)
            if state.channel_id is not None:
                return {"status": "success", "channel_id": state.channel_id}
            if state.credentials is None:
                try:
                    result = await asyncio.wait_for(state.login.wait_for_login(state.qr), 40)
                except TimeoutError:
                    return {"status": "wait"}
                if not result.connected:
                    return {"status": "error", "message": result.message}
                host = urlparse(result.base_url or "")
                if (
                    not result.bot_token
                    or not result.account_id
                    or not result.user_id
                    or host.scheme != "https"
                    or host.hostname != "ilinkai.weixin.qq.com"
                    or host.username
                    or host.password
                    or host.port not in {None, 443}
                ):
                    raise OctopError.localized(ErrorCode.CHANNEL_INVALID_CREDENTIALS)
                state.credentials = result
            # A regenerated QR invalidates an older in-flight confirmation.
            self._session(nonce, agent_id, user_id)
            result = state.credentials
            from octop.infra.gateway.gateway import ChannelCreateSpec

            row = await self.gateway.create_channel(
                ChannelCreateSpec(
                    channel_id=new_ulid(),
                    agent_id=agent_id,
                    user_id=user_id,
                    kind="weixin",
                    name="知君微信",
                    config={
                        "accounts": [
                            {
                                "account_id": result.account_id,
                                "token": result.bot_token,
                                "base_url": result.base_url,
                            }
                        ],
                        "owner_weixin_user_id": result.user_id,
                    },
                )
            )
            state.channel_id = row.channel_id
            return {"status": "success", "channel_id": row.channel_id}


def assert_weixin_channel(row: Any, changes: set[str] | None = None) -> None:
    """Zhijun can toggle its WeChat connection, never rewrite its credentials."""
    if row.kind != "weixin":
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    if changes is not None and changes != {"enabled"}:
        raise OctopError.localized(ErrorCode.FORBIDDEN)


def private_weixin_processor(
    processor: Callable[[InboundMessage], AsyncIterator[MessageEvent]],
    *,
    agent_id: str,
    owner_id: str,
    binding_check: Callable[[InboundMessage], bool] | None = None,
) -> Callable[[InboundMessage], AsyncIterator[MessageEvent]]:
    """Reject other contacts before history, memory capture, slash commands or inference."""
    if not owner_id:
        raise OctopError.localized(ErrorCode.CHANNEL_INVALID_CREDENTIALS)

    async def process(message: InboundMessage) -> AsyncIterator[MessageEvent]:
        if not accepts_private_weixin(message, agent_id=agent_id, owner_id=owner_id):
            return
        if binding_check is not None and not binding_check(message):
            return
        async for event in processor(message):
            yield event

    return process


def accepts_private_weixin(message: Any, *, agent_id: str, owner_id: str) -> bool:
    subject = getattr(message, "channel_subject", None)
    metadata = getattr(message, "metadata", {}) or {}
    return bool(
        owner_id
        and message.tenant_id == agent_id
        and message.channel_type == "weixin"
        and subject is not None
        and subject.subject_id == owner_id
        and getattr(subject, "chat_type", None) != "group"
        and not metadata.get("is_group")
        and metadata.get("chat_type") != "group"
    )


def assert_private_weixin_recipient(config: dict[str, Any], subject: Any) -> None:
    owner = config.get("owner_weixin_user_id")
    if not owner or subject.subject_id != owner or subject.chat_type == "group":
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    accounts = config.get("accounts")
    if isinstance(accounts, list) and accounts:
        metadata = subject.metadata or {}
        account = metadata.get("account_id")
        if (
            not account
            or not any(isinstance(a, dict) and a.get("account_id") == account for a in accounts)
            or str(metadata.get("from_user_id") or metadata.get("ilink_user_id") or "") != owner
        ):
            raise OctopError.localized(ErrorCode.FORBIDDEN)

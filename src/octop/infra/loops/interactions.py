"""Owner-verified channel ingress and durable Loop notifications over WANX Gateway."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import secrets
import time
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any, Literal

from octop_gateway.models import ChannelSubject, InboundMessage
from pydantic import ValidationError

from octop.i18n import tr
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.channels import owner_proof
from octop.infra.gateway.process.message_keys import chat_type_from_message, sanitize_im_metadata
from octop.infra.loops.models import ApprovalBody, JudgmentBody
from octop.infra.utils.locale import Locale, resolve_user_locale
from octop.infra.utils.ulid import new_ulid

if TYPE_CHECKING:
    from octop.infra.loops.service import LoopService


_locale: ContextVar[Locale] = ContextVar("loop_channel_locale", default="zh")


def _text(key: str, **values: Any) -> str:
    return tr("loops." + key, _locale.get(), **values)


def _status(value: str) -> str:
    return _text(
        {"paused": "paused_state", "completed": "completed_state", "stopped": "stopped_state"}.get(
            value, value
        )
    )


def fingerprint(row: Any) -> str:
    return hashlib.sha256((row.kind + ":" + row.config_json).encode()).hexdigest()


class LoopInteractions:
    def __init__(self, service: LoopService):
        self.service = service
        self.worker: asyncio.Task[None] | None = None

    async def boot(self) -> None:
        await self.service._db(self.service.repos.loop_repo.recover_notifications)
        self.service.gateway.processor.loop_message_interceptor = self.handle_inbound
        self.worker = asyncio.create_task(self._worker())

    async def shutdown(self) -> None:
        self.service.gateway.processor.loop_message_interceptor = None
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
            self.worker = None

    async def _channel(self, uid: int, aid: str, cid: str) -> Any:
        await self.service._db(self.service._assert_owner, uid, aid)
        user = await self.service._db(self.service.repos.user_repo.get, uid)
        channel = await self.service._db(self.service.repos.channel_repo.get, cid)
        if (
            not user
            or (user.role != "admin" and "channels" not in user.permissions)
            or not channel
            or (channel.user_id, channel.agent_id) != (uid, aid)
            or not channel.enabled
        ):
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        return channel

    async def list_bindings(self, uid: int) -> list[dict[str, Any]]:
        rows = await self.service._db(self.service.repos.loop_repo.bindings, uid)
        result = []
        for row in rows:
            public = {
                k: v
                for k, v in row.items()
                if k not in {"challenge_hash", "routing_json", "fingerprint"}
            }
            if row["status"].startswith("awaiting_") and row["expires_at"] <= time.time():
                public["status"] = "expired"
            elif row["status"] == "active":
                try:
                    await self.require_binding(uid, row["agent_id"], row["binding_id"])
                except OctopError:
                    public["status"] = "invalid"
            if public["status"] == "awaiting_confirmation":
                public["message_preview"] = json.loads(row["routing_json"]).get(
                    "_loop_pairing_preview", ""
                )
            result.append(public)
        return result

    async def create_binding(
        self, uid: int, aid: str, cid: str, proof: str | None = None
    ) -> dict[str, Any]:
        row = await self._channel(uid, aid, cid)
        subject = (
            owner_proof.consume(proof, uid, aid, row.kind, json.loads(row.config_json))
            if proof
            else None
        )
        if proof and not subject:
            raise OctopError(ErrorCode.LOOP_INVALID, "扫码已过期或账号不匹配，请重新连接。")
        if subject:
            bindings = await self.service._db(self.service.repos.loop_repo.bindings, uid)
            for binding in bindings:
                if (
                    binding["channel_id"] == cid
                    and binding["subject_id"] == subject
                    and binding["status"] in {"active", "invalid"}
                    and binding["confirmed_at"]
                ):
                    await self.service._db(
                        self.service.repos.loop_repo.binding_refresh_transport,
                        binding["binding_id"],
                        uid,
                        fingerprint(row),
                    )
                    return {"binding_id": binding["binding_id"], "status": "active"}
            bid = new_ulid()
            await self.service._db(
                self.service.repos.loop_repo.binding_create,
                {
                    "binding_id": bid,
                    "user_id": uid,
                    "agent_id": aid,
                    "channel_id": cid,
                    "fingerprint": fingerprint(row),
                    "challenge_hash": "",
                    "expires_at": int(time.time()) + 300,
                    "created_at": int(time.time()),
                },
            )
            await self.service._db(
                self.service.repos.loop_repo.binding_receive, bid, subject, subject, {}, True
            )
            return {"binding_id": bid, "status": "active"}
        bindings = await self.service._db(self.service.repos.loop_repo.bindings, uid)
        for binding in bindings:
            if binding["channel_id"] != cid:
                continue
            try:
                await self.require_binding(uid, aid, binding["binding_id"])
                return {"binding_id": binding["binding_id"], "status": "active"}
            except OctopError:
                continue
        code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
        data = {
            "binding_id": new_ulid(),
            "user_id": uid,
            "agent_id": aid,
            "channel_id": cid,
            "fingerprint": fingerprint(row),
            "challenge_hash": "message:" + hashlib.sha256(code.encode()).hexdigest(),
            "expires_at": int(time.time()) + 300,
            "created_at": int(time.time()),
        }
        await self.service._db(self.service.repos.loop_repo.binding_create, data)
        return {
            "binding_id": data["binding_id"],
            "code": code,
            "expires_at": data["expires_at"],
            "status": "awaiting_message",
        }

    async def require_binding(self, uid: int, aid: str, bid: str) -> dict[str, Any]:
        await self.service._db(self.service._assert_owner, uid, aid)
        rows = await self.service._db(self.service.repos.loop_repo.bindings, uid)
        row = next((r for r in rows if r["binding_id"] == bid), None)
        if not row:
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        channel = await self._channel(uid, row["agent_id"], row["channel_id"])
        if (
            row["status"] != "active"
            or not row["subject_id"]
            or fingerprint(channel) != row["fingerprint"]
        ):
            raise OctopError.localized(ErrorCode.LOOP_CHANNEL_INVALID)
        return dict(row)

    async def confirm_binding(self, uid: int, bid: str) -> dict[str, Any]:
        rows = await self.service._db(self.service.repos.loop_repo.bindings, uid)
        row = next((r for r in rows if r["binding_id"] == bid), None)
        if not row:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        channel = await self._channel(uid, row["agent_id"], row["channel_id"])
        if fingerprint(channel) != row["fingerprint"] or not await self.service._db(
            self.service.repos.loop_repo.binding_confirm, bid, uid
        ):
            raise OctopError.localized(ErrorCode.LOOP_CONFLICT)
        return {"binding_id": bid, "status": "active"}

    async def revoke_binding(self, uid: int, bid: str) -> None:
        rows = await self.service._db(self.service.repos.loop_repo.bindings, uid)
        if not any(r["binding_id"] == bid for r in rows):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        await self.service._db(self.service.repos.loop_repo.binding_revoke, bid, uid)

    async def notify_state(self, lid: str, event: str) -> None:
        loop = await self.service._db(self.service.repos.loop_repo.get, lid)
        if not loop:
            return
        locale = await self.service._db(
            resolve_user_locale, user_repo=self.service.repos.user_repo, user_id=loop["user_id"]
        )
        token = _locale.set(locale)
        try:
            await self._notify_state(lid, event)
        finally:
            _locale.reset(token)

    async def _notify_state(self, lid: str, event: str) -> None:
        row = await self.service._db(self.service.repos.loop_repo.get, lid)
        if not row or not row["definition"].get("channel_binding_id"):
            return
        if row["status"] not in {"awaiting_judgment", "awaiting_approval", "completed", "paused"}:
            return
        if row["status"] == "paused" and row["reason"] in {
            "user_paused",
            "round_limit",
            "judgment_configuration_required",
        }:
            return
        judgments = await self.service._db(self.service.repos.loop_repo.judgments, lid)
        pending = next((j for j in judgments if j["status"] == "pending"), None)
        reference = {"status": row["status"], "reason": row["reason"]}
        if pending:
            event = "judgment:" + pending["judgment_id"]
            reference["judgment_id"] = pending["judgment_id"]
        message = _text(
            "notification",
            name=row["definition"]["name"],
            lid=lid,
            status=_status(row["status"]),
            summary=row["progress"].get("summary", ""),
        )
        if pending:
            message += _text(
                "judgment_details",
                code=pending["code"],
                kind=_text(pending["kind"]),
                question=pending["payload"].get("question", ""),
                next_action=pending["payload"].get("next_action", ""),
                evidence="; ".join(pending["payload"].get("evidence", [])),
            )
            message += self.judgment_menu(pending)
        elif row["status"] == "awaiting_approval":
            rounds = await self.service._db(self.service.repos.loop_repo.rounds, lid)
            native = next((r for r in rounds if r["status"] == "awaiting_approval"), None)
            if native:
                event = "native:" + self.native_ticket(native)
                reference["native_ticket"] = self.native_ticket(native)
                message += _text("native_ticket", ticket=self.native_ticket(native))
                for index, action in enumerate(
                    native["pending"]["request"].get("action_requests", [])
                ):
                    message += f"\n{index + 1}. {action['name']} {json.dumps(action.get('args', {}), ensure_ascii=False)}"
                actions = native["pending"]["request"].get("action_requests", [])
                if len(actions) == 1:
                    message += _text(
                        "simple_question_hint"
                        if actions[0]["name"] == "ask_user_question"
                        else "simple_native_hint"
                    )
                message += _text("native_hint")
        await self.service._db(
            self.service.repos.loop_repo.notify,
            new_ulid(),
            lid,
            row["definition"]["channel_binding_id"],
            event + ":" + row["status"],
            message[:16000],
            reference,
        )

    async def notify_decision(self, lid: str, jid: str) -> None:
        row = await self.service._db(self.service.repos.loop_repo.get, lid)
        if not row or not row["definition"].get("channel_binding_id"):
            return
        judgments = await self.service._db(self.service.repos.loop_repo.judgments, lid)
        judgment = next(
            (j for j in judgments if j["judgment_id"] == jid and j["status"] == "resolved"), None
        )
        if not judgment or judgment["version"] != row["version"]:
            return
        locale = await self.service._db(
            resolve_user_locale, user_repo=self.service.repos.user_repo, user_id=row["user_id"]
        )
        message = tr(
            "loops.resolution",
            locale,
            name=row["definition"]["name"],
            code=judgment["code"],
            action=tr("loops.decision_" + judgment["decision"]["action"], locale),
        )
        await self.service._db(
            self.service.repos.loop_repo.notify,
            new_ulid(),
            lid,
            row["definition"]["channel_binding_id"],
            "resolved:" + jid,
            message,
        )

    async def deliver_due(self) -> None:
        rows = await self.service._db(self.service.repos.loop_repo.notifications, due=True)
        for row in rows:
            if not await self.service._db(
                self.service.repos.loop_repo.notification_claim, row["notification_id"]
            ):
                continue
            attempted = False
            try:
                loop = await self.service._db(self.service.repos.loop_repo.get, row["loop_id"])
                if not loop or loop["definition"].get("channel_binding_id") != row["binding_id"]:
                    raise OctopError.localized(ErrorCode.FORBIDDEN)
                reference = json.loads(row["reference_json"])
                stale = (
                    loop["status"] == "deleted"
                    or reference.get("status")
                    and (
                        loop["status"] != reference["status"]
                        or loop["reason"] != reference.get("reason")
                    )
                )
                if reference.get("delivery_round"):
                    rounds = await self.service._db(
                        self.service.repos.loop_repo.rounds, loop["loop_id"]
                    )
                    stale = (
                        stale
                        or loop["status"] in {"stopped", "deleted"}
                        or not any(
                            r["round_id"] == reference["delivery_round"]
                            and r["version"] == loop["version"]
                            and r["status"] == "ok"
                            for r in rounds
                        )
                    )
                if reference.get("judgment_id"):
                    judgments = await self.service._db(
                        self.service.repos.loop_repo.judgments, loop["loop_id"]
                    )
                    stale = stale or not any(
                        j["status"] == "pending" and j["judgment_id"] == reference["judgment_id"]
                        for j in judgments
                    )
                if reference.get("native_ticket"):
                    rounds = await self.service._db(
                        self.service.repos.loop_repo.rounds, loop["loop_id"]
                    )
                    stale = stale or not any(
                        r["status"] == "awaiting_approval"
                        and self.native_ticket(r) == reference["native_ticket"]
                        for r in rounds
                    )
                if stale:
                    await self.service._db(
                        self.service.repos.loop_repo.notification_finish,
                        row["notification_id"],
                        "cancelled",
                        "superseded",
                    )
                    continue
                binding = await self.require_binding(
                    loop["user_id"], loop["definition"]["agent_id"], row["binding_id"]
                )
                channel = await self._channel(
                    loop["user_id"], binding["agent_id"], binding["channel_id"]
                )
                if fingerprint(channel) != binding["fingerprint"]:
                    raise OctopError.localized(ErrorCode.FORBIDDEN)
                manager = self.service.gateway.channel_manager
                if manager is None or manager.get_channel(channel.channel_id) is None:
                    raise ConnectionError("channel_unavailable")
                attempted = True
                await self.service.gateway.push_text(
                    channel.kind,
                    channel.channel_id,
                    ChannelSubject(
                        subject_id=binding["subject_id"],
                        chat_type="dm",
                        metadata=json.loads(binding["routing_json"] or "{}"),
                    ),
                    row["message"],
                )
                await self.service._db(
                    self.service.repos.loop_repo.notification_finish, row["notification_id"], "sent"
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                retry = not attempted and row["attempts"] < 2
                await self.service._db(
                    self.service.repos.loop_repo.notification_finish,
                    row["notification_id"],
                    "queued" if retry else "uncertain" if attempted else "error",
                    "delivery_uncertain" if attempted else "channel_unavailable",
                    30 * (row["attempts"] + 1),
                )

    async def _worker(self) -> None:
        while True:
            try:
                await self.deliver_due()
            except Exception:
                logging.getLogger(__name__).exception("Loop notification worker failed")
            await asyncio.sleep(5)

    async def handle_inbound(self, msg: InboundMessage) -> str | None:
        channel = await self.service._db(self.service.repos.channel_repo.get, msg.channel_id)
        locale = await self.service._db(
            resolve_user_locale,
            user_repo=self.service.repos.user_repo,
            user_id=channel.user_id if channel else 0,
            channel_type=msg.channel_type,
        )
        token = _locale.set(locale)
        try:
            return await self._handle_inbound(msg)
        finally:
            _locale.reset(token)

    async def _handle_inbound(self, msg: InboundMessage) -> str | None:
        if msg.channel_type in {"dashboard", "cli"}:
            return None
        text = msg.text.strip()
        rows = await self.service._db(self.service.repos.loop_repo.bindings)
        rows = [
            r for r in rows if r["channel_id"] == msg.channel_id and r["agent_id"] == msg.tenant_id
        ]
        pending = next(
            (
                r
                for r in rows
                if r["status"] in {"awaiting_message", "awaiting_confirmation"}
                and r["challenge_hash"].startswith("message:")
                and r["expires_at"] > time.time()
            ),
            None,
        )
        if pending:
            if (
                chat_type_from_message(msg) != "dm"
                or not msg.channel_subject
                or not msg.channel_subject.subject_id
                or msg.channel_subject.chat_type not in {"", "dm", "single"}
            ):
                return _text("private_only")
            channel = await self._channel(pending["user_id"], pending["agent_id"], msg.channel_id)
            if (
                fingerprint(channel) != pending["fingerprint"]
                or msg.timestamp < pending["created_at"]
            ):
                return _text("invalid_code")
            if pending["status"] == "awaiting_confirmation":
                return _text("confirm_in_app")
            routing = sanitize_im_metadata(msg)
            routing["_loop_pairing_preview"] = text[:300] or "[收到一条消息]"
            received = await self.service._db(
                self.service.repos.loop_repo.binding_receive,
                pending["binding_id"],
                msg.channel_subject.subject_id,
                msg.channel_subject.display_name or msg.channel_subject.subject_id,
                routing,
            )
            return _text("confirm_in_app") if received else _text("invalid_code")
        explicit = text.startswith("/loop ")
        if explicit:
            text = text[6:].strip()
        match = re.fullmatch(
            r"(配对|绑定|进展|待处理|继续|反馈|完成|暂停|结束|批准|拒绝|回答|调整|允许|确认完成|按建议继续)(?:[\s:：]+(.*))?",
            text,
            re.S,
        )
        if text.casefold() in {
            "好",
            "好的",
            "可以",
            "行",
            "同意",
            "嗯",
            "ok",
            "yes",
            "是",
            "不行",
            "等下",
        }:
            action, argument = "澄清", ""
        elif re.match(r"^\d(?:[\s:：]|H\d|$)", text):
            action, argument = "选择", text
        elif re.fullmatch(r"[ABC](?:\s+H\d+)?", text, re.I):
            action, argument = "回答选项", text.upper()
        elif match:
            action, argument = match[1], (match[2] or "").strip()
            action = {"调整": "反馈", "允许": "批准", "确认完成": "完成", "按建议继续": "继续"}.get(
                action, action
            )
        else:
            return None
        rows = await self.service._db(self.service.repos.loop_repo.bindings)
        rows = [
            r for r in rows if r["channel_id"] == msg.channel_id and r["agent_id"] == msg.tenant_id
        ]
        if not rows and not explicit:
            return None
        if (
            chat_type_from_message(msg) != "dm"
            or not msg.channel_subject
            or not msg.channel_subject.subject_id
            or msg.channel_subject.chat_type not in {"", "dm", "single"}
        ):
            return _text("private_only")
        if action in {"绑定", "配对"}:
            digest = hashlib.sha256(argument.upper().encode()).hexdigest()
            candidate = next(
                (r for r in rows if secrets.compare_digest(r["challenge_hash"], digest)), None
            )
            if candidate:
                try:
                    channel = await self._channel(
                        candidate["user_id"], candidate["agent_id"], msg.channel_id
                    )
                    if fingerprint(channel) == candidate["fingerprint"] and await self.service._db(
                        self.service.repos.loop_repo.binding_receive,
                        candidate["binding_id"],
                        msg.channel_subject.subject_id,
                        msg.channel_subject.display_name or msg.channel_subject.subject_id,
                        sanitize_im_metadata(msg),
                    ):
                        return _text("confirm_in_app")
                except OctopError:
                    pass
            return _text("invalid_code")
        binding = next(
            (
                r
                for r in rows
                if r["status"] == "active" and r["subject_id"] == msg.channel_subject.subject_id
            ),
            None,
        )
        if not binding:
            return _text("bind_first")
        try:
            await self.require_binding(
                binding["user_id"], binding["agent_id"], binding["binding_id"]
            )
            loops = await self.service.list_loops(binding["user_id"])
            loops = [
                item
                for item in loops
                if item["definition"].get("channel_binding_id") == binding["binding_id"]
            ]
            if action == "澄清":
                waiting = [
                    item
                    for item in loops
                    if item.get("pending_judgment") or item["status"] == "awaiting_approval"
                ]
                if not waiting:
                    return None
                return (
                    _text("ambiguous")
                    + "\n"
                    + "\n".join(
                        item["definition"]["name"]
                        + (
                            self.judgment_menu(item["pending_judgment"])
                            if item.get("pending_judgment")
                            else _text("native_format")
                        )
                        for item in waiting
                    )
                )
            if action in {"进展", "待处理"}:
                chosen = [item for item in loops if not argument or item["loop_id"] == argument]
                if action == "待处理":
                    chosen = [
                        item
                        for item in chosen
                        if item.get("pending_judgment") or item["status"] == "awaiting_approval"
                    ]
                return "\n\n".join(
                    f"{item['definition']['name']} | {item['loop_id']}\n{_status(item['status'])}: {item['progress'].get('summary', '')}\n"
                    + (
                        _text("pending_ticket", code=item["pending_judgment"]["code"])
                        + self.judgment_menu(item["pending_judgment"])
                        if item.get("pending_judgment")
                        else ""
                    )
                    for item in chosen
                ) or _text("no_loops")
            if action == "选择":
                return await self._choice_reply(loops, binding["user_id"], argument)
            if action == "回答选项":
                return await self._answer_choice_reply(loops, binding["user_id"], argument)
            if action in {"暂停", "结束"}:
                chosen = (
                    [item for item in loops if item["loop_id"] == argument] if argument else loops
                )
                if len(chosen) != 1:
                    return _text("choose_loop")
                await self.service.control(
                    chosen[0]["loop_id"],
                    binding["user_id"],
                    "pause" if action == "暂停" else "stop",
                )
                return _text("paused") if action == "暂停" else _text("stopped")
            if action in {"批准", "拒绝", "回答"}:
                return await self._native_reply(loops, binding["user_id"], action, argument)
            ticket = re.match(r"^(H\d+)(?:[\s:：]+(.*))?$", argument, re.S)
            choices = [
                item
                for item in loops
                if item.get("pending_judgment")
                and (not ticket or item["pending_judgment"]["code"] == ticket[1])
            ]
            if len(choices) != 1:
                return _text("choose_ticket")
            loop = choices[0]
            feedback = (ticket[2] or "") if ticket else argument
            if action != "反馈" and feedback:
                return _text("ambiguous")
            if action == "反馈" and not feedback.strip():
                return _text("adjust_hint", code=loop["pending_judgment"]["code"])
            await self.service.judge(
                loop["loop_id"],
                binding["user_id"],
                JudgmentBody.model_validate(
                    {
                        "judgment_id": loop["pending_judgment"]["judgment_id"],
                        "action": {"继续": "continue", "反馈": "feedback", "完成": "complete"}[
                            action
                        ],
                        "feedback": feedback,
                    }
                ),
            )
            return _text("recorded") + (
                _text("completed") if action == "完成" else _text("continuing")
            )
        except (OctopError, ValidationError):
            return _text("cannot_decide")

    @staticmethod
    def judgment_menu(judgment: dict[str, Any]) -> str:
        choices = judgment["payload"].get("choices", [])
        if judgment["kind"] == "input" and choices:
            return _text(
                "answer_choices",
                choices="\n".join(f"{chr(65 + i)} {value}" for i, value in enumerate(choices)),
                code=judgment["code"],
            )
        return _text(
            "choice_"
            + (judgment["kind"] if judgment["kind"] in {"final", "input"} else "continue"),
            code=judgment["code"],
        )

    async def _answer_choice_reply(self, loops: list[dict[str, Any]], uid: int, text: str) -> str:
        match = re.fullmatch(r"([ABC])(?:\s+(H\d+))?", text)
        if not match:
            return _text("ambiguous")
        waiting = [
            item
            for item in loops
            if item.get("pending_judgment") or item["status"] == "awaiting_approval"
        ]
        chosen = [
            item
            for item in waiting
            if item.get("pending_judgment")
            and item["pending_judgment"]["kind"] == "input"
            and (not match[2] or item["pending_judgment"]["code"] == match[2])
        ]
        if len(chosen) != 1 or (not match[2] and len(waiting) != 1):
            return _text("choose_ticket")
        loop = chosen[0]
        judgment = loop["pending_judgment"]
        choices = judgment["payload"].get("choices", [])
        index = ord(match[1]) - 65
        if index >= len(choices):
            return _text("ambiguous")
        await self.service.judge(
            loop["loop_id"],
            uid,
            JudgmentBody(
                judgment_id=judgment["judgment_id"], action="feedback", feedback=choices[index]
            ),
        )
        return _text("recorded") + _text("continuing")

    async def _choice_reply(self, loops: list[dict[str, Any]], uid: int, text: str) -> str:
        # Numbers select business judgments only. They can never authorize a tool.
        match = re.fullmatch(r"([123])(?:\s+(H\d+))?(?:[：:]\s*(.*))?", text, re.S)
        if not match:
            return _text("ambiguous")
        option, code, feedback = match[1], match[2], (match[3] or "").strip()
        waiting = [
            item
            for item in loops
            if item.get("pending_judgment") or item["status"] == "awaiting_approval"
        ]
        choices = [
            item
            for item in waiting
            if item.get("pending_judgment")
            and (not code or item["pending_judgment"]["code"] == code)
        ]
        if len(choices) != 1 or (not code and len(waiting) != 1):
            return (
                _text("choose_ticket")
                + "\n"
                + "\n".join(
                    item["definition"]["name"] + " · " + item["pending_judgment"]["code"]
                    for item in waiting
                    if item.get("pending_judgment")
                )
            )
        loop = choices[0]
        judgment = loop["pending_judgment"]
        if option != "2" and feedback:
            return _text("ambiguous")
        if option == "3":
            await self.service.control(loop["loop_id"], uid, "pause")
            return _text("paused")
        if option == "2" and not feedback:
            return _text("adjust_hint", code=judgment["code"])
        if option == "1" and judgment["kind"] == "input":
            return _text("adjust_hint", code=judgment["code"])
        action: Literal["feedback", "complete", "continue"] = (
            "feedback"
            if option == "2"
            else ("complete" if judgment["kind"] == "final" else "continue")
        )
        await self.service.judge(
            loop["loop_id"],
            uid,
            JudgmentBody(
                judgment_id=judgment["judgment_id"],
                action=action,
                feedback=feedback,
            ),
        )
        return _text("recorded") + _text("completed" if action == "complete" else "continuing")

    async def _native_reply(
        self, loops: list[dict[str, Any]], uid: int, action: str, argument: str
    ) -> str:
        parsed = re.fullmatch(r"T([A-Za-z0-9_-]+)\s+(\d+)(?:\s+(.*))?", argument, re.S)
        if not parsed:
            # Omitted tickets are safe only for one waiting loop and one unhandled item.
            waiting = [
                item
                for item in loops
                if item.get("pending_judgment") or item["status"] == "awaiting_approval"
            ]
            if (
                len(waiting) != 1
                or waiting[0]["status"] != "awaiting_approval"
                or argument.startswith("T")
            ):
                return _text("native_format")
            rounds = await self.service.rounds(waiting[0]["loop_id"], uid)
            row = next((r for r in rounds if r["status"] == "awaiting_approval"), None)
            if not row:
                return _text("no_approval")
            pending = row["pending"]
            remaining = [
                i
                for i in range(len(pending["request"].get("action_requests", [])))
                if str(i) not in pending.get("collected", {})
            ]
            if len(remaining) != 1:
                return _text("native_format")
            if action == "批准" and argument:
                return _text("ambiguous")
            content = argument or (_text("user_rejected") if action == "拒绝" else "")
            argument = f"{self.native_ticket(row)} {remaining[0] + 1}" + (
                f" {content}" if content else ""
            )
            return await self._native_reply(loops, uid, action, argument)
        for loop in loops:
            if loop["status"] != "awaiting_approval":
                continue
            rounds = await self.service.rounds(loop["loop_id"], uid)
            row = next(
                (
                    r
                    for r in rounds
                    if r["status"] == "awaiting_approval"
                    and self.native_ticket(r) == "T" + parsed[1]
                ),
                None,
            )
            if not row:
                continue
            pending = row["pending"]
            actions = pending["request"].get("action_requests", [])
            index = int(parsed[2]) - 1
            if (
                index < 0
                or index >= len(actions)
                or (action == "回答") != (actions[index]["name"] == "ask_user_question")
            ):
                return _text("wrong_item")
            decision = {"type": {"批准": "approve", "拒绝": "reject", "回答": "respond"}[action]}
            if action != "批准":
                if not (parsed[3] or "").strip():
                    return _text("need_content")
                decision["message"] = parsed[3]
            if time.time() > pending.get("expires_at", 0):
                await self.service._db(
                    self.service.repos.loop_repo.transition,
                    loop["loop_id"],
                    loop["version"],
                    ("awaiting_approval",),
                    status="paused",
                    reason="execution_unknown",
                    enabled=0,
                    next_run_at=None,
                )
                await self.notify_state(loop["loop_id"], "expired:" + self.native_ticket(row))
                return _text("expired_approval")
            configs = pending["request"].get("review_configs") or []
            config = next((c for c in configs if c["action_name"] == actions[index]["name"]), None)
            if config and decision["type"] not in config["allowed_decisions"]:
                return _text("unsupported_decision")
            updated = await self.service._db(
                self.service.repos.loop_repo.collect_approval,
                row["round_id"],
                pending["checkpoint_id"],
                index,
                decision,
            )
            if not updated:
                return _text("already_handled")
            collected = updated["collected"]
            if len(collected) == len(actions):
                await self.service.approve(
                    loop["loop_id"],
                    uid,
                    ApprovalBody(
                        round_id=row["round_id"],
                        checkpoint_id=updated["checkpoint_id"],
                        decisions=[collected[str(i)] for i in range(len(actions))],
                    ),
                )
                return _text("resume_same_round")
            return _text(
                "partial_approval", index=index + 1, remaining=len(actions) - len(collected)
            )
        return _text("no_approval")

    @staticmethod
    def native_ticket(row: dict[str, Any]) -> str:
        suffix = hashlib.sha256(row["pending"]["checkpoint_id"].encode()).hexdigest()[:12]
        return "T" + str(row["round_id"]) + "-" + suffix

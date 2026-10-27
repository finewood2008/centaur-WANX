"""Durability, goal evidence, approvals, limits and native task takeover."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from langchain_core.messages import ToolMessage
from pydantic import ValidationError

from octop.config import OctopConfig
from octop.infra.cron.delivery import CronDeliveryService
from octop.infra.cron.manager import CronCreateSpec, CronManager
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.errors import OctopError
from octop.infra.gateway.channels import owner_proof
from octop.infra.history.projection import TurnHistoryTracker
from octop.infra.loops.boundary import LoopBoundary, LoopScope, loop_scope
from octop.infra.loops.models import ApprovalBody, JudgmentBody, LoopDefinition
from octop.infra.loops.service import LoopService
from octop.infra.utils.paths import PathLayout


@pytest.fixture
def env(tmp_path):
    db = SqlitePool(tmp_path / "db.sqlite")
    run_migrations(db)
    services = build_shared_services(db=db, paths=PathLayout(tmp_path), config=OctopConfig())
    repos = services.repos
    uid = repos.user_repo.create(username="alice", password_hash="x", role="user")
    repos.agent_repo.create(agent_id="expert", user_id=uid, name="Expert")
    agents = MagicMock()
    agents.validate_mcp_servers.return_value = []
    agents.prepare_chat_mcp = AsyncMock(return_value=[])
    graph = SimpleNamespace(
        aget_state=AsyncMock(
            return_value=SimpleNamespace(
                config={"configurable": {"checkpoint_id": "checkpoint-1"}}, next=("tools",)
            )
        )
    )
    agents.get_agent.return_value = SimpleNamespace(
        graph=graph,
        workspace=SimpleNamespace(als=AsyncMock(return_value=[])),
        config=SimpleNamespace(tools_disabled=frozenset()),
    )

    async def stream(_aid, _request, *_decisions, user_id=None):
        if _decisions:
            assert user_id == uid
        yield {
            "type": "token",
            "content": json.dumps(
                {
                    "outcome": "complete",
                    "summary": "A result",
                    "next_action": "",
                    "evidence": [],
                    "question": "",
                }
            ),
        }

    agents.stream = stream
    agents.resume_hitl = stream
    gateway = MagicMock()
    gateway.thread_registry.get_or_create_by_key = AsyncMock(return_value="thread-1")
    gateway.thread_registry.reset_by_session_key = AsyncMock()
    gateway.processor._begin_history = AsyncMock(
        side_effect=lambda _a, _t, r, **kw: TurnHistoryTracker.from_request(r)
    )
    gateway.processor._finish_history = AsyncMock()
    cron = CronManager(
        gateway=gateway,
        delivery_service=CronDeliveryService(gateway=gateway, agent_manager=agents, repos=repos),
        repos=repos,
    )
    cron._scheduler = MagicMock()
    cron._scheduler.get_job.return_value = None
    svc = LoopService(
        repos=repos,
        cron_manager=cron,
        agent_manager=agents,
        gateway=gateway,
        timezone="Asia/Shanghai",
    )
    yield svc, uid, agents, cron
    db.close()


def definition(**overrides):
    return LoopDefinition.model_validate(
        {
            "name": "My Loop",
            "agent_id": "expert",
            "objective": "Prepare a proposal",
            "instruction": "Make progress",
            "criterion": {"kind": "manual", "description": "User accepts"},
            "human_review": {
                "checkpoints": [{"name": "阶段检查", "expected_outcome": "检查当前成果"}]
            },
            **overrides,
        }
    )


async def settle(svc):
    if svc._tasks:
        await asyncio.gather(*list(svc._tasks.values()))
    await asyncio.sleep(0)


async def ready(svc, uid, **overrides):
    row = await svc.create(uid, definition(**overrides))
    await svc.start_round(row["loop_id"], uid, trial=True)
    await settle(svc)
    await svc.enable(row["loop_id"], uid)
    return row["loop_id"]


async def test_draft_never_runs_and_enable_requires_trial(env):
    svc, uid, _a, _c = env
    row = await svc.create(uid, definition())
    assert row["status"] == "draft" and not row["enabled"]
    assert not svc._tasks
    with pytest.raises(OctopError):
        await svc.enable(row["loop_id"], uid)


async def test_manual_completion_waits_for_user_and_feedback_continues(env):
    svc, uid, _a, _c = env
    lid = await ready(svc, uid)
    await svc.start_round(lid, uid)
    await settle(svc)
    row = await svc.get(lid, uid)
    assert row["status"] == "awaiting_judgment" and row["pending_judgment"]["kind"] == "stage"
    await decide(svc, uid, lid, "feedback", "Add sources")
    row = await svc.get(lid, uid)
    assert row["status"] == "scheduled" and row["progress"]["feedback"] == "Add sources"
    assert row["checkpoint_index"] == 0
    await svc.start_round(lid, uid)
    await settle(svc)
    await decide(svc, uid, lid, "continue")
    assert (await svc.get(lid, uid))["checkpoint_index"] == 1
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "final"
    assert (await decide(svc, uid, lid, "complete"))["status"] == "completed"


@pytest.mark.parametrize("fenced", [False, True])
async def test_tool_narration_does_not_fail_round_or_skip_human_judgment(env, fenced):
    svc, uid, agents, _cron = env
    lid = await ready(svc, uid)

    async def stream(_aid, _request):
        yield {"type": "token", "content": "I'll start by reading the sources.\n"}
        loop_scope.get().events.append(
            {"tool": "read_file", "call_id": "read-1", "status": "success", "result": "Source"}
        )
        yield {"type": "tool_result", "messages": []}
        yield {
            "type": "token",
            "content": ("```json\n" if fenced else "") + '{"outcome":"complete",',
        }
        yield {
            "type": "token",
            "content": '"summary":"Read the sources"}' + ("\n```" if fenced else ""),
        }

    agents.stream = stream
    await svc.start_round(lid, uid)
    await settle(svc)
    row = await svc.get(lid, uid)
    assert row["status"] == "awaiting_judgment"
    assert row["pending_judgment"]["kind"] == "stage"
    result = svc.repos.loop_repo.rounds(lid)[0]
    assert result["status"] == "ok"
    assert len(result["result"]["tools"]) == 1


async def decide(svc, uid, lid, action, feedback=""):
    row = await svc.get(lid, uid)
    return await svc.judge(
        lid,
        uid,
        JudgmentBody(
            judgment_id=row["pending_judgment"]["judgment_id"], action=action, feedback=feedback
        ),
    )


async def test_ai_claim_alone_cannot_pass_objective_check(env):
    svc, uid, _a, _c = env
    lid = await ready(
        svc,
        uid,
        allowed_tools=["current_time"],
        criterion={
            "kind": "tool_equals",
            "description": "Native result is true",
            "tool": "current_time",
            "field": ["ready"],
            "expected": True,
        },
    )
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "stage"
    await decide(svc, uid, lid, "continue")
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["status"] == "scheduled"
    assert not svc.repos.loop_repo.rounds(lid)[0]["result"]["verified"]


@pytest.mark.parametrize("outcome", ["continue", "complete", "needs_input"])
async def test_verified_native_tool_result_completes_objective(env, outcome):
    svc, uid, agents, _c = env
    lid = await ready(
        svc,
        uid,
        allowed_tools=["current_time"],
        criterion={
            "kind": "tool_equals",
            "description": "ready",
            "tool": "current_time",
            "field": ["ready"],
            "expected": True,
        },
    )

    async def stream(a, r):
        loop_scope.get().events.append(
            {
                "tool": "current_time",
                "call_id": "native-1",
                "status": "success",
                "result": {"ready": True},
            }
        )
        yield {
            "type": "token",
            "content": json.dumps(
                {"outcome": outcome, "summary": "Verified", "next_action": "", "evidence": []}
            ),
        }

    agents.stream = stream
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "stage"
    await decide(svc, uid, lid, "continue")
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "final"
    assert svc.repos.loop_repo.rounds(lid)[0]["result"]["verified"]
    assert (await decide(svc, uid, lid, "complete"))["status"] == "completed"


async def test_continuous_loop_and_round_limit(env):
    svc, uid, _a, _c = env
    lid = await ready(svc, uid, kind="continuous", interval_seconds=1800)
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["status"] == "awaiting_judgment"
    assert (await decide(svc, uid, lid, "continue"))["status"] == "scheduled"
    lid2 = await ready(
        svc,
        uid,
        max_rounds=1,
        criterion={
            "kind": "tool_equals",
            "description": "ready",
            "tool": "current_time",
            "expected": True,
        },
        allowed_tools=["current_time"],
    )
    await svc.start_round(lid2, uid)
    await settle(svc)
    assert (await svc.get(lid2, uid))["pending_judgment"]["kind"] == "stage"
    assert (await decide(svc, uid, lid2, "continue"))["reason"] == "round_limit"


async def test_restart_and_unknown_results_are_never_replayed(env):
    svc, uid, _a, _c = env
    row = await svc.create(uid, definition())
    svc.repos.loop_repo.claim(row["loop_id"], "interrupted-round", trial=True)
    await svc.boot()
    assert (await svc.get(row["loop_id"], uid))["reason"] == "execution_unknown"
    assert svc.repos.loop_repo.rounds(row["loop_id"])[0]["status"] == "interrupted"
    assert not svc._tasks
    with pytest.raises(OctopError):
        await svc.enable(row["loop_id"], uid)
    await svc.control(row["loop_id"], uid, "pause")
    with pytest.raises(OctopError):
        await svc.start_round(row["loop_id"], uid, trial=True)
    with pytest.raises(OctopError):
        await svc.revise(row["loop_id"], uid, definition(name="Bypass"))
    await svc.control(row["loop_id"], uid, "resolve")
    svc.gateway.thread_registry.reset_by_session_key.assert_awaited_once()
    assert (await svc.get(row["loop_id"], uid))["reason"] == "user_reconciled"


async def test_restart_after_pause_during_round_recovers_unknown_action(env):
    svc, uid, _a, _c = env
    row = await svc.create(uid, definition())
    lid = row["loop_id"]
    svc.repos.loop_repo.claim(lid, "paused-active", trial=True)
    await svc.control(lid, uid, "pause")
    await svc.boot()
    assert (await svc.get(lid, uid))["reason"] == "execution_unknown"
    assert svc.repos.loop_repo.rounds(lid)[0]["status"] == "interrupted"
    assert not svc._tasks


async def test_tool_revoked_before_trial_or_confirmation_is_rechecked(env):
    svc, uid, agents, _c = env
    row = await svc.create(uid, definition(allowed_tools=["write_file"]))
    lid = row["loop_id"]
    agents.get_agent.return_value.config.tools_disabled = frozenset({"write_file"})
    with pytest.raises(OctopError):
        await svc.start_round(lid, uid, trial=True)
    svc.repos.loop_repo.claim(lid, "revoked", trial=True)
    svc.repos.loop_repo.finish_round(
        "revoked",
        "awaiting_approval",
        {},
        {
            "checkpoint_id": "checkpoint-1",
            "session_key": "s",
            "request": {
                "action_requests": [{"name": "write_file", "args": {}}],
                "review_configs": [
                    {"action_name": "write_file", "allowed_decisions": ["approve", "reject"]}
                ],
            },
        },
    )
    svc.repos.loop_repo.update(lid, status="awaiting_approval", thread_id="thread-1")
    with pytest.raises(OctopError):
        await svc.approve(
            lid,
            uid,
            ApprovalBody(
                round_id="revoked", checkpoint_id="checkpoint-1", decisions=[{"type": "approve"}]
            ),
        )
    assert not svc._tasks and svc.repos.loop_repo.rounds(lid)[0]["status"] == "awaiting_approval"


async def test_takeover_is_atomic_and_blocks_old_cron_operations(env):
    svc, uid, _a, cron = env
    svc.gateway.thread_registry.get_session.return_value = None
    await cron.create(
        CronCreateSpec(
            cron_id="old",
            agent_id="expert",
            user_id=uid,
            trigger="interval:1800",
            prompt="old task",
            task_type="agent",
        )
    )
    row = await svc.create(uid, definition(source_cron_id="old"))
    assert not svc.repos.cron_repo.get("old").enabled
    with pytest.raises(OctopError):
        await cron.update("old", enabled=1)
    with pytest.raises(OctopError):
        await cron.run_now("old")
    with pytest.raises(OctopError):
        await cron.delete("old")
    await svc.control(row["loop_id"], uid, "release")
    assert not svc.repos.cron_repo.get("old").enabled
    await cron.update("old", enabled=1)


async def test_owner_revocation_and_foreign_owner(env):
    svc, uid, _a, _c = env
    row = await svc.create(uid, definition())
    other = svc.repos.user_repo.create(username="bob", password_hash="x", role="user")
    with pytest.raises(OctopError):
        await svc.get(row["loop_id"], other)
    svc.repos.user_repo.set_disabled(uid, True)
    with pytest.raises(OctopError):
        await svc.start_round(row["loop_id"], uid, trial=True)


async def test_duplicate_rounds_and_revision_gate(env):
    svc, uid, agents, _c = env
    lid = await ready(svc, uid)
    gate = asyncio.Event()

    async def stream(a, r):
        await gate.wait()
        yield {
            "type": "token",
            "content": json.dumps({"outcome": "continue", "summary": "one round"}),
        }

    agents.stream = stream
    await svc.start_round(lid, uid)
    with pytest.raises(OctopError):
        await svc.start_round(lid, uid)
    with pytest.raises(OctopError):
        await svc.revise(lid, uid, definition(name="Changed"))
    await svc.control(lid, uid, "pause")
    gate.set()
    await settle(svc)
    assert (await svc.get(lid, uid))["status"] == "paused"
    row = await svc.revise(lid, uid, definition(name="Changed"))
    assert row["version"] == 2
    with pytest.raises(OctopError):
        await svc.enable(lid, uid)


async def test_native_confirmation_survives_restart_and_resumes_same_round(env):
    svc, uid, agents, _c = env

    async def stream(a, r):
        yield {
            "type": "hitl_required",
            "request": {
                "action_requests": [{"name": "current_time", "args": {}}],
                "review_configs": [
                    {"action_name": "current_time", "allowed_decisions": ["approve", "reject"]}
                ],
            },
        }

    agents.stream = stream
    row = await svc.create(uid, definition(allowed_tools=["current_time"]))
    await svc.start_round(row["loop_id"], uid, trial=True)
    await settle(svc)
    r = svc.repos.loop_repo.rounds(row["loop_id"])[0]
    assert r["status"] == "awaiting_approval"
    await svc.shutdown()
    await svc.boot()

    async def resume(a, t, decisions, *, user_id):
        assert user_id == uid
        assert t == "thread-1" and decisions == [{"type": "approve"}]
        yield {
            "type": "token",
            "content": json.dumps({"outcome": "complete", "summary": "Approved"}),
        }

    agents.resume_hitl = resume
    body = ApprovalBody(
        round_id=r["round_id"], checkpoint_id="checkpoint-1", decisions=[{"type": "approve"}]
    )
    await svc.approve(row["loop_id"], uid, body)
    await settle(svc)
    assert len(svc.repos.loop_repo.rounds(row["loop_id"])) == 1
    assert svc.repos.loop_repo.rounds(row["loop_id"])[0]["status"] == "ok"


async def test_stale_checkpoint_cannot_execute(env):
    svc, uid, agents, _c = env
    row = await svc.create(uid, definition())
    svc.repos.loop_repo.claim(row["loop_id"], "pending", trial=True)
    svc.repos.loop_repo.finish_round(
        "pending",
        "awaiting_approval",
        {},
        {"checkpoint_id": "old", "request": {}, "session_key": "s"},
    )
    svc.repos.loop_repo.update(row["loop_id"], status="awaiting_approval", thread_id="thread-1")
    with pytest.raises(OctopError):
        await svc.approve(
            row["loop_id"],
            uid,
            ApprovalBody(round_id="pending", checkpoint_id="old", decisions=[{"type": "approve"}]),
        )
    assert (await svc.get(row["loop_id"], uid))["reason"] == "execution_unknown"


async def test_expired_confirmation_cannot_resume(env):
    svc, uid, agents, _c = env
    row = await svc.create(uid, definition())
    lid = row["loop_id"]
    svc.repos.loop_repo.claim(lid, "expired", trial=True)
    svc.repos.loop_repo.finish_round(
        "expired",
        "awaiting_approval",
        {},
        {"checkpoint_id": "checkpoint-1", "request": {}, "session_key": "s", "expires_at": 1},
    )
    svc.repos.loop_repo.update(lid, status="awaiting_approval", thread_id="thread-1")
    with pytest.raises(OctopError):
        await svc.approve(
            lid,
            uid,
            ApprovalBody(
                round_id="expired", checkpoint_id="checkpoint-1", decisions=[{"type": "approve"}]
            ),
        )
    assert not svc._tasks
    assert (await svc.get(lid, uid))["reason"] == "execution_unknown"


async def test_ended_loop_cannot_be_reopened_by_a_late_approval_claim(env):
    svc, uid, _a, _c = env
    row = await svc.create(uid, definition())
    lid = row["loop_id"]
    svc.repos.loop_repo.claim(lid, "late-approval", trial=True)
    svc.repos.loop_repo.finish_round(
        "late-approval", "awaiting_approval", {}, {"checkpoint_id": "checkpoint-1"}
    )
    # Stop is persisted before cancelling an interrupted native task.
    svc.repos.loop_repo.update(lid, status="stopped", enabled=0)
    assert not svc.repos.loop_repo.resume_claim(lid, "late-approval")
    assert (await svc.get(lid, uid))["status"] == "stopped"


async def test_consecutive_pre_action_failures_pause_and_stop_cancels(env):
    svc, uid, agents, _c = env
    lid = await ready(svc, uid)

    async def fail(a, request):
        raise RuntimeError("model_unavailable")
        yield {}

    agents.stream = fail
    for number in range(1, 4):
        await svc.start_round(lid, uid)
        await settle(svc)
        row = await svc.get(lid, uid)
        assert row["failures"] == number
        assert row["status"] == ("paused" if number == 3 else "scheduled")
    assert not row["enabled"]

    agents.stream = lambda a, r: wait_forever()
    await svc.enable(lid, uid)
    await svc.start_round(lid, uid)
    await asyncio.sleep(0.02)
    await svc.control(lid, uid, "stop")
    assert not svc._tasks and (await svc.get(lid, uid))["status"] == "stopped"
    agents.cancel_stream.assert_called()


async def wait_forever():
    await asyncio.Event().wait()
    yield {}


async def test_source_task_cannot_be_taken_over_while_running(env):
    svc, uid, _a, cron = env
    svc.gateway.thread_registry.get_session.return_value = None
    await cron.create(
        CronCreateSpec(
            cron_id="busy",
            agent_id="expert",
            user_id=uid,
            trigger="interval:1800",
            prompt="busy",
            task_type="agent",
        )
    )
    cron._running_jobs.add("busy")
    with pytest.raises(OctopError):
        await svc.create(uid, definition(source_cron_id="busy"))
    assert not svc.repos.loop_repo.list()
    assert svc.repos.cron_repo.get("busy").enabled


def test_continuous_mode_uses_30_minute_default():
    assert definition(kind="continuous").interval_seconds == 1800
    assert definition(kind="continuous", interval_seconds=3600).interval_seconds == 3600


async def test_long_running_loop_keeps_trial_gate_beyond_recent_history(env):
    svc, uid, _a, _c = env
    lid = await ready(svc, uid, kind="continuous")
    for number in range(101):
        svc.repos.loop_repo.claim(lid, f"old-{number}", trial=False)
        svc.repos.loop_repo.finish_round(f"old-{number}", "ok", {})
        svc.repos.loop_repo.update(lid, status="scheduled")
    await svc.control(lid, uid, "pause")
    assert not any(r["trial"] for r in svc.repos.loop_repo.rounds(lid))
    assert (await svc.enable(lid, uid))["status"] == "scheduled"
    recent = await svc.rounds(lid, uid)
    older = await svc.rounds(lid, uid, before=recent[-1]["round_id"])
    assert len(recent) == 100 and len(older) == 2
    assert older[-1]["trial"]
    other = await svc.create(uid, definition())
    assert not await svc.rounds(other["loop_id"], uid, before=recent[-1]["round_id"])


async def test_boundary_blocks_forged_and_resumed_tool_calls():
    boundary = LoopBoundary()
    handler = AsyncMock(return_value=ToolMessage(content='{"ready":true}', tool_call_id="call"))
    scope = LoopScope(frozenset({"current_time"}), lambda: None)
    token = loop_scope.set(scope)
    try:
        with pytest.raises(PermissionError):
            await boundary.awrap_tool_call(
                SimpleNamespace(tool_call={"name": "execute", "id": "call"}), handler
            )
        handler.assert_not_awaited()
        await boundary.awrap_tool_call(
            SimpleNamespace(tool_call={"name": "current_time", "id": "call"}), handler
        )
        assert scope.events[0]["result"] == {"ready": True}
    finally:
        loop_scope.reset(token)


@pytest.mark.parametrize(
    "patch",
    [
        {"interval_seconds": 0},
        {"allowed_tools": ["cronjob_create"]},
        {"criterion": {"kind": "file_exists", "description": "bad", "path": "../secret"}},
        {"criterion": {"kind": "tool_equals", "description": "bad", "tool": "x"}},
    ],
)
def test_invalid_configuration_rejected(patch):
    with pytest.raises(ValidationError):
        definition(**patch)


def inbound(text, *, subject="owner-platform", chat="dm", channel="channel-1"):
    from octop_gateway.models import ChannelSubject, InboundMessage, TextContent

    return InboundMessage(
        channel_id=channel,
        channel_type="weixin",
        tenant_id="expert",
        channel_subject=ChannelSubject(subject_id=subject, display_name="本人", chat_type=chat),
        content=[TextContent(text=text)],
        metadata={"chat_type": chat},
    )


async def bind_owner(svc, uid):
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    svc.repos.channel_repo.create(
        channel_id="channel-1",
        agent_id="expert",
        user_id=uid,
        kind="weixin",
        name="本人微信",
        config_json='{"token":"test-only"}',
    )
    created = await svc.interactions.create_binding(uid, "expert", "channel-1")
    reply = await svc.interactions.handle_inbound(inbound("绑定 " + created["code"]))
    assert "确认" in reply
    await svc.interactions.confirm_binding(uid, created["binding_id"])
    return created["binding_id"]


async def test_judgment_blocks_every_bypass_and_is_atomic(env):
    svc, uid, _a, _c = env
    lid = await ready(svc, uid)
    await svc.start_round(lid, uid)
    await settle(svc)
    before = await svc.get(lid, uid)
    await svc.control(lid, uid, "pause")
    assert (await svc.get(lid, uid))["status"] == "awaiting_judgment"
    for operation in [
        svc.enable(lid, uid),
        svc.control(lid, uid, "resume"),
        svc.start_round(lid, uid, trial=True),
        svc.revise(lid, uid, definition(name="Bypass")),
        svc.review(lid, uid, True, ""),
    ]:
        with pytest.raises(OctopError):
            await operation
    body = JudgmentBody(judgment_id=before["pending_judgment"]["judgment_id"], action="continue")
    results = await asyncio.gather(
        svc.judge(lid, uid, body), svc.judge(lid, uid, body), return_exceptions=True
    )
    assert sum(isinstance(result, OctopError) for result in results) == 1
    assert (await svc.get(lid, uid))["checkpoint_index"] == 1
    with pytest.raises(OctopError):
        await svc.judge(lid, uid, body)


@pytest.mark.parametrize("budget", ["rounds", "seconds"])
async def test_periodic_review_survives_pause_restart_and_does_not_advance_stage(env, budget):
    svc, uid, agents, _c = env

    async def stream(*_):
        yield {
            "type": "token",
            "content": json.dumps(
                {"outcome": "continue", "summary": "Progress", "next_action": "More research"}
            ),
        }

    agents.stream = stream
    lid = await ready(svc, uid, kind="continuous")
    if budget == "seconds":
        svc.repos.loop_repo.add_budget(lid, 1800)
    for _ in range(1 if budget == "seconds" else 3):
        await svc.start_round(lid, uid)
        await settle(svc)
    row = await svc.get(lid, uid)
    assert row["pending_judgment"]["kind"] == "periodic"
    await svc.control(lid, uid, "pause")
    await svc.boot()
    assert (await svc.get(lid, uid))["pending_judgment"]["judgment_id"] == row["pending_judgment"][
        "judgment_id"
    ]
    await decide(svc, uid, lid, "continue")
    row = await svc.get(lid, uid)
    assert row["review_rounds"] == row["review_seconds"] == row["checkpoint_index"] == 0
    assert row["status"] == "scheduled"
    await svc.shutdown()


async def test_pause_during_round_does_not_drop_due_judgment(env):
    svc, uid, agents, _c = env
    lid = await ready(svc, uid)

    async def stream(*_):
        await svc.control(lid, uid, "pause")
        yield {"type": "token", "content": '{"outcome":"complete","summary":"Ready"}'}

    agents.stream = stream
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "stage"


async def test_binding_requires_private_platform_identity_and_app_confirmation(env):
    svc, uid, _a, _c = env
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    svc.repos.channel_repo.create(
        channel_id="channel-1",
        agent_id="expert",
        user_id=uid,
        kind="weixin",
        name="微信",
        config_json="{}",
    )
    challenge = await svc.interactions.create_binding(uid, "expert", "channel-1")
    assert "私聊" in await svc.interactions.handle_inbound(
        inbound("绑定 " + challenge["code"], chat="group")
    )
    with pytest.raises(OctopError):
        await svc.interactions.confirm_binding(uid, challenge["binding_id"])
    await svc.interactions.handle_inbound(inbound("绑定 " + challenge["code"]))
    await svc.interactions.handle_inbound(inbound("这是另一位用户", subject="attacker"))
    pending = await svc.interactions.list_bindings(uid)
    assert pending[0]["subject_id"] == "owner-platform"
    assert pending[0]["status"] == "awaiting_confirmation"
    await svc.interactions.confirm_binding(uid, challenge["binding_id"])
    assert "绑定" in await svc.interactions.handle_inbound(inbound("进展", subject="attacker"))
    bindings = await svc.interactions.list_bindings(uid)
    assert bindings[0]["subject_id"] == "owner-platform"
    assert not {"challenge_hash", "routing_json", "fingerprint"}.intersection(bindings[0])
    svc.repos.channel_repo.update("channel-1", config_json='{"token":"changed"}')
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(uid, "expert", challenge["binding_id"])


async def test_binding_expiry_cross_user_and_permission_revocation(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    other = svc.repos.user_repo.create(username="bob", role="user", permissions=["channels"])
    with pytest.raises(OctopError):
        await svc.interactions.create_binding(other, "expert", "channel-1")
    with pytest.raises(OctopError):
        await svc.interactions.confirm_binding(other, bid)
    svc.repos.user_repo.set_permissions(uid, [])
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(uid, "expert", bid)
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    await svc.interactions.revoke_binding(uid, bid)
    row = await svc.interactions.create_binding(uid, "expert", "channel-1")
    with svc.repos.loop_repo._db.connect() as c:
        c.execute(
            "UPDATE loop_channel_bindings SET expires_at=0 WHERE binding_id=?", (row["binding_id"],)
        )
    assert "过期" in await svc.interactions.handle_inbound(inbound("绑定 " + row["code"]))


async def test_channel_desktop_compete_for_same_ticket_and_ambiguous_replies_do_not_act(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lids = [await ready(svc, uid, channel_binding_id=bid) for _ in range(2)]
    for lid in lids:
        await svc.start_round(lid, uid)
        await settle(svc)
    assert "编号" in await svc.interactions.handle_inbound(inbound("继续"))
    assert "编号" in await svc.interactions.handle_inbound(inbound("继续 随便"))
    for lid in lids:
        assert (await svc.get(lid, uid))["status"] == "awaiting_judgment"
    row = await svc.get(lids[0], uid)
    ticket = row["pending_judgment"]
    await asyncio.gather(
        svc.interactions.handle_inbound(inbound("继续 " + ticket["code"])),
        svc.judge(lids[0], uid, JudgmentBody(judgment_id=ticket["judgment_id"], action="continue")),
        return_exceptions=True,
    )
    assert (await svc.get(lids[0], uid))["checkpoint_index"] == 1
    assert (await svc.get(lids[1], uid))["status"] == "awaiting_judgment"
    assert "编号" in await svc.interactions.handle_inbound(inbound("继续 " + ticket["code"]))
    assert await svc.interactions.handle_inbound(inbound("普通消息")) is None
    assert await svc.interactions.handle_inbound(inbound("继续", channel="unconfigured")) is None


async def test_notifications_persist_retry_and_uncertain_delivery_never_replays(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)
    await svc.start_round(lid, uid)
    await settle(svc)
    records = svc.repos.loop_repo.notifications(lid)
    assert len(records) == 1 and "H" in records[0]["message"]
    svc.gateway.channel_manager.get_channel.return_value = None
    for i in range(3):
        await svc.interactions.deliver_due()
        row = svc.repos.loop_repo.notifications(lid)[0]
        if i < 2:
            assert row["status"] == "queued"
            svc.repos.loop_repo.notification_finish(row["notification_id"], "queued")
    assert svc.repos.loop_repo.notifications(lid)[0]["status"] == "error"
    assert (await svc.get(lid, uid))["status"] == "awaiting_judgment"
    svc.gateway.channel_manager.get_channel.return_value = object()
    svc.gateway.push_text = AsyncMock(side_effect=ConnectionError("unknown delivery"))
    svc.repos.loop_repo.notification_finish(records[0]["notification_id"], "queued")
    await svc.interactions.deliver_due()
    assert svc.repos.loop_repo.notifications(lid)[0]["status"] == "uncertain"
    await svc.interactions.deliver_due()
    svc.gateway.push_text.assert_awaited_once()
    # Desktop still works while a channel is disabled; business progress isn't hostage to delivery.
    svc.repos.channel_repo.update("channel-1", enabled=False)
    assert (await decide(svc, uid, lid, "continue"))["status"] == "scheduled"


async def test_mixed_native_replies_persist_and_resume_once(env):
    import time

    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)
    repo = svc.repos.loop_repo
    repo.claim(lid, "native-round", trial=False)
    pending = {
        "checkpoint_id": "checkpoint-1",
        "session_key": "test",
        "expires_at": int(time.time()) + 1800,
        "request": {
            "action_requests": [
                {"name": "write_file", "args": {}},
                {"name": "ask_user_question", "args": {}},
            ],
            "review_configs": [
                {"action_name": "write_file", "allowed_decisions": ["approve", "reject"]},
                {"action_name": "ask_user_question", "allowed_decisions": ["respond"]},
            ],
        },
    }
    repo.finish_round("native-round", "awaiting_approval", {"execution_seconds": 12}, pending)
    repo.update(lid, status="awaiting_approval", thread_id="thread-1")
    ticket = svc.interactions.native_ticket(repo.rounds(lid)[0])
    assert "尚有 1" in await svc.interactions.handle_inbound(inbound(f"批准 {ticket} 1"))
    await svc.boot()
    assert repo.rounds(lid)[0]["pending"]["collected"] == {"0": {"type": "approve"}}
    assert "同一轮" in await svc.interactions.handle_inbound(inbound(f"回答 {ticket} 2 简洁格式"))
    await settle(svc)
    assert repo.rounds(lid)[0]["round_id"] == "native-round"
    assert len(repo.rounds(lid)) == 2  # one trial and the original resumed round
    assert (await svc.get(lid, uid))["review_rounds"] == 1
    assert "没有匹配" in await svc.interactions.handle_inbound(inbound(f"批准 {ticket} 1"))
    await svc.shutdown()


async def test_legacy_loop_requires_confirmed_policy_and_new_trial(env):
    svc, uid, _a, _c = env
    legacy = definition().model_dump()
    legacy.pop("human_review")
    svc.repos.loop_repo.create("legacy", uid, legacy)
    svc.repos.loop_repo.update("legacy", status="scheduled", enabled=1)
    await svc.boot()
    row = await svc.get("legacy", uid)
    assert row["reason"] == "judgment_configuration_required"
    with pytest.raises(OctopError):
        await svc.start_round("legacy", uid, trial=True)
    updated = await svc.revise("legacy", uid, definition())
    assert updated["version"] == 2
    with pytest.raises(OctopError):
        await svc.enable("legacy", uid)
    await svc.shutdown()


async def test_changed_account_cannot_reactivate_old_binding_or_erase_notifications(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)
    await svc.start_round(lid, uid)
    await settle(svc)
    svc.repos.channel_repo.update("channel-1", config_json='{"token":"new"}')
    svc.repos.channel_repo.update("channel-1", config_json='{"token":"test-only"}')
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(uid, "expert", bid)
    svc.repos.channel_repo.delete("channel-1")
    assert len(svc.repos.loop_repo.notifications(lid)) == 1
    assert (await decide(svc, uid, lid, "continue"))["status"] == "scheduled"


async def test_native_expiry_and_checkpoint_specific_ticket(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)
    repo = svc.repos.loop_repo
    repo.claim(lid, "native-expiry", trial=False)
    pending = {
        "checkpoint_id": "checkpoint-new",
        "session_key": "s",
        "expires_at": 1,
        "request": {"action_requests": [{"name": "write_file", "args": {}}]},
    }
    repo.finish_round("native-expiry", "awaiting_approval", {}, pending)
    repo.update(lid, status="awaiting_approval")
    r = repo.rounds(lid)[0]
    ticket = svc.interactions.native_ticket(r)
    old = svc.interactions.native_ticket(
        {**r, "pending": {**pending, "checkpoint_id": "checkpoint-old"}}
    )
    assert "没有匹配" in await svc.interactions.handle_inbound(inbound(f"批准 {old} 1"))
    assert "过期" in await svc.interactions.handle_inbound(inbound(f"批准 {ticket} 1"))
    assert (await svc.get(lid, uid))["reason"] == "execution_unknown"


async def test_intercepted_reply_never_starts_an_ordinary_expert_turn(env):
    from octop.infra.gateway.process.processor import GlobalProcessor

    svc, uid, _a, _c = env
    await bind_owner(svc, uid)
    processor = object.__new__(GlobalProcessor)
    processor.loop_message_interceptor = svc.interactions.handle_inbound
    # An incompletely initialized processor can only answer through the interceptor.
    events = [event async for event in processor(inbound("进展"))]
    assert len(events) == 2


async def test_failed_execution_time_also_reaches_human_fallback(env):
    svc, uid, agents, _c = env
    lid = await ready(svc, uid)
    svc.repos.loop_repo.add_budget(lid, 1800, completed=False)

    async def stream(*_):
        raise RuntimeError("failed before tool")
        yield

    agents.stream = stream
    await svc.start_round(lid, uid)
    await settle(svc)
    row = await svc.get(lid, uid)
    assert row["pending_judgment"]["kind"] == "periodic"
    assert row["review_rounds"] == 0


async def test_outbox_recovery_deduplicates_and_suppresses_resolved_requests(env):
    svc, uid, _a, _c = env
    svc.interactions._worker = AsyncMock()
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)
    await svc.start_round(lid, uid)
    await settle(svc)
    await svc.boot()
    assert len(svc.repos.loop_repo.notifications(lid)) == 1
    await svc.interactions.shutdown()
    await decide(svc, uid, lid, "continue")
    svc.gateway.push_text = AsyncMock()
    await svc.interactions.deliver_due()
    notifications = svc.repos.loop_repo.notifications(lid)
    assert {r["status"] for r in notifications} == {"cancelled", "sent"}
    svc.gateway.push_text.assert_awaited_once()
    await svc.shutdown()


async def test_repo_claim_and_revise_cannot_bypass_uncertainty(env):
    svc, uid, _a, _c = env
    row = await svc.create(uid, definition())
    lid = row["loop_id"]
    svc.repos.loop_repo.update(lid, status="paused", reason="execution_unknown")
    assert svc.repos.loop_repo.claim(lid, "bypass", trial=True) is None
    with pytest.raises(ValueError):
        svc.repos.loop_repo.revise(lid, definition(name="Bypass").model_dump())


async def test_approval_receipt_is_durable_before_resumed_tool_can_run(env):
    svc, uid, _a, _c = env
    lid = (await svc.create(uid, definition()))["loop_id"]
    repo = svc.repos.loop_repo
    repo.claim(lid, "audit-round", trial=True)
    repo.finish_round(
        "audit-round",
        "awaiting_approval",
        {"execution_seconds": 5},
        {
            "checkpoint_id": "audit-checkpoint",
            "request": {"action_requests": [{"name": "write_file", "args": {}}]},
        },
    )
    repo.update(lid, status="awaiting_approval")
    assert repo.resume_claim(lid, "audit-round", "audit-checkpoint", [{"type": "approve"}])
    repo.record_tools("audit-round", [{"tool": "write_file", "status": "started"}])
    result = repo.rounds(lid)[0]["result"]
    assert result["approvals"][0]["checkpoint_id"] == "audit-checkpoint"
    assert result["approvals"][0]["user_id"] == uid
    assert result["execution_seconds"] == 5
    await svc.boot()
    assert repo.rounds(lid)[0]["result"]["approvals"] == result["approvals"]
    assert (await svc.get(lid, uid))["reason"] == "execution_unknown"
    await svc.shutdown()


async def test_conversation_refines_existing_proposal_without_saving_or_executing(env):
    svc, uid, agents, _c = env
    current = definition()
    refined = definition(instruction="Make a concise proposal, then check sources")
    llm = SimpleNamespace(
        ainvoke=AsyncMock(return_value=SimpleNamespace(content=refined.model_dump_json()))
    )
    harness = agents.get_agent.return_value
    harness.model_factory = SimpleNamespace(get=lambda _: llm)
    harness.config.pick_default_model_ref = lambda: "configured-model"
    agents.get_config.return_value = {"tools_disabled": ["execute"]}
    result = await svc.draft(uid, "expert", "先简洁一些", current=current)
    assert result.instruction == refined.instruction
    context = json.loads(llm.ainvoke.call_args.args[0][1].content)
    assert context["current_proposal"]["objective"] == current.objective
    assert context["request"] == "先简洁一些"
    assert "execute" not in context["existing_tools"]
    assert await svc.list_loops(uid) == []
    assert not svc._tasks
    llm.ainvoke.return_value.content = definition(allowed_tools=["invented_tool"]).model_dump_json()
    with pytest.raises(OctopError):
        await svc.draft(uid, "expert", "Do it")
    with pytest.raises(OctopError):
        await svc.draft(uid, "expert", "Do it", current=definition(agent_id="other"))
    assert llm.ainvoke.await_count == 2


async def test_channel_simple_choices_preserve_waiting_and_final_acceptance(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)
    await svc.start_round(lid, uid)
    await settle(svc)
    original = (await svc.get(lid, uid))["pending_judgment"]
    for ambiguous in ("好的", "可以", "1H3", "4"):
        assert "不明确" in await svc.interactions.handle_inbound(inbound(ambiguous))
    message = svc.repos.loop_repo.notifications(lid)[0]["message"]
    assert "1 按建议继续" in message and "2 我想调整" in message
    assert "绑定" in await svc.interactions.handle_inbound(inbound("1", subject="attacker"))
    assert "私聊" in await svc.interactions.handle_inbound(inbound("1", chat="group"))
    assert "先等你" in await svc.interactions.handle_inbound(inbound("2"))
    assert (await svc.get(lid, uid))["pending_judgment"] == original
    assert "暂停" in await svc.interactions.handle_inbound(inbound("3"))
    assert (await svc.get(lid, uid))["pending_judgment"]["judgment_id"] == original["judgment_id"]
    assert "继续" in await svc.interactions.handle_inbound(inbound("2：补充可靠来源"))
    row = await svc.get(lid, uid)
    assert row["checkpoint_index"] == 0 and row["progress"]["feedback"] == "补充可靠来源"
    assert "编号" in await svc.interactions.handle_inbound(inbound("1 " + original["code"]))
    await svc.start_round(lid, uid)
    await settle(svc)
    assert "继续" in await svc.interactions.handle_inbound(inbound("1"))
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "final"
    assert any(
        "1 确认目标完成" in event["message"] for event in svc.repos.loop_repo.notifications(lid)
    )
    assert "确认完成" in await svc.interactions.handle_inbound(inbound("1"))
    assert (await svc.get(lid, uid))["status"] == "completed"
    assert "编号" in await svc.interactions.handle_inbound(inbound("1"))
    assert await svc.interactions.handle_inbound(inbound("好的")) is None


async def test_simple_choices_disambiguate_loops_and_desktop_race(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lids = [await ready(svc, uid, channel_binding_id=bid) for _ in range(2)]
    for lid in lids:
        await svc.start_round(lid, uid)
    await settle(svc)
    assert "编号" in await svc.interactions.handle_inbound(inbound("1"))
    assert "不明确" in await svc.interactions.handle_inbound(inbound("1 maybe"))
    row = await svc.get(lids[0], uid)
    j = row["pending_judgment"]
    await asyncio.gather(
        svc.interactions.handle_inbound(inbound("1 " + j["code"])),
        svc.judge(lids[0], uid, JudgmentBody(judgment_id=j["judgment_id"], action="continue")),
        return_exceptions=True,
    )
    assert (await svc.get(lids[0], uid))["checkpoint_index"] == 1
    assert (await svc.get(lids[1], uid))["status"] == "awaiting_judgment"
    assert "编号" in await svc.interactions.handle_inbound(inbound("1 " + j["code"]))


@pytest.mark.parametrize("reply,expected", [("允许", "approve"), ("拒绝", "reject")])
async def test_simple_native_decision_is_explicit_and_numbers_never_approve(env, reply, expected):
    import time

    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)
    repo = svc.repos.loop_repo
    repo.claim(lid, "simple-native", trial=False)
    pending = {
        "checkpoint_id": "simple-cp",
        "session_key": "test",
        "expires_at": int(time.time()) + 1800,
        "request": {"action_requests": [{"name": "write_file", "args": {"path": "report.md"}}]},
    }
    repo.finish_round("simple-native", "awaiting_approval", {}, pending)
    repo.update(lid, status="awaiting_approval", thread_id="thread-1")
    svc.approve = AsyncMock()
    assert "编号" in await svc.interactions.handle_inbound(inbound("1"))
    assert "不明确" in await svc.interactions.handle_inbound(inbound("允许 也许"))
    svc.approve.assert_not_awaited()
    assert "同一轮" in await svc.interactions.handle_inbound(inbound(reply))
    decision = svc.approve.call_args.args[2].decisions[0]
    assert decision["type"] == expected
    assert "逐项" in await svc.interactions.handle_inbound(inbound(reply))
    svc.approve.assert_awaited_once()


async def test_simple_number_cannot_skip_missing_information(env):
    svc, uid, agents, _c = env
    bid = await bind_owner(svc, uid)
    lid = await ready(svc, uid, channel_binding_id=bid)

    async def stream(*_):
        yield {
            "type": "token",
            "content": json.dumps(
                {
                    "outcome": "needs_input",
                    "summary": "Need a delivery format",
                    "question": "Use a memo or slides?",
                }
            ),
        }

    agents.stream = stream
    await svc.start_round(lid, uid)
    await settle(svc)
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "input"
    assert "先等你" in await svc.interactions.handle_inbound(inbound("1"))
    assert (await svc.get(lid, uid))["status"] == "awaiting_judgment"
    assert "继续" in await svc.interactions.handle_inbound(inbound("2：简报"))
    assert (await svc.get(lid, uid))["progress"]["feedback"] == "简报"


async def test_builder_asks_then_builds_without_creating_a_loop(env):
    from octop.infra.loops.models import BuilderBody

    svc, uid, agents, _c = env
    proposal = definition(
        human_review={
            "checkpoints": [
                {
                    "name": "确认方向",
                    "instruction": "收集资料并生成提纲",
                    "expected_outcome": "确认方向与重点",
                }
            ]
        }
    ).model_dump()
    answer = {
        "message": "我先安排资料整理和方向判断。",
        "question": "你想先拿到什么？",
        "options": ["简版方案", "完整报告"],
        "ready": False,
        "proposal": proposal,
    }
    llm = SimpleNamespace(
        ainvoke=AsyncMock(return_value=SimpleNamespace(content=json.dumps(answer)))
    )
    harness = agents.get_agent.return_value
    harness.model_factory = SimpleNamespace(get=lambda _: llm)
    harness.config.pick_default_model_ref = lambda: "configured-model"
    agents.get_config.return_value = {}
    body = BuilderBody(agent_id="expert", messages=[{"role": "user", "content": "帮我做客户方案"}])
    first = await svc.build(uid, body)
    assert first.question and len(first.options) == 2 and not first.ready
    assert not svc._tasks and await svc.list_loops(uid) == []
    answer.update(ready=True, question="", options=[])
    llm.ainvoke.return_value.content = json.dumps(answer)
    with pytest.raises(OctopError):
        await svc.build(uid, body)  # A model cannot skip the initial question.
    body = BuilderBody.model_validate(
        {
            "agent_id": "expert",
            "messages": [
                *[m.model_dump() for m in body.messages],
                {"role": "assistant", "content": first.question},
                {"role": "user", "content": "简版方案"},
            ],
        }
    )
    body.current = first.proposal
    result = await svc.build(uid, body)
    assert (
        result.ready
        and result.proposal.human_review.checkpoints[0].instruction == "收集资料并生成提纲"
    )
    model_input = json.loads(llm.ainvoke.call_args.args[0][1].content)
    assert model_input["messages"][-1]["content"] == "简版方案"
    assert model_input["current_proposal"]["objective"] == proposal["objective"]
    assert await svc.list_loops(uid) == []
    llm.ainvoke.return_value.content = "not valid planning JSON"
    with pytest.raises(OctopError):
        await svc.build(uid, body)
    answer["proposal"]["allowed_tools"] = ["invented_capability"]
    llm.ainvoke.return_value.content = json.dumps(answer)
    with pytest.raises(OctopError):
        await svc.build(uid, body)


async def test_visual_stage_instructions_follow_human_judgment(env):
    svc, uid, agents, _c = env
    policy = {
        "checkpoints": [
            {"name": "方向", "instruction": "只准备提纲", "expected_outcome": "确认方向"},
            {"name": "成果", "instruction": "完善已确认的方案", "expected_outcome": "判断成果质量"},
        ]
    }
    lid = await ready(svc, uid, human_review=policy)
    received = []

    async def stream(_aid, request, *_):
        received.append(json.loads(request["messages"][0]["content"].split("\n", 1)[0]))
        yield {
            "type": "token",
            "content": '{"outcome":"complete","summary":"本阶段成果已就绪","checkpoint_ready":true}',
        }

    agents.stream = stream
    await svc.start_round(lid, uid)
    await settle(svc)
    assert received[-1]["active_stage"]["instruction"] == "只准备提纲"
    await decide(svc, uid, lid, "feedback", "聚焦客户需求")
    await svc.start_round(lid, uid)
    await settle(svc)
    assert received[-1]["active_stage"]["instruction"] == "只准备提纲"
    await decide(svc, uid, lid, "continue")
    await svc.start_round(lid, uid)
    await settle(svc)
    assert received[-1]["active_stage"]["instruction"] == "完善已确认的方案"
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "stage"
    await decide(svc, uid, lid, "continue")
    await svc.start_round(lid, uid)
    await settle(svc)
    assert received[-1]["active_stage"] is None
    assert (await svc.get(lid, uid))["pending_judgment"]["kind"] == "final"


@pytest.mark.parametrize(
    "overrides",
    [
        {"kind": "completion"},
        {
            "human_review": {
                "checkpoints": [
                    {"name": "one", "expected_outcome": "one"},
                    {"name": "two", "expected_outcome": "two"},
                ]
            }
        },
    ],
)
def test_routine_is_one_repeated_task_not_a_project(overrides):
    with pytest.raises(ValidationError):
        definition(task_mode="routine", **{"kind": "continuous", **overrides})


async def test_routine_run_completion_keeps_running_with_periodic_human_review(env):
    svc, uid, _agents, _cron = env
    lid = await ready(svc, uid, task_mode="routine", kind="continuous", max_rounds=2)
    for i in range(11):
        await svc.start_round(lid, uid)
        await settle(svc)
        row = await svc.get(lid, uid)
        assert row["checkpoint_index"] == 0
        if (i + 1) % 3 == 0:
            assert row["pending_judgment"]["kind"] == "periodic"
            with pytest.raises(OctopError):
                await svc.control(lid, uid, "resume")
            await decide(svc, uid, lid, "continue")
        else:
            assert row["status"] == "scheduled" and not row["pending_judgment"]
    assert (await svc.get(lid, uid))["round_count"] == 11
    assert all(j["kind"] == "periodic" for j in svc.repos.loop_repo.judgments(lid))


async def test_routine_channel_question_choices_are_verified_and_resume_soon(env):
    import time

    svc, uid, agents, _cron = env
    bid = await bind_owner(svc, uid)

    async def stream(_aid, _request, *_args):
        yield {
            "type": "token",
            "content": json.dumps(
                {
                    "outcome": "needs_input",
                    "summary": "有两份重复资料",
                    "question": "重复资料如何处理？",
                    "choices": ["合并重复项", "全部保留"],
                    "next_action": "按回答整理资料",
                }
            ),
        }

    agents.stream = stream
    lid = await ready(
        svc,
        uid,
        task_mode="routine",
        kind="continuous",
        calendar_trigger="cron:0 9 * * *",
        channel_binding_id=bid,
    )
    await svc.start_round(lid, uid)
    await settle(svc)
    row = await svc.get(lid, uid)
    j = row["pending_judgment"]
    assert j["kind"] == "input" and j["payload"]["choices"] == ["合并重复项", "全部保留"]
    notice = svc.repos.loop_repo.notifications(lid)[0]["message"]
    assert "A 合并重复项" in notice and "B 全部保留" in notice
    assert "绑定" in await svc.interactions.handle_inbound(inbound("A", subject="attacker"))
    assert "私聊" in await svc.interactions.handle_inbound(inbound("A", chat="group"))
    assert "不明确" in await svc.interactions.handle_inbound(inbound("C"))
    assert (await svc.get(lid, uid))["pending_judgment"]["judgment_id"] == j["judgment_id"]
    assert "继续" in await svc.interactions.handle_inbound(inbound("A " + j["code"]))
    resumed = await svc.get(lid, uid)
    assert resumed["progress"]["feedback"] == "合并重复项"
    assert int(time.time()) + 55 <= resumed["next_run_at"] <= int(time.time()) + 65
    assert resumed["checkpoint_index"] == 0
    assert "编号" in await svc.interactions.handle_inbound(inbound("B " + j["code"]))
    await svc.start_round(lid, uid)
    await settle(svc)
    second = (await svc.get(lid, uid))["pending_judgment"]
    assert second["judgment_id"] != j["judgment_id"]
    assert "编号" in await svc.interactions.handle_inbound(inbound("A " + j["code"]))
    await asyncio.gather(
        svc.interactions.handle_inbound(inbound("B " + second["code"])),
        svc.judge(
            lid,
            uid,
            JudgmentBody(judgment_id=second["judgment_id"], action="feedback", feedback="全部保留"),
        ),
        return_exceptions=True,
    )
    assert len([x for x in svc.repos.loop_repo.judgments(lid) if x["status"] == "resolved"]) == 2
    assert (await svc.get(lid, uid))["progress"]["feedback"] == "全部保留"


async def test_routine_builder_returns_one_task_and_keeps_legacy_builder_compatible(env):
    from octop.infra.loops.models import BuilderBody, BuilderReply

    svc, uid, agents, _cron = env
    routine = definition(
        task_mode="routine",
        kind="continuous",
        calendar_trigger="cron:0 9 * * *",
        human_review={
            "checkpoints": [
                {
                    "name": "检查汇总",
                    "instruction": "每天汇总新增资料",
                    "expected_outcome": "确认摘要有用",
                }
            ]
        },
    )
    llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=SimpleNamespace(
                content=BuilderReply(
                    message="已安排每日汇总", ready=True, proposal=routine
                ).model_dump_json()
            )
        )
    )
    harness = agents.get_agent.return_value
    harness.model_factory = SimpleNamespace(get=lambda _: llm)
    harness.config.pick_default_model_ref = lambda: "configured-model"
    agents.get_config.return_value = {"tools_disabled": ["execute"]}
    body = BuilderBody(
        agent_id="expert",
        task_mode="routine",
        current=routine,
        messages=[
            {"role": "user", "content": "每天汇总"},
            {"role": "assistant", "content": "几点运行？"},
            {"role": "user", "content": "每天9点"},
        ],
    )
    result = await svc.build(uid, body)
    assert result.ready and result.proposal.task_mode == "routine"
    assert "ONE repeatable standard small task" in llm.ainvoke.call_args.args[0][0].content
    assert not svc._tasks and await svc.list_loops(uid) == []
    llm.ainvoke.return_value.content = BuilderReply(
        message="项目方案",
        ready=True,
        proposal=definition(
            human_review={
                "checkpoints": [
                    {"name": "方案", "instruction": "写方案", "expected_outcome": "验收"}
                ]
            }
        ),
    ).model_dump_json()
    with pytest.raises(OctopError):
        await svc.build(uid, body)
    assert definition().task_mode == "goal"


async def test_reader_report_is_persisted_with_pending_judgment_without_approval(env):
    svc, uid, agents, _cron = env
    lid = await ready(svc, uid)
    report = {
        "title": "资料摘要",
        "overview": "两项关键发现",
        "highlights": ["应优先核实来源"],
        "sections": [{"title": "发现", "body": "完整正文", "sources": ["https://example.com"]}],
        "limitations": ["需要本人判断"],
    }

    async def stream(_aid, _request):
        yield {
            "type": "token",
            "content": json.dumps(
                {
                    "outcome": "complete",
                    "summary": "摘要已生成",
                    "report": report,
                }
            ),
        }

    agents.stream = stream
    await svc.start_round(lid, uid)
    await settle(svc)
    row = await svc.get(lid, uid)
    assert row["status"] == "awaiting_judgment"
    assert row["pending_judgment"]["payload"]["report"] == report
    assert row["pending_judgment"]["decision"] is None
    assert svc.repos.loop_repo.rounds(lid)[0]["result"]["decision"]["report"] == report


async def test_delete_retains_reports_cancels_judgment_and_restores_stopped(env):
    svc, uid, _agents, _cron = env
    lid = await ready(svc, uid)
    await svc.start_round(lid, uid)
    await settle(svc)
    before = await svc.rounds(lid, uid)
    with pytest.raises(OctopError):
        await svc.delete(lid, uid + 100)
    row = await svc.delete(lid, uid)
    assert row["status"] == "deleted" and not row["enabled"] and row["next_run_at"] is None
    assert row["pending_judgment"] is None
    assert await svc.list_loops(uid) == []
    assert (await svc.list_loops(uid, deleted=True))[0]["loop_id"] == lid
    assert await svc.rounds(lid, uid) == before
    assert (await svc.delete(lid, uid))["status"] == "deleted"
    for action in ["resume", "pause", "stop", "resolve", "release"]:
        with pytest.raises(OctopError):
            await svc.control(lid, uid, action)
    # A stale in-flight pause/update cannot bring a tombstone back to life.
    svc.repos.loop_repo.pause(lid)
    svc.repos.loop_repo.update(lid, status="scheduled", enabled=1)
    assert svc.repos.loop_repo.get(lid)["status"] == "deleted"
    with pytest.raises(OctopError):
        await svc.start_round(lid, uid, trial=True)
    restored = await svc.control(lid, uid, "restore")
    assert restored["status"] == "stopped" and not restored["enabled"]
    assert restored["next_run_at"] is None
    assert await svc.list_loops(uid, deleted=True) == []
    assert await svc.rounds(lid, uid) == before
    with pytest.raises(OctopError):
        await svc.enable(lid, uid)


async def test_delete_cancels_active_round_and_survives_restart(env):
    svc, uid, agents, _cron = env
    lid = await ready(svc, uid)
    started = asyncio.Event()

    async def stream(_aid, _request):
        started.set()
        await asyncio.Event().wait()
        yield {"type": "token", "content": "unreachable"}

    agents.stream = stream
    await svc.start_round(lid, uid)
    await asyncio.wait_for(started.wait(), 3)
    deleted = await svc.delete(lid, uid)
    assert deleted["status"] == "deleted"
    assert all(r["status"] != "running" for r in await svc.rounds(lid, uid))
    await svc.boot()
    assert (await svc.get(lid, uid))["status"] == "deleted"
    await svc.shutdown()


@pytest.mark.parametrize(
    "tool,expected", [("current_time", "execution_failed"), ("write_file", "execution_unknown")]
)
async def test_denied_tool_after_clock_is_known_failure_but_writes_are_uncertain(
    env, tool, expected
):
    svc, uid, agents, _cron = env

    async def denied(_aid, _req):
        scope = loop_scope.get()
        scope.events.append({"tool": tool, "status": "success"})
        raise PermissionError("loop_tool_outside_scope")
        yield

    agents.stream = denied
    row = await svc.create(uid, definition())
    await svc.start_round(row["loop_id"], uid, trial=True)
    await settle(svc)
    assert (await svc.get(row["loop_id"], uid))["reason"] == expected
    result = (await svc.rounds(row["loop_id"], uid))[0]["result"]
    assert result["error"] == "tool_not_authorized"


async def test_delivery_requires_binding_before_trial_or_enable(env):
    svc, uid, _agents, _cron = env
    row = await svc.create(
        uid, definition(task_mode="routine", kind="continuous", deliver_result=True)
    )
    with pytest.raises(OctopError) as error:
        await svc.start_round(row["loop_id"], uid, trial=True)
    assert error.value.code.value == "LOOP_CHANNEL_REQUIRED"
    assert not await svc.rounds(row["loop_id"], uid)


async def delivery_trial(env):
    svc, uid, agents, _cron = env
    bid = await bind_owner(svc, uid)

    async def message(_aid, req):
        text = str(req)
        assert "active_stage" in text and "owner_channel_delivery" in text
        # A routine must never be instructed to carry out a review stage.
        assert '"active_stage": null' in text
        yield {
            "type": "token",
            "content": json.dumps(
                {
                    "outcome": "complete",
                    "summary": "Message prepared",
                    "delivery_text": "今晚记得好好吃饭。",
                }
            ),
        }

    agents.stream = message
    row = await svc.create(
        uid,
        definition(
            task_mode="routine", kind="continuous", deliver_result=True, channel_binding_id=bid
        ),
    )
    await svc.start_round(row["loop_id"], uid, trial=True)
    await settle(svc)
    return svc, uid, row["loop_id"], bid


async def test_result_delivery_is_durable_and_sent_once(env):
    svc, uid, lid, bid = await delivery_trial(env)
    rounds = await svc.rounds(lid, uid)
    assert rounds[0]["status"] == "ok"
    notifications = svc.repos.loop_repo.notifications(lid)
    assert len(notifications) == 1
    assert notifications[0]["message"] == "今晚记得好好吃饭。"
    # Retrying persistence must not enqueue the same round twice.
    svc.repos.loop_repo.update(lid, status="running")
    svc.repos.loop_repo.finish_round(
        rounds[0]["round_id"],
        "ok",
        rounds[0]["result"],
        delivery={"binding_id": bid, "message": "duplicate"},
    )
    assert len(svc.repos.loop_repo.notifications(lid)) == 1
    svc.gateway.push_text = AsyncMock()
    await svc.interactions.deliver_due()
    await svc.interactions.deliver_due()
    svc.gateway.push_text.assert_awaited_once()
    assert svc.repos.loop_repo.notifications(lid)[0]["status"] == "sent"


@pytest.mark.parametrize("action", ["stop", "revoke", "revise"])
async def test_queued_result_never_sends_after_stop_revoke_or_new_version(env, action):
    svc, uid, lid, bid = await delivery_trial(env)
    if action == "stop":
        await svc.control(lid, uid, "stop")
    elif action == "revoke":
        await svc.interactions.revoke_binding(uid, bid)
    else:
        row = await svc.get(lid, uid)
        await svc.revise(
            lid, uid, LoopDefinition.model_validate(row["definition"] | {"name": "Changed"})
        )
    svc.gateway.push_text = AsyncMock()
    await svc.interactions.deliver_due()
    svc.gateway.push_text.assert_not_awaited()


async def test_result_unknown_delivery_is_never_replayed_after_restart(env):
    svc, uid, lid, _bid = await delivery_trial(env)
    row = svc.repos.loop_repo.notifications(lid)[0]
    assert svc.repos.loop_repo.notification_claim(row["notification_id"])
    svc.repos.loop_repo.recover_notifications()
    svc.gateway.push_text = AsyncMock()
    await svc.interactions.deliver_due()
    svc.gateway.push_text.assert_not_awaited()
    assert svc.repos.loop_repo.notifications(lid)[0]["status"] == "uncertain"


async def test_owner_binding_reused_across_experts_but_never_users(env):
    svc, uid, _a, _c = env
    bid = await bind_owner(svc, uid)
    svc.repos.agent_repo.create(agent_id="automation", user_id=uid, name="Automation")
    assert (await svc.interactions.require_binding(uid, "automation", bid))["binding_id"] == bid
    again = await svc.interactions.create_binding(uid, "expert", "channel-1")
    assert again == {"binding_id": bid, "status": "active"}
    other = svc.repos.user_repo.create(username="bob", password_hash="x", role="user")
    svc.repos.agent_repo.create(agent_id="bob", user_id=other, name="Bob")
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(other, "bob", bid)
    await svc.interactions.revoke_binding(uid, bid)
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(uid, "automation", bid)


async def test_wechat_transport_reuses_verified_recipient_without_old_bot_routing(env):
    svc, uid, _a, _c = env
    # Existing, owner-confirmed WeChat platform identity.
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    svc.repos.channel_repo.create(
        channel_id="channel-1",
        agent_id="expert",
        user_id=uid,
        kind="weixin",
        name="Old",
        config_json='{"token":"old"}',
    )
    challenge = await svc.interactions.create_binding(uid, "expert", "channel-1")
    await svc.interactions.handle_inbound(
        inbound("绑定 " + challenge["code"], subject="owner@im.wechat")
    )
    await svc.interactions.confirm_binding(uid, challenge["binding_id"])
    svc.repos.agent_repo.create(agent_id="automation", user_id=uid, name="Automation")
    svc.repos.channel_repo.create(
        channel_id="new-channel",
        agent_id="automation",
        user_id=uid,
        kind="weixin",
        name="New",
        config_json='{"token":"new"}',
    )
    proof = owner_proof.issue(uid, "automation", "weixin", "owner@im.wechat", {"token": "new"})
    reused = await svc.interactions.create_binding(uid, "automation", "new-channel", proof)
    assert reused["status"] == "active" and "code" not in reused
    row = await svc.interactions.require_binding(uid, "automation", reused["binding_id"])
    assert row["subject_id"] == "owner@im.wechat"
    assert json.loads(row["routing_json"]) == {}
    assert (await svc.interactions.create_binding(uid, "automation", "new-channel")) == reused
    svc.repos.channel_repo.update("new-channel", config_json='{"token":"changed"}')
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(uid, "automation", reused["binding_id"])


async def test_reconnecting_same_wechat_recipient_preserves_loop_binding(env):
    svc, uid, _a, _c = env
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    svc.repos.channel_repo.create(
        channel_id="channel-1",
        agent_id="expert",
        user_id=uid,
        kind="weixin",
        name="Wechat",
        config_json='{"token":"old"}',
    )
    challenge = await svc.interactions.create_binding(uid, "expert", "channel-1")
    await svc.interactions.handle_inbound(
        inbound("绑定 " + challenge["code"], subject="owner@im.wechat")
    )
    await svc.interactions.confirm_binding(uid, challenge["binding_id"])
    svc.repos.channel_repo.update("channel-1", config_json='{"token":"new"}')
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(uid, "expert", challenge["binding_id"])
    assert (await svc.interactions.create_binding(uid, "expert", "channel-1"))[
        "status"
    ] == "awaiting_message"
    proof = owner_proof.issue(uid, "expert", "weixin", "owner@im.wechat", {"token": "new"})
    reconnected = await svc.interactions.create_binding(uid, "expert", "channel-1", proof)
    assert reconnected == {"binding_id": challenge["binding_id"], "status": "active"}
    assert (await svc.interactions.require_binding(uid, "expert", reconnected["binding_id"]))[
        "subject_id"
    ] == "owner@im.wechat"
    assert "绑定" in await svc.interactions.handle_inbound(
        inbound("进展", subject="attacker@im.wechat")
    )


@pytest.mark.parametrize("kind", ["weixin", "qq", "wecom", "feishu", "dingtalk"])
async def test_any_private_message_requires_one_app_confirmation_for_all_channels(env, kind):
    svc, uid, _a, _c = env
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    svc.repos.channel_repo.create(
        channel_id="channel-1",
        agent_id="expert",
        user_id=uid,
        kind=kind,
        name=kind,
        config_json="{}",
    )
    challenge = await svc.interactions.create_binding(uid, "expert", "channel-1")
    msg = inbound("你好，是我，今天想试一下").model_copy(update={"channel_type": kind})
    stale = msg.model_copy(update={"timestamp": 1})
    await svc.interactions.handle_inbound(stale)
    assert (await svc.interactions.list_bindings(uid))[0]["status"] == "awaiting_message"
    result = await svc.interactions.handle_inbound(msg)
    assert "确认连接" in result
    pending = (await svc.interactions.list_bindings(uid))[0]
    assert pending["message_preview"] == msg.text
    with pytest.raises(OctopError):
        await svc.interactions.require_binding(uid, "expert", challenge["binding_id"])
    await svc.interactions.handle_inbound(inbound("我来抢先确认", subject="attacker"))
    assert (await svc.interactions.list_bindings(uid))[0]["subject_id"] == "owner-platform"
    await svc.interactions.confirm_binding(uid, challenge["binding_id"])
    binding = await svc.interactions.require_binding(uid, "expert", challenge["binding_id"])
    assert binding["status"] == "active"
    assert "无效" in await svc.interactions.handle_inbound(
        inbound("配对 " + challenge["code"], subject="other")
    )
    assert (await svc.interactions.create_binding(uid, "expert", "channel-1"))[
        "binding_id"
    ] == challenge["binding_id"]


@pytest.mark.parametrize(
    "kind,config",
    [
        ("weixin", {"bot_uin": "bot", "token": "secret"}),
        ("qq", {"app_id": "bot", "secret": "secret"}),
    ],
)
async def test_qr_owner_proof_scoped_single_use_and_rejects_forgery(env, kind, config):
    svc, uid, _a, _c = env
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    svc.repos.channel_repo.create(
        channel_id="channel-1",
        agent_id="expert",
        user_id=uid,
        kind=kind,
        name=kind,
        config_json=json.dumps(config),
    )
    proof = owner_proof.issue(uid, "expert", kind, "scan-owner", config)
    with pytest.raises(OctopError):
        await svc.interactions.create_binding(uid, "expert", "channel-1", "forged")
    wrong = owner_proof.issue(uid + 1, "expert", kind, "attacker", config)
    with pytest.raises(OctopError):
        await svc.interactions.create_binding(uid, "expert", "channel-1", wrong)
    connected = await svc.interactions.create_binding(uid, "expert", "channel-1", proof)
    assert connected["status"] == "active" and "code" not in connected
    assert (await svc.interactions.require_binding(uid, "expert", connected["binding_id"]))[
        "subject_id"
    ] == "scan-owner"
    with pytest.raises(OctopError):
        await svc.interactions.create_binding(uid, "expert", "channel-1", proof)


def test_qr_proof_expiry_and_credential_match(monkeypatch):
    config = {"app_id": "app", "secret": "secret"}
    proof = owner_proof.issue(1, "expert", "qq", "owner", config)
    assert owner_proof.consume(proof, 1, "expert", "qq", {**config, "secret": "changed"}) is None
    assert owner_proof.consume(proof, 1, "other", "qq", config) is None
    monkeypatch.setattr(owner_proof.time, "time", lambda: 99999999999)
    assert owner_proof.consume(proof, 1, "expert", "qq", config) is None


async def test_scheduled_round_needs_no_cloud_budget_lease(env, monkeypatch):
    svc, uid, agents, cron = env
    lid = await ready(svc, uid)
    tick = cron._scheduler.add_job.call_args.args[0]
    called = []
    original = agents.stream

    async def record(*args, **kwargs):
        called.append(args)
        async for chunk in original(*args, **kwargs):
            yield chunk

    agents.stream = record
    monkeypatch.setenv("WANX_MODEL_GATEWAY_URL", "http://127.0.0.1:1")
    await tick()
    await settle(svc)
    row = await svc.get(lid, uid)
    assert called
    assert row["reason"] != "cloud_budget_authorization_required"
    assert row["status"] != "running"


async def test_personal_agent_normal_messages_require_verified_owner(env):
    svc, uid, _a, _c = env
    # Other experts retain their existing conversational behavior.
    assert await svc.interactions.handle_inbound(inbound("An ordinary question")) is None
    svc.repos.user_repo.set_preference(uid, "wanx_assistant_agent_id", "expert")
    assert "验证" in await svc.interactions.handle_inbound(inbound("An ordinary question"))
    bid = await bind_owner(svc, uid)
    svc.executor.ensure = AsyncMock(return_value={"agent_id": "expert"})
    message = inbound("An ordinary question")
    message.metadata["message_id"] = "synthetic-inbound-1"
    assert await svc.interactions.handle_inbound(message) is None
    assert await svc.interactions.handle_inbound(message) is None
    intake = await svc.list_loops(uid)
    assert intake == []
    assert not svc._tasks
    assert (
        await svc.interactions.handle_inbound(inbound("An ordinary question", subject="visitor"))
        is not None
    )
    assert (
        await svc.interactions.handle_inbound(inbound("An ordinary question", chat="group"))
        is not None
    )
    await svc.interactions.revoke_binding(uid, bid)
    assert await svc.interactions.handle_inbound(inbound("An ordinary question")) is not None

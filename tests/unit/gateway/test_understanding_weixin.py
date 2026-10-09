"""Understanding invitations keep actual speech, bindings and uncertain sends separate."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from octop_gateway.models import TextContent
from pydantic import ValidationError

from octop.api.routers.chat.models import ChatTurnBody, UserTurnWsFrame
from octop.api.routers.chat.turn import (
    PreparedDashboardTurn,
    build_dashboard_inbound,
    prepare_dashboard_turn,
)
from octop.infra.agents.understanding_types import UnderstandingInvitation, UnderstandingState
from octop.infra.agents.understanding_weixin import (
    deliver_understanding_invitation,
    finish_care_push,
    reserve_care_push,
    resolve_weixin_invitation,
)
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.channels.zhijun_weixin import assert_private_weixin_recipient


def invitation(iid: str = "topic-1", title: str = "团队变化") -> UnderstandingInvitation:
    return UnderstandingInvitation(
        id=iid,
        title=title,
        question="当时这件事对你意味着什么？",
        summary="资料里提及一次分工变化。",
        quote="分工调整后，我们重新协作。",
        source={
            "kb_id": "own-library",
            "document_id": "doc-1",
            "filename": "日记.txt",
            "source_version": "version-1",
            "start": 0,
            "end": 20,
        },
        activation_phrase=f"聊聊「{title}」",
        created_at="2026-10-01T00:00:00+00:00",
    )


@pytest.fixture
def env(monkeypatch):
    from octop.infra.agents import knowledge_understanding as domain

    now = datetime(2026, 10, 1, 2, tzinfo=UTC)
    workspace = SimpleNamespace(
        state=UnderstandingState(
            enabled=True,
            weixin_reminders=True,
            invitations=[invitation()],
        )
    )

    async def read(_workspace):
        return _workspace.state.model_copy(deep=True)

    async def save(_workspace, state):
        _workspace.state = state.model_copy(deep=True)

    row = SimpleNamespace(agent_id="own-profile", user_id=7, application_id="zhijun")
    session = SimpleNamespace(
        agent_id=row.agent_id,
        user_id=7,
        channel_type="weixin",
        channel_chat_type="dm",
        channel_id="own-channel",
        session_key="own-session",
        thread_id="own-thread",
        channel_subject_id="own-weixin",
        channel_metadata={"account_id": "bot-account", "from_user_id": "own-weixin"},
    )
    channel = SimpleNamespace(
        channel_id=session.channel_id,
        agent_id=row.agent_id,
        user_id=7,
        enabled=True,
        kind="weixin",
        config_json=json.dumps(
            {
                "owner_weixin_user_id": "own-weixin",
                "accounts": [{"account_id": "bot-account"}],
            }
        ),
    )
    care = SimpleNamespace(
        enabled=True,
        active_hours_start="09:00",
        active_hours_end="22:00",
        min_interval_hours=5,
    )
    gateway = SimpleNamespace(
        get_channel=Mock(return_value=channel),
        require_session=Mock(return_value=session),
        push_session_text=AsyncMock(),
    )

    async def locked(_aid, _sk, operation):
        await operation()

    gateway.run_in_session = AsyncMock(side_effect=locked)
    registry = SimpleNamespace(
        get_agent=Mock(return_value=SimpleNamespace(workspace=workspace)),
        get_row=Mock(return_value=row),
        octop_config=SimpleNamespace(default_timezone="Asia/Shanghai"),
        _repos=SimpleNamespace(
            session_repo=SimpleNamespace(
                list_by_agent=Mock(return_value=[session]), get=Mock(return_value=session)
            ),
            proactive_care_config_repo=SimpleNamespace(get=Mock(return_value=care)),
            care_push_repo=SimpleNamespace(latest_push_at=Mock(return_value=None)),
            user_repo=SimpleNamespace(get=Mock(return_value=SimpleNamespace(locale="zh"))),
        ),
        ontology=SimpleNamespace(gateway=gateway),
    )

    async def resolve(_registry, uid, iid):
        item = next((i for i in workspace.state.invitations if i.id == iid), None)
        if (
            uid != 7
            or item is None
            or item.status in {"invalid", "dismissed"}
            or not item.source_available
        ):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return item.model_dump()

    def owned(_registry, uid):
        if uid != 7:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return row

    monkeypatch.setattr(domain, "_read_state", read)
    monkeypatch.setattr(domain, "_save_state", save)
    monkeypatch.setattr(domain, "resolve_invitation", resolve)
    monkeypatch.setattr(domain, "_owned", owned)

    async def start(_registry, _uid, iid):
        item = next(i for i in workspace.state.invitations if i.id == iid)
        item.status = "active"
        return item.model_dump()

    activation = AsyncMock(side_effect=start)
    monkeypatch.setattr(domain, "activate_invitation", activation)
    monkeypatch.setattr("octop.infra.agents.understanding_weixin._now", lambda: now)
    return SimpleNamespace(
        registry=registry,
        row=row,
        workspace=workspace,
        session=session,
        channel=channel,
        care=care,
        gateway=gateway,
        now=now,
        activation=activation,
    )


async def deliver(env):
    await deliver_understanding_invitation(env.registry, env.row, env.workspace.state)


async def activate(env, text, **overrides):
    kwargs = {
        "channel_id": "own-channel",
        "session_key": "own-session",
        "text": text,
        "account_id": "bot-account",
        "subject_id": "own-weixin",
    }
    return await resolve_weixin_invitation(env.registry, 7, **{**kwargs, **overrides})


def test_http_ws_invitation_context_never_changes_actual_text():
    frame = UserTurnWsFrame(text="这件事让我很难受", invitation_id="topic-1")
    body = frame.to_turn_body()
    assert body.messages == [{"role": "user", "content": "这件事让我很难受"}]
    assert body.invitation_id == "topic-1"
    direct = ChatTurnBody(messages=body.messages, invitation_id="topic-1")
    assert direct.messages == body.messages
    with pytest.raises(ValidationError):
        UserTurnWsFrame(text="hello", invitation_id="x" * 129)
    prepared = PreparedDashboardTurn(
        thread_id="own-thread",
        session_key="own-session",
        mcp_servers=[],
        skills=[],
        model_ref=None,
        inbound_content=[TextContent(text="这件事让我很难受")],
        composer_context=None,
        inbound_attachments=[],
        application_id="zhijun",
    )
    inbound = build_dashboard_inbound(
        agent_id="own-profile",
        user_id=7,
        prepared=prepared,
        turn=direct,
        ws_connection_id="ws",
    )
    assert inbound.text == "这件事让我很难受"
    assert inbound.metadata["zhijun_invitation_id"] == "topic-1"
    assert "当时这件事" not in inbound.text


async def test_cross_profile_invitation_is_rejected_before_thread_or_model(env, monkeypatch):
    env.row.default_model = None
    monkeypatch.setattr("octop.api.routers.chat.turn.require_agent_row", lambda *_a, **_k: env.row)
    server = SimpleNamespace(app_runtime=SimpleNamespace(agent_registry=env.registry))
    with pytest.raises(OctopError) as error:
        await prepare_dashboard_turn(
            server,
            agent_id="own-profile",
            user=SimpleNamespace(id=7),
            turn=ChatTurnBody(text="我的实际回答", invitation_id="foreign-invitation"),
        )
    assert error.value.code == ErrorCode.NOT_FOUND
    env.registry.get_agent.assert_not_called()
    env.row.application_id = "wanx"
    with pytest.raises(OctopError) as error:
        await prepare_dashboard_turn(
            server,
            agent_id="own-profile",
            user=SimpleNamespace(id=7),
            turn=ChatTurnBody(text="我的实际回答", invitation_id="topic-1"),
        )
    assert error.value.code == ErrorCode.NOT_FOUND


async def test_validated_context_reaches_human_kwargs_without_prepending(env, monkeypatch):
    from octop_gateway.models import ChannelSubject, InboundMessage

    from octop.infra.gateway.process.processor import GlobalProcessor

    monkeypatch.setattr(
        "octop.infra.gateway.process.processor.media_backend_for_agent", lambda *_a: None
    )
    processor = object.__new__(GlobalProcessor)
    processor._agent_manager = env.registry
    processor._agent_repo = SimpleNamespace(get=lambda _aid: env.row)
    processor._user_repo = env.registry._repos.user_repo
    processor._resolve_harness_model = Mock(return_value=None)
    processor._resolve_reasoning_overrides = Mock(return_value={})
    processor._resolve_turn_mcp_servers = AsyncMock(return_value=[])
    processor.teams = SimpleNamespace(stamp_host_runtime=Mock())
    processor._attach_turn_knowledge_config = Mock()
    processor._apply_turn_hitl_policy = Mock()
    processor._stamp_turn_conversation_mode = lambda request, **_kwargs: request
    message = InboundMessage(
        channel_id="ws",
        channel_type="dashboard",
        tenant_id="own-profile",
        channel_subject=ChannelSubject(subject_id="7"),
        content=[TextContent(text="那时我刚换团队")],
        metadata={"zhijun_invitation_id": "topic-1"},
    )
    request = await processor._build_dashboard_request(
        message,
        agent_id="own-profile",
        user_id=7,
        session_key="own-session",
        thread_id="own-thread",
        meta=message.metadata,
    )
    human = request["messages"][0]
    assert human.content == "那时我刚换团队"
    assert human.additional_kwargs["zhijun_invitation_id"] == "topic-1"


async def test_submission_is_persisted_and_does_not_run_a_chat(env):
    await deliver(env)
    env.gateway.push_session_text.assert_awaited_once()
    assert env.workspace.state.weixin_deliveries[0]["status"] == "submitted"
    assert env.workspace.state.weixin_deliveries[0]["subject_id"] == "own-weixin"
    text = env.gateway.push_session_text.call_args.args[1]
    assert text == "有空时，回来和知君聊聊吧。"
    assert "团队变化" not in text
    assert env.workspace.state.invitations[0].question not in text
    await deliver(env)
    env.gateway.push_session_text.assert_awaited_once()


async def test_unavailable_source_waits_without_reserving_and_recovers(env):
    env.workspace.state.invitations[0].source_available = False
    await deliver(env)
    assert env.workspace.state.weixin_deliveries == []
    env.gateway.push_session_text.assert_not_awaited()

    env.workspace.state.invitations[0].source_available = True
    await deliver(env)
    env.gateway.push_session_text.assert_awaited_once()
    assert env.workspace.state.weixin_deliveries[0]["status"] == "submitted"


@pytest.mark.parametrize("attempted", [False, True])
async def test_source_becomes_unavailable_before_attempt_can_recover(env, attempted):
    async def source_changes_while_queued(_aid, _sk, operation):
        env.workspace.state.invitations[0].source_available = False
        await operation()

    env.gateway.run_in_session.side_effect = source_changes_while_queued
    await deliver(env)
    failed = env.workspace.state.weixin_deliveries[0]
    assert failed["status"] == "failed"
    assert failed["error"] == "source_unavailable"
    assert not failed.get("attempted_at")
    env.gateway.push_session_text.assert_not_awaited()

    async def unchanged(_aid, _sk, operation):
        await operation()

    env.gateway.run_in_session.side_effect = unchanged
    env.workspace.state.invitations[0].source_available = True
    if attempted:
        failed["attempted_at"] = env.now.isoformat()
    await deliver(env)
    if attempted:
        env.gateway.push_session_text.assert_not_awaited()
        assert len(env.workspace.state.weixin_deliveries) == 1
    else:
        env.gateway.push_session_text.assert_awaited_once()
        assert len(env.workspace.state.weixin_deliveries) == 2
        assert env.workspace.state.weixin_deliveries[-1]["status"] == "submitted"


@pytest.mark.parametrize("disabled", ["understanding", "reminder", "care", "channel", "hours"])
async def test_reminders_require_all_opt_ins_and_active_hours(env, disabled):
    if disabled == "understanding":
        env.workspace.state.enabled = False
    elif disabled == "reminder":
        env.workspace.state.weixin_reminders = False
    elif disabled == "care":
        env.care.enabled = False
    elif disabled == "channel":
        env.channel.enabled = False
    else:
        env.care.active_hours_start = "12:00"
    await deliver(env)
    env.gateway.push_session_text.assert_not_awaited()


@pytest.mark.parametrize("mismatch", ["account", "subject", "foreign", "group"])
async def test_current_binding_is_checked_before_any_submission(env, mismatch):
    if mismatch == "account":
        env.session.channel_metadata["account_id"] = "old-account"
    elif mismatch == "subject":
        env.session.channel_subject_id = "stranger"
    elif mismatch == "foreign":
        env.channel.agent_id = "wanx-profile"
    else:
        env.session.channel_chat_type = "group"
    await deliver(env)
    env.gateway.push_session_text.assert_not_awaited()


async def test_uncertain_delivery_is_never_auto_repeated(env):
    env.gateway.push_session_text.side_effect = TimeoutError()
    await deliver(env)
    assert env.workspace.state.weixin_deliveries[0]["status"] == "unknown"
    env.workspace.state.weixin_deliveries[0]["attempted_at"] = (
        env.now - timedelta(days=8)
    ).isoformat()
    env.workspace.state.weixin_deliveries[0]["expires_at"] = (
        env.now - timedelta(days=1)
    ).isoformat()
    await deliver(env)
    env.gateway.push_session_text.assert_awaited_once()


async def test_concurrent_runs_submit_only_one_invitation(env):
    await asyncio.gather(deliver(env), deliver(env))
    env.gateway.push_session_text.assert_awaited_once()


async def test_one_daily_reminder_uses_server_calendar_even_after_interval(env, monkeypatch):
    await deliver(env)
    env.workspace.state.weixin_deliveries[0]["activated_at"] = env.now.isoformat()
    env.workspace.state.invitations.append(invitation("topic-2", "另一段经历"))
    monkeypatch.setattr(
        "octop.infra.agents.understanding_weixin._now", lambda: env.now + timedelta(hours=6)
    )
    await deliver(env)
    env.gateway.push_session_text.assert_awaited_once()


async def test_route_change_while_queued_cancels_without_submission(env):
    async def changed(_aid, _sk, operation):
        env.channel.config_json = json.dumps(
            {
                "owner_weixin_user_id": "new-owner",
                "accounts": [{"account_id": "new-account"}],
            }
        )
        await operation()

    env.gateway.run_in_session.side_effect = changed
    await deliver(env)
    env.gateway.push_session_text.assert_not_awaited()
    assert env.workspace.state.weixin_deliveries[0]["status"] == "failed"


async def test_post_submission_save_failure_keeps_unknown_instead_of_fake_failure(env, monkeypatch):
    from octop.infra.agents import knowledge_understanding as domain

    saved = domain._save_state
    failed_once = False

    async def fail_after_submission(workspace, state):
        nonlocal failed_once
        if state.weixin_deliveries[-1]["status"] == "submitted" and not failed_once:
            failed_once = True
            raise OSError("synthetic write failure")
        await saved(workspace, state)

    monkeypatch.setattr(domain, "_save_state", fail_after_submission)
    await deliver(env)
    assert env.workspace.state.weixin_deliveries[0]["status"] == "unknown"
    await deliver(env)
    env.gateway.push_session_text.assert_awaited_once()


async def test_ordinary_messages_are_never_guessed_as_answers(env):
    await deliver(env)
    assert await activate(env, "今天累了，先聊别的") is None
    assert await activate(env, "聊聊") is None
    assert await activate(env, "资料里说聊聊「团队变化」") is None
    result = await activate(env, "聊聊「团队变化」：这是我写的，当时刚换团队。")
    assert result["id"] == "topic-1"
    env.activation.assert_awaited_once_with(env.registry, 7, "topic-1")


async def test_changed_account_expired_or_ambiguous_topics_do_not_bind(env):
    await deliver(env)
    assert await activate(env, "聊聊「团队变化」", account_id="old-account") is None
    env.workspace.state.weixin_deliveries.append(dict(env.workspace.state.weixin_deliveries[0]))
    assert await activate(env, "聊聊「团队变化」") is None
    env.workspace.state.weixin_deliveries.pop()
    env.workspace.state.weixin_deliveries[0]["expires_at"] = (
        env.now - timedelta(seconds=1)
    ).isoformat()
    assert await activate(env, "聊聊「团队变化」") is None
    env.activation.assert_not_awaited()


async def test_only_explicit_activation_enables_background_and_topic_change_clears_it(env):
    await deliver(env)
    assert await activate(env, "这次调整让我不太适应") is None
    assert (await activate(env, "聊聊「团队变化」"))["id"] == "topic-1"
    assert (await activate(env, "我当时觉得自己没有被尊重"))["id"] == "topic-1"
    assert await activate(env, "这个先不聊，我想说别的") is None
    assert await activate(env, "我想聊今天的工作") is None
    env.activation.assert_awaited_once()


async def test_rebound_thread_and_changed_source_cannot_restore_old_background(env):
    await deliver(env)
    await activate(env, "聊聊「团队变化」")
    env.session.thread_id = "new-topic-thread"
    assert await activate(env, "我当时挺难过的") is None
    env.session.thread_id = "own-thread"
    env.workspace.state.invitations[0].status = "invalid"
    assert await activate(env, "我当时挺难过的") is None


async def test_reminder_and_existing_care_share_a_cooldown(env):
    await deliver(env)
    assert await reserve_care_push(env.registry, env.row.agent_id) is None
    env.workspace.state.weixin_deliveries.clear()
    reservation = await reserve_care_push(env.registry, env.row.agent_id)
    assert reservation is not None
    await finish_care_push(env.registry, env.row.agent_id, reservation, "submitted")
    await deliver(env)
    env.gateway.push_session_text.assert_awaited_once()


async def test_pre_upgrade_care_timestamp_also_blocks_a_new_reminder(env):
    env.registry._repos.care_push_repo.latest_push_at.return_value = int(
        (env.now - timedelta(minutes=10)).timestamp()
    )
    await deliver(env)
    env.gateway.push_session_text.assert_not_awaited()


def test_private_push_rejects_stale_account_even_for_current_owner():
    from octop_gateway.models import ChannelSubject

    config = {"owner_weixin_user_id": "own-weixin", "accounts": [{"account_id": "new"}]}
    with pytest.raises(OctopError):
        assert_private_weixin_recipient(
            config,
            ChannelSubject(
                subject_id="own-weixin",
                metadata={"account_id": "old", "from_user_id": "own-weixin"},
            ),
        )


def test_latest_care_timestamp_is_scoped_to_agent_and_retains_existing_records(tmp_path):
    from octop.infra.db.migrate import run_migrations
    from octop.infra.db.pool import SqlitePool
    from octop.infra.db.repos.agents import AgentRepo
    from octop.infra.db.repos.care_push import CarePushRepo
    from octop.infra.db.repos.users import UserRepo

    pool = SqlitePool(tmp_path / "synthetic-cooldown.db")
    try:
        run_migrations(pool)
        owner = UserRepo(pool).create(username="synthetic", password_hash="x", role="user")
        agents = AgentRepo(pool)
        for aid in ("own", "other"):
            agents.create(agent_id=aid, user_id=owner, name=aid)
        repo = CarePushRepo(pool)
        assert repo.latest_push_at("own") is None
        repo.insert(agent_id="own", session_key="own-session", episode_ids=["a"], pushed_at=100)
        repo.insert(agent_id="own", session_key="own-session", episode_ids=["b"], pushed_at=50)
        repo.insert(agent_id="other", session_key="other-session", episode_ids=["c"], pushed_at=200)
        assert repo.latest_push_at("own") == 100
        assert repo.latest_push_at("other") == 200
    finally:
        pool.close()


async def test_current_binding_check_precedes_history_and_capture():
    from octop_gateway.models import ChannelSubject, InboundMessage, MessageEvent

    from octop.infra.gateway.channels.zhijun_weixin import private_weixin_processor

    captured = []

    async def native(message):
        captured.append(message)
        yield MessageEvent.completed()

    process = private_weixin_processor(
        native,
        agent_id="own-profile",
        owner_id="own-weixin",
        binding_check=lambda _m: False,
    )
    message = InboundMessage(
        channel_id="own-channel",
        channel_type="weixin",
        tenant_id="own-profile",
        channel_subject=ChannelSubject(subject_id="own-weixin"),
        content=[TextContent(text="hello")],
    )
    assert [event async for event in process(message)] == []
    assert captured == []

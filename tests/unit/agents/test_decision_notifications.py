"""Fixed-data checks of ownership, source sensitivity and real gateway payloads."""

import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from pydantic import ValidationError

from octop.infra.agents.decision_book import (
    DecisionCreate,
    DecisionReview,
    create_decision,
    deliver_due_decision,
    read_decisions,
    review_decision,
)
from octop.infra.agents.notification_policy import (
    ChannelPurpose,
    notification_text,
    read_channel_policies,
    set_channel_purpose,
)
from octop.infra.errors import OctopError


@pytest.fixture
def env(monkeypatch):
    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 2, 4, tzinfo=UTC)

    monkeypatch.setattr("octop.infra.agents.decision_book.datetime", FixedDatetime)
    monkeypatch.setattr("octop.infra.agents.understanding_weixin._now", lambda: FixedDatetime.now())
    files = {}

    async def read(path):
        return files.get(path)

    async def write(path, data):
        files[path] = data.decode()

    workspace = SimpleNamespace(
        aread_text=AsyncMock(side_effect=read), aupload_bytes=AsyncMock(side_effect=write)
    )
    row = SimpleNamespace(agent_id="own", user_id=7, application_id="zhijun")
    channel = SimpleNamespace(
        channel_id="channel",
        agent_id="own",
        user_id=7,
        kind="weixin",
        enabled=True,
        config_json=json.dumps(
            {"owner_weixin_user_id": "owner", "accounts": [{"account_id": "bot"}]}
        ),
    )
    session = SimpleNamespace(
        agent_id="own", user_id=7, channel_id="channel", channel_chat_type="dm", channel_metadata={}
    )
    care = SimpleNamespace(
        enabled=True, active_hours_start="00:00", active_hours_end="23:59", min_interval_hours=1
    )
    registry = SimpleNamespace(
        get_agent=Mock(
            return_value=SimpleNamespace(workspace=workspace, config=SimpleNamespace(locale="zh"))
        ),
        get_row=Mock(return_value=row),
        octop_config=SimpleNamespace(default_timezone="Asia/Shanghai"),
        _repos=SimpleNamespace(
            proactive_care_config_repo=SimpleNamespace(get=Mock(return_value=care)),
            care_push_repo=SimpleNamespace(latest_push_at=Mock(return_value=None)),
        ),
    )

    async def serial(_aid, _session_key, operation):
        await operation()

    gateway = SimpleNamespace(
        get_channel=Mock(return_value=channel),
        list_channels=Mock(return_value=[channel]),
        require_session=Mock(return_value=session),
        run_in_session=AsyncMock(side_effect=serial),
        push_session_text=AsyncMock(),
    )
    monkeypatch.setattr(
        "octop.infra.agents.personal_ontology.get_profile",
        lambda _registry, uid: row if uid == 7 else None,
    )
    return SimpleNamespace(
        registry=registry,
        row=row,
        files=files,
        gateway=gateway,
        channel=channel,
        session=session,
        care=care,
    )


async def add(env, **kwargs):
    book = await read_decisions(env.registry, 7)
    return await create_decision(
        env.registry,
        7,
        DecisionCreate(
            revision=book.revision,
            description="接下新的项目",
            expectation="两个月内回款",
            revisit_at=datetime(2001, 1, 1, tzinfo=UTC),
            **kwargs,
        ),
    )


async def private_channel(env):
    await set_channel_purpose(
        env.registry, 7, env.gateway, ChannelPurpose(channel_id="channel", purpose="private")
    )


async def test_explicit_choice_outcome_loop_preserves_original_expectation_and_is_owner_scoped(env):
    book = await add(env)
    entry = book.entries[0]
    updated = await review_decision(
        env.registry,
        7,
        entry.id,
        DecisionReview(
            revision=book.revision, outcome="实际用了三个月", reflection="下次预留更长的回款时间"
        ),
    )
    assert updated.entries[0].expectation == "两个月内回款"
    assert updated.entries[0].state == "reviewed"
    assert updated.entries[0].sensitive
    with pytest.raises(OctopError):
        await read_decisions(env.registry, 8)
    with pytest.raises(OctopError):
        await review_decision(
            env.registry, 7, entry.id, DecisionReview(revision=book.revision, outcome="stale")
        )
    with pytest.raises(ValidationError):
        DecisionReview(revision=updated.revision, source_class="owner_entry", sensitive=False)


@pytest.mark.parametrize("source", ["inner", "self_image", "episode", "heavy", "crisis"])
def test_renaming_sensitive_material_to_a_decision_never_allows_a_body(source):
    text = notification_text(
        purpose="private",
        kind="decision",
        source_class=source,
        sensitive=False,
        approved_summary="用户认可的摘要",
        locale="zh",
    )
    assert text == "有空时，回来和知君聊聊吧。"


@pytest.mark.parametrize(
    "purpose,private,summary,expected",
    [
        ("work", False, "回看项目回款", False),
        ("private", True, "回看项目回款", False),
        ("private", False, "", False),
        ("private", False, "回看项目回款", True),
    ],
)
async def test_actual_gateway_receives_only_authorized_summary(
    env, purpose, private, summary, expected
):
    if purpose == "private":
        await private_channel(env)
    await add(env, private=private, push_summary=summary)
    await deliver_due_decision(env.registry, env.row, env.gateway, "session")
    text = env.gateway.push_session_text.call_args.args[1]
    assert ("回看项目回款" in text) == expected
    assert "接下新的项目" not in text and "两个月内回款" not in text
    assert (await read_decisions(env.registry, 7)).entries[0].reminder_status == "submitted"


async def test_rebound_credentials_and_group_session_cannot_inherit_private_authorization(env):
    await private_channel(env)
    assert (await read_channel_policies(env.registry, 7, env.gateway))[0].declared
    env.channel.config_json = json.dumps({"owner_weixin_user_id": "new-owner"})
    policy = (await read_channel_policies(env.registry, 7, env.gateway))[0]
    assert policy.purpose == "work" and not policy.declared
    await private_channel(env)
    env.session.channel_chat_type = "group"
    await add(env, private=False, push_summary="允许的摘要")
    await deliver_due_decision(env.registry, env.row, env.gateway, "session")
    assert "允许的摘要" not in env.gateway.push_session_text.call_args.args[1]


async def test_private_record_immutable_and_crisis_rejected_before_any_write(env):
    with pytest.raises(OctopError):
        await create_decision(
            env.registry,
            7,
            DecisionCreate(
                revision="empty",
                description="结束自己的生命",
                expectation="明天",
                revisit_at=datetime.now(UTC),
            ),
        )
    assert env.files == {}
    book = await create_decision(
        env.registry,
        7,
        DecisionCreate(
            revision="empty",
            description="决定离婚",
            expectation="改变现状",
            revisit_at=datetime.now(UTC),
            private=False,
            push_summary="一个约定",
        ),
    )
    assert book.entries[0].sensitive


async def test_concurrent_and_uncertain_dispatch_never_auto_repeat(env):
    await add(env, private=False, push_summary="摘要")
    env.gateway.push_session_text.side_effect = TimeoutError()
    results = await asyncio.gather(
        *[deliver_due_decision(env.registry, env.row, env.gateway, "session") for _ in range(2)],
        return_exceptions=True,
    )
    assert any(isinstance(result, TimeoutError) for result in results)
    env.gateway.push_session_text.assert_awaited_once()
    assert (await read_decisions(env.registry, 7)).entries[0].reminder_status == "unknown"


@pytest.mark.parametrize("change", ["purpose", "opt_out", "cancel"])
async def test_queued_delivery_rechecks_current_authorization(env, change):
    await private_channel(env)
    await add(env, private=False, push_summary="摘要")

    async def queued(_aid, _session_key, operation):
        if change == "purpose":
            await set_channel_purpose(
                env.registry, 7, env.gateway, ChannelPurpose(channel_id="channel")
            )
        elif change == "opt_out":
            env.care.enabled = False
        else:
            book = await read_decisions(env.registry, 7)
            await review_decision(
                env.registry,
                7,
                book.entries[0].id,
                DecisionReview(revision=book.revision, action="cancel"),
            )
        await operation()

    env.gateway.run_in_session.side_effect = queued
    await deliver_due_decision(env.registry, env.row, env.gateway, "session")
    if change == "purpose":
        assert "摘要" not in env.gateway.push_session_text.call_args.args[1]
    else:
        env.gateway.push_session_text.assert_not_awaited()
        assert (await read_decisions(env.registry, 7)).entries[0].reminder_status == "none"

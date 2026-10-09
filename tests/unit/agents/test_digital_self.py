"""Publication isolation, per-visitor memory and failure recovery without live models."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage

from octop.infra.agents import digital_self as service
from octop.infra.agents.digital_self_types import (
    AccessCommand,
    HistoryCommand,
    PreviewTurn,
    SelfCommand,
    SelfDraft,
    SelfEntry,
    SelfSource,
    SourcePage,
    VisitorHistory,
    VisitorRequest,
    VisitorTurn,
)
from octop.infra.errors import OctopError


class Workspace:
    def __init__(self):
        self.files = {"SOUL.md": "PRIVATE-RULE", "memory/private.md": "PRIVATE-SECRET"}
        self.drop = False

    async def aread_text(self, path):
        return self.files.get(path)

    async def aupload_bytes(self, path, content):
        if not self.drop:
            self.files[path] = content.decode()


@pytest.fixture
def env(monkeypatch):
    rows = [
        SimpleNamespace(
            agent_id=f"agent{i}",
            user_id=i,
            application_id="zhijun",
            enabled=True,
            last_state="running",
            default_model="fake:model",
        )
        for i in (1, 2, 3)
    ]
    rows.append(SimpleNamespace(agent_id="wanx", user_id=9, application_id="wanx"))
    workspaces = {row.agent_id: Workspace() for row in rows}
    llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=AIMessage(
                content=json.dumps(
                    {
                        "answer": "PUBLISHED-ANSWER",
                        "sources": ["method"],
                        "options": ["先不展开"],
                        "memory": [{"text": "MODEL-INFERENCE", "quote": "我是访客二"}],
                    }
                )
            )
        )
    )
    harness = SimpleNamespace(
        config=SimpleNamespace(pick_default_model_ref=lambda: "fake:model"),
        model_factory=SimpleNamespace(get=Mock(return_value=llm)),
        invoke=Mock(side_effect=AssertionError("private harness must never run")),
    )
    registry = SimpleNamespace(
        get_application_profile=lambda uid, app: next(
            (r for r in rows if r.user_id == uid and r.application_id == app), None
        ),
        workspace_for_agent=lambda aid: workspaces[aid],
        get_agent=lambda _aid: harness,
        _config=SimpleNamespace(default_timezone="Asia/Shanghai"),
        _repos=SimpleNamespace(agent_repo=SimpleNamespace(list_all=lambda **_kw: rows)),
    )
    monkeypatch.setattr(service, "_model", lambda _h: {"name": "fake:model", "local": True})
    return registry, workspaces["agent1"], llm, rows


def draft(**changes):
    return SelfDraft(
        name="合成专家",
        bio="研究方法与判断",
        entries=[
            SelfEntry(id="method", title="判断的方法", text="PUBLISHED-METHOD", recognized=True)
        ],
        **changes,
    )


async def publish(reg, data=None):
    state = await service.read_self(reg, 1)
    return await service.update_self(
        reg, 1, SelfCommand(revision=state.revision, action="publish", draft=data or draft())
    )


async def approve(reg, public, uid=2):
    await service.request_access(reg, uid, public.id, VisitorRequest(note="合成咨询"))
    state = await service.read_self(reg, 1)
    return await service.review_access(
        reg, 1, AccessCommand(revision=state.revision, visitor_id=uid, action="approve")
    )


async def turn(
    reg, public, uid=2, text="我是访客二", request_id="request_000000001", assisted=False
):
    history = await service.history_page(reg, uid, public.id, 0, 40)
    return await service.visitor_turn(
        reg,
        uid,
        public.id,
        VisitorTurn(
            request_id=request_id,
            revision=history.revision,
            publication_version=public.publication.version,
            text=text,
            acknowledge_owner_visibility=True,
            assisted=assisted,
        ),
    )


async def test_empty_unpublished_default_no_model_or_private_writes(env):
    reg, ws, llm, _ = env
    before = dict(ws.files)
    state = await service.read_self(reg, 1)
    assert not state.id and state.status == "unpublished" and state.draft.access == "approval"
    assert (await service.discover(reg, 2, "", 0, 20)).items == []
    assert before == ws.files
    llm.ainvoke.assert_not_called()
    with pytest.raises(OctopError):
        await service.read_self(reg, 9)


async def test_owner_review_publish_and_local_projection(env):
    reg, ws, llm, _ = env
    data = draft()
    data.entries[0].recognized = False
    with pytest.raises(OctopError) as error:
        await publish(reg, data)
    assert error.value.status == 422
    public = await publish(reg)
    result = await service.discover(reg, 2, "方法", 0, 20)
    assert result.total == 1 and result.network_status == "contract_pending"
    payload = result.model_dump_json()
    assert (
        "PRIVATE" not in payload and "PUBLISHED-METHOD" not in payload and "agent1" not in payload
    )
    assert (await service.discover(reg, 1, "", 0, 20)).total == 0
    assert result.items[0].online and result.items[0].access_status == "none"
    with pytest.raises(OctopError):
        await service.published_entry(reg, 2, public.id, "method")
    llm.ainvoke.assert_not_called()
    assert ws.files["SOUL.md"] == "PRIVATE-RULE"


async def test_private_prompt_never_loaded_visitor_memory_isolated(env):
    reg, ws, llm, _ = env
    public = await publish(reg)
    await approve(reg, public)
    first = await turn(reg, public)
    prompt = str(llm.ainvoke.call_args.args)
    assert "PRIVATE" not in prompt and "PUBLISHED-METHOD" in prompt
    assert first.memory[0].text == "我是访客二"  # exact visitor quote, not AI inference
    assert first.messages[-1].publication_version == public.publication.version
    assert first.messages[-1].context_sources == ["method"]
    assert (await service.history_page(reg, 3, public.id, 0, 40)).messages == []
    await approve(reg, public, 3)
    await turn(reg, public, 3, "我是访客三", "request_000000002")
    last_prompt = str(llm.ainvoke.call_args.args)
    assert "我是访客二" not in last_prompt
    assert set(ws.files) == {
        "SOUL.md",
        "memory/private.md",
        service._STATE,
        "zhijun/digital-self/visitors/2.json",
        "zhijun/digital-self/visitors/3.json",
    }
    with pytest.raises(OctopError):
        await service.history_page(reg, 2, public.id, 0, 40, visitor_id=3)
    owner = await service.history_page(reg, 1, public.id, 0, 40, visitor_id=2)
    assert owner.messages == first.messages
    entry = await service.published_entry(reg, 2, public.id, "method")
    assert "source" not in entry.model_dump()


async def test_drafts_do_not_publish_and_withdrawn_answers_leave_context(env):
    reg, _ws, llm, _ = env
    public = await publish(reg)
    await approve(reg, public)
    await turn(reg, public)
    state = await service.read_self(reg, 1)
    changed = draft()
    changed.entries[0].text = "NEW-METHOD"
    await service.update_self(
        reg, 1, SelfCommand(revision=state.revision, action="save", draft=changed)
    )
    assert (await service.published_entry(reg, 2, public.id, "method")).text == "PUBLISHED-METHOD"
    latest = await publish(reg, changed)
    with pytest.raises(OctopError):
        await service.published_entry(reg, 2, public.id, "method", public.publication.version)
    await turn(reg, latest, text="接着说判断方法", request_id="request_000000003")
    payload = str(llm.ainvoke.call_args.args)
    assert (
        "NEW-METHOD" in payload
        and "PUBLISHED-ANSWER" not in payload
        and "PUBLISHED-METHOD" not in payload
    )
    with pytest.raises(OctopError) as error:
        await turn(reg, public, text="用旧版本", request_id="request_000000004")
    assert error.value.status == 409


async def test_ai_choices_not_recounted_as_independent_visitor_evidence(env):
    reg, _ws, llm, _ = env
    public = await publish(reg)
    await approve(reg, public)
    first = await turn(reg, public, assisted=True)
    assert not first.memory
    llm.ainvoke.return_value = AIMessage(
        content=json.dumps(
            {
                "answer": "好",
                "sources": ["method"],
                "memory": [{"text": "主动撤回", "quote": "先不展开"}],
            }
        )
    )
    second = await turn(reg, public, text="先不展开", request_id="request_000000005")
    assert not second.memory and second.messages[-2].assisted


async def test_idempotency_quota_and_disclosure(env):
    reg, _ws, llm, _ = env
    public = await publish(reg, draft(visitor_daily_limit=1))
    await approve(reg, public)
    first = await turn(reg, public)
    repeated = await turn(reg, public)
    assert repeated.messages == first.messages and llm.ainvoke.call_count == 1
    with pytest.raises(OctopError) as error:
        await turn(reg, public, text="再次问", request_id="request_000000006")
    assert error.value.status == 429
    with pytest.raises(OctopError):
        await service.visitor_turn(
            reg,
            2,
            public.id,
            VisitorTurn(
                request_id="request_000000007",
                revision=first.revision,
                publication_version=public.publication.version,
                text="问",
                acknowledge_owner_visibility=False,
            ),
        )


async def test_clear_syncs_owner_and_visitor_and_future_context(env):
    reg, _ws, llm, _ = env
    public = await publish(reg)
    await approve(reg, public)
    first = await turn(reg, public)
    cleared = await service.clear_history(
        reg, 2, public.id, HistoryCommand(revision=first.revision, action="clear")
    )
    assert not cleared.messages and not cleared.memory
    assert not (await service.history_page(reg, 1, public.id, 0, 40, visitor_id=2)).messages
    await turn(reg, public, text="新的问题", request_id="request_000000008")
    assert "我是访客二" not in str(llm.ainvoke.call_args.args)


@pytest.mark.parametrize("action", ["revoke", "pause", "unpublish", "publish"])
async def test_owner_change_during_inference_withholds_reply(env, action):
    reg, _ws, llm, _ = env
    public = await publish(reg)
    await approve(reg, public)
    entered, release = asyncio.Event(), asyncio.Event()

    async def invoke(*_args, **_kw):
        entered.set()
        await release.wait()
        return AIMessage(content=json.dumps({"answer": "OLD-ANSWER", "sources": ["method"]}))

    llm.ainvoke.side_effect = invoke
    pending = asyncio.create_task(turn(reg, public))
    await asyncio.wait_for(entered.wait(), timeout=2)
    with pytest.raises(OctopError) as busy:
        await turn(reg, public, 3, "并发问题", "request_000000010")
    assert busy.value.status == 409
    current = await service.read_self(reg, 1)
    if action == "revoke":
        await service.review_access(
            reg, 1, AccessCommand(revision=current.revision, visitor_id=2, action="revoke")
        )
    else:
        await service.update_self(
            reg,
            1,
            SelfCommand(
                revision=current.revision,
                action=action,
                draft=draft() if action == "publish" else None,
            ),
        )
    release.set()
    with pytest.raises(OctopError):
        await pending
    history = await service.history_page(reg, 2, public.id, 0, 40)
    assert not history.messages and history.pending_status == "failed"


async def test_failed_request_recovery_does_not_resend_or_delete_history(env):
    reg, _ws, llm, _ = env
    public = await publish(reg)
    await approve(reg, public)
    done = await turn(reg, public)
    llm.ainvoke.side_effect = TimeoutError("synthetic timeout")
    with pytest.raises(TimeoutError):
        await turn(reg, public, text="第二个问题", request_id="request_000000011")
    reg._digital_self_locks.clear()  # process restart
    recovered = await service.history_page(reg, 2, public.id, 0, 40)
    assert recovered.pending_status == "failed" and recovered.messages == done.messages
    with pytest.raises(OctopError):
        await turn(reg, public, text="第二个问题", request_id="request_000000012")
    assert llm.ainvoke.call_count == 2
    cleared = await service.clear_history(
        reg, 2, public.id, HistoryCommand(revision=recovered.revision, action="dismiss_pending")
    )
    assert cleared.messages == done.messages and cleared.pending_request is None


async def test_restart_unknown_and_bad_model_citations(env):
    reg, ws, llm, _ = env
    public = await publish(reg)
    await approve(reg, public)
    old = VisitorHistory(
        pending_request="unknown_000000001", pending_text="未完成问题", pending_status="running"
    )
    ws.files[service._history_path(2)] = old.model_dump_json()
    assert (await service.history_page(reg, 2, public.id, 0, 40)).pending_status == "unknown"
    llm.ainvoke.assert_not_called()
    await service.clear_history(
        reg, 2, public.id, HistoryCommand(revision=old.revision, action="dismiss_pending")
    )
    llm.ainvoke.return_value = AIMessage(
        content=json.dumps({"answer": "泄露", "sources": ["PRIVATE-WORKSPACE"]})
    )
    with pytest.raises(OctopError) as error:
        await turn(reg, public)
    assert error.value.status == 502
    assert not (await service.history_page(reg, 2, public.id, 0, 40)).messages


async def test_open_access_still_honors_revocation_and_offline(env):
    reg, _ws, _llm, rows = env
    public = await publish(reg, draft(access="open"))
    await service.request_access(reg, 2, public.id, VisitorRequest(contact="合成介绍与联系方法"))
    state = await service.read_self(reg, 1)
    state = await service.review_access(
        reg, 1, AccessCommand(revision=state.revision, visitor_id=2, action="contact_accept")
    )
    assert state.visitors[0].contact_status == "accepted"
    await service.review_access(
        reg, 1, AccessCommand(revision=state.revision, visitor_id=2, action="revoke")
    )
    with pytest.raises(OctopError) as error:
        await turn(reg, public)
    assert error.value.status == 403
    rows[0].last_state = "stopped"
    assert not (await service.public_card(reg, 3, public.id)).online
    with pytest.raises(OctopError) as error:
        await turn(reg, public, 3)
    assert error.value.status == 503


async def test_generation_resets_recognition_and_retains_sources_and_access(env):
    reg, _ws, llm, _ = env
    original = draft(access="approval", visitor_daily_limit=2)
    generated = draft(access="open", visitor_daily_limit=10)
    llm.ainvoke.return_value = AIMessage(content=generated.model_dump_json())
    state = await service.update_self(
        reg, 1, SelfCommand(revision="empty", action="generate", draft=original)
    )
    assert state.draft.access == "approval" and state.draft.visitor_daily_limit == 2
    assert not state.draft.entries[0].recognized and not state.publication
    llm.ainvoke.return_value = AIMessage(
        content=json.dumps({"answer": "试聊回答", "sources": ["method"]})
    )
    preview = await service.preview_self(
        reg, 1, PreviewTurn(revision=state.revision, text="试聊问题")
    )
    assert preview.answer == "试聊回答"
    assert not any("visitors/" in path for path in env[1].files)
    generated.entries.append(SelfEntry(id="extra", title="模型擅自增加", text="无证据"))
    llm.ainvoke.return_value = AIMessage(content=generated.model_dump_json())
    with pytest.raises(OctopError):
        await service.update_self(
            reg, 1, SelfCommand(revision=state.revision, action="generate", draft=original)
        )


async def test_stale_source_edit_and_save_failure_not_false_success(env, monkeypatch):
    reg, ws, llm, _ = env
    data = draft()
    data.entries[0].source = SelfSource(
        kind="memory", id="private-atom", version="v1", title="旧来源", text="旧内容"
    )
    monkeypatch.setattr(service, "_source_valid", AsyncMock(return_value=False))
    with pytest.raises(OctopError):
        await publish(reg, data)
    ws.drop = True
    with pytest.raises(OctopError) as error:
        await publish(reg)
    assert error.value.status == 503
    assert (await service.read_self(reg, 1)).status == "unpublished"
    llm.ainvoke.assert_not_called()


async def test_uncited_but_supplied_source_change_during_inference_is_withheld(env, monkeypatch):
    reg, _ws, llm, _rows = env
    data = draft()
    data.entries[0].source = SelfSource(
        kind="memory", id="owner-source", version="v1", title="依据", text="选择的原文"
    )
    valid = AsyncMock(return_value=True)
    monkeypatch.setattr(service, "_source_valid", valid)
    public = await publish(reg, data)
    await approve(reg, public)
    entered, release = asyncio.Event(), asyncio.Event()

    async def invoke(*_args, **_kwargs):
        entered.set()
        await release.wait()
        return AIMessage(
            content=json.dumps({"answer": "引用为空也不能使用失效材料", "sources": []})
        )

    llm.ainvoke.side_effect = invoke
    pending = asyncio.create_task(turn(reg, public))
    await asyncio.wait_for(entered.wait(), timeout=2)
    valid.return_value = False
    release.set()
    with pytest.raises(OctopError) as error:
        await pending
    assert error.value.code.value == "DIGITAL_SELF_SOURCE_UNAVAILABLE"
    assert not (await service.history_page(reg, 2, public.id, 0, 40)).messages


async def test_unreviewed_private_inference_needs_owner_rewritten_expression(env, monkeypatch):
    reg, _ws, _llm, _rows = env
    data = draft()
    source = SelfSource(
        kind="ontology",
        id="unverified",
        version="v1",
        title="待核对的推测",
        text="一次疲惫不能成为性格",
        needs_review=True,
    )
    data.entries[0].source = source
    data.entries[0].text = source.text
    monkeypatch.setattr(service, "source_page", AsyncMock(return_value=SourcePage(items=[source])))
    with pytest.raises(OctopError) as error:
        await publish(reg, data)
    assert error.value.code.value == "DIGITAL_SELF_INVALID_DRAFT"
    data.entries[0].text = "对外交流时，我希望先讨论判断适用的处境。"
    assert (await publish(reg, data)).status == "published"
    data.entries[0].source = source.model_copy(update={"needs_review": False})
    with pytest.raises(OctopError) as forged:
        await service._check_sources(reg, 1, data)
    assert forged.value.code.value == "DIGITAL_SELF_SOURCE_UNAVAILABLE"

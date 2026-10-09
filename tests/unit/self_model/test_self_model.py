"""Synthetic-only acceptance tests for ownership, evidence and recall governance."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace as NS

import pytest
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest

from octop.infra.agents.middleware import self_model as gate
from octop.infra.agents.self_model.service import Review, SelfModelService, digest
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.self_model import SelfModelRepo, VersionConflict
from octop.infra.errors import OctopError


@pytest.fixture
def env(tmp_path):
    db = SqlitePool(tmp_path / "control.db")
    run_migrations(db)
    repo = SelfModelRepo(db)
    event = NS(
        id="event1",
        user="1",
        content="我做决定前习惯先做小范围验证。",
        payload={"role": "user"},
        event_type="message",
        timestamp=datetime.now(UTC),
        thread_id="thread-a",
    )
    atom = NS(
        id="atom1",
        assertion=event.content,
        quote_event_id=event.id,
        verbatim_quote=event.content,
        deprecated_at=None,
    )
    memory = NS(
        get_atom=lambda sid: atom if sid == atom.id else None,
        get_raw_events_by_ids=lambda ids: [event] if event.id in ids else [],
        list_atoms=lambda **kw: [atom],
    )
    rows = {
        aid: NS(agent_id=aid, user_id=uid, name=aid, is_shared=0, kind="expert")
        for aid, uid in [("a", 1), ("b", 1), ("other", 2)]
    }
    llm = NS(
        call_llm=lambda *a, **kw: json.dumps(
            {
                "about_user": True,
                "content": atom.assertion,
                "quote": event.content,
                "section": "ways",
                "framing": "long_term",
                "conditions": "",
                "exceptions": "",
            },
            ensure_ascii=False,
        )
    )
    manager = NS(
        get_row=rows.get,
        list_rows=lambda: list(rows.values()),
        _repos=NS(db=db),
        get_agent=lambda aid: NS(_memory_runtime=NS(memory=memory, _llm_client=llm)),
    )
    svc = SelfModelService(repo, manager, lambda aid: memory)
    repo.enable("a", 1, True, 0)
    yield NS(
        db=db,
        repo=repo,
        event=event,
        atom=atom,
        memory=memory,
        manager=manager,
        svc=svc,
        rows=rows,
        llm=llm,
        path=tmp_path / "control.db",
    )
    db.close()


def seed(e, aid="a"):
    ev = e.event
    e.repo.insert(
        aid,
        1,
        "first",
        {
            "content": ev.content,
            "section": "ways",
            "framing": "long_term",
            "conditions": "",
            "exceptions": "",
            "source_nature": "hypothesis",
            "source_id": "atom1",
            "source_hash": digest(e.atom.assertion),
            "evidence": [
                {
                    "event_id": ev.id,
                    "quote": ev.content,
                    "start": 0,
                    "end": len(ev.content),
                    "content_hash": digest(ev.content),
                    "thread_id": ev.thread_id,
                    "timestamp": ev.timestamp.isoformat(),
                }
            ],
        },
    )
    return e.repo.list(aid, 1)[0]


def confirm(e):
    c = seed(e)
    return e.svc.review("a", 1, c["id"], Review(version=1, action="confirm"))


def test_migration_and_scope(env):
    e = env
    run_migrations(e.db)
    seed(e)
    assert not e.repo.list("b", 1) and not e.repo.list("a", 2)
    with pytest.raises(OctopError):
        e.svc.snapshot("a", 2)
    assert e.svc.snapshot("a", 1)["claims"][0]["state"] == "candidate"
    assert e.svc.context("a", 1) == []


@pytest.mark.parametrize("mode", ["shared", "team"])
def test_non_private_agents_suspended(env, mode):
    e = env
    confirm(e)
    if mode == "shared":
        e.rows["a"].is_shared = 1
    else:
        e.rows["a"].kind = "team"
    assert e.svc.context("a", 1) == []
    with pytest.raises(OctopError):
        e.svc.snapshot("a", 1)


def test_team_member_owner_can_review_and_retract_private_model(env):
    e = env
    e.rows["b"].kind = "team"
    e.manager._teams = NS(member_ids=lambda aid: ["a"])
    c = confirm(e)
    c = e.svc.calibrate("a", 1, c["id"], c["version"], 4)
    assert e.svc.snapshot("a", 1)["claims"][0]["rating"] == 4
    assert e.svc.context("a", 1)[0]["content"] == c["content"]
    with pytest.raises(OctopError):
        e.svc.snapshot("a", 2)
    e.svc.review("a", 1, c["id"], Review(version=c["version"], action="retract"))
    assert not e.svc.context("a", 1)


def test_team_assignment_is_not_owner_evidence(env):
    e = env
    c = confirm(e)
    e.event.thread_id = "team-thread~a"
    assert not e.svc._own_event(e.event, 1)
    assert not e.svc.evidence_valid("a", 1, c)
    assert not e.svc.context("a", 1)


def test_confirm_calibrate_edit_and_stale_write(env):
    e = env
    c = confirm(e)
    assert len(e.svc.context("a", 1)) == 1
    c = e.svc.calibrate("a", 1, c["id"], c["version"], 4)
    assert c["rating"] == 4
    with pytest.raises(VersionConflict):
        e.svc.calibrate("a", 1, c["id"], 2, 0)
    c = e.svc.review(
        "a",
        1,
        c["id"],
        Review(
            version=c["version"],
            action="edit",
            content="我只在产品实验中先做小范围验证",
            conditions="产品实验",
        ),
    )
    assert c["rating"] is None and c["calibrated_version"] is None
    assert not e.svc.context("a", 1)
    assert e.event.content in e.repo.retired_text("a", 1)


def test_rating_zero_not_unknown(env):
    e = env
    c = confirm(e)
    c = e.svc.calibrate("a", 1, c["id"], c["version"], 0)
    snap = e.svc.snapshot("a", 1)["claims"][0]
    assert snap["rating"] == 0 and not snap["needs_recalibration"]
    assert not e.svc.context("a", 1)


def test_context_only_and_aspiration(env):
    e = env
    c = seed(e)
    c = e.svc.review(
        "a", 1, c["id"], Review(version=1, action="context_only", conditions="这个项目")
    )
    assert not e.svc.context("a", 1, "other-thread")
    assert e.svc.context("a", 1, "thread-a")[0]["framing"] == "context_only"
    c = e.svc.review(
        "a",
        1,
        c["id"],
        Review(
            version=c["version"],
            action="edit",
            content="我希望更擅长验证",
            framing="aspirational",
            conditions="",
        ),
    )
    assert e.svc.context("a", 1)[0]["framing"] == "aspirational"


def test_evidence_changes_fail_closed(env):
    e = env
    c = confirm(e)
    e.svc.calibrate("a", 1, c["id"], c["version"], 4)
    e.event.content = "客户喜欢冒险"
    assert not e.svc.context("a", 1)
    snap = e.svc.snapshot("a", 1)["claims"][0]
    assert snap["needs_recalibration"] and snap["rating"] is None
    with pytest.raises(OctopError):
        e.svc.calibrate("a", 1, c["id"], 3, 4)


def test_retraction_survives_pause_and_reopen(env):
    e = env
    c = confirm(e)
    e.svc.review("a", 1, c["id"], Review(version=c["version"], action="retract"))
    e.repo.enable("a", 1, False, 1)
    reopened = SqlitePool(e.path)
    try:
        other = SelfModelService(SelfModelRepo(reopened), e.manager, lambda aid: e.memory)
        assert other.repo.guarded("a")
        assert not other.context("a", 1)
        assert other.repo.list("a", 1)[0]["state"] == "retracted"
    finally:
        reopened.close()


@pytest.mark.asyncio
async def test_generation_incremental_and_rejection_not_recreated(env):
    e = env
    e.svc.start("a", 1)
    await e.svc.tasks["a"]
    c = e.repo.list("a", 1)[0]
    assert c["state"] == "candidate" and c["rating"] is None
    e.svc.review("a", 1, c["id"], Review(version=1, action="reject"))
    e.svc.start("a", 1)
    await e.svc.tasks["a"]
    assert len(e.repo.list("a", 1)) == 1
    assert e.repo.latest_job("a", 1)["processed"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "text,role,user",
    [
        ("客户倾向保守", "user", "1"),
        ("我倾向保守", "assistant", "1"),
        ("我倾向保守", "user", "2"),
        ("我倾向保守", "user", None),
    ],
)
async def test_other_people_assistant_and_missing_identity_never_become_self(env, text, role, user):
    e = env
    e.event.content = text
    e.event.payload = {"role": role}
    e.event.user = user
    e.atom.verbatim_quote = text
    e.atom.assertion = text
    e.svc.start("a", 1)
    await e.svc.tasks["a"]
    assert not e.repo.list("a", 1)


@pytest.mark.asyncio
async def test_temporary_statement_forces_context(env):
    e = env
    e.event.content = "我这次先别冒险。"
    e.atom.verbatim_quote = e.event.content
    e.atom.assertion = e.event.content
    e.svc.start("a", 1)
    await e.svc.tasks["a"]
    assert e.repo.list("a", 1)[0]["framing"] == "context_only"


@pytest.mark.asyncio
async def test_model_failure_is_not_fake_success(env):
    e = env
    e.llm.call_llm = lambda *a, **kw: "not JSON"
    e.svc.start("a", 1)
    await e.svc.tasks["a"]
    assert e.repo.latest_job("a", 1)["state"] == "failed"
    assert not e.repo.list("a", 1)


def test_defer_stays_pending_and_no_rating(env):
    e = env
    c = seed(e)
    c = e.svc.review("a", 1, c["id"], Review(version=1, action="defer"))
    assert c["deferred"] and c["state"] == "candidate"
    with pytest.raises(OctopError):
        e.svc.calibrate("a", 1, c["id"], 2, 4)


def test_gate_blocks_old_paths_and_preserves_history_storage(env, monkeypatch):
    e = env
    c = confirm(e)
    monkeypatch.setattr(
        gate, "get_config", lambda: {"configurable": {"user": "1", "thread_id": "thread-a"}}
    )
    mw = gate.SelfModelMiddleware(e.manager, "a")

    def request(name, args):
        return ToolCallRequest(
            tool_call={"name": name, "args": args, "id": "call1"}, tool=None, state={}, runtime=None
        )

    answer = mw._tool(request("memory_search", {"query": "验证"}))
    assert c["content"] in answer.content
    assert mw._tool(request("memory_get", {"path": "raw/old.md"})).content == "[]"
    e.svc.review("a", 1, c["id"], Review(version=c["version"], action="retract"))
    assert (
        mw._tool(request("memory_get", {"path": f"self/{c['id']}@{c['version']}"})).content == "[]"
    )
    original = HumanMessage(
        content="你好<memory-context>旧画像</memory-context>",
        additional_kwargs={"_octop_memory_recall": {"suffix": "旧画像"}},
    )
    result = gate.sanitize_messages(
        [
            original,
            SystemMessage(content="不可追溯的摘要"),
            ToolMessage(content="旧记忆", name="memory_get", tool_call_id="x"),
        ],
        [],
    )
    assert "旧画像" not in str(result) and "旧记忆" not in str(result)
    assert "旧画像" in original.content
    e.repo.enable("a", 1, False, 1)
    assert mw._tool(request("memory_search", {"query": "验证"})).content == "[]"


@pytest.mark.parametrize(
    "extra",
    [
        {"peer_invoke_mode": "sync"},
        {"self_model_delegated": True},
        {"thread_id": "team-thread~a"},
        {"team_snapshot": True},
        {"team_wrapup": True},
    ],
)
def test_team_delegation_has_no_self_context(env, monkeypatch, extra):
    from langchain.agents.middleware import ModelRequest
    from langchain_core.language_models.fake_chat_models import FakeListChatModel

    e = env
    c = confirm(e)
    e.rows["b"].kind = "team"
    e.manager._teams = NS(member_ids=lambda aid: ["a"])
    monkeypatch.setattr(gate, "get_config", lambda: {"configurable": {"user": "1", **extra}})
    mw = gate.SelfModelMiddleware(e.manager, "a")
    assert mw._context() == []
    request = ModelRequest(
        model=FakeListChatModel(responses=["ok"]),
        messages=[HumanMessage(content="处理团队任务")],
        system_message=SystemMessage(content="Team instructions"),
        tools=[],
    )
    assert c["content"] not in mw._request(request).system_message.content
    for name, args in [
        ("memory_search", {"query": "验证"}),
        ("memory_get", {"path": f"self/{c['id']}@{c['version']}"}),
    ]:
        call = ToolCallRequest(
            tool_call={"name": name, "args": args, "id": "call"},
            tool=None,
            state={},
            runtime=None,
        )
        assert mw._tool(call).content == "[]"


@pytest.mark.asyncio
async def test_http_contract_owner_only_and_version_conflict(env):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from httpx import ASGITransport, AsyncClient

    from octop.api.deps import current_user
    from octop.api.routers import self_model as api

    e = env
    c = seed(e)
    e.rows["b"].kind = "team"
    e.manager._teams = NS(member_ids=lambda aid: ["a"])
    app = FastAPI()
    app.include_router(api.router, prefix="/api")
    app.dependency_overrides[api.service] = lambda: e.svc
    identity = NS(id=1, is_admin=False)
    app.dependency_overrides[current_user] = lambda: identity

    @app.exception_handler(OctopError)
    async def error_handler(request, exc):
        return JSONResponse(status_code=exc.status, content={"code": exc.code.value})

    root = "/api/agents/a/memory/self-model"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        result = await client.get(root)
        assert result.status_code == 200
        assert result.json()["claims"][0]["state"] == "candidate"
        route = f"{root}/claims/{c['id']}/review"
        assert (
            await client.post(route, json={"version": 1, "action": "confirm"})
        ).status_code == 200
        assert (
            await client.post(route, json={"version": 1, "action": "retract"})
        ).status_code == 409
        identity.id = 2
        identity.is_admin = True
        assert (await client.get(root)).status_code == 403
        assert (
            await client.post(route, json={"version": 2, "action": "retract"})
        ).status_code == 403
        identity.id = 1
        assert (
            await client.post(
                f"{root}/claims/{c['id']}/calibration", json={"version": 2, "value": True}
            )
        ).status_code == 422


def test_actual_model_request_uses_current_revision(env, monkeypatch):
    from langchain.agents.middleware import ModelRequest
    from langchain_core.language_models.fake_chat_models import FakeListChatModel

    e = env
    c = confirm(e)
    monkeypatch.setattr(
        gate, "get_config", lambda: {"configurable": {"user": "1", "thread_id": "thread-a"}}
    )
    mw = gate.SelfModelMiddleware(e.manager, "a")
    request = ModelRequest(
        model=FakeListChatModel(responses=["ok"]),
        messages=[HumanMessage(content="建议怎么做？")],
        system_message=SystemMessage(
            content="You assist. <agent_memory>旧的个人摘要</agent_memory>"
        ),
        tools=[],
    )
    projected = mw._request(request)
    assert c["content"] in projected.system_message.content
    assert "旧的个人摘要" not in projected.system_message.content
    e.svc.review("a", 1, c["id"], Review(version=c["version"], action="retract"))
    projected = mw._request(request)
    assert c["content"] not in projected.system_message.content
    assert "旧的个人摘要" not in projected.system_message.content
    assert c["content"] not in str(projected.messages)


@pytest.mark.asyncio
async def test_disabled_during_model_work_does_not_commit(env):
    e = env

    def completion(*args, **kwargs):
        e.repo.enable("a", 1, False, 1)
        return json.dumps(
            {"about_user": True, "content": e.event.content, "quote": e.event.content}
        )

    e.llm.call_llm = completion
    e.svc.start("a", 1)
    await e.svc.tasks["a"]
    assert not e.repo.list("a", 1)
    assert e.repo.latest_job("a", 1)["error"] == "disabled"


def test_governance_change_omits_paraphrased_old_context(env, monkeypatch):
    from langchain.agents.middleware import ModelRequest
    from langchain_core.language_models.fake_chat_models import FakeListChatModel
    from langchain_core.messages import AIMessage

    e = env
    c = confirm(e)
    e.svc.review("a", 1, c["id"], Review(version=c["version"], action="retract"))
    monkeypatch.setattr(gate, "get_config", lambda: {"configurable": {"user": "1"}})
    mw = gate.SelfModelMiddleware(e.manager, "a")
    request = ModelRequest(
        model=FakeListChatModel(responses=["ok"]),
        tools=[],
        system_message=SystemMessage(content=[{"type": "text", "text": "Assistant instructions"}]),
        messages=[
            HumanMessage(content="老问题"),
            AIMessage(content="你是一个非常谨慎的人"),
            HumanMessage(content="现在帮我"),
        ],
        state={"memory_contents": {"SOUL.md": "Be concise", "USER.md": "旧画像"}},
    )
    projected = mw._request(request)
    assert len(projected.messages) == 1
    assert "谨慎" not in str(projected.messages)
    assert "Be concise" in projected.system_message.content
    assert "旧画像" not in projected.system_message.content


def test_contextual_exceptions_do_not_silently_match(env):
    e = env
    c = seed(e)
    e.svc.review(
        "a",
        1,
        c["id"],
        Review(version=1, action="context_only", conditions="当前项目", exceptions="紧急时例外"),
    )
    assert not e.svc.context("a", 1, "thread-a")


def test_compacted_human_summary_is_not_personal_evidence():
    summary = HumanMessage(
        content="用户天生保守",
        additional_kwargs={"lc_source": "summarization", "checkpoint_ts": 99999999999999},
    )
    assert gate.sanitize_messages([summary, HumanMessage(content="现在呢")], []) == [
        HumanMessage(content="现在呢")
    ]


def test_defer_previously_confirmed_claim_stops_use(env):
    e = env
    c = confirm(e)
    e.svc.review("a", 1, c["id"], Review(version=c["version"], action="defer"))
    assert e.svc.context("a", 1) == []
    row = e.svc.snapshot("a", 1)["claims"][0]
    assert row["deferred"] and row["state"] == "candidate" and row["usage"] == "unconfirmed"


def test_native_profile_projection_preserves_existing_categories(tmp_path):
    from octop_memory import Memory
    from octop_memory.types import AtomCard, Candidate, Entity, RawEvent

    from octop.infra.agents.self_model.profile import profile_projection, source_section

    memory = Memory(
        namespace="synthetic",
        backend="sqlite",
        backend_config={"db_path": str(tmp_path / "memory.sqlite")},
    )
    stamp = datetime.now(UTC)
    memory.add_entity(
        Entity(
            id="person",
            entity_type="Person",
            canonical_name="合成伙伴",
            aliases=[],
            atom_count=0,
            created_at=stamp,
        )
    )
    for i, (kind, section) in enumerate(
        [
            ("Preference", "about_me"),
            ("Task", "current_focus"),
            ("Fact", "told_me"),
            ("Decision", "told_me"),
        ]
    ):
        rid = f"r{i}"
        cid = f"c{i}"
        aid = f"a{i}"
        phrase = f"我记下合成资料{i}"
        memory.add_raw_batch(
            [
                RawEvent(
                    id=rid,
                    host="manual",
                    session_id="s",
                    thread_id="t",
                    user="1",
                    timestamp=stamp,
                    event_type="user_message",
                    content=phrase,
                )
            ]
        )
        memory.add_candidate(
            Candidate(
                id=cid,
                raw_event_ids=[rid],
                candidate_type=kind,
                status="promoted",
                title="synthetic",
                assertion=phrase,
                verbatim_quote=phrase,
                quote_event_id=rid,
                subject_name="self",
                subject_entity_type="User",
                target_entity_id="person",
                confidence="high",
                importance="high",
                recommended_action="promote",
                promotion_reason="qa",
                extractor_version="qa",
                created_at=stamp,
            )
        )
        atom = AtomCard(
            id=aid,
            entity_id="person",
            candidate_id=cid,
            raw_event_ids=[rid],
            assertion=phrase,
            verbatim_quote=phrase,
            quote_event_id=rid,
            search_terms=[],
            occurred_at=stamp,
            confidence="high",
            importance="high",
            created_at=stamp,
        )
        memory.add_atom(atom)
        assert source_section(memory, atom) == section
    from octop_memory.types import Episode

    memory.add_episodes(
        [
            Episode(
                id="ep",
                raw_event_ids=["r0"],
                occurred_at=stamp,
                summary="我在合成访谈前紧张",
                verbatim_quote="我有点紧张",
                quote_event_id="r0",
                emotion="anxious",
                intensity=3,
                people=[],
                topics=["访谈"],
                extractor_version="qa",
                created_at=stamp,
            )
        ]
    )
    result = profile_projection(memory)
    assert any(r["node_kind"] == "episode" and r["intensity"] == 3 for r in result["records"])
    assert not any(r["node_kind"] in {"raw", "journal"} for r in result["records"])
    assert {
        "about_me",
        "current_focus",
        "told_me",
        "entities",
        "emotions",
    } == set(result["groups"])
    assert len(result["memories"]) == 4 and result["entities"][0]["canonical_name"] == "合成伙伴"
    assert {a["section"] for a in result["memories"]} == {"about_me", "current_focus", "told_me"}
    assert all("state" not in item and "rating" not in item for item in result["memories"])


@pytest.mark.asyncio
async def test_single_source_extraction_and_missing_source(env):
    e = env
    e.svc.start("a", 1, ["missing"])
    await e.svc.tasks["a"]
    assert e.repo.latest_job("a", 1)["error"] == "evidence_missing"
    assert not e.repo.list("a", 1)
    e.svc.start("a", 1, ["atom1"])
    await e.svc.tasks["a"]
    assert len(e.repo.list("a", 1)) == 1


@pytest.fixture
def reflection_env(env, monkeypatch):
    from octop.infra.agents.self_model import service

    profile = {
        "groups": list(service.GROUPS),
        "memories": [],
        "entities": [],
        "records": [
            {
                "id": "episode:e1",
                "source_id": "e1",
                "node_kind": "episode",
                "section": "emotions",
                "content": "我在临时汇报时紧张",
                "quote": "我当时紧张",
                "timestamp": "2026-09-30T00:00:00Z",
                "emotion": "anxious",
                "intensity": 3,
            }
        ],
        "counts": {},
        "coverage": {},
        "error": None,
    }
    monkeypatch.setattr(service, "profile_projection", lambda m: profile)
    env.profile = profile
    return env


@pytest.mark.asyncio
async def test_reflection_never_confirms_and_emotion_correction_stays_contextual(reflection_env):
    from octop.infra.agents.self_model.reflection import apply_correction, reflect

    e = reflection_env
    e.llm.call_llm = lambda *a, **kw: json.dumps(
        {
            "text": "那次临时汇报让你紧张，不能据此认定你害怕表达。",
            "cited_ids": ["episode:e1"],
            "proposals": [
                {
                    "target_id": "episode:e1",
                    "content": "我只在那次临时汇报时感到紧张",
                    "framing": "long_term",
                }
            ],
        }
    )
    before = e.repo.history_cutoff("a")
    r = await reflect(e.svc, "a", 1, "只是那次临时汇报紧张，平时不害怕表达。")
    assert not e.repo.list("a", 1)
    assert e.repo.history_cutoff("a") == before
    assert r["proposals"][0]["framing"] == "context_only"
    c = apply_correction(e.svc, "a", 1, r["id"], 0)
    assert c["state"] == "confirmed" and c["source_nature"] == "owner_correction"
    assert c["rating"] is None and e.svc.evidence_valid("a", 1, c)
    assert not e.svc.context("a", 1, "unrelated-thread")
    assert e.svc.snapshot("a", 1)["reflections"][0]["stale"]
    with pytest.raises(VersionConflict):
        apply_correction(e.svc, "a", 1, r["id"], 0)
    e.profile["records"][0]["intensity"] = 4
    assert not e.svc.evidence_valid("a", 1, c)


@pytest.mark.asyncio
async def test_reflection_rejects_unknown_sources_and_unrequested_edits(reflection_env):
    from octop.infra.agents.self_model.reflection import reflect

    e = reflection_env
    for payload in [
        {"text": "fiction", "cited_ids": ["unknown"], "proposals": []},
        {
            "text": "change",
            "cited_ids": ["episode:e1"],
            "proposals": [{"target_id": "episode:e1", "content": "改写", "framing": "long_term"}],
        },
    ]:
        e.llm.call_llm = lambda *a, payload=payload, **kw: json.dumps(payload)
        with pytest.raises(OctopError):
            await reflect(e.svc, "a", 1)
    assert not e.repo.reflections("a", 1)
    with pytest.raises(OctopError):
        await reflect(e.svc, "a", 2, "修改")


@pytest.mark.asyncio
async def test_reflection_cannot_apply_after_pause_or_source_change(reflection_env):
    from octop.infra.agents.self_model.reflection import apply_correction, reflect

    e = reflection_env
    e.llm.call_llm = lambda *a, **kw: json.dumps(
        {
            "text": "核对",
            "cited_ids": ["episode:e1"],
            "proposals": [
                {
                    "target_id": "episode:e1",
                    "content": "我在汇报时兴奋",
                    "framing": "context_only",
                    "conditions": "那次汇报",
                }
            ],
        }
    )
    r = await reflect(e.svc, "a", 1, "是兴奋，不是紧张")
    e.profile["records"][0]["content"] = "来源已变化"
    with pytest.raises(VersionConflict):
        apply_correction(e.svc, "a", 1, r["id"], 0)
    e.repo.enable("a", 1, False, 1)
    with pytest.raises(OctopError):
        apply_correction(e.svc, "a", 1, r["id"], 0)
    assert not e.repo.list("a", 1)


@pytest.mark.asyncio
async def test_corrected_claim_refresh_uses_new_wording_not_retired_source(reflection_env):
    from octop.infra.agents.self_model.reflection import apply_correction, material, reflect

    e = reflection_env
    c = confirm(e)
    e.llm.call_llm = lambda *a, **kw: json.dumps(
        {
            "text": "明白了，只限产品试验。",
            "cited_ids": [c["id"]],
            "proposals": [
                {
                    "target_id": c["id"],
                    "content": "我在产品试验中先验证",
                    "framing": "long_term",
                    "conditions": "",
                    "exceptions": "",
                }
            ],
        }
    )
    r = await reflect(e.svc, "a", 1, "只在产品试验中如此")
    updated = apply_correction(e.svc, "a", 1, r["id"], 0)
    assert updated["content"] == "我在产品试验中先验证"
    assert e.svc.context("a", 1)[0]["content"] == updated["content"]
    e.svc.review("a", 1, updated["id"], Review(version=updated["version"], action="retract"))
    assert all(s["id"] != c["id"] for s in material(e.svc.snapshot("a", 1)))
    assert not e.svc.context("a", 1)


@pytest.mark.asyncio
async def test_reviewed_source_without_incremental_ledger_is_not_reintroduced(env):
    e = env
    c = confirm(e)
    e.svc.review("a", 1, c["id"], Review(version=c["version"], action="retract"))
    assert e.repo.source_hash("a", 1, "atom1") is None
    e.svc.start("a", 1)
    await e.svc.tasks["a"]
    assert len(e.repo.list("a", 1)) == 1
    assert e.repo.latest_job("a", 1)["added"] == 0
    assert not e.svc.context("a", 1)


@pytest.mark.asyncio
async def test_point_dialogue_only_sends_selected_material_and_its_conversation(reflection_env):
    from octop.infra.agents.self_model.reflection import reflect

    e = reflection_env
    other = {**e.profile["records"][0], "id": "episode:e2", "content": "另一个不相关的情境"}
    e.profile["records"].append(other)
    prompts = []

    def answer(prompt, **kwargs):
        prompts.append(json.loads(prompt))
        return json.dumps(
            {"text": "我们先核对这一次的感受。", "cited_ids": ["episode:e1"], "proposals": []}
        )

    e.llm.call_llm = answer
    await reflect(e.svc, "a", 1, "先聊全局")
    first = await reflect(e.svc, "a", 1, "那次是紧张还是兴奋？", "episode:e1", 0)
    assert first["target_id"] == "episode:e1"
    assert first["target_content"] == e.profile["records"][0]["content"]
    assert [s["id"] for s in prompts[-1]["sources"]] == ["episode:e1"]
    assert prompts[-1]["recent_dialogue"] == []
    await reflect(e.svc, "a", 1, "更像兴奋", "episode:e1", 0)
    assert prompts[-1]["recent_dialogue"][0]["owner"] == "那次是紧张还是兴奋？"
    assert not e.repo.list("a", 1)


@pytest.mark.asyncio
async def test_point_dialogue_rejects_stale_versions_and_off_target_corrections(reflection_env):
    from octop.infra.agents.self_model.reflection import reflect

    e = reflection_env
    claim = seed(e)
    calls = []

    def answer(prompt, **kwargs):
        calls.append(prompt)
        return json.dumps({"text": "修改另外一个点", "cited_ids": [claim["id"]], "proposals": []})

    e.llm.call_llm = answer
    for target, version in [(claim["id"], 0), ("missing", 0), ("episode:e1", None)]:
        with pytest.raises(VersionConflict):
            await reflect(e.svc, "a", 1, "修改", target, version)
    assert not calls
    with pytest.raises(OctopError):
        await reflect(e.svc, "a", 1, "只修改情绪", "episode:e1", 0)
    assert not e.repo.reflections("a", 1)

"""Real platform contract tests; model output is supplied as native speech fixtures."""

import json
from typing import Any

import pytest
from langchain_core.messages import AIMessage

from octop.infra.agents.teams.brainstorm import build_brainstorm_tools, service_for
from octop.infra.errors import OctopError
from octop.infra.history.projection import message_inputs
from tests.integration.test_applications import products as products
from tests.integration.test_brainstorm import advisory as advisory


@pytest.mark.parametrize(
    "topic", ["学院下一期是否扩大招生", "是否在保留收入的同时尝试新的职业方向"]
)
async def test_proposal_review_revision_ruling_and_continuation(
    advisory: Any, monkeypatch: Any, topic: str
) -> None:
    client, server, _, auth = advisory
    registry = server.app_runtime.agent_registry
    service = service_for(registry)
    monkeypatch.setattr(service, "_launch", lambda *args: None)
    p = (await client.post("/api/brainstorm/profile", headers=auth, json={})).json()
    assert "personal_council_v1" in p["capabilities"]
    assert {m["expert_id"] for m in p["members"]} == {
        "brainstorm-council-strategy",
        "brainstorm-council-resources",
        "brainstorm-council-review",
        "brainstorm-council-action",
    }
    a, b = [m["agent_id"] for m in p["members"][:2]]
    for aid in [p["team_id"], a, b]:
        cfg = registry._build_harness_config(registry.get_row(aid))
        assert cfg.memory_enabled is False
        assert cfg.memory_recall_inject_enabled is False
    created = await client.post(
        "/api/brainstorm/sessions",
        headers=auth,
        json={"topic": topic, "context_enabled": False, "council_enabled": True},
    )
    assert created.status_code == 201, created.text
    s = created.json()
    tid = s["thread_id"]
    url = f"/api/brainstorm/sessions/{tid}"
    tool = next(
        t
        for t in build_brainstorm_tools(registry, s["team_id"])
        if t.name == "brainstorm_checkpoint"
    )
    config = {
        "configurable": {"thread_id": tid, "agent_id": s["team_id"], "user": str(s["user_id"])}
    }

    async def checkpoint(**kwargs: Any) -> Any:
        return await tool.ainvoke(
            {
                "summary": "围绕用户的条件研究",
                "ideas": [],
                "directions": [],
                "questions": [],
                **kwargs,
            },
            config=config,
        )

    async def state() -> Any:
        return (await client.get(url, headers=auth)).json()

    async def control(**body: Any) -> Any:
        current = await state()
        result = await client.post(
            url + "/control", headers=auth, json={"revision": current["revision"], **body}
        )
        assert result.status_code == 200, result.text
        return result.json()

    def say(mid: str, author: str, text: str) -> None:
        registry._repos.thread_message_repo.append_if_ready(
            tid,
            message_inputs(
                [AIMessage(content=text, id=mid, additional_kwargs={"speaker_agent_id": author})]
            ),
        )

    await checkpoint(
        phase="agenda",
        goal=topic,
        constraints=["暂时保留原有安排"],
        agenda="比较投入与验证方式",
        recommended_roster=[
            {"agent_id": a, "reason": "提出可比较方向"},
            {"agent_id": b, "reason": "审议投入与代价"},
        ],
    )
    s = await state()
    await control(action="start", decision_id=s["decision"]["id"], participant_ids=[a, b])
    say("m1", a, "建议先每周投入十小时试一个月，代价是占用休息时间。")
    proposal = {
        "id": "p1v1",
        "kind": "proposal",
        "issue_id": "i1",
        "proposal_id": "p1",
        "version": 1,
        "author_id": a,
        "message_id": "m1",
        "title": "试一个月",
        "advice": "每周投入十小时",
        "basis": "先验证真实效果",
        "cost": "占用休息时间",
    }
    # A next-speaker dispatch may win the race against recording the prior
    # speaker. The atomic batch can introduce its issue after the proposal.
    service._pending[tid] = {"next-speaker-job"}
    await checkpoint(
        council_updates=[
            proposal,
            {"id": "issue1", "kind": "issue", "issue_id": "i1", "question": "怎样用小投入验证？"},
        ]
    )
    before = await state()
    with pytest.raises(OctopError):
        await checkpoint(wait_for_user=True)
    assert (await state()) == before
    service._pending[tid].clear()
    before = await state()
    await checkpoint(council_updates=[proposal])
    assert (await state())["council"] == before["council"]
    say("m2", b, "十小时可能难以坚持，需要先确认实际时间。")
    await checkpoint(
        council_updates=[
            {
                "id": "r1",
                "kind": "review",
                "issue_id": "i1",
                "proposal_id": "p1",
                "version": 1,
                "author_id": b,
                "message_id": "m2",
                "responds_to": "m1",
                "stance": "concern",
                "point": "十小时可能难以坚持",
            }
        ]
    )
    # A made-up native reference is rejected transactionally.
    before = await state()
    with pytest.raises(OctopError):
        await checkpoint(
            council_updates=[
                {"id": "badissue", "kind": "issue", "issue_id": "bad", "question": "伪议题"},
                {**proposal, "id": "fake", "proposal_id": "fake", "message_id": "missing"},
            ]
        )
    assert (await state())["council"] == before["council"]
    # Changed boundary invalidates all recommendations and cannot silently be adopted.
    await control(action="revise", text="每周只能投入两小时")
    s = await state()
    assert s["council"]["proposals"][0]["status"] == "needs_review"
    assert not service.can_dispatch(s["team_id"], tid, s["user_id"], a)
    await checkpoint(
        phase="agenda", goal=topic, constraints=["每周只能投入两小时"], agenda="在两小时内验证"
    )
    s = await state()
    await control(action="start", decision_id=s["decision"]["id"], participant_ids=[a, b])
    with pytest.raises(OctopError):
        await checkpoint(
            council_updates=[
                {**proposal, "id": "old-speech", "version": 2, "change_reason": "时间改变"}
            ]
        )
    say("m3", a, "改成每周只做一次两小时的小试验，不挤占原有安排。")
    await checkpoint(
        council_updates=[
            {
                **proposal,
                "id": "p1v2",
                "version": 2,
                "message_id": "m3",
                "advice": "每周一次两小时的小试验",
                "cost": "需要更长时间才能观察结果",
                "change_reason": "根据你的两小时时间上限缩小试验",
            },
            {
                "id": "brief1",
                "kind": "brief",
                "recommendation": {"proposal_id": "p1", "version": 2},
                "input_acknowledgment": "已把十小时调整为两小时，保留现有安排",
                "next_step": "请审议参谋检查新方案",
            },
        ]
    )
    say("m4", b, "支持缩小试验，保留两周后重新评估的条件。")
    await checkpoint(
        council_updates=[
            {
                "id": "r2",
                "kind": "review",
                "issue_id": "i1",
                "proposal_id": "p1",
                "version": 2,
                "author_id": b,
                "message_id": "m4",
                "stance": "support",
                "point": "支持，但两周后需评估实际效果",
            }
        ]
    )

    async def verdict(version: int) -> None:
        await checkpoint(
            decision={
                "kind": "verdict",
                "question": "是否按两小时方案试行？",
                "options": [
                    {
                        "label": "先试两周",
                        "effect": "adopt",
                        "proposal": {"proposal_id": "p1", "version": version},
                    },
                    {"label": "再研究其他办法", "effect": "revisit"},
                ],
            },
            report_draft={
                "overview": "每周两小时先试",
                "key_points": ["先试再决定"],
                "disagreements": ["仍需实际验证效果"],
                "actions": [{"task": "两周后评估"}],
                "open_questions": ["实际效果如何？"],
            },
        )

    with pytest.raises(OctopError):
        await verdict(1)
    await verdict(2)
    s = await state()
    old_decision = s["decision"]["id"]
    # A user comment is not adoption and prevents dispatch until acknowledged.
    await control(action="respond", text="我还想知道具体代价", decision_id=old_decision)
    s = await state()
    assert not s["ruling"]
    assert not service.can_dispatch(s["team_id"], tid, s["user_id"])
    stale = await client.post(
        url + "/control",
        headers=auth,
        json={"action": "respond", "decision_id": old_decision, "option_index": 0},
    )
    assert stale.status_code == 400
    await checkpoint(
        council_updates=[
            {
                "id": "ack2",
                "kind": "brief",
                "input_acknowledgment": "代价是验证周期更长",
                "recommendation": {"proposal_id": "p1", "version": 2},
            }
        ]
    )
    await verdict(2)
    s = await state()
    s = await control(action="respond", decision_id=s["decision"]["id"], option_index=0)
    assert s["status"] == "ended" and s["council"]["adopted"] == {"proposal_id": "p1", "version": 2}
    report = (await client.get(url + "/report", headers=auth)).json()
    assert "两小时" in report["markdown"] and "十小时" in report["markdown"]
    document = await client.get(url + "/report/document", headers=auth)
    assert document.content.startswith(b"PK")
    old = json.dumps(await state(), ensure_ascii=False, sort_keys=True)
    continued = await client.post(
        "/api/brainstorm/sessions",
        headers=auth,
        json={
            "topic": "两周后复盘",
            "continued_from": tid,
            "context_enabled": False,
            "council_enabled": True,
        },
    )
    assert continued.status_code == 201, continued.text
    nxt = continued.json()
    assert nxt["matter_id"] == s["matter_id"]
    assert nxt["phase"] == "intake"
    assert nxt["council"]["proposals"] == [] and nxt["inherited_background"]
    assert json.dumps(await state(), ensure_ascii=False, sort_keys=True) == old
    # Restart preserves proposal history, decisions, and links.
    service._states.pop(tid)
    assert (await state())["council"] == s["council"]


async def test_parallel_context_cannot_erase_intake_checkpoint(
    advisory: Any, monkeypatch: Any
) -> None:
    import asyncio

    client, server, _, auth = advisory
    registry = server.app_runtime.agent_registry
    service = service_for(registry)
    monkeypatch.setattr(service, "_launch", lambda *args: None)
    await client.post("/api/brainstorm/profile", headers=auth, json={})
    s = (
        await client.post(
            "/api/brainstorm/sessions",
            headers=auth,
            json={
                "topic": "每周写作",
                "context_enabled": False,
                "council_enabled": True,
            },
        )
    ).json()
    tools = {t.name: t for t in build_brainstorm_tools(registry, s["team_id"])}
    config = {
        "configurable": {
            "thread_id": s["thread_id"],
            "agent_id": s["team_id"],
            "user": str(s["user_id"]),
        }
    }
    entered, release = asyncio.Event(), asyncio.Event()
    original = service.context

    async def delayed(state: Any, query: str) -> Any:
        entered.set()
        await release.wait()
        return await original(state, query)

    monkeypatch.setattr(service, "context", delayed)
    context = asyncio.create_task(
        tools["brainstorm_context"].ainvoke({"query": "写作"}, config=config)
    )
    await entered.wait()
    checkpoint = asyncio.create_task(
        tools["brainstorm_checkpoint"].ainvoke(
            {
                "summary": "以可持续为准",
                "ideas": [],
                "directions": [],
                "questions": [],
                "phase": "agenda",
                "agenda": "比较可持续做法",
                "goal": "验证可持续写作",
                "council_updates": [
                    {
                        "id": "ack",
                        "kind": "brief",
                        "input_acknowledgment": "成功标准改为稳定且不痛苦",
                    }
                ],
            },
            config=config,
        )
    )
    await asyncio.sleep(0)
    assert not checkpoint.done()
    release.set()
    await asyncio.gather(context, checkpoint)
    result = (await client.get(f"/api/brainstorm/sessions/{s['thread_id']}", headers=auth)).json()
    assert result["status"] == "waiting" and result["decision"]["kind"] == "agenda"
    assert result["goal"] == "验证可持续写作"
    assert result["council"]["input_acknowledgment"] == "成功标准改为稳定且不痛苦"
    assert not service.can_dispatch(s["team_id"], s["thread_id"], s["user_id"])
    # A sparse checkpoint must preserve accumulated fields, not silently clear
    # the brief or force models to repeat large arrays on every update.
    await client.post(
        f"/api/brainstorm/sessions/{s['thread_id']}/control",
        headers=auth,
        json={"action": "respond", "text": "背景正确，补充说明", "revision": result["revision"]},
    )
    await tools["brainstorm_checkpoint"].ainvoke({"brief": "等待你确认"}, config=config)
    sparse = (await client.get(f"/api/brainstorm/sessions/{s['thread_id']}", headers=auth)).json()
    assert sparse["summary"] == result["summary"]
    assert sparse["goal"] == result["goal"]
    assert sparse["brief"] == "等待你确认"

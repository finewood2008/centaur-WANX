"""Document invitations bind actual owner turns and preserve revisable declarations."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, Mock

import pytest
from langchain.agents.middleware import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from octop_memory import Memory
from tests.unit.agents.test_knowledge_understanding import (
    enable,
    proposal,
    upload,
)
from tests.unit.agents.test_knowledge_understanding import (
    reading_env as reading_env,
)

from octop.infra.agents import knowledge_understanding as understanding
from octop.infra.agents.ontology_runtime import ZhijunOntologyMiddleware, read_context
from octop.infra.agents.personal_ontology import read_personal_ontology
from octop.infra.agents.understanding_types import UnderstandingLibrary, UnderstandingSettings
from octop.infra.errors import OctopError
from octop.infra.knowledge import jobs


@pytest.fixture
def dialogue_env(reading_env, tmp_path, monkeypatch):
    env = reading_env
    memory = Memory("synthetic-dialogue", backend_config={"db_path": str(tmp_path / "memory.db")})
    env.harness._memory_runtime.memory = memory
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {
                "agent_id": "profile",
                "user": str(env.uid),
                "thread_id": "actual-thread",
                "source": "web",
            }
        },
    )
    env.middleware = ZhijunOntologyMiddleware(env.registry, "profile", env.uid)
    yield env
    memory.backend.close()


async def invitation(env):
    document = upload(env, "当时我希望先看分工落实，再决定投入。")
    await enable(env)
    env.model.return_value = proposal()
    await understanding.process_understanding_batch(env.registry, env.uid)
    state = await understanding.read_understanding(env.registry, env.uid)
    assert len(state.invitations) == 1
    return document, state.invitations[0], state


def tool_request(human, name, args):
    return ToolCallRequest(
        tool_call={"id": "tool", "name": name, "args": args},
        tool=None,
        state={"messages": [human]},
        runtime=None,
    )


async def supplied_context(env, human):
    handler = AsyncMock(
        return_value=ModelResponse(result=[AIMessage(id="reply", content="我在听。")])
    )
    request = ModelRequest(model=Mock(), messages=[human], state={"messages": [human]})
    await env.middleware.awrap_model_call(request, handler)
    supplied = handler.call_args.args[0]
    assert supplied.messages == [human]
    assert supplied.state["messages"] == [human]
    return await read_context(env.registry, env.uid, "actual-thread", "我在听。", latest=True)


async def test_acceptance_supplies_source_without_fabricating_a_human_turn(dialogue_env):
    env = dialogue_env
    _, item, state = await invitation(env)
    before = env.harness._memory_runtime.memory.list_raw()
    accepted = await understanding.review_invitation(
        env.registry, env.uid, item.id, "accept", state.revision
    )
    assert accepted.invitations[0].status == "active"
    assert env.harness._memory_runtime.memory.list_raw() == before
    assert not (await read_personal_ontology(env.registry, env.uid)).claims
    human = HumanMessage(
        id="actual-owner-turn",
        content="我想回看这段资料背后的情况。",
        additional_kwargs={"zhijun_invitation_id": item.id},
    )
    context = await supplied_context(env, human)
    assert human.content == "我想回看这段资料背后的情况。"
    assert context.understanding_lines[0]["id"] == item.id
    assert context.understanding_lines[0]["source"]["source_version"] == item.source.source_version
    assert context.understanding_lines[0]["understanding_revision"] == accepted.revision
    assert context.understanding_lines[0]["role"] == "personal"
    assert env.harness._memory_runtime.memory.list_raw() == before


@pytest.mark.parametrize("first", ["review", "ontology"])
async def test_explicit_owner_words_keep_both_sources_and_affect_next_turn(dialogue_env, first):
    env = dialogue_env
    document, item, _ = await invitation(env)
    statement = "我希望责任与决定权相配"
    human = HumanMessage(
        id="actual-declaration",
        content="这段确实是我的经历。涉及合作分工时，" + statement + "。",
        additional_kwargs={"zhijun_invitation_id": item.id},
    )
    handler = AsyncMock()

    async def review():
        state = await understanding.read_understanding(env.registry, env.uid)
        answer = await env.middleware.awrap_tool_call(
            tool_request(
                human,
                "zhijun_understanding_review",
                {
                    "invitation_id": item.id,
                    "revision": state.revision,
                    "action": "recognize",
                    "quote": "这段确实是我的经历",
                },
            ),
            handler,
        )
        assert json.loads(answer.content)["saved"] is True

    async def update():
        ontology = await read_personal_ontology(env.registry, env.uid)
        answer = await env.middleware.awrap_tool_call(
            tool_request(
                human,
                "zhijun_ontology_update",
                {
                    "revision": ontology.revision,
                    "action": "add",
                    "quote": human.content,
                    "statement": statement,
                    "kind": "principle",
                    "conditions": "涉及合作分工时",
                },
            ),
            handler,
        )
        assert json.loads(answer.content)["status"] == "ready"

    if first == "review":
        await review()
        await update()
    else:
        await update()
        await review()
    handler.assert_not_called()
    doc = await read_personal_ontology(env.registry, env.uid)
    claim = doc.claims[0]
    assert claim.statement == statement and claim.source_kind == "self_report"
    assert claim.declaration_turn == human.id and claim.evidence_valid
    assert {source.source_type for source in claim.evidence} == {"knowledge", "owner_declaration"}
    owner = next(source for source in claim.evidence if source.source_type == "owner_declaration")
    assert owner.event_id == human.id and owner.quote == human.content
    knowledge = next(source for source in claim.evidence if source.source_type == "knowledge")
    assert (
        knowledge.document_id == document.id
        and knowledge.source_version == item.source.source_version
    )
    context = await supplied_context(env, HumanMessage(id="next", content="我在犹豫合作的分工"))
    assert context.claims == []  # Explicit words form candidates, not core admission.
    assert context.understanding_lines == []
    env.knowledge.update_text_document(
        env.base.id, document.id, actor_user_id=env.uid, content="新资料已替换原来的记录。"
    )
    jobs.process_document(env.services, env.base.id, document.id)
    after = await read_personal_ontology(env.registry, env.uid)
    assert after.claims[0].statement == statement and after.claims[0].evidence_valid
    assert not next(s for s in after.claims[0].evidence if s.source_type == "knowledge").available
    next_context = await supplied_context(
        env, HumanMessage(id="after-edit", content="我在犹豫合作的分工")
    )
    assert next_context.claims == []


@pytest.mark.parametrize("text", ["先不展开，今天只想歇一会。", "这段先不聊，只想让你听我说。"])
async def test_owner_wish_to_pause_wins_over_an_explicit_invitation(dialogue_env, text):
    env = dialogue_env
    _, item, _ = await invitation(env)
    human = HumanMessage(
        id="pause", content=text, additional_kwargs={"zhijun_invitation_id": item.id}
    )
    context = await supplied_context(env, human)
    assert context.understanding_lines == []
    assert not (await read_personal_ontology(env.registry, env.uid)).claims


@pytest.mark.parametrize(
    "action,quote",
    [
        ("recognize", "我今天很累"),
        ("past", "我今天很累"),
        ("changed", "我今天很累"),
        ("recognize", "这是我的经历？"),
        ("recognize", "假设这是我的经历"),
    ],
)
async def test_arbitrary_or_hypothetical_words_cannot_recognize_material(
    dialogue_env, action, quote
):
    env = dialogue_env
    _, item, state = await invitation(env)
    human = HumanMessage(
        id="not-recognition", content=quote, additional_kwargs={"zhijun_invitation_id": item.id}
    )
    answer = await env.middleware.awrap_tool_call(
        tool_request(
            human,
            "zhijun_understanding_review",
            {
                "invitation_id": item.id,
                "revision": state.revision,
                "action": action,
                "quote": quote,
            },
        ),
        AsyncMock(),
    )
    assert json.loads(answer.content)["saved"] is False
    current = await understanding.read_understanding(env.registry, env.uid)
    assert current.invitations[0].status == "pending" and not current.invitations[0].responses


async def test_old_or_foreign_binding_cannot_attach_a_source_to_current_declaration(dialogue_env):
    env = dialogue_env
    _, item, state = await invitation(env)
    human = HumanMessage(
        id="old-turn", content="这是我的经历", additional_kwargs={"zhijun_invitation_id": item.id}
    )
    answer = await env.middleware.awrap_tool_call(
        tool_request(
            human,
            "zhijun_understanding_review",
            {
                "invitation_id": item.id,
                "revision": state.revision,
                "action": "recognize",
                "quote": human.content,
            },
        ),
        AsyncMock(),
    )
    assert json.loads(answer.content)["saved"]
    current = await understanding.read_understanding(env.registry, env.uid)
    assert current.invitations[0].status == "active"
    # Close the discussion explicitly before exercising an old/foreign binding.
    await understanding.review_invitation(
        env.registry, env.uid, item.id, "resolve", current.revision
    )
    with pytest.raises(OctopError):
        await understanding.resolve_invitation(
            env.registry, env.uid, item.id, reviewed_turn="new-turn"
        )
    with pytest.raises(OctopError):
        await understanding.resolve_invitation(env.registry, env.uid + 100, item.id)
    new = HumanMessage(
        id="new-turn",
        content="我希望先理清事实",
        additional_kwargs={"zhijun_invitation_id": item.id},
    )
    answer = await env.middleware.awrap_tool_call(
        tool_request(
            new,
            "zhijun_ontology_update",
            {
                "revision": "empty",
                "action": "add",
                "quote": new.content,
                "statement": new.content,
            },
        ),
        AsyncMock(),
    )
    assert json.loads(answer.content)["status"] == "ready"
    assert not (await read_personal_ontology(env.registry, env.uid)).claims[0].evidence


async def test_explicit_declaration_saves_without_initialized_native_memory(dialogue_env):
    env = dialogue_env
    env.harness._memory_runtime.memory = None
    human = HumanMessage(id="empty-memory", content="我希望你先听我说完")
    answer = await env.middleware.awrap_tool_call(
        tool_request(
            human,
            "zhijun_ontology_update",
            {
                "revision": "empty",
                "action": "add",
                "quote": human.content,
                "statement": human.content,
                "kind": "response",
            },
        ),
        AsyncMock(),
    )
    assert json.loads(answer.content)["status"] == "ready"
    current = await read_personal_ontology(env.registry, env.uid)
    assert current.claims[0].evidence_valid and current.claims[0].declaration == human.content
    context = await supplied_context(
        env, HumanMessage(id="next-empty-memory", content="今天有些难过")
    )
    assert context.claims == []


async def test_current_correction_replaces_declaration_and_old_tool_revision_cannot_overwrite(
    dialogue_env,
):
    env = dialogue_env
    first = HumanMessage(id="first", content="我希望你先听我说完")
    handler = AsyncMock()
    result = await env.middleware.awrap_tool_call(
        tool_request(
            first,
            "zhijun_ontology_update",
            {
                "revision": "empty",
                "action": "add",
                "quote": first.content,
                "statement": first.content,
                "kind": "response",
            },
        ),
        handler,
    )
    saved = (await read_personal_ontology(env.registry, env.uid)).model_dump()
    human = HumanMessage(id="correction", content="其实我现在希望先一起理清事实")
    args = {
        "revision": saved["revision"],
        "claim_id": saved["claims"][0]["id"],
        "action": "correct",
        "quote": human.content,
        "statement": "我现在希望先一起理清事实",
        "kind": "response",
    }
    result = await env.middleware.awrap_tool_call(
        tool_request(human, "zhijun_ontology_update", args), handler
    )
    assert json.loads(result.content)["status"] == "ready"
    stale = await env.middleware.awrap_tool_call(
        tool_request(human, "zhijun_ontology_update", args), handler
    )
    assert json.loads(stale.content)["status"] == "stale"
    context = await supplied_context(
        env, HumanMessage(id="after-correction", content="今天有些难过")
    )
    assert context.claims == []
    candidate = (await read_personal_ontology(env.registry, env.uid)).claims[0]
    assert candidate.statement == args["statement"] and candidate.declaration_turn == human.id
    assert candidate.core_status == "pending"
    handler.assert_not_called()


async def test_scope_removal_keeps_current_declaration_without_attaching_removed_source(
    dialogue_env,
):
    env = dialogue_env
    _, item, state = await invitation(env)
    statement = "我希望你先听我说完"
    human = HumanMessage(
        id="same-turn",
        content="这段确实是我的经历。" + statement,
        additional_kwargs={"zhijun_invitation_id": item.id},
    )
    recognized = await understanding.record_understanding_response(
        env.registry,
        env.uid,
        item.id,
        quote="这段确实是我的经历",
        turn_id=human.id,
        action="recognize",
        revision=state.revision,
    )
    await understanding.update_understanding(
        env.registry,
        env.uid,
        UnderstandingSettings(
            revision=recognized.revision,
            libraries=[UnderstandingLibrary(kb_id=env.base.id, selected=False, role="personal")],
        ),
    )
    answer = await env.middleware.awrap_tool_call(
        tool_request(
            human,
            "zhijun_ontology_update",
            {
                "revision": "empty",
                "action": "add",
                "quote": statement,
                "statement": statement,
                "kind": "response",
            },
        ),
        AsyncMock(),
    )
    assert json.loads(answer.content)["status"] == "ready"
    claim = (await read_personal_ontology(env.registry, env.uid)).claims[0]
    assert claim.statement == statement and claim.source_kind == "self_report"
    assert claim.evidence_valid and not claim.evidence
    context = await supplied_context(
        env, HumanMessage(id="next-after-removal", content="今天有些难过")
    )
    assert context.claims == []  # Explicit words form candidates, not core admission.
    assert context.understanding_lines == []


async def confirmation_request(
    env, item, text="是的，请这样记住。", statement="涉及合作分工时，我更重视责任与决定权相配"
):
    owner = HumanMessage(
        id="discussion-owner",
        content="当时我最在意的是，责任由我承担，决定却不由我做。",
        additional_kwargs={"zhijun_invitation_id": item.id},
    )
    reply = AIMessage(
        id="conclusion-reply", content=f"我会这样记住：「{statement}」。这样理解准确吗？"
    )
    human = HumanMessage(
        id="conclusion-confirmation",
        content=text,
        additional_kwargs={"zhijun_invitation_id": item.id},
    )
    doc = await read_personal_ontology(env.registry, env.uid)
    request = tool_request(
        human,
        "zhijun_ontology_update",
        {
            "revision": doc.revision,
            "action": "confirm",
            "quote": text,
            "statement": statement,
            "conditions": "涉及合作分工时",
            "kind": "principle",
        },
    )
    request.state["messages"] = [owner, reply, human]
    return request


async def test_reverb_conclusion_requires_user_confirmation_and_remains_revisable(dialogue_env):
    from octop.infra.agents.ontology_types import OntologyEdit
    from octop.infra.agents.personal_ontology import edit_personal_ontology

    env = dialogue_env
    _, item, _ = await invitation(env)
    request = await confirmation_request(env, item)
    assert not (await read_personal_ontology(env.registry, env.uid)).claims
    answer = await env.middleware.awrap_tool_call(request, AsyncMock())
    result = json.loads(answer.content)
    assert result["status"] == "ready"
    doc = await read_personal_ontology(env.registry, env.uid)
    claim = doc.claims[0]
    assert claim.statement == request.tool_call["args"]["statement"]
    assert claim.declaration == "是的，请这样记住。" and claim.state == "confirmed"
    assert {e.source_type for e in claim.evidence} == {"knowledge", "owner_declaration"}
    assert (await understanding.read_understanding(env.registry, env.uid)).invitations[
        0
    ].status == "resolved"
    context = await supplied_context(env, HumanMessage(id="later", content="我想讨论合作分工"))
    assert context.claims == []
    assert claim.core_status == "pending"
    restored = await edit_personal_ontology(
        env.registry,
        env.uid,
        claim.id,
        OntologyEdit(
            revision=doc.revision,
            action="restore",
            restore_version=result["previous_version"],
        ),
    )
    assert restored.status == "ready" and restored.ontology.claims[0].state == "withdrawn"


@pytest.mark.parametrize(
    "text", ["是的，但是只限于那次", "不准确", "也许吧", "是的？", "先不记住", "资料里说是的"]
)
async def test_reverb_never_treats_uncertainty_or_qualification_as_confirmation(dialogue_env, text):
    env = dialogue_env
    _, item, _ = await invitation(env)
    request = await confirmation_request(env, item, text)
    # Even a partial affirmative substring cannot hide the owner's qualification.
    if text.startswith("是的，但是"):
        request.tool_call["args"]["quote"] = "是的"
    answer = await env.middleware.awrap_tool_call(request, AsyncMock())
    assert json.loads(answer.content)["saved"] is False
    assert not (await read_personal_ontology(env.registry, env.uid)).claims
    assert (await understanding.read_understanding(env.registry, env.uid)).invitations[
        0
    ].status == "pending"


@pytest.mark.parametrize(
    "alter", ["statement", "previous_topic", "no_conclusion", "source", "two_conclusions"]
)
async def test_reverb_confirmation_binds_the_visible_conclusion_and_current_owned_source(
    dialogue_env, alter
):
    env = dialogue_env
    _, item, _ = await invitation(env)
    request = await confirmation_request(env, item)
    if alter == "statement":
        request.tool_call["args"]["statement"] = "我愿意接受所有风险"
    elif alter == "previous_topic":
        request.state["messages"][0].additional_kwargs["zhijun_invitation_id"] = "another"
    elif alter == "no_conclusion":
        request.state["messages"][1].content = "好，我们继续聊。"
    elif alter == "two_conclusions":
        request.state["messages"][1].content = (
            "我会这样记住：「另一个判断」。" + request.state["messages"][1].content
        )
    else:
        state = await understanding.read_understanding(env.registry, env.uid)
        await understanding.update_understanding(
            env.registry,
            env.uid,
            UnderstandingSettings(
                revision=state.revision,
                libraries=[
                    UnderstandingLibrary(kb_id=env.base.id, role="personal", selected=False)
                ],
            ),
        )
    answer = await env.middleware.awrap_tool_call(request, AsyncMock())
    assert json.loads(answer.content)["saved"] is False
    assert not (await read_personal_ontology(env.registry, env.uid)).claims


async def bind_discussion(env, item, *, resolved=False):
    state = await understanding.read_understanding(env.registry, env.uid)
    state.invitations[0].discussion_thread_id = "actual-thread"
    state.invitations[0].status = "resolved" if resolved else "active"
    await understanding._save_state(env.workspace, state)


@pytest.mark.parametrize("separator", ["：", "——", " — "])
async def test_actual_natural_confirmation_and_dash_proposal_are_saved(dialogue_env, separator):
    env = dialogue_env
    _, item, _ = await invitation(env)
    await bind_discussion(env, item)
    statement = "人越不用不采纳的那个权力，就越挡不住 AI 自己拍板那一步；这两件事是连着的。"
    request = await confirmation_request(
        env, item, "准确，这两件在我这里是一条线，不是两个开关。", statement
    )
    request.tool_call["args"]["conditions"] = ""
    request.state["messages"][
        1
    ].content = (
        f"那就不是两个开关，是一条线。我会这样记住{separator}「{statement}」这样理解准确吗？"
    )
    request.state["messages"][0].additional_kwargs = {}
    request.state["messages"][-1].additional_kwargs = {}
    answer = await env.middleware.awrap_tool_call(request, AsyncMock())
    assert json.loads(answer.content)["status"] == "ready"
    claim = (await read_personal_ontology(env.registry, env.uid)).claims[0]
    assert claim.statement == statement
    assert claim.declaration == "准确，这两件在我这里是一条线，不是两个开关。"
    assert {e.source_type for e in claim.evidence} == {"knowledge", "owner_declaration"}


async def test_finished_discussion_keeps_source_and_accepts_later_refinement(dialogue_env):
    env = dialogue_env
    _, item, _ = await invitation(env)
    await bind_discussion(env, item, resolved=True)
    with pytest.raises(OctopError):
        await understanding.resolve_invitation(env.registry, env.uid, item.id)
    context = await supplied_context(env, HumanMessage(id="continuing", content="接着聊这件事。"))
    assert context.understanding_lines[0]["id"] == item.id
    request = await confirmation_request(env, item)
    request.state["messages"][0].additional_kwargs = {}
    request.state["messages"][-1].additional_kwargs = {}
    answer = await env.middleware.awrap_tool_call(request, AsyncMock())
    assert json.loads(answer.content)["status"] == "ready"
    assert (await understanding.read_understanding(env.registry, env.uid)).invitations[
        0
    ].status == "resolved"


async def test_finished_discussion_can_record_current_scope_review_without_client_tag(dialogue_env):
    env = dialogue_env
    _, item, _ = await invitation(env)
    await bind_discussion(env, item, resolved=True)
    state = await understanding.read_understanding(env.registry, env.uid)
    human = HumanMessage(id="scope-review", content="以前我是这样想的。")
    answer = await env.middleware.awrap_tool_call(
        tool_request(
            human,
            "zhijun_understanding_review",
            {
                "revision": state.revision,
                "invitation_id": item.id,
                "quote": human.content,
                "action": "past",
            },
        ),
        AsyncMock(),
    )
    assert json.loads(answer.content)["saved"] is True
    updated = await understanding.read_understanding(env.registry, env.uid)
    assert updated.invitations[0].responses[0]["turn_id"] == human.id
    assert updated.invitations[0].status == "resolved"


async def test_scoped_owner_restatement_saves_only_affirmed_words(dialogue_env):
    env = dialogue_env
    _, item, _ = await invitation(env)
    await bind_discussion(env, item)
    statement = "定方向是人的权力，担最终责任就是配套的义务，AI 可以给方向候选，但不能替人背书。"
    text = f"准确，至少在人机分工这一层：{statement}我还不确定的是，AI 自主生成目标时还算不算车。"
    proposal = await confirmation_request(env, item, text)
    proposal.state["messages"][-1].additional_kwargs = {}
    rejected = json.loads((await env.middleware.awrap_tool_call(proposal, AsyncMock())).content)
    assert rejected == {"status": "needs_review", "saved": False, "reason": "confirmation_required"}
    # The user's own scoped statement can be recorded separately from the uncertain question.
    body = proposal.tool_call["args"]
    body.update(action="add", statement=statement, conditions="至少在人机分工这一层")
    body["quote"] = text.split("我还不确定的是")[0]
    answer = await env.middleware.awrap_tool_call(proposal, AsyncMock())
    assert json.loads(answer.content)["status"] == "ready"
    claim = (await read_personal_ontology(env.registry, env.uid)).claims[0]
    assert claim.statement == statement and claim.conditions == "至少在人机分工这一层"
    assert "不确定" not in claim.statement


@pytest.mark.parametrize(
    "alter", ["foreign_previous", "foreign_current", "unbound", "source", "retraction"]
)
async def test_persistent_binding_does_not_authorize_foreign_or_qualified_confirmation(
    dialogue_env, alter
):
    env = dialogue_env
    _, item, _ = await invitation(env)
    if alter != "unbound":
        await bind_discussion(env, item)
    request = await confirmation_request(env, item)
    request.state["messages"][0].additional_kwargs = {}
    request.state["messages"][-1].additional_kwargs = {}
    if alter == "foreign_previous":
        request.state["messages"][0].additional_kwargs["zhijun_invitation_id"] = "foreign"
    elif alter == "foreign_current":
        request.state["messages"][-1].additional_kwargs["zhijun_invitation_id"] = "foreign"
    elif alter == "source":
        state = await understanding.read_understanding(env.registry, env.uid)
        state.libraries[0].selected = False
        await understanding._save_state(env.workspace, state)
    elif alter == "retraction":
        text = "准确，但其实不是这样，请别记。"
        request.state["messages"][-1].content = text
        request.tool_call["args"]["quote"] = text
    answer = json.loads((await env.middleware.awrap_tool_call(request, AsyncMock())).content)
    if alter == "unbound":
        # Ordinary dialogue can now adopt a unique visible conclusion. It does not
        # inherit the document's attribution without an invitation binding.
        assert answer["status"] == "ready"
        claim = (await read_personal_ontology(env.registry, env.uid)).claims[0]
        assert claim.source_kind == "self_report"
        assert not any(e.source_type == "knowledge" for e in claim.evidence)
        return
    assert answer["status"] == "needs_review" and answer["saved"] is False
    assert not (await read_personal_ontology(env.registry, env.uid)).claims

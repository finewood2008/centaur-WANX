"""Owner approval in a deliberately opened candidate discussion, never arbitrary chat."""

import json
from unittest.mock import AsyncMock

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from tests.unit.agents.test_ontology_admission import command, statement
from tests.unit.agents.test_personal_ontology import ontology_env as ontology_env

from octop.infra.agents.ontology_admission import admitted, pending, review_core
from octop.infra.agents.ontology_runtime import ZhijunOntologyMiddleware, select_context
from octop.infra.agents.personal_ontology import _read, _save

FINAL = "AI 不是不能用，而是最原始的那些资料不交出去。"
ANSWER = (
    "是的，就是这个意思。AI 能用，一起讨论、一起加工都可以，我不愿意交出去的就是最原始的那些资料。"
)


async def setup(registry, monkeypatch):
    c = await statement(registry, "我不愿意把理解和作品交给 AI")
    doc = await _read(registry.get_agent("own").workspace)
    doc.claims[0].discussion_thread_id = "chosen"
    await _save(registry.get_agent("own").workspace, doc)
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {
                "agent_id": "own",
                "user": "7",
                "thread_id": "chosen",
                "source": "web",
            }
        },
    )
    return c


async def call(registry, messages, **args):
    doc = await _read(registry.get_agent("own").workspace)
    c = doc.claims[0]
    result = await ZhijunOntologyMiddleware(registry, "own", 7).awrap_tool_call(
        ToolCallRequest(
            tool_call={
                "id": "t",
                "name": "zhijun_ontology_update",
                "args": {
                    "revision": doc.revision,
                    "claim_id": c.id,
                    "expected_version": c.version,
                    "quote": messages[-1].content,
                    "kind": "principle",
                    **args,
                },
            },
            tool=None,
            state={"messages": messages},
            runtime=None,
        ),
        AsyncMock(),
    )
    return json.loads(result.content)


def approval(answer=ANSWER):
    return [
        HumanMessage(content="就是你最原始的那些资料"),
        AIMessage(content=f"我会这样记住：「{FINAL}」这样理解准确吗？"),
        HumanMessage(id="owner-approval", content=answer),
    ]


async def test_actual_reported_correction_and_full_approval_admits_same_id(
    ontology_env, monkeypatch
):
    registry, _, workspace = ontology_env
    c = await setup(registry, monkeypatch)
    quote = "也不是都不能交给ai，而是不能把原始的素材交出去"
    result = await call(
        registry, [HumanMessage(id="correction", content=quote)], action="correct", statement=quote
    )
    assert result["status"] == "ready" and result["core_effect"] == "candidate"
    doc = await _read(workspace)
    assert len(doc.claims) == 1 and pending(doc.claims[0]) and doc.claims[0].id == c.id
    version = doc.claims[0].version
    # Model supplies the previous visible conclusion; stored text comes from the owner's restatement.
    result = await call(registry, approval(), action="confirm", statement=FINAL)
    assert result["status"] == "ready" and result["core_effect"] == "admitted"
    saved = (await _read(workspace)).claims[0]
    assert admitted(saved) and saved.id == c.id and saved.version != version
    assert saved.statement == ANSWER.split("。", 1)[1]
    assert saved.declaration == ANSWER and saved.declaration_turn == "owner-approval"
    assert select_context(await _read(workspace), "原始资料 AI", "next").claims[0].id == c.id
    assert saved.evidence[-1].source_type == "owner_declaration"
    # A network retry cannot double-admit or silently approve another version.
    replay = await call(
        registry, approval(), action="confirm", statement=FINAL, expected_version=version
    )
    assert replay["status"] == "ready"
    assert (await _read(workspace)).claims[0].version == saved.version
    undo = await review_core(registry, 7, c.id, command(saved, "restore", restore_version=version))
    assert pending(undo.ontology.claims[0]) and not admitted(undo.ontology.claims[0])
    assert undo.ontology.claims[0].statement == quote


@pytest.mark.parametrize("answer", ["是的", "是的，就是这个意思。", "确认加入本体"])
async def test_short_owner_confirmation_in_bound_thread(ontology_env, monkeypatch, answer):
    registry, _, workspace = ontology_env
    c = await setup(registry, monkeypatch)
    result = await call(
        registry,
        approval(answer),
        action="confirm",
        statement=c.statement if answer == "确认加入本体" else FINAL,
    )
    assert result["status"] == "ready" and admitted((await _read(workspace)).claims[0])


@pytest.mark.parametrize(
    "answer",
    [
        "是的，不过我还要想一想",
        "是的，先别记下来",
        "需要进入列表",
        "这不是我的观点",
        "这样准确吗？",
    ],
)
async def test_qualifications_and_list_requests_do_not_admit(ontology_env, monkeypatch, answer):
    registry, _, workspace = ontology_env
    await setup(registry, monkeypatch)
    result = await call(registry, approval(answer), action="confirm", statement=FINAL)
    assert result["status"] == "needs_review" and not admitted((await _read(workspace)).claims[0])


async def test_wrong_target_thread_stale_version_and_fabricated_statement_are_blocked(
    ontology_env, monkeypatch
):
    registry, _, workspace = ontology_env
    c = await setup(registry, monkeypatch)
    for args in [
        {"claim_id": "another"},
        {"statement": "我愿意交出所有资料"},
        {"quote": "旧轮的原话"},
    ]:
        result = await call(registry, approval(), action="confirm", **{"statement": FINAL, **args})
        assert result["status"] == "needs_review"
    result = await call(
        registry, approval(), action="confirm", statement=FINAL, expected_version="old"
    )
    assert result["status"] == "stale"
    monkeypatch.setattr(
        "langgraph.config.get_config",
        lambda: {
            "configurable": {
                "agent_id": "own",
                "user": "7",
                "thread_id": "other",
                "source": "web",
            }
        },
    )
    result = await call(registry, approval(), action="confirm", statement=FINAL)
    assert result["status"] == "needs_review"
    assert (await _read(workspace)).claims[0].version == c.version


async def test_correction_revokes_core_until_the_owner_confirms_again(ontology_env, monkeypatch):
    registry, _, workspace = ontology_env
    await setup(registry, monkeypatch)
    await call(registry, approval(), action="confirm", statement=FINAL)
    text = "准确些说，工作资料可以讨论，家人的资料不交出去"
    corrected = await call(
        registry, [HumanMessage(content=text, id="new")], action="correct", statement=text
    )
    assert corrected["core_effect"] == "candidate"
    doc = await _read(workspace)
    assert pending(doc.claims[0]) and not select_context(doc, "原始资料", "next").claims

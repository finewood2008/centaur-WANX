"""The missing-tool fallback reads owned history without writing model guesses."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from octop.infra.agents.response_options import follow_up_question, generate_response_options
from octop.infra.errors import OctopError


def fixture() -> tuple[SimpleNamespace, SimpleNamespace, SimpleNamespace]:
    llm = SimpleNamespace(
        ainvoke=AsyncMock(
            return_value=AIMessage(
                content=json.dumps(
                    {
                        "options": [
                            {
                                "label": "产品本身",
                                "draft": "我想先把核心产品的方向理清楚，再接着说研发进展。",
                            },
                            {
                                "label": "研发过程",
                                "draft": "我更想聊这周的研发过程，产品方向可以稍后再说。",
                            },
                            {
                                "label": "还没理清",
                                "draft": "这周研发的事还没理清，我想从眼下正在做的部分慢慢说。",
                            },
                        ]
                    },
                    ensure_ascii=False,
                )
            )
        )
    )
    harness = SimpleNamespace(
        aget_history=AsyncMock(
            return_value=[
                HumanMessage(content="这周在研发我们的核心产品"),
                AIMessage(content="我在听。你想先从哪里说起？"),
            ]
        ),
        model_factory=SimpleNamespace(get=Mock(return_value=llm)),
        config=SimpleNamespace(pick_default_model_ref=lambda: "owned/default"),
    )
    registry = SimpleNamespace(
        get_row=lambda _: SimpleNamespace(application_id="zhijun", user_id=7),
        get_agent=lambda _: harness,
        is_agent_active=lambda _: False,
    )
    threads = SimpleNamespace(
        get_thread=lambda _: SimpleNamespace(agent_id="owned", user_id=7, model_ref=None)
    )
    return registry, threads, harness


async def run(registry: SimpleNamespace, threads: SimpleNamespace, **kwargs: object) -> object:
    return await generate_response_options(
        registry,
        threads,
        agent_id="owned",
        user_id=7,
        thread_id="thread",
        reply="我在听。你想先从哪里说起？",
        **kwargs,
    )


def test_only_one_final_question_can_auto_trigger() -> None:
    assert follow_up_question("我在听。\n**你想先从哪里说起？**") == "你想先从哪里说起？"
    assert (
        follow_up_question("有没有哪段时间不一样？比如某个阶段，或者某个人在的时候。")
        == "有没有哪段时间不一样？"
    )
    for text in ["我在听。", "你怎么想？后来呢？", "原话是“你怎么想？”", "> 你怎么想？"]:
        assert follow_up_question(text) is None


@pytest.mark.asyncio
async def test_generates_even_without_agent_tool_call_and_uses_only_owned_native_context() -> None:
    registry, threads, harness = fixture()
    messages = harness.aget_history.return_value
    messages.insert(
        1,
        AIMessage(
            content="",
            tool_calls=[
                {"id": "read", "name": "search_knowledge", "args": {}},
                {"id": "options", "name": "zhijun_response_options", "args": {}},
            ],
        ),
    )
    messages.insert(2, ToolMessage(content="合成资料：研发目标", tool_call_id="read"))
    messages.insert(
        3,
        ToolMessage(
            content="尚未确认的选项不得进入上下文",
            name="zhijun_response_options",
            tool_call_id="options",
        ),
    )
    result = await run(registry, threads)
    assert result.status == "ready"  # type: ignore[attr-defined]
    assert result.invitation.question == "你想先从哪里说起？"  # type: ignore[attr-defined]
    assert len(result.invitation.options) == 3  # type: ignore[attr-defined]
    harness.model_factory.get.assert_called_once_with("owned/default")
    context = harness.model_factory.get.return_value.ainvoke.call_args.args[0][1].content
    assert "研发我们的核心产品" in context and "合成资料：研发目标" in context
    assert "尚未确认的选项" not in context
    assert harness.aget_history.return_value is messages


@pytest.mark.asyncio
@pytest.mark.parametrize("wrong", ["application", "agent", "owner"])
async def test_checks_application_agent_and_thread_owner_before_reading(wrong: str) -> None:
    registry, threads, harness = fixture()
    if wrong == "application":
        registry.get_row = lambda _: SimpleNamespace(application_id="wanx", user_id=7)
    else:
        threads.get_thread = lambda _: SimpleNamespace(
            agent_id="other" if wrong == "agent" else "owned", user_id=8 if wrong == "owner" else 7
        )
    with pytest.raises(OctopError):
        await run(registry, threads)
    harness.aget_history.assert_not_called()


@pytest.mark.asyncio
async def test_rejects_stale_or_answered_reply_without_invoking_model() -> None:
    registry, threads, harness = fixture()
    harness.aget_history.return_value.append(HumanMessage(content="已经回答"))
    assert (await run(registry, threads)).status == "stale"  # type: ignore[attr-defined]
    harness.model_factory.get.assert_not_called()


@pytest.mark.asyncio
async def test_discards_result_if_another_turn_arrives_during_generation() -> None:
    registry, threads, harness = fixture()
    first = harness.aget_history.return_value
    harness.aget_history.side_effect = [first, [*first, HumanMessage(content="新的回答")]]
    assert (await run(registry, threads)).status == "stale"  # type: ignore[attr-defined]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "content",
    [
        "",
        "not json",
        '{"options":[]}',
        '{"options":[{"label":"a","draft":"one"},{"label":"a","draft":"two"}]}',
    ],
)
async def test_model_failures_never_produce_fake_choices(content: str) -> None:
    registry, threads, harness = fixture()
    harness.model_factory.get.return_value.ainvoke.return_value = AIMessage(content=content)
    assert (await run(registry, threads)).status == "unavailable"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_auto_respects_opt_out_while_explicit_request_can_restore_choices() -> None:
    registry, threads, harness = fixture()
    harness.aget_history.return_value[0] = HumanMessage(content="不要选项，听我说")
    assert (await run(registry, threads)).status == "not_needed"  # type: ignore[attr-defined]
    harness.model_factory.get.assert_not_called()
    assert (await run(registry, threads, manual=True)).status == "ready"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_confirmation_uses_substance_and_keeps_user_context_after_many_source_reads() -> None:
    registry, threads, harness = fixture()
    reply = "我会记住：在人机分工中，定方向的人也要为结果负责。这样理解准确吗？"
    harness.aget_history.return_value = [
        HumanMessage(content="人类是 driver，AI 是车。定方向的人就是最后要负责的人。"),
        *(
            ToolMessage(
                content=f"已读原文片段 {i}", name="zhijun_knowledge_get", tool_call_id=str(i)
            )
            for i in range(15)
        ),
        AIMessage(content=reply),
    ]
    drafts = [
        "我在意的就是人不能把方向和责任一并交给 AI。工具可以辅助判断，但最终由人决定并承担结果。",
        "我说的是人机合作中的分工。人定目标、承担结果，AI 可以帮助执行，这两层需要区分。",
        "在人机分工里我认同这个关联。至于是不是适用于所有情况的人生原则，我现在还没想清楚。",
    ]
    harness.model_factory.get.return_value.ainvoke.return_value = AIMessage(
        content=json.dumps(
            {"options": [{"label": str(i), "draft": draft} for i, draft in enumerate(drafts)]}
        )
    )
    result = await generate_response_options(
        registry, threads, agent_id="owned", user_id=7, thread_id="thread", reply=reply
    )
    assert result.status == "ready"
    prompt, data = harness.model_factory.get.return_value.ainvoke.call_args.args[0]
    supplied = json.loads(data.content)
    assert supplied["current_reply"] == reply
    assert supplied["question"] == "这样理解准确吗？"
    assert "人类是 driver" in supplied["recent_conversation"][0]["text"]
    assert len(supplied["already_read_materials"]) == 4
    assert supplied["already_read_materials"][-1]["text"] == "已读原文片段 14"
    assert "不能只针对末尾问句" in prompt.content
    assert [option.draft for option in result.invitation.options] == drafts  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_generic_confirmation_triplet_is_rejected_instead_of_presented_as_answers() -> None:
    registry, threads, harness = fixture()
    harness.model_factory.get.return_value.ainvoke.return_value = AIMessage(
        content=json.dumps(
            {
                "options": [
                    {"label": "准确", "draft": "准确，就是这样。"},
                    {"label": "补充", "draft": "大方向对，但有一处我想补一下。"},
                    {"label": "暂不记", "draft": "先别急着记下来，我还想再想想。"},
                ]
            }
        )
    )
    assert (await run(registry, threads)).status == "unavailable"  # type: ignore[attr-defined]

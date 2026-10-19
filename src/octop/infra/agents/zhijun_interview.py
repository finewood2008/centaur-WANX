"""Resumable, owner-started interview. Answers remain ordinary native chat turns."""

from __future__ import annotations

import json
import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from octop.infra.agents.personal_ontology import _digest, _lock
from octop.infra.agents.zhijun_profile import primary
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.gateway.threads import ThreadRegistry
from octop.infra.utils.ulid import new_ulid

_PATH = "zhijun/interview.json"
QUESTIONS = (
    ("你的经历", "有没有一段经历，让你慢慢变成了现在的自己？从你愿意说的地方开始。"),
    ("你的近况", "最近你把心力花在哪件事上？"),
    ("你在乎的", "拿不定主意的时候，什么是你最不想放下的？"),
    ("正在想的事", "最近有没有一个难拿的主意，想和我一起想想？"),
)


class InterviewState(BaseModel):
    version: str = "empty"
    status: Literal["not_started", "active", "paused", "completed"] = "not_started"
    step: int = Field(default=0, ge=0, le=3)
    thread_id: str = ""
    last_request: str = ""
    last_fingerprint: str = ""


class InterviewView(BaseModel):
    version: str
    status: Literal["not_started", "active", "paused", "completed"]
    step: int
    total: int = len(QUESTIONS)
    thread_id: str
    topic: str
    question: str
    thread_available: bool


class InterviewCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    action: Literal["start", "resume", "pause", "next", "finish"]
    expected_version: str = Field(min_length=1, max_length=100)
    request_id: str = Field(min_length=1, max_length=100)


def _workspace(registry: Any, uid: int, aid: str) -> Any:
    row = registry.get_row(aid)
    if not primary(row) or row.user_id != uid:
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return registry.get_agent(aid).workspace


async def _read(workspace: Any) -> InterviewState:
    raw = await workspace.aread_text(_PATH)
    return InterviewState.model_validate_json(raw) if raw else InterviewState()


def _view(state: InterviewState, threads: Any, uid: int, aid: str) -> InterviewView:
    thread = threads.get_thread(state.thread_id) if state.thread_id else None
    available = bool(thread and thread.agent_id == aid and thread.user_id == uid)
    topic, question = QUESTIONS[state.step]
    return InterviewView(
        **state.model_dump(exclude={"last_request", "last_fingerprint"}),
        topic=topic,
        question=question,
        thread_available=available,
    )


async def read_interview(registry: Any, threads: Any, uid: int, aid: str) -> InterviewView:
    return _view(await _read(_workspace(registry, uid, aid)), threads, uid, aid)


async def update_interview(
    registry: Any, threads: Any, uid: int, aid: str, body: InterviewCommand
) -> InterviewView:
    workspace = _workspace(registry, uid, aid)
    async with _lock(registry, "interview:" + aid):
        state = await _read(workspace)
        fingerprint = _digest(body.model_dump())
        if body.request_id == state.last_request:
            if fingerprint != state.last_fingerprint:
                raise OctopError(ErrorCode.SELF_MODEL_INVALID, "这次操作标识已用于其他修改")
            return _view(state, threads, uid, aid)
        if state.version != body.expected_version:
            raise OctopError(ErrorCode.SELF_MODEL_INVALID, "访谈进度已变化，请刷新后继续")
        if not registry.try_begin_history_backfill(aid):
            raise OctopError.localized(ErrorCode.AGENT_BUSY)
        created = ""
        try:
            view = _view(state, threads, uid, aid)
            if body.action == "start":
                if state.status != "not_started" and view.thread_available:
                    raise OctopError(ErrorCode.SELF_MODEL_INVALID, "已有访谈，请继续原来的对话")
                created = threads.create_thread(
                    agent_id=aid,
                    user_id=uid,
                    channel_type=ThreadRegistry.CHANNEL_DASHBOARD,
                    session_key=ThreadRegistry.dashboard_key(agent_id=aid, user_id=uid),
                    title="慢慢认识你 · 起步访谈",
                    last_active=int(time.time()),
                )
                state = InterviewState(thread_id=created, status="active")
            else:
                if not view.thread_available:
                    raise OctopError(ErrorCode.SELF_MODEL_INVALID, "原访谈对话已不可用，请重新开始")
                if body.action == "resume" and state.status == "paused":
                    state.status = "active"
                elif body.action == "pause" and state.status == "active":
                    state.status = "paused"
                elif body.action == "next" and state.status == "active":
                    if state.step == len(QUESTIONS) - 1:
                        state.status = "completed"
                    else:
                        state.step += 1
                elif body.action == "finish" and state.status in {"active", "paused"}:
                    state.status = "completed"
                else:
                    raise OctopError(ErrorCode.SELF_MODEL_INVALID, "当前访谈不能执行这项操作")
            state.version = new_ulid()
            state.last_request, state.last_fingerprint = body.request_id, fingerprint
            content = state.model_dump_json()
            await workspace.aupload_bytes(_PATH, content.encode())
            if await workspace.aread_text(_PATH) != content:
                raise OctopError.localized(ErrorCode.INTERNAL_ERROR)
        except BaseException as exc:
            if created:
                # A transport failure can occur after the progress was persisted.
                # Keep its referenced thread, and let the same request recover the receipt.
                try:
                    persisted = await _read(workspace)
                except Exception:
                    pass  # Unknown write outcome: retaining an empty thread is recoverable.
                else:
                    if persisted.thread_id != created:
                        threads.delete_thread(created)
            if isinstance(exc, Exception) and not isinstance(exc, OctopError):
                raise OctopError.localized(ErrorCode.INTERNAL_ERROR) from exc
            raise
        finally:
            registry.end_history_backfill(aid)
        return _view(state, threads, uid, aid)


async def interview_context(registry: Any, uid: int, aid: str, tid: str) -> str:
    state = await _read(_workspace(registry, uid, aid))
    if not tid or state.status != "active" or state.thread_id != tid:
        return ""
    return (
        "\n## 起步访谈：跟随本人，不替本人补全\n"
        "本人已主动开始访谈，话题由本人选择切换。以下当前问题已显示，不要重新问一遍。"
        "访谈要顺着本人刚说的具体内容往前走，不是等本人独自把故事讲完。普通叙事分享时，"
        "从最新内容里选一个尚未说清、值得了解的点，只问一个具体而开放的问题；本人已经回答的不要再问。"
        "通常直接问，问题本身就是承接。开头若只是同义复述本人上一句话，就删掉那句，直接进入具体问题。需要回应情绪或纠正时才加一句短承接，不机械重复事实，也不评价‘这很具体’‘这很有分量’。"
        "不要连续用‘你愿意多说说吗’‘从哪里说起都行’‘我听着’结尾，也不要每轮声明‘不急着分析/归纳’。"
        "问题可以询问已提到的经历中发生了什么、本人如何看待、当时如何做决定；这些是邀请本人提供未知信息，"
        "不是让你补出答案。只挑一个切口，不一口气问经过、原因、感受和收获，不急着总结人生道理。"
        "对方只想倾诉、只要简短回应、拒绝某个问题、暂停或换话题时直接尊重，不为了访谈而强行追问。"
        "承接不是解释：可以不复述；需要提及经历时，直接引用本人原话中的一个短语，不改写情节。保留感受和限定词。过去某时的情绪不能延长到现在，例如‘回家后有点烦’不能说成‘那点烦还在’。不能增加原因、准备情况、结局、动机、"
        "价值排序、身体机制或他人态度；即使常识上合理也不能当成这个人的事实。"
        "‘听起来’‘可能’‘往往’不能让无依据的补充变成合格承接。未知就留白，需要时开放询问，"
        "不要把自己的猜测塞进问题，也不要用二选一让本人替猜测选答案。问题只围绕本人已提到的片段开放展开，不假设谁要求他、事情是否结束、为何没说话。"
        "情绪倾诉只承认已表达的难受，不解释为什么难受，不用性格评价或归因来安慰。"
        "只谈当前消息时不必检索过去；工具实际返回为空就保持未知，不声称整个档案或过去都没有记录。"
        "若本人明确索要分析，区分已知与假设，提出需要核实的条件，仍不把假设写成人生事实。"
        "不要声称理解已保存、访谈状态已改变或访谈已完成；以实际服务端回执为准。"
        "\n以下是如何从已知内容找到提问切口的示例，不是本人资料，也不应固定套用：\n"
        "- 本人：我开过两家小店。可直接问：哪一家对你的影响更大？"
        "（不假设开店顺序、成败或对方做过什么。）\n"
        "- 本人：那家店拿到了资助，最后却关了。可问：回头看，你觉得店关掉的主要原因是什么？"
        "（已知关店，可以询问原因；不能直接猜资金断裂、合伙矛盾或经营失误。）\n"
        "- 本人：临时做汇报，我很紧张。可问：你还记得那次汇报里最让你紧张的是什么吗？"
        "（询问紧张的具体对象，不预设没准备、被叫上台或被人质疑。）\n"
        "- 本人：比赛没赢，不过和队友相处得很好。可问：和队友相处时，有什么片段让你印象很深？"
        "（不认定友谊比输赢更重要，不假定这让他释然。）\n"
        "- 本人：我很累，只想说说。可以简短接住：嗯，不用急着理清楚。"
        "（此时不追问、不归因。不要把只想说说的处理套到所有普通分享。）\n"
        "- 本人：这次我没答应，但平时会。可问：这次你是怎么做出决定的？"
        "（不假定他开始拒绝、改变性格或受到伤害。）\n"
        "发出前检查每个关于本人的陈述和问题前提：能否从本人原话或已核验来源直接找到依据？"
        "找不到就删除，不用推测补足字数。宁可短而贴切，不为表达完整而填空。自然说话，不向本人解释这些检查规则。\n"
        + json.dumps(
            {"topic": QUESTIONS[state.step][0], "question": QUESTIONS[state.step][1]},
            ensure_ascii=False,
        )
    )

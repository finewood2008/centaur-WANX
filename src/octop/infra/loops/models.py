"""Credential-free Loop contracts shared by domain and HTTP adapters."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from octop.infra.cron.trigger import build_trigger


class Criterion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["manual", "file_exists", "tool_equals"] = "manual"
    description: str = Field(min_length=1, max_length=2000)
    path: str = ""
    tool: str = ""
    field: list[str] = Field(default_factory=list, max_length=10)
    expected: str | int | float | bool | None = None

    @model_validator(mode="after")
    def valid_binding(self) -> Criterion:
        if self.kind == "file_exists" and (
            not self.path
            or self.path.startswith(("/", "\\"))
            or "\\" in self.path
            or ":" in self.path
            or any(p in {"..", ".octop", ".octop-auth"} for p in self.path.split("/"))
        ):
            raise ValueError("criterion path must be a relative workspace content path")
        if self.kind == "tool_equals" and not self.tool:
            raise ValueError("tool_equals requires an existing tool name")
        return self


class HumanCheckpoint(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    expected_outcome: str = Field(min_length=1, max_length=2000)
    instruction: str = Field(
        default="",
        max_length=2000,
        description="AI work for this stage before the human checkpoint; legacy stages use the overall instruction.",
    )


class HumanReviewPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    checkpoints: list[HumanCheckpoint] = Field(min_length=1, max_length=10)
    max_rounds: int = Field(default=3, ge=1, le=1000)
    max_execution_seconds: int = Field(default=1800, ge=60, le=86400)


class JudgmentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    judgment_id: str
    action: Literal["continue", "feedback", "complete"]
    feedback: str = Field(default="", max_length=4000)


class ChannelBindingBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str
    channel_id: str
    owner_proof: str | None = Field(
        default=None,
        max_length=128,
        description="One-use server proof from an authenticated QR flow; otherwise wait for a private message and app confirmation.",
    )


class LoopDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    agent_id: str = Field(min_length=1, max_length=128)
    objective: str = Field(min_length=1, max_length=4000)
    instruction: str = Field(min_length=1, max_length=4000)
    kind: Literal["completion", "continuous"] = "completion"
    task_mode: Literal["goal", "routine"] = Field(
        default="goal",
        description="Routine repeats one standard small task; goal retains legacy stages.",
    )
    criterion: Criterion
    human_review: HumanReviewPolicy
    channel_binding_id: str | None = None
    deliver_result: bool = Field(
        default=False,
        description="Send each successful round to the verified owner channel. Requires channel binding before trial or enable.",
    )
    interval_seconds: int = Field(default=60, ge=60, le=86400 * 30)
    calendar_trigger: str | None = Field(
        default=None,
        description="For a continuous loop, use cron:<five fields>, e.g. cron:0 9 * * * for daily 09:00 in the box timezone. Otherwise null.",
    )
    max_rounds: int = Field(default=10, ge=1, le=1000)
    timeout_seconds: int = Field(default=600, ge=10, le=3600)
    failure_limit: int = Field(default=3, ge=1, le=20)
    allowed_tools: list[str] = Field(default_factory=list, max_length=100)
    mcp_servers: list[str] = Field(default_factory=list, max_length=30)
    knowledge_base_ids: list[str] = Field(default_factory=list, max_length=30)
    skill_package_ids: list[str] = Field(default_factory=list, max_length=30)
    model: str | None = None
    source_cron_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def mode_defaults(cls, value: Any) -> Any:
        if isinstance(value, dict) and value.get("kind") == "continuous":
            return {"interval_seconds": 1800, **value}
        return value

    @model_validator(mode="after")
    def valid_configuration(self) -> LoopDefinition:
        if not self.name.strip() or not self.objective.strip() or not self.instruction.strip():
            raise ValueError("name, objective and instruction must not be blank")
        if self.task_mode == "routine" and (
            self.kind != "continuous" or len(self.human_review.checkpoints) != 1
        ):
            raise ValueError("routine mode repeats one small task with one human review policy")
        if self.calendar_trigger:
            if self.kind != "continuous" or not self.calendar_trigger.startswith("cron:"):
                raise ValueError("calendar scheduling is available for continuous loops only")
            build_trigger(self.calendar_trigger)
        if self.criterion.kind == "tool_equals" and self.criterion.tool not in self.allowed_tools:
            raise ValueError("criterion tool must be included in allowed_tools")
        if any(
            n.startswith("cronjob_") or n in {"task", "ask_agent", "agent_list", "acp_runner"}
            for n in self.allowed_tools
        ):
            raise ValueError("loop tools cannot create schedules or delegate outside their scope")
        return self


class ReportSection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=8000)
    sources: list[str] = Field(default_factory=list, max_length=10)


class ResultReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=160)
    overview: str = Field(min_length=1, max_length=800)
    highlights: list[str] = Field(default_factory=list, max_length=5)
    sections: list[ReportSection] = Field(min_length=1, max_length=12)
    limitations: list[str] = Field(default_factory=list, max_length=5)


class RoundDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Literal["continue", "complete", "needs_input"]
    summary: str = Field(min_length=1, max_length=8000)
    next_action: str = Field(default="", max_length=4000)
    evidence: list[str] = Field(default_factory=list, max_length=50)
    question: str = Field(default="", max_length=2000)
    checkpoint_ready: bool = False
    choices: list[str] = Field(default_factory=list, max_length=3)
    report: ResultReport | None = None
    delivery_text: str = Field(
        default="",
        max_length=4000,
        description="Exact plain-text message for the verified owner; the service handles delivery. Never claim it was already sent.",
    )

    @model_validator(mode="after")
    def valid_choices(self) -> RoundDecision:
        if any(not choice.strip() or len(choice) > 500 for choice in self.choices):
            raise ValueError("answer choices must be short and non-empty")
        return self


class ReviewBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accepted: bool
    feedback: str = Field(default="", max_length=4000)


class ApprovalBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    round_id: str
    checkpoint_id: str
    decisions: list[dict[str, Any]] = Field(min_length=1, max_length=50)


class LoopView(BaseModel):
    loop_id: str
    user_id: int
    version: int
    definition: dict[str, Any]
    status: str
    enabled: bool
    reason: str | None
    progress: dict[str, Any]
    round_count: int
    failures: int
    next_run_at: int | None
    thread_id: str | None
    source_cron_id: str | None
    created_at: int
    updated_at: int
    checkpoint_index: int = 0
    review_rounds: int = 0
    review_seconds: float = 0
    pending_judgment: dict[str, Any] | None = None
    notifications: list[dict[str, Any]] = Field(default_factory=list)


class OverviewResultView(BaseModel):
    trial: bool
    loop_id: str
    round_id: str
    name: str
    finished_at: int
    title: str
    overview: str
    highlights: list[str]
    legacy_summary: str | None = None


class RoundView(BaseModel):
    round_id: str
    loop_id: str
    version: int
    number: int
    status: str
    trial: bool
    result: dict[str, Any]
    pending: dict[str, Any] | None
    started_at: int
    finished_at: int | None


class DraftBody(BaseModel):
    agent_id: str
    text: str = Field(min_length=1, max_length=4000)
    current: LoopDefinition | None = Field(
        default=None,
        description="Current editable proposal for conversational refinement; never executed or saved by drafting.",
    )


class BuilderMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ConnectorToolsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str
    mcp_servers: list[str] = Field(default_factory=list, max_length=30)


class ConnectorToolView(BaseModel):
    name: str
    description: str
    server: str


class ConnectorToolsView(BaseModel):
    tools: list[ConnectorToolView]
    unavailable: list[str]


class BuilderBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    agent_id: str
    messages: list[BuilderMessage] = Field(min_length=1, max_length=20)
    current: LoopDefinition | None = None
    mcp_servers: list[str] | None = Field(default=None, max_length=30)
    knowledge_base_ids: list[str] | None = Field(default=None, max_length=30)
    skill_package_ids: list[str] | None = Field(default=None, max_length=30)
    task_mode: Literal["goal", "routine"] = "goal"

    @model_validator(mode="after")
    def user_turn(self) -> BuilderBody:
        if self.messages[-1].role != "user":
            raise ValueError("a builder turn must end with a user answer")
        return self


class BuilderReply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=1000)
    question: str = Field(default="", max_length=1000)
    options: list[str] = Field(default_factory=list, max_length=3)
    ready: bool = False
    proposal: LoopDefinition | None = None

    @model_validator(mode="after")
    def valid_turn(self) -> BuilderReply:
        if self.ready:
            if self.proposal is None or self.question or self.options:
                raise ValueError("a ready proposal has no unanswered question")
            if any(not c.instruction.strip() for c in self.proposal.human_review.checkpoints):
                raise ValueError("ready stages must describe the AI work")
        elif not self.question.strip() or not 2 <= len(self.options) <= 3:
            raise ValueError("ask one question with two or three choices")
        if any(not option.strip() or len(option) > 500 for option in self.options):
            raise ValueError("choices must be short and non-empty")
        return self


class ExecutorView(BaseModel):
    agent_id: str
    name: str


class CapabilityView(BaseModel):
    connector_selection: bool = True
    resource_selection: bool = True
    shared_knowledge_base: bool = True
    available: bool = True
    protocol_version: int = 2
    human_judgments: bool = True
    channel_interaction: bool = True
    visual_builder: bool = True
    routine_tasks: bool = True
    task_trash: bool = True
    dedicated_executor: bool = True
    result_delivery: bool = True
    timezone: str


class BindingView(BaseModel):
    binding_id: str
    agent_id: str
    channel_id: str | None
    status: str
    subject_id: str | None = None
    display_name: str | None = None
    expires_at: int
    created_at: int
    confirmed_at: int | None = None
    message_preview: str = ""


class BindingChallengeView(BaseModel):
    binding_id: str
    code: str = Field(
        description="One-use code, shown only when created; send it in a private message"
    )
    expires_at: int
    status: str


class BindingConfirmationView(BaseModel):
    binding_id: str
    status: str


class JudgmentView(BaseModel):
    judgment_id: str
    code: str
    loop_id: str
    version: int
    round_id: str | None
    kind: Literal["stage", "periodic", "input", "final"]
    status: str
    payload: dict[str, Any]
    decision: dict[str, Any] | None = None
    created_at: int
    resolved_at: int | None = None

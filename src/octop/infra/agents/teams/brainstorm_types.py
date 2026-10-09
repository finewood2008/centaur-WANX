"""Brainstorm state; conversations remain native Octop threads."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class SourceReference(BaseModel):
    id: str
    kind: Literal["memory", "ontology", "knowledge", "history"]
    title: str
    text: str = ""
    version: str = ""
    provenance: str = ""


class ContextResult(BaseModel):
    sources: list[SourceReference] = Field(default_factory=list)
    text: str = ""
    notices: list[str] = Field(default_factory=list)


class MeetingOption(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    detail: str = Field(default="", max_length=300)
    effect: Literal["respond", "adopt", "revisit"] = Field(
        default="respond", description="Only adopt on a verdict records the owner's final ruling."
    )


class DecisionProposal(BaseModel):
    kind: Literal["intake", "judgment", "verdict"]
    question: str = Field(min_length=1, max_length=500)
    options: list[MeetingOption] = Field(min_length=2, max_length=3)


class MeetingDecision(BaseModel):
    id: str
    kind: Literal["intake", "agenda", "judgment", "verdict"]
    question: str
    options: list[MeetingOption] = Field(default_factory=list)


class UserJudgment(BaseModel):
    question: str
    answer: str


class MeetingAction(BaseModel):
    task: str = Field(min_length=1, max_length=1000)
    owner: str = Field(default="", max_length=200, description="Proposed owner, not an assignment.")
    timing: str = Field(default="", max_length=200, description="Proposed timing, if discussed.")


class MeetingReportDraft(BaseModel):
    overview: str = Field(default="", max_length=6000)
    key_points: list[str] = Field(default_factory=list, max_length=30)
    disagreements: list[str] = Field(default_factory=list, max_length=20)
    actions: list[MeetingAction] = Field(default_factory=list, max_length=20)
    open_questions: list[str] = Field(default_factory=list, max_length=20)


class MeetingReport(BaseModel):
    thread_id: str
    title: str
    generated_at: datetime
    outcome: Literal["adopted", "unresolved"]
    markdown: str = Field(description="Frozen report including the explicit owner ruling, if any.")


class BrainstormMember(BaseModel):
    agent_id: str
    name: str
    model: str | None
    expert_id: str = ""
    description: str = ""


class BrainstormExpert(BaseModel):
    id: str
    name: str
    description: str
    source: Literal["builtin", "skillhub"]
    recommended: bool = False


class BrainstormSession(BaseModel):
    thread_id: str
    team_id: str
    user_id: int
    title: str
    participants: list[BrainstormMember] = Field(default_factory=list)
    status: Literal["running", "waiting", "paused", "ended", "interrupted"] = "running"
    context_enabled: bool = True
    excluded_source_ids: list[str] = Field(default_factory=list)
    context: ContextResult = Field(default_factory=ContextResult)
    ideas: list[str] = Field(default_factory=list)
    directions: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)
    summary: str = ""
    turns: int = 0
    revision: int = 0
    phase: Literal["intake", "agenda", "deliberation", "decision", "closed"] = "deliberation"
    agenda_confirmed: bool = False
    goal: str = ""
    constraints: list[str] = Field(default_factory=list)
    agenda: str = ""
    brief: str = ""
    decision: MeetingDecision | None = Field(
        default=None, description="The current owner input card; its id changes when replaced."
    )
    judgments: list[UserJudgment] = Field(default_factory=list)
    intake_answers: int = 0
    ruling: str = Field(default="", description="An explicit owner adoption, never a host summary.")
    report_draft: MeetingReportDraft | None = None
    report: MeetingReport | None = Field(
        default=None, description="Final report frozen on closing."
    )


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: str = Field(min_length=1, max_length=12000)
    context_enabled: bool = True
    expert_ids: list[str] | None = Field(default=None, min_length=2, max_length=12)


class SessionControl(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal[
        "pause",
        "resume",
        "end",
        "summarize",
        "sources",
        "respond",
        "start",
        "revise",
        "agenda",
        "adopt",
    ]
    context_enabled: bool | None = None
    excluded_source_ids: list[str] | None = Field(default=None, max_length=100)
    text: str | None = Field(
        default=None,
        min_length=1,
        max_length=12000,
        description="Owner feedback for respond. Use either text or option_index.",
    )
    decision_id: str | None = Field(
        default=None, description="Current card id, required for selecting an option or starting."
    )
    option_index: int | None = Field(
        default=None, ge=0, le=2, description="Zero-based index in the current card's options."
    )
    revision: int | None = Field(
        default=None, ge=0, description="Last observed revision; stale submissions are rejected."
    )


class ProfileConfigure(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expert_ids: list[str] | None = Field(default=None, min_length=2, max_length=12)
    expert_models: dict[str, str] = Field(
        default_factory=dict,
        max_length=12,
        description="Model assignments keyed by selected WANX expert ID. Values must be enabled chat models from the current WANX catalog. Omitted experts keep their existing model.",
    )


class BrainstormProfile(BaseModel):
    team_id: str | None = None
    members: list[BrainstormMember] = Field(default_factory=list)
    host_model: str | None = None
    models: list[str] = Field(default_factory=list)
    experts: list[BrainstormExpert] = Field(default_factory=list)

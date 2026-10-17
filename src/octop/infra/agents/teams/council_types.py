"""Personal council records; speech bodies remain in native thread history."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ProposalRef(BaseModel):
    proposal_id: str
    version: int = Field(ge=1)


class CouncilIssue(BaseModel):
    id: str
    question: str = Field(min_length=1, max_length=500)
    status: Literal["discussing", "presented", "deferred", "decided"] = "discussing"


class ProposalVersion(BaseModel):
    version: int
    title: str
    advice: str
    basis: str
    cost: str
    change_reason: str
    message_id: str
    source_ids: list[str] = Field(default_factory=list)
    context_version: int = 0


class CouncilProposal(BaseModel):
    id: str
    issue_id: str
    author_id: str
    status: Literal["active", "deferred", "needs_review", "adopted"] = "active"
    versions: list[ProposalVersion] = Field(default_factory=list)


class CouncilReview(BaseModel):
    id: str
    issue_id: str
    proposal_id: str
    version: int
    author_id: str
    stance: Literal["support", "concern", "question"]
    point: str
    message_id: str


class CouncilSpeech(BaseModel):
    message_id: str
    issue_id: str
    author_id: str
    responds_to: str = ""


class CouncilChange(BaseModel):
    id: str
    kind: Literal["proposal", "revision", "review", "user", "context", "defer", "ruling"]
    text: str
    issue_id: str = ""
    proposal_id: str = ""
    message_id: str = ""


class CouncilBoard(BaseModel):
    version: int = 0
    context_version: int = 0
    stale_message_ids: list[str] = Field(default_factory=list)
    active_issue_id: str = ""
    issues: list[CouncilIssue] = Field(default_factory=list)
    proposals: list[CouncilProposal] = Field(default_factory=list)
    reviews: list[CouncilReview] = Field(default_factory=list)
    speeches: list[CouncilSpeech] = Field(default_factory=list)
    changes: list[CouncilChange] = Field(default_factory=list)
    recommendation: ProposalRef | None = None
    adopted: ProposalRef | None = None
    pending_input: str = ""
    input_acknowledgment: str = ""
    next_step: str = ""
    processed_updates: list[str] = Field(default_factory=list)


class RosterRecommendation(BaseModel):
    agent_id: str
    reason: str = Field(min_length=1, max_length=300)


class CouncilUpdate(BaseModel):
    """One idempotent change, backed by an existing native speech where applicable."""

    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    kind: Literal["issue", "proposal", "review", "speech", "brief", "defer"]
    issue_id: str = ""
    question: str = ""
    status: Literal["discussing", "presented", "deferred"] = "discussing"
    proposal_id: str = ""
    version: int = Field(default=1, ge=1)
    author_id: str = ""
    message_id: str = ""
    responds_to: str = ""
    title: str = ""
    advice: str = ""
    basis: str = ""
    cost: str = ""
    change_reason: str = ""
    source_ids: list[str] = Field(default_factory=list, max_length=20)
    stance: Literal["support", "concern", "question"] = "concern"
    point: str = ""
    recommendation: ProposalRef | None = None
    input_acknowledgment: str = ""
    next_step: str = ""

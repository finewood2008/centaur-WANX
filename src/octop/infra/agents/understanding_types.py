"""Owned, source-versioned reading progress and invitations; never native memory facts."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from octop.infra.agents.ontology_types import Kind

Role = Literal["personal", "reference", "mixed"]


class UnderstandingLibrary(BaseModel):
    kb_id: str
    name: str = ""
    default_open: bool = False
    role: Role = "mixed"
    selected: bool = False


class UnderstandingSource(BaseModel):
    kb_id: str
    document_id: str
    filename: str
    source_version: str
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    content_hash: str = ""
    extracted_hash: str = ""


class UnderstandingInvitation(BaseModel):
    id: str
    title: str
    question: str
    summary: str
    quote: str
    source: UnderstandingSource
    role: Role = "mixed"
    author: str = ""
    time_scope: str = ""
    meaning: str = ""
    suggested_statement: str = ""
    kind: Kind = "situation"
    conditions: str = ""
    exceptions: str = ""
    status: Literal["pending", "active", "snoozed", "resolved", "dismissed", "invalid"] = "pending"
    activation_phrase: str
    created_at: str
    reviewed_at: str | None = None
    read_at: str | None = None
    discussion_thread_id: str | None = None
    snoozed_until: str | None = None
    responses: list[dict[str, str]] = Field(default_factory=list)
    source_available: bool = True

    @model_validator(mode="before")
    @classmethod
    def legacy_read_state(cls, value: Any) -> Any:
        if isinstance(value, dict) and "read_at" not in value:
            return {**value, "read_at": value.get("reviewed_at")}
        return value


class UnderstandingProgress(BaseModel):
    status: Literal["idle", "pending", "running", "paused", "failed", "complete"] = "idle"
    documents_total: int = 0
    documents_read: int = 0
    characters_total: int = 0
    characters_read: int = 0
    pending_documents: int = 0
    failed_documents: int = 0
    last_error: str | None = None


class DocumentReading(BaseModel):
    kb_id: str
    document_id: str
    filename: str
    source_version: str = ""
    content_hash: str = ""
    extracted_hash: str = ""
    updated_at: str = ""
    offset: int = 0
    total_chars: int = 0
    status: Literal["pending", "reading", "complete", "failed", "unavailable"] = "pending"
    last_error: str | None = None
    attempts: int = 0
    role: Role = "mixed"


class UnderstandingState(BaseModel):
    schema_version: int = 1
    revision: str = "empty"
    enabled: bool = False
    libraries: list[UnderstandingLibrary] = Field(default_factory=list)
    model: dict[str, Any] = Field(default_factory=lambda: {"name": "", "local": False})
    progress: UnderstandingProgress = Field(default_factory=UnderstandingProgress)
    invitations: list[UnderstandingInvitation] = Field(default_factory=list)
    documents: dict[str, DocumentReading] = Field(default_factory=dict)
    weixin_reminders: bool = False
    weixin_deliveries: list[dict[str, Any]] = Field(default_factory=list)


class UnderstandingModelInfo(BaseModel):
    name: str = Field(default="", description="Profile's configured synthesis model reference.")
    local: bool = Field(
        default=False, description="Whether the model endpoint is local to this host."
    )


class UnderstandingPublicState(BaseModel):
    """Owner-facing status; delivery reservations remain private to the coordinator."""

    model_config = ConfigDict(from_attributes=True)
    schema_version: int = 1
    revision: str = "empty"
    enabled: bool = False
    libraries: list[UnderstandingLibrary] = Field(default_factory=list)
    model: UnderstandingModelInfo = Field(default_factory=UnderstandingModelInfo)
    progress: UnderstandingProgress = Field(default_factory=UnderstandingProgress)
    invitations: list[UnderstandingInvitation] = Field(default_factory=list)
    documents: dict[str, DocumentReading] = Field(default_factory=dict)
    weixin_reminders: bool = False


class UnderstandingSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=1, max_length=100)
    libraries: list[UnderstandingLibrary] = Field(default_factory=list, max_length=100)
    enabled: bool | None = None
    weixin_reminders: bool | None = None


class UnderstandingRevision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=1, max_length=100)


class InvitationReview(UnderstandingRevision):
    action: Literal["accept", "later", "dismiss", "resolve", "read"]


class UnderstandingConversation(BaseModel):
    state: UnderstandingPublicState
    thread: dict[str, Any]


class ReadingProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=60)
    question: str = Field(min_length=1, max_length=250)
    summary: str = Field(min_length=1, max_length=400)
    quote: str = Field(min_length=1, max_length=500)
    author: str = Field(default="归属尚待核对", max_length=100)
    time_scope: str = Field(default="", max_length=100)
    meaning: str = Field(default="", max_length=400)
    suggested_statement: str = Field(default="", max_length=400)
    kind: Kind = "situation"
    conditions: str = Field(default="", max_length=300)
    exceptions: str = Field(default="", max_length=300)


class ReadingProposals(BaseModel):
    model_config = ConfigDict(extra="forbid")
    invitations: list[ReadingProposal] = Field(default_factory=list, max_length=2)

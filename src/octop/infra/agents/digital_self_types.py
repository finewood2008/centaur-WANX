"""Owner-reviewed publications and isolated visitor conversations."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SelfSource(StrictModel):
    kind: Literal["statement", "ontology", "memory", "episode", "knowledge"]
    id: str = Field(max_length=180)
    version: str = Field(max_length=120)
    title: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=1, max_length=6000)
    needs_review: bool = False
    total_chars: int = 0
    next_start: int | None = None


class SourcePage(BaseModel):
    items: list[SelfSource]
    has_more: bool = False
    libraries: list[dict[str, str]] = Field(default_factory=list)


class SelfEntry(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=1, max_length=6000)
    source: SelfSource | None = None
    recognized: bool = False


class SelfDraft(StrictModel):
    name: str = Field(default="", max_length=60)
    bio: str = Field(default="", max_length=600)
    topics: list[str] = Field(default_factory=list, max_length=8)
    style: str = Field(default="简洁、具体，先理解问题，再说明判断依据。", max_length=800)
    boundaries: str = Field(default="不代本人承诺合作、交易或私人事项。", max_length=1200)
    questions: list[str] = Field(default_factory=list, max_length=3)
    entries: list[SelfEntry] = Field(default_factory=list, max_length=30)
    access: Literal["approval", "open"] = "approval"
    visitor_daily_limit: int = Field(default=10, ge=1, le=10)
    daily_limit: int = Field(default=100, ge=1, le=100)


class SelfPublication(BaseModel):
    version: str
    published_at: str
    draft: SelfDraft


class SelfAccess(BaseModel):
    visitor_id: int
    status: Literal["pending", "approved", "rejected", "revoked"] = "pending"
    note: str = ""
    contact: str = ""
    updated_at: str = ""
    contact_status: Literal["none", "pending", "accepted", "declined"] = "none"


class SelfState(BaseModel):
    id: str = ""
    revision: str = "empty"
    status: Literal["unpublished", "published", "paused"] = "unpublished"
    draft: SelfDraft = Field(default_factory=SelfDraft)
    publication: SelfPublication | None = None
    visitors: list[SelfAccess] = Field(default_factory=list)
    usage: dict[str, int] = Field(default_factory=dict)
    network_status: Literal["contract_pending"] = "contract_pending"


class SelfCommand(StrictModel):
    revision: str = Field(min_length=1, max_length=100)
    action: Literal["save", "generate", "publish", "pause", "unpublish"]
    draft: SelfDraft | None = None


class AccessCommand(StrictModel):
    revision: str = Field(min_length=1, max_length=100)
    visitor_id: int
    action: Literal["approve", "reject", "revoke", "contact_accept", "contact_decline"]


class SelfCard(BaseModel):
    id: str
    name: str
    bio: str
    topics: list[str]
    questions: list[str]
    works: list[str]
    updated_at: str
    version: str
    online: bool
    access: Literal["approval", "open"]
    access_status: str
    model: str
    model_local: bool
    owner_visible: bool = True
    contact_status: Literal["none", "pending", "accepted", "declined"] = "none"


class DiscoveryPage(BaseModel):
    items: list[SelfCard]
    total: int
    has_more: bool
    unavailable_profiles: int = 0
    network_status: Literal["contract_pending"] = "contract_pending"


class VisitorMessage(BaseModel):
    id: str
    role: Literal["user", "assistant"]
    text: str
    at: str
    publication_version: str
    sources: list[str] = Field(default_factory=list)
    context_sources: list[str] = Field(default_factory=list)
    options: list[str] = Field(default_factory=list)
    request_id: str = ""
    assisted: bool = False


class RelationshipFact(BaseModel):
    text: str
    quote: str
    message_id: str


class VisitorHistory(BaseModel):
    revision: str = "empty"
    messages: list[VisitorMessage] = Field(default_factory=list)
    memory: list[RelationshipFact] = Field(default_factory=list)
    pending_request: str | None = None
    pending_text: str = ""
    pending_at: str = ""
    pending_status: Literal["running", "unknown", "failed"] | None = None


class HistoryPage(BaseModel):
    revision: str
    messages: list[VisitorMessage]
    memory: list[RelationshipFact]
    total: int
    has_more: bool
    pending_request: str | None = None
    pending_text: str = ""
    pending_status: str | None = None


class VisitorTurn(StrictModel):
    request_id: str = Field(min_length=12, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    revision: str = Field(min_length=1, max_length=100)
    publication_version: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=4000)
    acknowledge_owner_visibility: bool = Field(
        description="Visitor explicitly acknowledges that the owner can read this conversation and the configured model processes it."
    )
    assisted: bool = Field(
        default=False,
        description="The human message originated from an editable AI suggestion and is not independent relationship evidence.",
    )


class HistoryCommand(StrictModel):
    revision: str = Field(min_length=1, max_length=100)
    action: Literal["clear", "forget", "dismiss_pending"]


class VisitorRequest(StrictModel):
    note: str = Field(default="", max_length=600)
    contact: str = Field(default="", max_length=600)


class SelfReply(BaseModel):
    answer: str = Field(min_length=1, max_length=12000)
    sources: list[str] = Field(default_factory=list, max_length=8)
    context_sources: list[str] = Field(default_factory=list, max_length=8)
    options: list[str] = Field(default_factory=list, max_length=3)
    memory: list[dict[str, str]] = Field(default_factory=list, max_length=8)


class PreviewTurn(StrictModel):
    revision: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=4000)


class PublishedEntry(BaseModel):
    id: str
    title: str
    text: str
    publication_version: str

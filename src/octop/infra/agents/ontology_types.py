"""Versioned, user-owned personal understandings; no native memory mutations."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Kind = Literal[
    "principle", "value", "decision", "boundary", "aspiration", "situation", "response", "identity"
]


class OntologyProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    kind: Kind
    title: str = Field(min_length=1, max_length=40)
    statement: str = Field(min_length=1, max_length=400)
    conditions: str = Field(min_length=1, max_length=300)
    exceptions: str = Field(min_length=1, max_length=300)
    evidence_ids: list[str] = Field(min_length=2, max_length=6)
    context_ids: list[str] = Field(default_factory=list, max_length=12)
    equivalent_to: str = ""


class OntologyEvidence(BaseModel):
    source_type: Literal["memory", "knowledge", "owner_declaration"] = "memory"
    atom_id: str = ""
    event_id: str = ""
    quote: str
    timestamp: str
    atom_hash: str = ""
    raw_hash: str = ""
    experience_id: str = ""
    kb_id: str = ""
    document_id: str = ""
    filename: str = ""
    source_version: str = ""
    start: int = 0
    end: int = 0
    available: bool = True


class OntologyVersion(BaseModel):
    version: str
    at: str
    reason: str
    value: dict[str, Any]


class OntologyClaim(BaseModel):
    id: str
    kind: Kind
    title: str
    statement: str
    conditions: str
    exceptions: str
    time_scope: str = ""
    state: Literal["draft", "confirmed", "dismissed", "withdrawn"] = "draft"
    evidence: list[OntologyEvidence] = Field(default_factory=list)
    evidence_valid: bool = True
    reviewed_at: str | None = None
    source_kind: Literal["inference", "self_report"] = "inference"
    owner_edited: bool = False
    core: bool = False
    version: str = "legacy"
    changed: bool = False
    history: list[OntologyVersion] = Field(default_factory=list)
    declaration: str = ""
    declaration_turn: str = ""
    context_ids: list[str] = Field(default_factory=list)
    suggested_kind: Kind | None = None
    core_status: Literal[
        "pending", "snoozed", "admitted", "rejected", "inactive", "background", "merged"
    ] = "pending"
    admitted_version: str = ""
    admitted_at: str = ""
    admitted_by: int | None = None
    importance: Literal[1, 2, 3] = 1
    affinity: Literal[1, 2, 3, 4, 5] = 3
    valid_from: str = ""
    valid_until: str = ""
    snoozed_until: str = ""
    merged_into: str = ""
    discussion_thread_id: str = ""
    candidate_edited: bool = False
    source_claim_ids: list[str] = Field(default_factory=list)


class OntologyRelation(BaseModel):
    id: str
    source: str
    target: str
    kind: Literal["supports", "balances", "changes"]
    description: str
    evidence_ids: list[str] = Field(default_factory=list)
    state: Literal["draft", "confirmed", "dismissed"] = "draft"
    version: str = "legacy"
    source_version: str = ""
    target_version: str = ""


ContextKind = Literal["person", "project", "role", "goal", "situation", "fact", "episode"]


class OntologyContextNode(BaseModel):
    """Current, source-bound context; native records remain the historical evidence."""

    id: str
    kind: ContextKind
    title: str
    statement: str
    version: str
    state: Literal["active", "withdrawn"] = "active"
    source_kind: Literal["native", "self_report"] = "native"
    owner_edited: bool = False
    evidence_valid: bool = True
    conditions: str = ""
    time_scope: str = ""
    aliases: list[str] = Field(default_factory=list)
    native_ids: list[str] = Field(default_factory=list)
    evidence: list[OntologyEvidence] = Field(default_factory=list)
    history: list[OntologyVersion] = Field(default_factory=list)
    changed: bool = False
    core: bool = False
    emotion: str = ""
    occurred_at: str = ""
    merged_into: str = ""


class OntologyContextLink(BaseModel):
    id: str
    source: str
    target: str
    kind: Literal["about", "experienced", "evidence", "related", "supports", "balances", "changes"]
    description: str = ""
    source_kind: Literal["native", "inference", "self_report"] = "native"
    evidence_ids: list[str] = Field(default_factory=list)
    state: Literal["draft", "confirmed", "dismissed"] = "draft"
    version: str = "legacy"
    source_version: str = ""
    target_version: str = ""


class OntologyGraphCoverage(BaseModel):
    atoms: int = 0
    entities: int = 0
    episodes: int = 0
    verifiable_facts: int = 0
    duplicate_sources: int = 0
    unavailable_sources: int = 0
    complete: bool = True


class OntologyCoverage(BaseModel):
    read_atoms: int = 0
    total_atoms: int = 0
    eligible_sources: int = 0
    independent_events: int = 0
    has_more: bool = False
    processed_sources: int = 0


class OntologyProgress(BaseModel):
    status: Literal["idle", "pending", "running", "failed", "complete"] = "idle"
    checked_at: str | None = None
    last_error: str | None = None
    processed: dict[str, str] = Field(default_factory=dict)


class PersonalOntology(BaseModel):
    schema_version: int = 4
    revision: str = "empty"
    generated_at: str | None = None
    source_fingerprint: str = ""
    outdated: bool = False
    coverage: OntologyCoverage = Field(default_factory=OntologyCoverage)
    claims: list[OntologyClaim] = Field(default_factory=list)
    relations: list[OntologyRelation] = Field(default_factory=list)
    progress: OntologyProgress = Field(default_factory=OntologyProgress)
    retired: list[dict[str, Any]] = Field(default_factory=list, exclude=False)
    nodes: list[OntologyContextNode] = Field(default_factory=list)
    links: list[OntologyContextLink] = Field(default_factory=list)
    graph_coverage: OntologyGraphCoverage = Field(default_factory=OntologyGraphCoverage)
    graph_fingerprint: str = ""
    graph_retired: list[str] = Field(default_factory=list)
    graph_retired_sources: list[str] = Field(default_factory=list)
    core_operations: dict[str, dict[str, str]] = Field(default_factory=dict)
    fact_confirmations: dict[str, dict[str, Any]] = Field(default_factory=dict)


class OntologyResult(BaseModel):
    status: Literal["ready", "insufficient", "unavailable", "stale"]
    ontology: PersonalOntology
    changed_id: str | None = None
    previous_version: str | None = None
    core_effect: Literal["candidate", "admitted", "stopped"] | None = None


class OntologyReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=1, max_length=100)
    action: Literal["confirm", "dismiss", "withdraw"]
    expected_version: str = Field(default="", max_length=100)


class OntologyEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision: str = Field(min_length=1, max_length=100)
    action: Literal["add", "correct", "scope", "change", "disable", "restore", "pin", "classify"]
    statement: str = Field(default="", max_length=400)
    kind: Kind = "principle"
    conditions: str = Field(default="", max_length=300)
    exceptions: str = Field(default="", max_length=300)
    time_scope: str = Field(default="", max_length=120)
    core: bool = False
    restore_version: str = Field(default="", max_length=100)
    expected_version: str = Field(default="", max_length=100)
    context_ids: list[str] = Field(default_factory=list, max_length=12)


class OntologyContextEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision: str = Field(min_length=1, max_length=100)
    expected_version: str = Field(default="", max_length=100)
    request_id: str = Field(default="", max_length=100)
    action: Literal[
        "add", "correct", "scope", "change", "disable", "restore", "merge", "purge", "pin"
    ]
    kind: ContextKind = "fact"
    statement: str = Field(default="", max_length=800)
    title: str = Field(default="", max_length=120)
    conditions: str = Field(default="", max_length=300)
    time_scope: str = Field(default="", max_length=120)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    related_ids: list[str] = Field(default_factory=list, max_length=12)
    merge_target: str = Field(default="", max_length=100)
    merge_target_version: str = Field(default="", max_length=100)
    restore_version: str = Field(default="", max_length=100)
    core: bool = False


class OntologyContext(BaseModel):
    turn_id: str
    revision: str
    claims: list[OntologyClaim] = Field(default_factory=list)
    relations: list[OntologyRelation] = Field(default_factory=list)
    available: bool = True
    supplied_at: str = ""
    candidate_discussion: OntologyClaim | None = None
    user_text_hash: str = ""
    reply_hash: str = ""
    updates: list[OntologyResult] = Field(default_factory=list)
    understanding_lines: list[dict[str, Any]] = Field(default_factory=list)
    nodes: list[OntologyContextNode] = Field(default_factory=list)
    links: list[OntologyContextLink] = Field(default_factory=list)


class OntologyRelationEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    revision: str = Field(min_length=1, max_length=100)
    relation_id: str
    action: Literal["confirm", "dismiss"]
    expected_version: str = Field(default="", max_length=100)


class CoreCommand(BaseModel):
    """Owner UI command over exactly the version shown in the confirmation card."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    expected_version: str = Field(min_length=1, max_length=100)
    request_id: str = Field(min_length=1, max_length=100)
    action: Literal[
        "admit",
        "edit_candidate",
        "later",
        "reject",
        "edit_core",
        "importance",
        "disable",
        "restore",
    ]
    statement: str = Field(default="", max_length=400)
    conditions: str = Field(default="", max_length=300)
    importance: Literal[1, 2, 3] = 1
    restore_version: str = Field(default="", max_length=100)


class CoreCandidatePage(BaseModel):
    revision: str
    items: list[OntologyClaim]
    total: int
    pending_count: int
    offset: int
    has_more: bool


class CoreConversationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: str = Field(min_length=1, max_length=100)


class CoreConversationThread(BaseModel):
    thread_id: str
    session_key: str
    channel_type: str
    title: str
    created_at: float
    last_active: float


class CoreConversation(BaseModel):
    thread: CoreConversationThread
    claim: OntologyClaim

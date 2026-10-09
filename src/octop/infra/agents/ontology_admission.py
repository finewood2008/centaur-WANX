"""Explicit owner admission to core ontology. Models can only prepare candidates."""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime, timedelta
from difflib import SequenceMatcher
from typing import Any

from octop.infra.agents.ontology_types import (
    CoreCandidatePage,
    CoreCommand,
    Kind,
    OntologyClaim,
    OntologyContextNode,
    OntologyEvidence,
    OntologyResult,
    OntologyVersion,
    PersonalOntology,
)
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.ulid import new_ulid


def admitted(c: OntologyClaim) -> bool:
    return (
        c.core_status == "admitted"
        and c.state == "confirmed"
        and bool(c.admitted_at)
        and c.admitted_by is not None
        and c.admitted_version == c.version
        and c.evidence_valid
        and not c.merged_into
        and c.kind != "situation"
    )


def pending(c: OntologyClaim) -> bool:
    return (
        c.core_status in {"pending", "snoozed"}
        and c.state not in {"withdrawn", "dismissed"}
        and not c.merged_into
        and c.kind != "situation"
    )


def due(c: OntologyClaim) -> bool:
    return pending(c) and (not c.snoozed_until or c.snoozed_until <= datetime.now(UTC).isoformat())


def _text(value: str) -> str:
    return re.sub(r"[\W_]", "", value.lower())


def same_understanding(a: OntologyClaim, b: OntologyClaim) -> bool:
    """Conservative local grouping; scope, time and polarity must agree."""
    if a.kind != b.kind or a.time_scope != b.time_scope:
        return False
    if _text(a.conditions) != _text(b.conditions):
        return False
    if _text(a.exceptions) != _text(b.exceptions):
        return False
    if _text(a.statement) == _text(b.statement):
        return True
    sources_a = {e.event_id or e.document_id for e in a.evidence}
    sources_b = {e.event_id or e.document_id for e in b.evidence}
    if not sources_a or sources_a != sources_b:
        return False
    polarity = r"不再|不愿|不能|不应该|不要|不喜欢|不是|并非|从不|总是|仅|只|暂"
    if set(re.findall(polarity, a.statement)) != set(re.findall(polarity, b.statement)):
        return False
    return SequenceMatcher(None, _text(a.statement), _text(b.statement)).ratio() >= 0.82


def group_candidates(doc: PersonalOntology) -> None:
    for claim in doc.claims:
        if (
            claim.core_status == "background"
            and claim.source_kind == "self_report"
            and claim.state not in {"withdrawn", "dismissed"}
        ):
            nid = "context:" + claim.id
            if not any(n.id == nid for n in doc.nodes):
                doc.nodes.append(
                    OntologyContextNode(
                        id=nid,
                        kind="situation",
                        owner_edited=True,
                        title=claim.title,
                        statement=claim.statement,
                        version=claim.version,
                        conditions=claim.conditions,
                        time_scope=claim.time_scope,
                        evidence=claim.evidence,
                        evidence_valid=claim.evidence_valid,
                        source_kind="self_report"
                        if claim.source_kind == "self_report"
                        else "native",
                    )
                )
    representatives: list[OntologyClaim] = []
    for claim in sorted(doc.claims, key=lambda c: c.id, reverse=True):
        if (
            not pending(claim)
            or claim.owner_edited
            or claim.candidate_edited
            or claim.discussion_thread_id
        ):
            continue
        match = next((c for c in representatives if same_understanding(c, claim)), None)
        if match is None or claim.candidate_edited:
            representatives.append(claim)
            continue
        merge_candidate(doc, match, claim)


def merge_candidate(doc: PersonalOntology, target: OntologyClaim, source: OntologyClaim) -> None:
    """Keep both original records; only consolidate the pending queue and its evidence."""
    target.history.append(
        OntologyVersion(
            version=target.version,
            at=doc.generated_at or "",
            reason="candidate_sources_merged",
            value=target.model_dump(exclude={"history"}),
        )
    )
    # Also deterministic for the migration's read-only projection.
    target.version = hashlib.sha256(
        (target.version + ":" + source.id + ":" + source.version).encode()
    ).hexdigest()[:26]
    source.merged_into = target.id
    source.core_status = "merged"
    target.source_claim_ids = list(
        dict.fromkeys([*target.source_claim_ids, source.id, *source.source_claim_ids])
    )
    for child in doc.claims:
        if child.merged_into == source.id:
            child.merged_into = target.id
    existing = {e.model_dump_json() for e in target.evidence}
    for evidence in source.evidence:
        if evidence.model_dump_json() not in existing:
            target.evidence.append(evidence)
            existing.add(evidence.model_dump_json())
    target.context_ids = list(dict.fromkeys([*target.context_ids, *source.context_ids]))


def migrate_core(doc: PersonalOntology) -> PersonalOntology:
    if doc.schema_version >= 4:
        return doc
    for claim in doc.claims:
        previous = claim.model_dump(exclude={"history"})
        claim.history.append(
            OntologyVersion(
                version="pre-core-" + claim.version,
                at=doc.generated_at or "",
                reason="core_review_required",
                value=previous,
            )
        )
        claim.admitted_version = ""
        claim.admitted_at = ""
        claim.admitted_by = None
        claim.importance = 1
        claim.core = False
        if claim.state == "dismissed":
            claim.core_status = "rejected"
        elif claim.state == "withdrawn":
            claim.core_status = "inactive"
        elif claim.kind == "situation" and not (
            re.search(r"我是|自我定位|长期.*(角色|建设者|创业者)|把自己看作", claim.statement)
            and not re.search(
                r"最近|眼下|此刻|近来|目前|暂时|这段时间", claim.statement + claim.time_scope
            )
        ):
            claim.core_status = "background"
            claim.state = "draft"
        else:
            if claim.kind == "situation":
                claim.kind = "identity"
            claim.core_status = "pending"
            claim.state = "draft"
    doc.schema_version = 4
    group_candidates(doc)
    return doc


async def candidate_page(
    registry: Any, uid: int, *, offset: int = 0, limit: int = 10, processed: bool = False
) -> CoreCandidatePage:
    from octop.infra.agents.personal_ontology import read_personal_ontology

    doc = await read_personal_ontology(registry, uid, check_changes=False)
    rows = [
        c
        for c in doc.claims
        if (c.core_status in {"admitted", "inactive", "rejected"} if processed else pending(c))
    ]
    # ULIDs preserve creation order; sort before slicing so newest items lead every page.
    rows.sort(key=lambda c: (due(c), c.id), reverse=True)
    return CoreCandidatePage(
        revision=doc.revision,
        items=rows[offset : offset + limit],
        total=len(rows),
        pending_count=sum(due(c) and c.evidence_valid for c in doc.claims),
        offset=offset,
        has_more=offset + limit < len(rows),
    )


async def review_core(
    registry: Any,
    uid: int,
    cid: str,
    body: CoreCommand,
    *,
    discussion_thread_id: str = "",
    declaration: str = "",
    turn_id: str = "",
    kind: Kind | None = None,
) -> OntologyResult:
    from octop.infra.agents.personal_ontology import (
        _checkpoint,
        _digest,
        _lock,
        _owned,
        _read,
        _save,
        read_personal_ontology,
    )

    row = _owned(registry, uid)
    workspace = registry.get_agent(row.agent_id).workspace
    proof = (
        {"thread": discussion_thread_id, "declaration": declaration, "turn": turn_id, "kind": kind}
        if discussion_thread_id
        else {}
    )
    fingerprint = _digest({"id": cid, **body.model_dump(), **proof})
    async with _lock(registry, row.agent_id):
        doc = await read_personal_ontology(registry, uid, check_changes=False)
        receipt = doc.core_operations.get(body.request_id)
        if receipt:
            if receipt["fingerprint"] != fingerprint:
                raise OctopError.localized(ErrorCode.FORBIDDEN)
            saved = next((c for c in doc.claims if c.id == cid), None)
            if saved is None or saved.version != receipt.get("committed_version"):
                return OntologyResult(status="stale", ontology=doc)
            return OntologyResult(
                status="ready",
                ontology=doc,
                changed_id=cid,
                previous_version=receipt["previous_version"],
                core_effect="admitted"
                if admitted(saved)
                else "candidate"
                if pending(saved)
                else "stopped",
            )
        claim = next((c for c in doc.claims if c.id == cid and not c.merged_into), None)
        if claim is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if discussion_thread_id and (
            claim.discussion_thread_id != discussion_thread_id
            or not declaration
            or not turn_id
            or body.action != "admit"
            or not body.statement
            or kind == "situation"
        ):
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        if claim.version != body.expected_version:
            return OntologyResult(status="stale", ontology=doc)
        is_core = admitted(claim)
        if body.action in {"admit", "edit_candidate", "later", "reject"} and not pending(claim):
            return OntologyResult(status="stale", ontology=doc)
        if body.action in {"edit_core", "importance"} and not is_core:
            return OntologyResult(status="stale", ontology=doc)
        if body.action == "admit" and not claim.evidence_valid:
            return OntologyResult(status="stale", ontology=doc)
        if body.action in {"edit_candidate", "edit_core"} and not body.statement:
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        restore = None
        if body.action == "restore":
            restore = next((h for h in claim.history if h.version == body.restore_version), None)
            if restore is None:
                raise OctopError.localized(ErrorCode.NOT_FOUND)
        previous = _checkpoint(claim, "owner_core_" + body.action)
        now = datetime.now(UTC).isoformat()
        if body.action in {"edit_core", "edit_candidate"} or discussion_thread_id:
            claim.statement = body.statement
            claim.title = body.statement[:30]
            claim.conditions = body.conditions
            claim.declaration = body.statement
            claim.source_kind = "self_report"
            claim.owner_edited = True
            claim.candidate_edited = True
            claim.evidence_valid = True
        if body.action in {"admit", "edit_core", "importance"}:
            claim.core_status = "admitted"
            claim.state = "confirmed"
            claim.admitted_at = now
            claim.admitted_by = uid
            claim.admitted_version = claim.version
            claim.importance = body.importance if body.action != "edit_core" else claim.importance
            # Admission adopts this expression. Evidence remains separate, with its original author.
            claim.declaration = claim.statement
            claim.source_kind = "self_report"
            claim.reviewed_at = now
            claim.owner_edited = True
            claim.evidence_valid = True
        elif body.action == "edit_candidate":
            claim.core_status = "pending"
            claim.state = "draft"
            claim.admitted_version = ""
            claim.snoozed_until = ""
        elif body.action == "later":
            claim.core_status = "snoozed"
            claim.snoozed_until = (datetime.now(UTC) + timedelta(days=1)).isoformat()
        elif body.action in {"reject", "disable"}:
            claim.core_status = "rejected" if body.action == "reject" else "inactive"
            claim.state = "dismissed" if body.action == "reject" else "withdrawn"
            claim.admitted_version = ""
            claim.owner_edited = True
        elif restore:
            restored = OntologyClaim.model_validate(restore.value)
            restored.history = claim.history
            restored.version = claim.version
            restored.owner_edited = True
            # Only a version already admitted through the new owner UI can be restored to core.
            if admitted(OntologyClaim.model_validate(restore.value)):
                restored.admitted_version = restored.version
                restored.admitted_at = now
                restored.admitted_by = uid
            else:
                restored.admitted_version = ""
                if restored.state not in {"withdrawn", "dismissed"}:
                    restored.state = "draft"
                    restored.core_status = (
                        "background" if restored.kind == "situation" else "pending"
                    )
            doc.claims[doc.claims.index(claim)] = restored
            claim = restored
        if discussion_thread_id:
            claim.declaration = declaration
            claim.declaration_turn = turn_id
            if kind:
                claim.kind = kind
            claim.evidence.append(
                OntologyEvidence(
                    source_type="owner_declaration",
                    event_id=turn_id,
                    quote=declaration,
                    timestamp=now,
                    raw_hash=_digest(declaration),
                )
            )
        # Unreviewed inferred relations do not gain authority through approving their endpoints.
        for relation in doc.relations:
            if cid in {relation.source, relation.target}:
                relation.state = "dismissed"
        group_candidates(doc)
        doc.core_operations[body.request_id] = {
            "fingerprint": fingerprint,
            "previous_version": previous,
            "committed_version": claim.version,
        }
        await _save(workspace, doc)
        persisted = await _read(workspace)
        if next(c for c in persisted.claims if c.id == cid).version != claim.version:
            raise OctopError.localized(ErrorCode.INTERNAL_ERROR)
    return OntologyResult(
        status="ready",
        ontology=await read_personal_ontology(registry, uid),
        changed_id=cid,
        previous_version=previous,
        core_effect="admitted" if admitted(claim) else "candidate" if pending(claim) else "stopped",
    )


async def start_core_conversation(
    registry: Any, threads: Any, uid: int, cid: str, expected_version: str
) -> dict[str, Any]:
    from octop.infra.agents.personal_ontology import _lock, _owned, _save, read_personal_ontology
    from octop.infra.gateway.threads import ThreadRegistry

    row = _owned(registry, uid)
    workspace = registry.get_agent(row.agent_id).workspace
    async with _lock(registry, row.agent_id):
        doc = await read_personal_ontology(registry, uid, check_changes=False)
        claim = next((c for c in doc.claims if c.id == cid), None)
        if claim is None or not (pending(claim) or admitted(claim)) or not claim.evidence_valid:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if claim.version != expected_version:
            raise OctopError.localized(ErrorCode.SELF_MODEL_CONFLICT)
        tid = claim.discussion_thread_id or new_ulid()
        existing = threads.get_thread(tid)
        if existing and (existing.agent_id != row.agent_id or existing.user_id != uid):
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        if not claim.discussion_thread_id:
            claim.discussion_thread_id = tid
            await _save(workspace, doc)
        if existing is None:
            threads.create_thread(
                thread_id=tid,
                agent_id=row.agent_id,
                user_id=uid,
                channel_type=ThreadRegistry.CHANNEL_DASHBOARD,
                session_key=ThreadRegistry.dashboard_key(agent_id=row.agent_id, user_id=uid),
                title=claim.title,
            )
        thread = threads.get_thread(tid)
        return {
            "claim": claim,
            "thread": {
                "thread_id": thread.thread_id,
                "session_key": thread.session_key,
                "channel_type": "web",
                "title": thread.title,
                "created_at": thread.created_at,
                "last_active": thread.last_active,
            },
        }

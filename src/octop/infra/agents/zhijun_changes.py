"""Source-bound change suggestions, resolved only by the owner in one document save."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from octop.infra.agents.ontology_admission import admitted, pending
from octop.infra.agents.ontology_types import OntologyClaim, PersonalOntology
from octop.infra.agents.personal_ontology import _checkpoint, _digest, _lock, _owned, _save
from octop.infra.agents.zhijun_profile import primary
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.ulid import new_ulid


class ChangeView(BaseModel):
    id: str
    version: str
    previous: OntologyClaim
    proposed: OntologyClaim
    question: str


class ChangeResult(BaseModel):
    status: Literal["ready", "stale"]


class ChangeCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    action: Literal["change", "exception", "reject"]
    request_id: str = Field(min_length=1, max_length=100)
    expected_version: str = Field(min_length=1, max_length=100)
    source_version: str = Field(min_length=1, max_length=100)
    target_version: str = Field(min_length=1, max_length=100)
    note: str = Field(default="", max_length=300)


def pending_changes(doc: PersonalOntology) -> list[ChangeView]:
    claims = {c.id: c for c in doc.claims}
    result = []
    for relation in doc.relations:
        source, target = claims.get(relation.source), claims.get(relation.target)
        if (
            relation.kind != "changes"
            or relation.state != "draft"
            or not source
            or not target
            or not pending(source)
            or not admitted(target)
            or not source.evidence_valid
            or not source.evidence
            or any(not e.available for e in source.evidence)
            or relation.source_version != source.version
            or relation.target_version != target.version
            or not relation.evidence_ids
            or not set(relation.evidence_ids).issubset({e.atom_id for e in source.evidence})
        ):
            continue
        result.append(
            ChangeView(
                id=relation.id,
                version=relation.version,
                previous=target,
                proposed=source,
                question="你以前这样说过，这次的表述似乎不同。是想法变了、某个情境下的例外，还是我理解错了？",
            )
        )
    return result


def _confirm_sources(doc: PersonalOntology, claim: OntologyClaim, uid: int, now: str) -> None:
    for evidence in claim.evidence:
        if evidence.source_type == "memory":
            previous = doc.fact_confirmations.get(evidence.atom_id, {})
            doc.fact_confirmations[evidence.atom_id] = {
                "atom_hash": evidence.atom_hash,
                "at": now,
                "by": uid,
                "history": [
                    *previous.get("history", []),
                    {k: v for k, v in previous.items() if k != "history"},
                ],
            }


async def resolve_change(registry: Any, uid: int, rid: str, body: ChangeCommand) -> dict[str, Any]:
    from octop.infra.agents.role_ontology import read_role_ontology

    row = _owned(registry, uid)
    if not primary(row):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    workspace = registry.get_agent(row.agent_id).workspace
    async with _lock(registry, row.agent_id):
        doc = await read_role_ontology(registry, uid)
        fingerprint = _digest({"relation": rid, **body.model_dump()})
        receipt = doc.core_operations.get(body.request_id)
        relation = next((r for r in doc.relations if r.id == rid), None)
        if receipt:
            if receipt["fingerprint"] != fingerprint:
                raise OctopError(ErrorCode.SELF_MODEL_INVALID, "这次操作标识已用于其他修改")
            return {
                "status": "ready"
                if relation
                and relation.version == receipt["version"]
                and relation.state == receipt["state"]
                and any(
                    c.id == relation.source and c.version == relation.source_version
                    for c in doc.claims
                )
                and any(
                    c.id == relation.target and c.version == relation.target_version
                    for c in doc.claims
                )
                else "stale"
            }
        view = next((c for c in pending_changes(doc) if c.id == rid), None)
        if (
            view is None
            or relation is None
            or view.version != body.expected_version
            or view.proposed.version != body.source_version
            or view.previous.version != body.target_version
        ):
            return {"status": "stale"}
        source, target = view.proposed, view.previous
        if body.action == "exception" and (
            not body.note or len(target.exceptions + "\n" + body.note) > 300
        ):
            raise OctopError(
                ErrorCode.SELF_MODEL_INVALID,
                "请写明例外适用的情境；原有例外与新内容合计不能超过 300 字",
            )
        now = datetime.now(UTC).isoformat()
        _checkpoint(source, "owner_change_review_" + body.action)
        source.owner_edited = True
        if body.action == "change":
            _checkpoint(target, "owner_replaced_by_change")
            target.state, target.core_status, target.admitted_version = "withdrawn", "inactive", ""
            target.owner_edited, target.valid_until = True, now
            source.state, source.core_status, source.changed = "confirmed", "admitted", True
            source.admitted_by, source.admitted_at, source.admitted_version = (
                uid,
                now,
                source.version,
            )
            source.reviewed_at = now
            _confirm_sources(doc, source, uid, now)
        elif body.action == "exception":
            _checkpoint(target, "owner_added_exception")
            target.exceptions = (target.exceptions + "\n" + body.note).strip()
            target.owner_edited = True
            known = {_digest(e.model_dump()) for e in target.evidence}
            target.evidence.extend(
                e for e in source.evidence if _digest(e.model_dump()) not in known
            )
            target.admitted_version, target.admitted_at, target.admitted_by = (
                target.version,
                now,
                uid,
            )
            target.reviewed_at = now
            source.core_status, source.state = "background", "draft"
            _confirm_sources(doc, source, uid, now)
        else:
            # Rejecting the interpretation does not withdraw the native source material.
            source.state, source.core_status = "dismissed", "rejected"
        relation.state = "dismissed" if body.action == "reject" else "confirmed"
        relation.version = new_ulid()
        relation.source_version, relation.target_version = source.version, target.version
        relation.resolution, relation.resolution_note = body.action, body.note
        relation.resolved_at, relation.resolved_by = now, uid
        doc.core_operations[body.request_id] = {
            "fingerprint": fingerprint,
            "id": rid,
            "version": relation.version,
            "state": relation.state,
        }
        await _save(workspace, doc)
    return {"status": "ready"}

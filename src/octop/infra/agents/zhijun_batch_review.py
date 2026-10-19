"""Explicit, bounded owner review with per-item durable receipts; no model calls."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from octop.infra.agents.ontology_admission import admitted, pending
from octop.infra.agents.ontology_types import OntologyClaim, PersonalOntology
from octop.infra.agents.personal_ontology import _digest, _owned
from octop.infra.agents.role_ontology import RoleCommand, command, read_role_ontology
from octop.infra.agents.zhijun_changes import pending_changes
from octop.infra.agents.zhijun_profile import primary
from octop.infra.errors import ErrorCode, OctopError


class ReviewItem(BaseModel):
    claim: OntologyClaim
    token: str
    eligible: bool
    reason: str = ""


class ReviewPage(BaseModel):
    items: list[ReviewItem]
    limit: int = 20


class ReviewChoice(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    id: str = Field(min_length=1, max_length=100)
    expected_version: str = Field(min_length=1, max_length=100)
    token: str = Field(min_length=1, max_length=100)
    action: Literal["admit", "reject"]


class BatchReview(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    request_id: str = Field(min_length=1, max_length=100)
    items: list[ReviewChoice] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_items(self) -> BatchReview:
        if len({item.id for item in self.items}) != len(self.items):
            raise ValueError("Each understanding can only appear once")
        return self


class ReviewOutcome(BaseModel):
    id: str
    status: Literal["confirmed", "rejected", "stale", "blocked", "unverified"]
    message: str


class BatchResult(BaseModel):
    results: list[ReviewOutcome]


def review_item(doc: PersonalOntology, claim: OntologyClaim) -> ReviewItem:
    reason = ""
    if not pending(claim):
        reason = "这项理解已经处理，请重新读取。"
    elif not claim.evidence_valid or any(not e.available for e in claim.evidence):
        reason = "来源或有效期已变化，请单独重新核对。"
    elif any(change.proposed.id == claim.id for change in pending_changes(doc)):
        reason = "与原有理解可能不同，请在待核对变化中单独处理。"
    return ReviewItem(
        claim=claim, token=_digest(claim.model_dump()), eligible=not reason, reason=reason
    )


def _scope(registry: Any, uid: int) -> str:
    row = _owned(registry, uid)
    if not primary(row):
        raise OctopError.localized(ErrorCode.NOT_FOUND)
    return str(row.agent_id)


async def review_page(registry: Any, uid: int) -> ReviewPage:
    _scope(registry, uid)
    doc = await read_role_ontology(registry, uid)
    return ReviewPage(items=[review_item(doc, c) for c in doc.claims if pending(c)])


async def batch_review(registry: Any, uid: int, body: BatchReview) -> BatchResult:
    aid = _scope(registry, uid)
    if not registry.try_begin_history_backfill(aid):
        raise OctopError.localized(ErrorCode.AGENT_BUSY)
    results = []
    try:
        for item in body.items:
            # Each command locks, validates current sources and verifies its persisted write.
            # Reusing the same batch after a disconnect replays individual durable receipts.
            try:
                operation_id = "batch:" + _digest([body.request_id, item.id])
                result = await command(
                    registry,
                    uid,
                    item.id,
                    RoleCommand(
                        request_id=operation_id,
                        expected_version=item.expected_version,
                        action=item.action,
                    ),
                    review_token=item.token,
                )
                if result["status"] == "ready":
                    doc = result["ontology"]
                    current = next((c for c in doc.claims if c.id == item.id), None)
                    receipt = doc.core_operations.get(operation_id, {})
                    if (
                        current is None
                        or current.version != receipt.get("version")
                        or (item.action == "admit" and not admitted(current))
                        or (item.action == "reject" and current.core_status != "rejected")
                    ):
                        result["status"] = "stale"
                if result["status"] == "ready":
                    results.append(
                        ReviewOutcome(
                            id=item.id,
                            status="confirmed" if item.action == "admit" else "rejected",
                            message="已确认" if item.action == "admit" else "已标为不对",
                        )
                    )
                else:
                    results.append(
                        ReviewOutcome(
                            id=item.id,
                            status="blocked" if result["status"] == "blocked" else "stale",
                            message="内容、来源或状态已变化，请重新读取后单独核对。",
                        )
                    )
            except Exception:
                # Do not turn an uncertain write into success or leak backend details.
                results.append(
                    ReviewOutcome(
                        id=item.id,
                        status="unverified",
                        message="尚未核实保存结果，请重试本次提交；已保存的项目不会重复写入。",
                    )
                )
        return BatchResult(results=results)
    finally:
        registry.end_history_backfill(aid)

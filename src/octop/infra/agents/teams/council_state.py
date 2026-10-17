"""Validated, append-only proposal history shared by controls and the host tool."""

from octop.infra.agents.teams.brainstorm_types import BrainstormSession
from octop.infra.agents.teams.council_types import (
    CouncilBoard,
    CouncilChange,
    CouncilIssue,
    CouncilProposal,
    CouncilReview,
    CouncilSpeech,
    CouncilUpdate,
    ProposalRef,
    ProposalVersion,
)
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.ulid import new_ulid


def invalid() -> None:
    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)


def current_proposal(board: CouncilBoard, ref: ProposalRef) -> CouncilProposal:
    item = next((p for p in board.proposals if p.id == ref.proposal_id), None)
    if (
        item is None
        or not item.versions
        or item.versions[-1].version != ref.version
        or item.status != "active"
        or item.versions[-1].context_version != board.context_version
    ):
        invalid()
    assert item is not None
    return item


def invalidate_context(
    state: BrainstormSession, text: str, message_ids: list[str] | None = None
) -> None:
    board = state.council
    if board is None:
        return
    board.stale_message_ids = list(dict.fromkeys([*board.stale_message_ids, *(message_ids or [])]))
    board.context_version += 1
    board.version += 1
    board.recommendation = None
    board.next_step = ""
    board.input_acknowledgment = ""
    board.pending_input = text
    for p in board.proposals:
        if p.status == "active":
            p.status = "needs_review"
    board.changes.append(CouncilChange(id=new_ulid(), kind="context", text=text))
    state.decision = None
    state.report_draft = None
    state.brief = ""
    state.summary = ""


def apply_updates(
    state: BrainstormSession, updates: list[CouncilUpdate], speeches: dict[str, str]
) -> None:
    """Caller works on a copy and commits only when every update validates."""
    board = state.council
    if board is None:
        invalid()
    assert board is not None
    allowed = set(state.confirmed_roster or [m.agent_id for m in state.participants])
    sources = {s.id for s in state.context.sources if s.id not in state.excluded_source_ids}
    if not state.context_enabled:
        sources = set()
    initial_version = board.version
    # An atomic batch can describe its issue after the speech that refers to it.
    # Establish issue identities first; preserve order among versioned changes.
    for u in sorted(updates, key=lambda update: update.kind != "issue"):
        if u.id in board.processed_updates:
            continue
        issue = next((i for i in board.issues if i.id == u.issue_id), None)
        if u.kind == "issue":
            if not u.issue_id or not u.question.strip():
                invalid()
            if issue is None:
                issue = CouncilIssue(id=u.issue_id, question=u.question)
                board.issues.append(issue)
            elif issue.question != u.question:
                invalid()
            issue.status = u.status
            if u.status == "discussing":
                board.active_issue_id = issue.id
        elif u.kind in {"proposal", "review", "speech"}:
            if (
                issue is None
                or speeches.get(u.message_id) != u.author_id
                or u.author_id not in allowed | {state.team_id, "user"}
            ):
                invalid()
            if u.responds_to and u.responds_to not in speeches:
                invalid()
            old = next((s for s in board.speeches if s.message_id == u.message_id), None)
            if old and old.issue_id != u.issue_id:
                invalid()
            if old is None:
                board.speeches.append(
                    CouncilSpeech(
                        message_id=u.message_id,
                        issue_id=u.issue_id,
                        author_id=u.author_id,
                        responds_to=u.responds_to,
                    )
                )
            if u.kind in {"proposal", "review"} and u.message_id in board.stale_message_ids:
                invalid()
            if u.kind == "proposal":
                if (
                    u.author_id not in allowed
                    or not all(
                        v.strip() for v in [u.proposal_id, u.title, u.advice, u.basis, u.cost]
                    )
                    or not set(u.source_ids) <= sources
                ):
                    invalid()
                p = next((p for p in board.proposals if p.id == u.proposal_id), None)
                if p is None:
                    if u.version != 1:
                        invalid()
                    p = CouncilProposal(
                        id=u.proposal_id, issue_id=u.issue_id, author_id=u.author_id
                    )
                    board.proposals.append(p)
                elif (
                    p.issue_id != u.issue_id
                    or p.author_id != u.author_id
                    or u.version != p.versions[-1].version + 1
                    or u.message_id == p.versions[-1].message_id
                    or not u.change_reason.strip()
                ):
                    invalid()
                p.versions.append(
                    ProposalVersion(
                        version=u.version,
                        title=u.title,
                        advice=u.advice,
                        basis=u.basis,
                        cost=u.cost,
                        change_reason=u.change_reason,
                        message_id=u.message_id,
                        source_ids=u.source_ids,
                        context_version=board.context_version,
                    )
                )
                p.status = "active"
                board.recommendation = None
                board.changes.append(
                    CouncilChange(
                        id=u.id,
                        kind="proposal" if u.version == 1 else "revision",
                        text=u.change_reason or u.advice,
                        issue_id=u.issue_id,
                        proposal_id=p.id,
                        message_id=u.message_id,
                    )
                )
            if u.kind == "review":
                p = current_proposal(
                    board, ProposalRef(proposal_id=u.proposal_id, version=u.version)
                )
                if p.issue_id != u.issue_id or u.author_id not in allowed or not u.point.strip():
                    invalid()
                board.reviews.append(
                    CouncilReview(
                        id=u.id,
                        issue_id=u.issue_id,
                        proposal_id=u.proposal_id,
                        version=u.version,
                        author_id=u.author_id,
                        stance=u.stance,
                        point=u.point,
                        message_id=u.message_id,
                    )
                )
                board.changes.append(
                    CouncilChange(
                        id=u.id,
                        kind="review",
                        text=u.point,
                        issue_id=u.issue_id,
                        proposal_id=p.id,
                        message_id=u.message_id,
                    )
                )
        elif u.kind == "defer":
            p = current_proposal(board, ProposalRef(proposal_id=u.proposal_id, version=u.version))
            p.status = "deferred"
            board.recommendation = None
            board.changes.append(
                CouncilChange(
                    id=u.id, kind="defer", text=u.point, issue_id=p.issue_id, proposal_id=p.id
                )
            )
        elif u.kind == "brief":
            if u.recommendation:
                current_proposal(board, u.recommendation)
            board.recommendation = u.recommendation
            board.next_step = u.next_step
            if u.input_acknowledgment:
                board.input_acknowledgment = u.input_acknowledgment
                board.pending_input = ""
        board.processed_updates.append(u.id)
        board.version += 1
    if board.version != initial_version:
        state.decision = None

"""Content-driven brainstorm sessions on native Teams, inbox and room streams."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import BaseTool, tool
from octop_harness.request import ChatRequest

from octop.i18n import tr
from octop.infra.agents.experts.catalog import build_create_spec_from_expert
from octop.infra.agents.experts.skillhub_market import install_skillset_template
from octop.infra.agents.manager import AgentCreateSpec
from octop.infra.agents.providers.resolved import list_resolved_models
from octop.infra.agents.teams.brainstorm_report import compile_report, report_document
from octop.infra.agents.teams.brainstorm_types import (
    BrainstormExpert,
    BrainstormMember,
    BrainstormProfile,
    BrainstormSession,
    ContextResult,
    DecisionProposal,
    MeetingDecision,
    MeetingReport,
    MeetingReportDraft,
    ProfileConfigure,
    SessionControl,
    SessionCreate,
    UserJudgment,
)
from octop.infra.applications.context import owned_zhijun_context
from octop.infra.applications.service import assert_product_login
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.history.projection import message_inputs
from octop.infra.utils.ulid import new_ulid

APPLICATION_ID = "super-advisory"
logger = logging.getLogger(__name__)
DEFAULT_EXPERTS = (
    "brainstorm-creative",
    "brainstorm-strategy",
    "brainstorm-practice",
    "brainstorm-challenge",
)


def is_brainstorm_host(row: Any) -> bool:
    return (
        row is not None
        and row.application_id == APPLICATION_ID
        and row.kind == "team"
        and bool(json.loads(row.config_json or "{}").get("brainstorm"))
    )


class BrainstormService:
    def __init__(self, registry: Any) -> None:
        self.registry = registry
        self._states: dict[str, BrainstormSession] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._pending: dict[str, set[str]] = {}
        self._locales: dict[int, str] = {}
        self._profile_locks: dict[int, asyncio.Lock] = {}
        self._job_revisions: dict[str, int] = {}
        self._received: dict[str, list[str]] = {}
        self._seen_results: set[str] = set()

    def _locale(self, uid: int) -> str:
        return self._locales.get(uid, "en")

    def _assert_user(self, user: Any) -> None:
        self._locales[user.id] = user.locale
        if user.application_id != APPLICATION_ID:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        assert_product_login(self.registry._repos, user.id, APPLICATION_ID)
        product = self.registry._repos.application_repo.get(APPLICATION_ID)
        if (
            product is None
            or "brainstorm" not in product.capabilities
            or "teams" not in product.capabilities
        ):
            raise OctopError.localized(ErrorCode.FORBIDDEN)

    def _expert_cards(self, locale: str) -> list[BrainstormExpert]:
        catalog = self.registry._expert_catalog
        if catalog is None:
            return []
        return sorted(
            [
                BrainstormExpert(
                    id=ex.id,
                    name=(ex.label_zh if locale == "zh" else ex.label_en) or ex.id,
                    description=ex.description_zh if locale == "zh" else ex.description_en,
                    source="builtin" if catalog.is_bundled(ex.id) else "skillhub",
                    recommended=ex.id.startswith("brainstorm-"),
                )
                for ex in catalog.list_summaries(include_market_cache=True)
                if ex.id != "zhijun-personal-companion"
            ],
            key=lambda ex: (not ex.recommended, ex.id),
        )

    def _member(self, row: Any, cards: list[BrainstormExpert]) -> BrainstormMember:
        cfg = json.loads(row.config_json or "{}")
        expert_id = (
            cfg.get("brainstorm_expert")
            or row.template_name
            or (f"brainstorm-{cfg['brainstorm_role']}" if cfg.get("brainstorm_role") else "")
        )
        card = next((c for c in cards if c.id == expert_id), None)
        return BrainstormMember(
            agent_id=row.agent_id,
            name=row.name,
            model=row.default_model,
            expert_id=expert_id,
            description=card.description if card else row.description or "",
        )

    async def profile(self, user: Any) -> BrainstormProfile:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._assert_user, user)
        models = await loop.run_in_executor(
            None, lambda: list_resolved_models(self.registry._repos.provider_repo.list_all())
        )
        cards = await loop.run_in_executor(None, self._expert_cards, user.locale)
        result = BrainstormProfile(
            models=[f"{m['provider_name']}/{m['model']}" for m in models],
            experts=cards,
        )
        row = await loop.run_in_executor(
            None, self.registry.get_application_profile, user.id, APPLICATION_ID
        )
        if row is not None:
            if not is_brainstorm_host(row):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            result.team_id, result.host_model = row.agent_id, row.default_model
            members = await loop.run_in_executor(
                None, self.registry.teams.visible_member_ids, row.agent_id
            )
            rows = await loop.run_in_executor(
                None, lambda: [self.registry.get_row(aid) for aid in members]
            )
            result.members = [self._member(m, cards) for m in rows if m is not None]
            defaults = json.loads(row.config_json or "{}").get("brainstorm_expert_ids")
            if defaults is not None:
                result.members = [m for m in result.members if m.expert_id in defaults]
        return result

    async def import_expert(self, user: Any, slug: str, cache_root: Path) -> BrainstormExpert:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._assert_user, user)
        # Reuse WANX's validated SkillHub installer, catalog and workspace seeding.
        item = await loop.run_in_executor(
            None, lambda: install_skillset_template(slug=slug, cache_root=cache_root)
        )
        await loop.run_in_executor(None, self.registry._expert_catalog.refresh)
        cards = await loop.run_in_executor(None, self._expert_cards, user.locale)
        card = next((c for c in cards if c.id == item.expert_id), None)
        if card is None:
            raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
        return card

    async def configure(self, user: Any, body: ProfileConfigure) -> BrainstormProfile:
        async with self._profile_locks.setdefault(user.id, asyncio.Lock()):
            profile = await self.profile(user)
            ids = list(
                dict.fromkeys(
                    body.expert_ids or [m.expert_id for m in profile.members] or DEFAULT_EXPERTS
                )
            )
            if len(ids) < 2 or any(i not in {e.id for e in profile.experts} for i in ids):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if any(
                expert_id not in ids or model not in profile.models
                for expert_id, model in body.expert_models.items()
            ):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if profile.team_id and (
                self.registry.is_agent_active(profile.team_id)
                or self.registry._team_jobs.busy_member_ids(profile.team_id)
                or any(
                    s.team_id == profile.team_id and s.status == "running"
                    for s in self._states.values()
                )
            ):
                raise OctopError.localized(ErrorCode.TEAM_MEMBER_BUSY)
            if not profile.models:
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            loop = asyncio.get_running_loop()
            product = await loop.run_in_executor(
                None, self.registry._repos.application_repo.get, APPLICATION_ID
            )
            deployment = await loop.run_in_executor(
                None, self.registry._repos.application_repo.deployment, APPLICATION_ID
            )
            # Host bindings and provider configuration remain managed by WANX.
            bindings = (deployment or {}).get("resource_bindings", {})
            host_model = (
                bindings.get("default_model")
                or next(
                    (
                        bindings[k]
                        for k, r in product.resource_requirements.items()
                        if r["kind"] == "model" and k in bindings
                    ),
                    product.agent_template.get("default_model"),
                )
                or profile.host_model
                or profile.models[0]
            )
            if host_model not in profile.models:
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            locale = self._locale(user.id)
            if profile.team_id is None:
                host = await self.registry.create(
                    AgentCreateSpec(
                        name=tr("brainstorm.host_name", locale),
                        user_id=user.id,
                        application_id=APPLICATION_ID,
                        kind="team",
                        default_model=host_model,
                        config={"brainstorm": True},
                        member_ids=[],
                    )
                )
                profile.team_id = host.agent_id
            else:
                await self.registry.update(profile.team_id, default_model=host_model)
            existing = await loop.run_in_executor(
                None, self.registry._repos.agent_repo.list_by_user, user.id
            )
            members = []
            for expert_id in ids:
                expert = self.registry._expert_catalog.get(expert_id)
                member = next(
                    (
                        row
                        for row in existing
                        if row.application_id == APPLICATION_ID
                        and row.kind == "expert"
                        and self._member(row, profile.experts).expert_id == expert_id
                    ),
                    None,
                )
                if member is None:
                    spec = build_create_spec_from_expert(
                        expert_id=expert_id,
                        expert=expert,
                        user_id=user.id,
                        locale=locale,
                        default_model=body.expert_models.get(expert_id, host_model),
                        config_extra={"brainstorm_expert": expert_id},
                    )
                    spec.application_id = APPLICATION_ID
                    member = await self.registry.create(spec)
                else:
                    # Keep native identity/history and omitted model assignments.
                    cfg = json.loads(member.config_json or "{}")
                    cfg["brainstorm_expert"] = expert_id
                    updates: dict[str, Any] = {"config_json": json.dumps(cfg)}
                    if expert_id in body.expert_models:
                        updates["default_model"] = body.expert_models[expert_id]
                    member = await self.registry.update(member.agent_id, **updates)
                if member.last_state != "running":
                    await self.registry.start(member.agent_id)
                members.append(member.agent_id)
            # Retain previous native members for resuming meetings with their original roster.
            previous = await loop.run_in_executor(
                None, self.registry.teams.member_ids, profile.team_id
            )
            await loop.run_in_executor(
                None,
                self.registry.teams.replace_members,
                profile.team_id,
                list(dict.fromkeys([*members, *previous])),
            )
            host_row = await loop.run_in_executor(None, self.registry.get_row, profile.team_id)
            host_cfg = json.loads(host_row.config_json or "{}")
            host_cfg["brainstorm_expert_ids"] = ids
            await self.registry.update(profile.team_id, config_json=json.dumps(host_cfg))
            for path in ("AGENTS.md", "SOUL.md"):
                await self._workspace(profile.team_id).aupload_bytes(
                    path, tr("brainstorm.host_prompt", locale).encode()
                )
            await self.registry.reload(profile.team_id)
            return await self.profile(user)

    def _workspace(self, team_id: str) -> Any:
        return self.registry.workspace_for_agent(team_id)

    async def _save(self, state: BrainstormSession) -> None:
        self._states[state.thread_id] = state
        workspace = await asyncio.get_running_loop().run_in_executor(
            None, self._workspace, state.team_id
        )
        await workspace.aupload_bytes(
            f"brainstorm/{state.thread_id}.json", state.model_dump_json().encode()
        )

    async def _load(self, team_id: str, thread_id: str) -> BrainstormSession:
        if thread_id in self._states:
            return self._states[thread_id]
        row = await asyncio.get_running_loop().run_in_executor(
            None, self.registry._repos.thread_repo.get, thread_id
        )
        if row is None or row.agent_id != team_id:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        workspace = await asyncio.get_running_loop().run_in_executor(None, self._workspace, team_id)
        text = await workspace.aread_text(f"brainstorm/{thread_id}.json")
        if not text:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        state = BrainstormSession.model_validate_json(text)
        if not state.participants:
            members = await asyncio.get_running_loop().run_in_executor(
                None, self.registry.teams.member_ids, team_id
            )
            rows = await asyncio.get_running_loop().run_in_executor(
                None, lambda: [self.registry.get_row(aid) for aid in members]
            )
            state.participants = [self._member(row, []) for row in rows if row is not None]
        # Existing meetings need an agenda confirmation before further dispatch.
        if not state.goal:
            state.goal = state.title
        if state.status == "ended":
            state.phase = "closed"
        elif not state.agenda_confirmed and state.phase == "deliberation":
            state.phase = "intake"
        if state.status == "running":
            state.status = "interrupted"
        self._states[thread_id] = state
        return state

    async def get(self, user: Any, thread_id: str) -> BrainstormSession:
        profile = await self.profile(user)
        if profile.team_id is None:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        state = await self._load(profile.team_id, thread_id)
        if state.user_id != user.id:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        return state.model_copy(deep=True)

    async def list_sessions(self, user: Any) -> list[BrainstormSession]:
        profile = await self.profile(user)
        if profile.team_id is None:
            return []
        rows = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: self.registry._repos.thread_repo.list_by_agent_user(
                agent_id=profile.team_id, user_id=user.id, limit=100
            ),
        )
        sessions = []
        for row in rows:
            try:
                sessions.append(await self.get(user, row.thread_id))
            except OctopError as exc:
                if exc.code != ErrorCode.NOT_FOUND:
                    raise
        return sessions

    def _report_excerpts(self, state: BrainstormSession) -> list[tuple[str, str]]:
        names = {m.agent_id: m.name for m in state.participants}
        found: dict[str, str] = {}
        offset = 0
        while len(found) < len(names):
            rows, more = self.registry._repos.thread_message_repo.page(
                state.thread_id, limit=100, offset=offset
            )
            for row in reversed(rows):
                if row.role not in {"ai", "assistant"}:
                    continue
                data = json.loads(row.message_json).get("data", {})
                speaker = data.get("additional_kwargs", {}).get("speaker_agent_id")
                content = data.get("content", "")
                if isinstance(content, list):
                    content = "\n".join(
                        str(b.get("text", ""))
                        for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                if speaker in names and speaker not in found and content:
                    found[speaker] = str(content)
            if not more:
                break
            offset += len(rows)
        return [(names[aid], found[aid]) for aid in names if aid in found]

    async def _finalize_report(self, state: BrainstormSession, user: Any) -> MeetingReport:
        if state.report is None:
            excerpts = await asyncio.get_running_loop().run_in_executor(
                None, self._report_excerpts, state.model_copy(deep=True)
            )
            state.report = compile_report(
                state,
                owner=user.display_name or user.username,
                locale=user.locale,
                timezone=self.registry._config.default_timezone,
                excerpts=excerpts,
            )
            await self._save(state)
        return state.report.model_copy(deep=True)

    async def report(self, user: Any, thread_id: str) -> MeetingReport:
        await self.get(user, thread_id)
        async with self._locks.setdefault(thread_id, asyncio.Lock()):
            state = self._states[thread_id]
            if state.status != "ended":
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            return await self._finalize_report(state, user)

    async def report_document(self, user: Any, thread_id: str) -> bytes:
        report = await self.report(user, thread_id)
        return await asyncio.get_running_loop().run_in_executor(None, report_document, report)

    async def context(self, state: BrainstormSession, query: str) -> ContextResult:
        revision = state.revision
        product = await asyncio.get_running_loop().run_in_executor(
            None, self.registry._repos.application_repo.get, APPLICATION_ID
        )
        if (
            not state.context_enabled
            or product is None
            or "zhijun_context" not in product.capabilities
        ):
            state.context = ContextResult()
        else:
            result = await owned_zhijun_context(
                self.registry,
                state.user_id,
                query,
                excluded=state.excluded_source_ids,
                locale=self._locale(state.user_id),
            )
            if state.revision != revision:
                return state.context
            state.context = result
        await self._save(state)
        return state.context

    async def create(self, user: Any, body: SessionCreate) -> BrainstormSession:
        profile = await self.profile(user)
        if profile.team_id is None or len(profile.members) < 2:
            raise OctopError.localized(ErrorCode.TEAM_MEMBERS_TOO_FEW)
        chosen = (
            set(body.expert_ids)
            if body.expert_ids is not None
            else {m.expert_id for m in profile.members}
        )
        participants = [m for m in profile.members if m.expert_id in chosen]
        if len(participants) < 2 or chosen != {m.expert_id for m in participants}:
            raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
        tid = new_ulid()
        gateway = self.registry._team_processor._gateway
        await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: gateway.thread_registry.create_thread(
                agent_id=profile.team_id,
                user_id=user.id,
                channel_type="dashboard",
                session_key=f"{profile.team_id}:dashboard:{user.id}:{tid}",
                title=body.topic[:100],
                thread_id=tid,
            ),
        )
        state = BrainstormSession(
            thread_id=tid,
            team_id=profile.team_id,
            user_id=user.id,
            title=body.topic,
            participants=participants,
            context_enabled=body.context_enabled,
            phase="intake",
            goal=body.topic,
        )
        await self._save(state)
        await self.context(state, body.topic)

        def project() -> None:
            self.registry._repos.thread_message_repo.mark_projection(tid, "ready")
            self.registry._repos.thread_message_repo.append_if_ready(
                tid, message_inputs([HumanMessage(content=body.topic, id=new_ulid())])
            )

        await asyncio.get_running_loop().run_in_executor(None, project)
        self._launch(state, body.topic)
        return state.model_copy(deep=True)

    def _launch(self, state: BrainstormSession, text: str) -> None:
        current = self._tasks.get(state.thread_id)
        if current is not None and not current.done():
            return
        revision = state.revision

        async def run() -> None:
            try:
                await self.registry._team_processor.stream_host_followup_to_room(
                    {
                        "agent_id": state.team_id,
                        "thread_id": state.thread_id,
                        "user": str(state.user_id),
                        "source": "brainstorm",
                        "messages": [HumanMessage(content=text)],
                        "configurable": {
                            "user": str(state.user_id),
                            "source": "brainstorm",
                            "brainstorm_revision": revision,
                        },
                    },
                    room_thread_id=state.thread_id,
                    speaker_id=state.team_id,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Brainstorm host failed thread=%s", state.thread_id)
                current_state = self._states[state.thread_id]
                if current_state.status == "running" and current_state.revision == revision:
                    current_state.status = "interrupted"
                    message = tr("brainstorm.turn_failed", self._locale(state.user_id))
                    current_state.context.notices.append(message)
                    await self._save(current_state)
                    await self.registry._team_processor._relay_chunk(
                        {"type": "error", "message": message},
                        room_thread_id=state.thread_id,
                        member_thread_id=state.thread_id,
                        speaker_id=state.team_id,
                    )
            finally:
                self._tasks.pop(state.thread_id, None)

        self._tasks[state.thread_id] = asyncio.create_task(run())

    async def control(self, user: Any, thread_id: str, body: SessionControl) -> BrainstormSession:
        await self.get(user, thread_id)
        async with self._locks.setdefault(thread_id, asyncio.Lock()):
            state = self._states[thread_id]
            if state.status == "ended" and body.action != "end":
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if body.revision is not None and body.revision != state.revision:
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            text = (body.text or "").strip()
            decision = state.decision
            selected = None
            if body.decision_id is not None and (
                decision is None or body.decision_id != decision.id
            ):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if body.option_index is not None:
                if (
                    body.action != "respond"
                    or text
                    or decision is None
                    or body.decision_id != decision.id
                    or body.option_index >= len(decision.options)
                ):
                    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
                selected = decision.options[body.option_index]
                if selected.effect == "adopt" and decision.kind != "verdict":
                    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
                text = selected.label + (f"：{selected.detail}" if selected.detail else "")
            if body.action in {"respond", "adopt"} and not text:
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if body.action == "adopt" and (
                decision is None
                or decision.kind != "verdict"
                or body.decision_id != decision.id
                or body.option_index is not None
            ):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if body.action == "start" and (
                state.phase != "agenda"
                or decision is None
                or body.decision_id != decision.id
                or not state.agenda.strip()
            ):
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            state.status = "ended" if body.action == "end" else "paused"
            state.revision += 1
            control_revision = state.revision
            self._pending[thread_id] = set()
            self.registry.cancel_stream(state.team_id, thread_id)
            task = self._tasks.get(thread_id)
            if task:
                task.cancel()
            if body.context_enabled is not None:
                state.context_enabled = body.context_enabled
            if body.excluded_source_ids is not None:
                state.excluded_source_ids = body.excluded_source_ids
            if body.action == "end":
                state.phase = "closed"
                state.decision = None
            elif body.action == "revise":
                state.phase, state.agenda_confirmed = "intake", False
                state.intake_answers = 0
                state.decision = None
                state.report_draft = None
                text = tr("brainstorm.revise", self._locale(user.id))
            elif body.action == "agenda":
                state.phase = "agenda"
                state.decision = None
                text = tr("brainstorm.prepare_agenda", self._locale(user.id))
            elif body.action == "start":
                assert decision is not None
                state.phase, state.agenda_confirmed = "deliberation", True
                text = tr("brainstorm.start_meeting", self._locale(user.id))
                state.judgments.append(UserJudgment(question=decision.question, answer=text))
                state.decision = None
            elif body.action in {"respond", "adopt"}:
                state.judgments.append(
                    UserJudgment(
                        question=decision.question if decision else state.agenda, answer=text
                    )
                )
                if body.action == "adopt" or (selected and selected.effect == "adopt"):
                    state.ruling = text
                    state.phase, state.status = "closed", "ended"
                elif state.phase in {"intake", "agenda"}:
                    state.intake_answers += 1
                    if state.intake_answers >= 2:
                        state.phase = "agenda"
                else:
                    state.phase = "deliberation"
                state.decision = None
                state.questions = []
            await self._save(state)
        if task:
            await asyncio.gather(task, return_exceptions=True)
        async with self._locks[thread_id]:
            if state.revision != control_revision:
                return state.model_copy(deep=True)
            if body.action == "sources":
                state.report_draft = None
                await self.context(state, state.goal)
            elif body.action in {"respond", "start", "revise", "agenda", "adopt"}:
                await asyncio.get_running_loop().run_in_executor(
                    None,
                    lambda: self.registry._repos.thread_message_repo.append_if_ready(
                        thread_id, message_inputs([HumanMessage(content=text, id=new_ulid())])
                    ),
                )
                if state.status != "ended":
                    state.status = "running"
                    await self._save(state)
                    self._launch(state, text)
            elif body.action in {"resume", "summarize"}:
                if state.decision is not None:
                    state.status = "waiting"
                    await self._save(state)
                    return state.model_copy(deep=True)
                state.status = "running"
                await self._save(state)
                self._launch(
                    state,
                    tr(
                        "brainstorm.summarize"
                        if body.action == "summarize"
                        else "brainstorm.continue",
                        self._locale(user.id),
                    ),
                )
            if state.status == "ended":
                await self._finalize_report(state, user)
        return state.model_copy(deep=True)

    def can_dispatch(
        self, team_id: str, thread_id: str, user_id: str | int, member_id: str | None = None
    ) -> bool:
        state = self._states.get(thread_id)
        return (
            state is not None
            and state.team_id == team_id
            and str(state.user_id) == str(user_id)
            and state.status == "running"
            and state.phase == "deliberation"
            and state.agenda_confirmed
            and (member_id is None or member_id in {m.agent_id for m in state.participants})
        )

    def track_job(self, thread_id: str, job_id: str, *, begin: bool) -> None:
        pending = self._pending.setdefault(thread_id, set())
        if begin:
            pending.add(job_id)
            self._job_revisions.setdefault(job_id, self._states[thread_id].revision)
        else:
            # Wait for inbox synthesis to collect every result, even if all
            # member streams finished before the first callback acquired the lock.
            if job_id in self._seen_results:
                pending.discard(job_id)

    async def collect_member_result(
        self, msg: Any, result_text: str | None, error_text: str | None
    ) -> tuple[str, int] | None:
        tid = str(msg.source_thread_id or "")
        state = await self._load(msg.source_agent_id, tid)
        row = await asyncio.get_running_loop().run_in_executor(
            None, self.registry.get_row, msg.target_agent_id
        )
        async with self._locks.setdefault(tid, asyncio.Lock()):
            if msg.id in self._seen_results:
                return None
            self._seen_results.add(msg.id)
            self._pending.setdefault(tid, set()).discard(msg.id)
            if self._job_revisions.pop(msg.id, None) != state.revision:
                return None
            name = row.name if row else msg.target_agent_id
            self._received.setdefault(tid, []).append(
                f"{name}: {(error_text or result_text or '')[:12000]}"
            )
            if self._pending[tid] or not self.can_dispatch(state.team_id, tid, state.user_id):
                return None
            return "\n\n".join(self._received.pop(tid, [])), state.revision

    async def finish_turn(self, thread_id: str, revision: int | None = None) -> None:
        async with self._locks.setdefault(thread_id, asyncio.Lock()):
            state = self._states[thread_id]
            if revision is not None and state.revision != revision:
                return
            state.turns += 1
            if state.status == "running" and not self._pending.get(thread_id):
                # A model can omit dispatch. Expose the idle state truthfully.
                state.status = "waiting"
            await self._save(state)

    async def prepare_turn(self, team_id: str, payload: dict[str, Any]) -> bool:
        tid = str(payload.get("thread_id") or "")
        state = await self._load(team_id, tid)
        uid = (
            (payload.get("configurable") or {}).get("user")
            or payload.get("user")
            or payload.get("user_id")
        )
        if str(uid) != str(state.user_id):
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        await asyncio.get_running_loop().run_in_executor(
            None, assert_product_login, self.registry._repos, state.user_id, APPLICATION_ID
        )
        owner = await asyncio.get_running_loop().run_in_executor(
            None, self.registry._repos.user_repo.get, state.user_id
        )
        if owner is None or owner.disabled:
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        self._locales[state.user_id] = owner.locale
        source = str(
            payload.get("source") or (payload.get("configurable") or {}).get("source") or ""
        )
        if source == "dashboard" and state.status != "ended":
            state.status = "running"
            state.revision += 1
            state.decision = None
            self._pending[tid] = set()
        revision = (payload.get("configurable") or {}).get("brainstorm_revision")
        if revision is not None and revision != state.revision:
            return False
        if source == "inbox" and not self.can_dispatch(team_id, tid, state.user_id):
            return False
        if state.status != "running":
            return False
        row = await asyncio.get_running_loop().run_in_executor(
            None, self.registry._repos.thread_repo.get, tid
        )
        if row is None or row.user_id != state.user_id:
            raise OctopError.localized(ErrorCode.NOT_FOUND)
        payload["configurable"] = {
            **(payload.get("configurable") or {}),
            "session_key": row.session_key,
            "brainstorm_revision": state.revision,
        }
        state.context.notices = [
            n
            for n in state.context.notices
            if n != tr("brainstorm.turn_failed", self._locale(state.user_id))
        ]
        await self._save(state)
        briefing = tr(
            "brainstorm.turn_context",
            self._locale(state.user_id),
            title=state.title,
            summary=state.summary,
            directions=json.dumps(state.directions, ensure_ascii=False),
            context=state.context.text,
            excluded=json.dumps(state.excluded_source_ids, ensure_ascii=False),
            phase=state.phase,
            confirmed=state.agenda_confirmed,
            goal=state.goal,
            constraints=json.dumps(state.constraints, ensure_ascii=False),
            agenda=state.agenda,
            judgments=json.dumps(
                [j.model_dump() for j in state.judgments[-12:]], ensure_ascii=False
            ),
            intake_answers=state.intake_answers,
            member_results="\n\n".join(self._received.pop(tid, [])),
            participants=json.dumps(
                [
                    {"agent_id": m.agent_id, "name": m.name, "description": m.description}
                    for m in state.participants
                ],
                ensure_ascii=False,
            ),
        )
        messages = ChatRequest(messages=payload.get("messages") or []).normalize_messages()
        payload["messages"] = [SystemMessage(content=briefing), *messages]
        return True

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def service_for(registry: Any) -> BrainstormService:
    service = getattr(registry, "_brainstorm_service", None)
    if service is None:
        service = BrainstormService(registry)
        registry._brainstorm_service = service
    return service


def build_brainstorm_tools(registry: Any, agent_id: str) -> list[BaseTool]:
    async def state_for_call() -> BrainstormSession:
        from langgraph.config import get_config

        config = get_config().get("configurable") or {}
        state = await service_for(registry)._load(agent_id, str(config.get("thread_id") or ""))
        if (
            config.get("agent_id") != agent_id
            or str(config.get("user")) != str(state.user_id)
            or state.status != "running"
            or (
                config.get("brainstorm_revision") is not None
                and config["brainstorm_revision"] != state.revision
            )
        ):
            raise OctopError.localized(ErrorCode.FORBIDDEN)
        return state

    @tool
    async def brainstorm_context(query: str) -> str:
        """Retrieve the owner's relevant Zhijun context for the next exploration question."""
        state = await state_for_call()
        return (await service_for(registry).context(state, query)).model_dump_json()

    @tool
    async def brainstorm_checkpoint(
        summary: str,
        ideas: list[str],
        directions: list[str],
        questions: list[str],
        wait_for_user: bool = False,
        phase: str | None = None,
        goal: str | None = None,
        constraints: list[str] | None = None,
        agenda: str | None = None,
        brief: str | None = None,
        decision: DecisionProposal | None = None,
        report_draft: MeetingReportDraft | None = None,
    ) -> str:
        """Save evolving ideas and unexplored directions; explicitly wait when owner input is needed. Dispatch the next exploration with ask_agent when continuing."""
        state = await state_for_call()
        async with service_for(registry)._locks.setdefault(state.thread_id, asyncio.Lock()):
            state = await state_for_call()
            if phase not in {None, "intake", "agenda", "deliberation", "decision"}:
                raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if phase == "deliberation" and not state.agenda_confirmed:
                raise OctopError.localized(ErrorCode.FORBIDDEN)
            if phase == "intake" and state.phase != "intake":
                raise OctopError.localized(ErrorCode.FORBIDDEN)
            next_phase = phase if phase == "agenda" else state.phase
            if decision is not None and next_phase != "agenda":
                if (decision.kind == "intake") != (next_phase == "intake"):
                    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
                effects = {o.effect for o in decision.options}
                if (effects != {"respond"} and decision.kind != "verdict") or (
                    decision.kind == "verdict" and not {"adopt", "revisit"} <= effects
                ):
                    raise OctopError.localized(ErrorCode.APPLICATION_INVALID)
            if phase == "agenda":
                state.phase, state.agenda_confirmed = "agenda", False
            if state.phase in {"intake", "agenda"}:
                if goal is not None:
                    state.goal = goal[:2000]
                if constraints is not None:
                    state.constraints = constraints[:10]
                if agenda is not None:
                    state.agenda = agenda[:2000]
            if brief is not None:
                state.brief = brief[:6000]
            if report_draft is not None:
                state.report_draft = report_draft
            state.summary, state.ideas, state.directions, state.questions = (
                summary,
                ideas[:30],
                directions[:20],
                questions[:1],
            )
            if state.phase == "agenda":
                state.agenda = state.agenda or summary
                state.decision = MeetingDecision(
                    id=new_ulid(),
                    kind="agenda",
                    question=tr(
                        "brainstorm.confirm_agenda", service_for(registry)._locale(state.user_id)
                    ),
                )
            elif decision is not None:
                state.decision = MeetingDecision(id=new_ulid(), **decision.model_dump())
                state.questions = [decision.question]
                if decision.kind in {"judgment", "verdict"}:
                    state.phase = "decision"
            if wait_for_user or state.decision is not None or state.phase == "intake":
                state.status = "waiting"
            await service_for(registry)._save(state)
        return json.dumps({"status": state.status, "revision": state.revision})

    return [brainstorm_context, brainstorm_checkpoint]

"""Isolated source tests: no user workspace, model call, or personal confirmation."""

import asyncio
import json
import unittest
from datetime import UTC, datetime
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from tests.unit.agents.test_role_ontology import Registry, Workspace

from octop.infra.agents import personal_ontology as p
from octop.infra.agents import role_ontology as r
from octop.infra.agents import role_ontology_flow as f
from octop.infra.agents.ontology_admission import admitted, pending
from octop.infra.agents.ontology_types import (
    OntologyClaim,
    OntologyCoverage,
    OntologyEvidence,
    OntologyResult,
)


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.registry = Registry()
        self.registry.is_agent_active = lambda aid: False
        self.registry.ontology = NS(jobs={})

    async def asyncTearDown(self):
        tasks = list(self.registry.ontology.jobs.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def enable(self, aid="personal"):
        w = self.registry.get_agent(aid).workspace
        d = await p._read(w)
        d.preparation.enabled = True
        await p._save(w, d)
        return d

    async def test_exact_declarations_and_ambiguous_or_quoted_text(self):
        self.assertEqual(
            f.explicit_declaration("我确认我现在的核心是人工智能，这条可以进本体"),
            "我现在的核心是人工智能",
        )
        self.assertEqual(f.explicit_declaration("请纳入本体：我是一个设计师"), "我是一个设计师")
        self.assertEqual(f.explicit_declaration("请记住：我希望你先听我说完"), "我希望你先听我说完")
        for text in [
            "可以",
            "这条可以进本体",
            "不要把我是设计师加入本体",
            "他说“请记住：我是设计师”",
            "例如我是设计师，这条可以进本体",
            "我不是要确认加入本体",
            "[上传资料] 请记住：我是设计师",
            "请记住：我是设计师？",
        ]:
            self.assertIsNone(f.explicit_declaration(text), text)

    async def test_chat_confirmation_atomic_idempotent_and_isolated(self):
        with r.agent_scope(self.registry, 1, "personal"):
            a = await f.capture_declaration(
                self.registry,
                1,
                "personal",
                "t",
                "turn",
                "我确认我现在的核心是人工智能，这条可以进本体",
            )
            b = await f.capture_declaration(
                self.registry,
                1,
                "personal",
                "t",
                "turn",
                "我确认我现在的核心是人工智能，这条可以进本体",
            )
        self.assertEqual(a, b)
        d = await p._read(self.registry.agents["personal"].workspace)
        self.assertEqual(len(d.claims), 1)
        self.assertTrue(admitted(d.claims[0]))
        self.assertEqual(d.claims[0].kind, "value")
        self.assertEqual(d.claims[0].evidence[0].source_type, "owner_declaration")
        self.assertEqual(d.claims[0].discussion_thread_id, "t")
        self.assertFalse(self.registry.agents["work"].workspace.files)

    async def test_sources_include_unreviewed_owner_not_assistant_or_withdrawn(self):
        from octop.infra.agents import ontology_graph as g

        atoms = [
            {"id": k, "candidate_id": k, "assertion": k, "verbatim_quote": "我是设计师" + k}
            for k in ["a", "b", "c"]
        ]
        memory = NS(
            get_candidate=lambda k: NS(
                quote_event_id=k, subject_entity_type="User", subject_entity_name="me"
            ),
            get_raw=lambda k: NS(
                id=k,
                user="1",
                event_type="assistant_message" if k == "c" else "user_message",
                content="我是设计师" + k,
                thread_id=k,
                session_id=k,
                timestamp=datetime.now(UTC),
            ),
        )
        workspace = self.registry.agents["personal"].workspace
        d = await p._read(workspace)
        d.fact_confirmations = {"b": {"atom_hash": ""}}
        await p._save(workspace, d)
        with (
            r.agent_scope(self.registry, 1, "personal"),
            patch.object(g, "_pages", return_value=(atoms, True)),
        ):
            sources, coverage, _ = await p._owned_sources(workspace, memory, 1)
        self.assertEqual(set(sources), {"a"})
        self.assertFalse(sources["a"]["owner_confirmed_fact"])
        self.assertEqual(coverage.total_atoms, 3)

    async def test_candidate_single_confirmation_also_confirms_displayed_evidence(self):
        workspace = self.registry.agents["personal"].workspace
        d = await p._read(workspace)
        a = {"id": "a", "deprecated_at": None}
        h = p._digest(a)
        c = OntologyClaim(
            id="candidate",
            version="v1",
            kind="identity",
            title="设计师",
            statement="我是设计师",
            conditions="",
            exceptions="",
            basis="owner_statement",
            evidence=[OntologyEvidence(atom_id="a", quote="我是设计师", timestamp="", atom_hash=h)],
        )
        d.claims = [c]
        await p._save(workspace, d)
        with (
            r.agent_scope(self.registry, 1, "personal"),
            patch.object(p, "_valid", return_value=True),
            patch.object(r, "atom_payload", return_value=a),
        ):
            before = await r.read_role_ontology(self.registry, 1)
            self.assertTrue(before.claims[0].evidence_valid)
            self.assertFalse(admitted(before.claims[0]))
            result = await r.command(
                self.registry,
                1,
                "candidate",
                r.RoleCommand(
                    request_id="admit",
                    expected_version="v1",
                    action="admit",
                    statement=c.statement,
                    kind=c.kind,
                ),
            )
            self.assertTrue(admitted(result["ontology"].claims[0]))
            self.assertEqual(result["ontology"].fact_confirmations["a"]["atom_hash"], h)
            await r.command(
                self.registry,
                1,
                "a",
                r.RoleCommand(request_id="withdraw", expected_version=h, action="fact_withdraw"),
            )
            self.assertFalse(admitted((await r.read_role_ontology(self.registry, 1)).claims[0]))

    async def test_worker_opt_in_and_no_repeat_for_unchanged_sources(self):
        source = AsyncMock(
            return_value=(
                {"a": {}},
                OntologyCoverage(eligible_sources=1, independent_events=1),
                "same",
            )
        )
        await f.prepare_role(self.registry, 1, "work")
        self.assertFalse(self.registry.agents["work"].workspace.files)
        await self.enable()

        async def generate(reg, uid, revision, **kw):
            return OntologyResult(
                status="ready", ontology=await p._read(reg.agents["personal"].workspace)
            )

        model = AsyncMock(side_effect=generate)
        with (
            patch.object(f, "_owned_sources", source),
            patch.object(f, "generate_personal_ontology", model),
        ):
            await f.prepare_role(self.registry, 1, "personal")
            await f.prepare_role(self.registry, 1, "personal")
        self.assertEqual(model.await_count, 1)
        d = await p._read(self.registry.agents["personal"].workspace)
        self.assertEqual(d.preparation.outcome, "no_new_candidates")
        self.assertFalse(d.claims)
        self.assertFalse(self.registry.agents["work"].workspace.files)

    async def test_worker_reports_invalid_model_and_retries_only_on_request(self):
        await self.enable()
        with (
            patch.object(
                f, "_owned_sources", AsyncMock(return_value=({"a": {}}, OntologyCoverage(), "same"))
            ),
            patch.object(
                f,
                "generate_personal_ontology",
                AsyncMock(
                    return_value=OntologyResult(
                        status="unavailable",
                        reason="invalid_response",
                        ontology=await p._read(self.registry.agents["personal"].workspace),
                    )
                ),
            ) as model,
        ):
            await f.prepare_role(self.registry, 1, "personal")
            await f.prepare_role(self.registry, 1, "personal")
            self.assertEqual(model.await_count, 1)
            await f.prepare_role(self.registry, 1, "personal", retry=True)
            self.assertEqual(model.await_count, 2)
        self.assertEqual(
            (await p._read(self.registry.agents["personal"].workspace)).preparation.outcome,
            "invalid_response",
        )

    async def test_memory_disabled_pauses_automatic_processing(self):
        await self.enable()
        self.registry._agent_config_dict = lambda row: {"memory": {"memory_enabled": False}}
        with patch.object(f, "generate_personal_ontology", AsyncMock()) as model:
            await f.prepare_role(self.registry, 1, "personal")
            model.assert_not_awaited()
        self.assertEqual(
            (await p._read(self.registry.agents["personal"].workspace)).preparation.outcome,
            "memory_paused",
        )

    async def test_worker_stale_revision_retries_new_material(self):
        await self.enable()
        with (
            patch.object(
                f, "_owned_sources", AsyncMock(return_value=({"a": {}}, OntologyCoverage(), "same"))
            ),
            patch.object(
                f,
                "generate_personal_ontology",
                AsyncMock(
                    return_value=OntologyResult(
                        status="stale",
                        ontology=await p._read(self.registry.agents["personal"].workspace),
                    )
                ),
            ),
        ):
            await f.prepare_role(self.registry, 1, "personal")
        state = (await p._read(self.registry.agents["personal"].workspace)).preparation
        self.assertEqual(state.outcome, "stale")
        self.assertEqual(state.fingerprint, "")

    async def test_coordinator_only_schedules_enabled_private_wanx_rows(self):
        for row in self.registry.rows.values():
            row.enabled = True
        self.registry.rows["work"].is_shared = True
        self.registry.list_rows = lambda: list(self.registry.rows.values())
        coordinator = f.RoleOntologyCoordinator(self.registry)
        with patch.object(f, "prepare_role", AsyncMock()) as worker:
            await coordinator.tick()
            await asyncio.gather(*coordinator.jobs.values())
            worker.assert_awaited_once_with(self.registry, 1, "personal")

    async def test_model_single_source_exact_self_statement_only(self):
        from octop.infra.agents import ontology_graph as g

        source = {
            "a": {
                "atom_id": "a",
                "event_id": "e",
                "experience_id": "one",
                "assertion": "我是设计师",
                "quote": "我是设计师",
                "timestamp": "",
                "atom_hash": "h",
                "raw_hash": "r",
            }
        }
        harness = self.registry.agents["personal"]
        harness.config = NS(pick_default_model_ref=lambda: "test")
        harness.model_factory = NS(get=lambda _: None)
        proposal = {
            "kind": "identity",
            "title": "设计师",
            "statement": "我是设计师",
            "conditions": "本人自述",
            "exceptions": "可修正",
            "evidence_ids": ["a"],
            "basis": "owner_statement",
        }

        async def hydrate(doc, *args):
            return doc

        for overrides, expected in [
            ({}, "ready"),
            ({"statement": "我是一个非常独立的人"}, "unavailable"),
            ({"basis": "inference"}, "unavailable"),
        ]:
            harness.workspace = Workspace()
            with (
                r.agent_scope(self.registry, 1, "personal"),
                patch.object(
                    p,
                    "_owned_sources",
                    AsyncMock(
                        return_value=(
                            source,
                            OntologyCoverage(eligible_sources=1, independent_events=1),
                            "f",
                        )
                    ),
                ),
                patch.object(
                    p,
                    "ainvoke_text",
                    AsyncMock(return_value=json.dumps({"claims": [{**proposal, **overrides}]})),
                ),
                patch.object(g, "hydrate_graph", hydrate),
                patch.object(p, "_valid", return_value=True),
            ):
                result = await p.generate_personal_ontology(self.registry, 1, "empty")
            self.assertEqual(result.status, expected)
            if expected == "ready":
                self.assertTrue(pending(result.ontology.claims[0]))
                self.assertFalse(admitted(result.ontology.claims[0]))
                self.assertFalse(result.ontology.fact_confirmations)

    async def test_middleware_foreign_agent_peer_and_wrong_user_never_write(self):
        from langchain_core.messages import HumanMessage, SystemMessage

        await self.enable()

        class Request:
            messages = [HumanMessage(content="我是设计师，这条可以进本体", id="t")]
            state = {"messages": messages}
            system_message = SystemMessage(content="expert")

            def override(self, **kwargs):
                return self

        for cfg in [
            {"agent_id": "work", "user": "1"},
            {"agent_id": "personal", "user": "2"},
            {"agent_id": "personal", "user": "1", "source": "peer"},
        ]:
            with patch(
                "langgraph.config.get_config",
                return_value={"configurable": {**cfg, "thread_id": "t"}},
            ):
                await r.RoleOntologyMiddleware(self.registry, "personal", 1).awrap_model_call(
                    Request(), AsyncMock()
                )
        self.assertFalse((await p._read(self.registry.agents["personal"].workspace)).claims)

    async def test_middleware_write_receipt_precedes_model_response(self):
        from langchain_core.messages import HumanMessage, SystemMessage

        await self.enable()
        seen = []

        class Request:
            messages = [HumanMessage(content="我是设计师，这条可以进本体", id="t")]
            state = {"messages": messages}
            system_message = SystemMessage(content="expert")

            def override(self, **kwargs):
                seen.append(kwargs["system_message"].content)
                return self

        with patch(
            "langgraph.config.get_config",
            return_value={
                "configurable": {"agent_id": "personal", "user": "1", "thread_id": "chat"}
            },
        ):
            await r.RoleOntologyMiddleware(self.registry, "personal", 1).awrap_model_call(
                Request(), AsyncMock()
            )
        self.assertIn('"status": "admitted"', seen[0])
        self.assertTrue(
            admitted((await p._read(self.registry.agents["personal"].workspace)).claims[0])
        )


if __name__ == "__main__":
    unittest.main()

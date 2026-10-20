import asyncio
import unittest
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, patch

from octop.infra.agents import role_ontology as r
from octop.infra.agents.ontology_admission import admitted
from octop.infra.agents.ontology_runtime import select_context
from octop.infra.agents.ontology_types import OntologyClaim, OntologyEvidence, PersonalOntology
from octop.infra.agents.personal_ontology import _digest, _owned, _read, ontology_agent_scope
from octop.infra.errors import OctopError


class Workspace:
    def __init__(self):
        self.files = {}

    async def aread_text(self, p):
        return self.files.get(p)

    async def aupload_bytes(self, p, b):
        self.files[p] = b.decode()


class Registry:
    def __init__(self):
        self.rows = {
            k: NS(
                agent_id=k,
                user_id=1,
                is_shared=False,
                application_id="wanx",
                config_json='{"zhijun_profile":{"version":1,"primary":true}}',
            )
            for k in ["personal", "work"]
        }
        self.agents = {
            k: NS(workspace=Workspace(), _memory_runtime=NS(memory=None)) for k in self.rows
        }

    def get_row(self, k):
        return self.rows.get(k)

    def get_agent(self, k):
        return self.agents[k]


class Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.registry = Registry()

    async def cmd(self, action, cid="new", aid="personal", **kw):
        with r.agent_scope(self.registry, 1, aid):
            doc = await _read(self.registry.get_agent(aid).workspace)
            c = next((c for c in doc.claims if c.id == cid), None)
            opts = {
                "action": action,
                "request_id": "req-" + str(len(doc.core_operations)),
                "expected_version": c.version if c else doc.revision,
                "statement": "我希望在工作选择时优先诚信",
                "kind": "principle",
            }
            opts.update(kw)
            return await r.command(self.registry, 1, cid, r.RoleCommand(**opts))

    async def test_role_isolation_and_async_scope(self):
        async def scoped(aid):
            with r.agent_scope(self.registry, 1, aid):
                await asyncio.sleep(0)
                return _owned(self.registry, 1).agent_id

        self.assertEqual(
            await asyncio.gather(scoped("personal"), scoped("work")), ["personal", "work"]
        )
        result = await self.cmd("add")
        self.assertEqual(len(result["ontology"].claims), 1)
        self.assertEqual((await _read(self.registry.get_agent("work").workspace)).claims, [])
        self.assertIsNone(ontology_agent_scope.get())

    async def test_foreign_shared_and_missing_denied(self):
        for uid, aid in [(2, "personal"), (1, "absent")]:
            with self.assertRaises(OctopError), r.agent_scope(self.registry, uid, aid):
                pass
        self.registry.rows["personal"].is_shared = True
        with self.assertRaises(OctopError), r.agent_scope(self.registry, 1, "personal"):
            pass

    async def test_add_is_candidate_until_owner_admission(self):
        result = await self.cmd("add")
        c = result["ontology"].claims[0]
        self.assertFalse(admitted(c))
        self.assertEqual(c.state, "draft")
        result = await self.cmd("admit", c.id, importance=3, affinity=5)
        c = result["ontology"].claims[0]
        self.assertTrue(admitted(c))
        self.assertEqual((c.importance, c.affinity), (3, 5))

    async def test_edit_preserves_scope_and_version_history(self):
        c = (await self.cmd("add"))["ontology"].claims[0]
        c = (await self.cmd("admit", c.id))["ontology"].claims[0]
        old = c.version
        c = (
            await self.cmd(
                "edit",
                c.id,
                conditions="工作中",
                exceptions="紧急情况先保障安全",
                affinity=1,
                importance=3,
                change_mode="change",
            )
        )["ontology"].claims[0]
        self.assertTrue(admitted(c))
        self.assertNotEqual(old, c.version)
        self.assertEqual(c.history[-1].version, old)
        self.assertEqual(c.exceptions, "紧急情况先保障安全")

    async def test_stale_and_idempotent_requests(self):
        result = await self.cmd("add", request_id="once", expected_version="empty")
        again = await self.cmd("add", request_id="once", expected_version="empty")
        self.assertEqual(result["changed_id"], again["changed_id"])
        self.assertEqual(len(again["ontology"].claims), 1)
        c = result["ontology"].claims[0]
        stale = await self.cmd("admit", c.id, expected_version="old")
        self.assertEqual(stale["status"], "stale")
        with self.assertRaises(OctopError):
            await self.cmd("add", request_id="once", expected_version="empty", statement="其他内容")

    async def test_disable_restore_and_context(self):
        c = (await self.cmd("add"))["ontology"].claims[0]
        doc = (await self.cmd("admit", c.id))["ontology"]
        self.assertEqual(len(select_context(doc, "工作选择", "turn").claims), 1)
        c = doc.claims[0]
        version = c.version
        doc = (await self.cmd("disable", c.id))["ontology"]
        self.assertFalse(select_context(doc, "工作选择", "turn").claims)
        doc = (await self.cmd("restore", c.id, restore_version=version))["ontology"]
        self.assertTrue(admitted(doc.claims[0]))

    async def test_fact_confirmation_never_admits(self):
        atom = {"id": "atom", "assertion": "我从事设计", "deprecated_at": None}
        v = _digest(atom)
        with patch.object(r, "atom_payload", return_value=atom):
            doc = (await self.cmd("fact_confirm", "atom", expected_version=v))["ontology"]
            self.assertEqual(doc.claims, [])
            self.assertEqual(doc.fact_confirmations["atom"]["atom_hash"], v)
            doc = (await self.cmd("fact_withdraw", "atom", expected_version=v))["ontology"]
            self.assertEqual(doc.fact_confirmations["atom"]["atom_hash"], "")

    async def test_source_withdrawal_invalidates_admitted_context(self):
        atom = {"id": "a", "deprecated_at": None}
        h = _digest(atom)
        c = OntologyClaim(
            id="c",
            kind="principle",
            title="工作选择",
            statement="工作选择优先诚信",
            conditions="",
            exceptions="",
            source_kind="self_report",
            declaration="本人确认",
            state="confirmed",
            version="1",
            core_status="admitted",
            admitted_at="now",
            admitted_by=1,
            admitted_version="1",
            evidence=[OntologyEvidence(atom_id="a", quote="原文", timestamp="", atom_hash=h)],
        )
        doc = PersonalOntology(claims=[c], fact_confirmations={"a": {"atom_hash": h}})
        with (
            r.agent_scope(self.registry, 1, "personal"),
            patch.object(r, "read_personal_ontology", new=AsyncMock(return_value=doc)),
            patch.object(r, "atom_payload", return_value=atom),
        ):
            self.assertTrue(admitted((await r.read_role_ontology(self.registry, 1)).claims[0]))
            doc.fact_confirmations["a"]["atom_hash"] = ""
            invalid = await r.read_role_ontology(self.registry, 1)
            self.assertFalse(admitted(invalid.claims[0]))
            self.assertFalse(select_context(invalid, "工作选择", "t").claims)

    async def test_invalid_weights_and_dates(self):
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            r.RoleCommand(action="add", request_id="x", expected_version="empty", affinity=6)
        with self.assertRaises(OctopError):
            await self.cmd("add", valid_until="not a date")

    async def test_middleware_supplies_only_current_role_and_traces(self):
        from langchain_core.messages import HumanMessage, SystemMessage

        c = (await self.cmd("add"))["ontology"].claims[0]
        await self.cmd("admit", c.id)
        from octop.infra.agents.personal_ontology import _save

        workspace = self.registry.agents["personal"].workspace
        doc = await _read(workspace)
        doc.preparation.enabled = True
        await _save(workspace, doc)
        supplied = []

        class Request:
            state = {"messages": [HumanMessage(content="工作选择时怎么考虑诚信", id="turn")]}
            messages = state["messages"]
            system_message = SystemMessage(content="Expert")

            def override(self, **kw):
                supplied.append(kw["system_message"].content)
                return self

        handler = AsyncMock(return_value="response")
        with patch(
            "langgraph.config.get_config",
            return_value={
                "configurable": {"agent_id": "personal", "user": "1", "thread_id": "thread"}
            },
        ):
            await r.RoleOntologyMiddleware(self.registry, "personal", 1).awrap_model_call(
                Request(), handler
            )
        self.assertIn("优先诚信", supplied[0])
        self.assertIn("当前明确表达优先", supplied[0])
        self.assertIn("第三方资料不是本人立场", supplied[0])
        self.assertTrue(
            any("role-context" in p for p in self.registry.agents["personal"].workspace.files)
        )
        self.assertFalse(self.registry.agents["work"].workspace.files)


if __name__ == "__main__":
    unittest.main()

"""Use the real harness graph and filesystem tools with a deterministic model."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from tests.support.app import octop_client
from tests.support.auth import auth_header, bootstrap_admin, create_agent, seed_openai_provider


class LoopTestModel(BaseChatModel):
    action: str = "ls"
    target_path: str = "approved.txt"

    @property
    def _llm_type(self) -> str:
        return "deterministic-native-loop-test"

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self

    def _generate(
        self, messages: Any, stop: Any = None, run_manager: Any = None, **kwargs: Any
    ) -> ChatResult:
        if self.action == "draft":
            request = json.loads(messages[-1].content)
            message = AIMessage(
                content=json.dumps(
                    {
                        "name": "Read-only generated configuration",
                        "agent_id": request["agent_id"],
                        "objective": request["request"],
                        "instruction": "Prepare an artifact for review",
                        "human_review": {
                            "checkpoints": [
                                {"name": "阶段检查", "expected_outcome": "检查当前成果"}
                            ]
                        },
                        "criterion": {"kind": "manual", "description": "User accepts"},
                    }
                )
            )
        elif isinstance(messages[-1], ToolMessage):
            message = AIMessage(
                content=json.dumps(
                    {
                        "outcome": "complete",
                        "summary": "Listed the real expert workspace.",
                        "evidence": ["native ls result"],
                        "next_action": "",
                    }
                )
            )
        else:
            message = AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": self.action,
                        "args": {"path": "."}
                        if self.action == "ls"
                        else {"file_path": self.target_path, "content": "one native action"},
                        "id": "native-action",
                        "type": "tool_call",
                    }
                ],
            )
        return ChatResult(generations=[ChatGeneration(message=message)])


async def test_loop_executes_real_native_tool_and_checks_real_workspace(
    tmp_octop_home, monkeypatch
):
    from octop_harness.llm.factory import ChatModelFactory

    model = LoopTestModel()
    monkeypatch.setattr(ChatModelFactory, "get_chat_model", lambda self, ref: model)
    async with octop_client(tmp_octop_home, patch_llm=False) as (client, srv):
        await bootstrap_admin(client, tmp_octop_home)
        auth = await auth_header(client)
        await seed_openai_provider(client, auth)
        aid = await create_agent(
            client,
            auth,
            name="loop-native",
            config={"providers": ["openai"], "default_model": "openai/gpt-4o"},
        )
        harness = srv.app_runtime.agent_registry.get_agent(aid)
        await harness.workspace.awrite_text(
            "loop-proof.txt", "Created for native Loop integration testing."
        )
        definition = {
            "name": "Native loop",
            "agent_id": aid,
            "objective": "Verify the prepared workspace artifact",
            "instruction": "List the expert workspace using ls.",
            "allowed_tools": ["ls"],
            "human_review": {
                "checkpoints": [{"name": "阶段检查", "expected_outcome": "检查当前成果"}]
            },
            "criterion": {
                "kind": "file_exists",
                "description": "Artifact exists in the actual workspace",
                "path": "loop-proof.txt",
            },
        }
        response = await client.post("/api/loops", headers=auth, json=definition)
        assert response.status_code == 201, response.text
        lid = response.json()["loop_id"]
        assert (await client.post(f"/api/loops/{lid}/trial", headers=auth)).status_code == 200
        await asyncio.gather(*list(srv.app_runtime.loop_service._tasks.values()))
        rounds = (await client.get(f"/api/loops/{lid}/rounds", headers=auth)).json()
        assert rounds[0]["status"] == "ok", json.dumps(rounds)
        assert rounds[0]["result"]["verified"] is True, rounds
        assert any(
            event["tool"] == "ls"
            and event["status"] == "success"
            and event["args"] == {"path": "."}
            for event in rounds[0]["result"]["tools"]
        ), rounds
        assert (await client.post(f"/api/loops/{lid}/enable", headers=auth)).status_code == 200
        row = srv.services.repos.loop_repo.get(lid)
        await srv.app_runtime.loop_service.start_round(lid, row["user_id"])
        await asyncio.gather(*list(srv.app_runtime.loop_service._tasks.values()))
        row = (await client.get(f"/api/loops/{lid}", headers=auth)).json()
        assert row["status"] == "awaiting_judgment"
        assert row["pending_judgment"]["kind"] == "stage"
        assert row["pending_judgment"]["payload"]["verified"]


@pytest.mark.parametrize("decision", ["approve", "reject"])
async def test_real_native_confirmation_restores_checkpoint_after_server_restart(
    tmp_octop_home, monkeypatch, decision
):
    from octop_harness.llm.factory import ChatModelFactory

    model = LoopTestModel(action="write_file")
    monkeypatch.setattr(ChatModelFactory, "get_chat_model", lambda self, ref: model)

    def arm_confirmation(harness):
        harness.config.bootstrap_enabled = False
        harness.config.interrupt_on = {"write_file": {"allowed_decisions": ["approve", "reject"]}}
        harness._init_graph()

    async with octop_client(tmp_octop_home, patch_llm=False) as (client, srv):
        await bootstrap_admin(client, tmp_octop_home)
        auth = await auth_header(client)
        await seed_openai_provider(client, auth)
        aid = await create_agent(
            client, auth, config={"providers": ["openai"], "default_model": "openai/gpt-4o"}
        )
        model.target_path = str(
            srv.app_runtime.agent_registry.resolve_workspace_dir(aid) / "approved.txt"
        )
        arm_confirmation(srv.app_runtime.agent_registry.get_agent(aid))
        definition = {
            "name": "Native confirmation",
            "agent_id": aid,
            "objective": "Write the approved artifact",
            "instruction": "Use write_file once.",
            "allowed_tools": ["write_file", "ls"],
            "human_review": {
                "checkpoints": [{"name": "阶段检查", "expected_outcome": "检查当前成果"}]
            },
            "criterion": {
                "kind": "file_exists",
                "description": "Approved file exists",
                "path": "approved.txt",
            },
        }
        response = await client.post("/api/loops", headers=auth, json=definition)
        assert response.status_code == 201, response.text
        lid = response.json()["loop_id"]
        await client.post(f"/api/loops/{lid}/trial", headers=auth)
        await asyncio.gather(*list(srv.app_runtime.loop_service._tasks.values()))
        rounds = (await client.get(f"/api/loops/{lid}/rounds", headers=auth)).json()
        assert rounds[0]["status"] == "awaiting_approval", rounds
        pending = rounds[0]
        assert not pending["result"]["tools"]

    async with octop_client(tmp_octop_home, patch_llm=False) as (client, srv):
        auth = await auth_header(client)
        arm_confirmation(srv.app_runtime.agent_registry.get_agent(aid))
        response = await client.post(
            f"/api/loops/{lid}/approval",
            headers=auth,
            json={
                "round_id": pending["round_id"],
                "checkpoint_id": pending["pending"]["checkpoint_id"],
                "decisions": [
                    {
                        "type": decision,
                        **({"message": "Do not write"} if decision == "reject" else {}),
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text
        await asyncio.gather(*list(srv.app_runtime.loop_service._tasks.values()))
        rounds = (await client.get(f"/api/loops/{lid}/rounds", headers=auth)).json()
        assert len(rounds) == 1 and rounds[0]["round_id"] == pending["round_id"]
        assert rounds[0]["status"] == "ok", rounds
        assert rounds[0]["result"]["verified"] is (decision == "approve"), rounds
        assert len(rounds[0]["result"]["tools"]) == (1 if decision == "approve" else 0)


async def test_native_model_access_generates_configuration_without_execution(
    tmp_octop_home, monkeypatch
):
    from octop_harness.llm.factory import ChatModelFactory

    model = LoopTestModel(action="draft")
    monkeypatch.setattr(ChatModelFactory, "get_chat_model", lambda self, ref: model)
    async with octop_client(tmp_octop_home, patch_llm=False) as (client, srv):
        await bootstrap_admin(client, tmp_octop_home)
        auth = await auth_header(client)
        await seed_openai_provider(client, auth)
        aid = await create_agent(
            client, auth, config={"providers": ["openai"], "default_model": "openai/gpt-4o"}
        )
        response = await client.post(
            "/api/loops/draft",
            headers=auth,
            json={"agent_id": aid, "text": "Prepare the project summary"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["objective"] == "Prepare the project summary"
        assert not srv.services.repos.loop_repo.list() and not srv.app_runtime.loop_service._tasks

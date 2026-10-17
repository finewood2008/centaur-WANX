from __future__ import annotations

from unittest.mock import AsyncMock

from octop.infra.loops.models import BuilderReply, LoopDefinition


async def test_loop_api_owner_scope_versions_and_trial_gate(env_alice_bob_agent):
    c, srv, alice, bob, aid = env_alice_bob_agent
    body = {
        "name": "Proposal",
        "agent_id": aid,
        "objective": "Prepare a proposal",
        "instruction": "Review sources",
        "human_review": {"checkpoints": [{"name": "阶段检查", "expected_outcome": "检查当前成果"}]},
        "criterion": {"kind": "manual", "description": "User accepts"},
    }
    response = await c.get("/api/loops/capability", headers=alice)
    assert response.status_code == 200 and response.json()["protocol_version"] == 2
    response = await c.post("/api/loops", headers=alice, json=body)
    assert response.status_code == 201, response.text
    row = response.json()
    lid = row["loop_id"]
    assert row["status"] == "draft" and row["enabled"] is False
    assert (await c.get(f"/api/loops/{lid}", headers=bob)).status_code == 404
    assert (await c.get("/api/loops", headers=bob)).json() == []
    assert (await c.post(f"/api/loops/{lid}/enable", headers=alice)).status_code == 409
    assert (
        await c.put(f"/api/loops/{lid}", headers=alice, json={**body, "name": "Revised"})
    ).json()["version"] == 2
    srv.app_runtime.loop_service.draft = AsyncMock(return_value=LoopDefinition.model_validate(body))
    response = await c.post(
        "/api/loops/draft", headers=alice, json={"agent_id": aid, "text": "Prepare proposal"}
    )
    assert (
        response.status_code == 200 and len((await c.get("/api/loops", headers=alice)).json()) == 1
    )
    response = await c.post(
        "/api/loops/draft",
        headers=alice,
        json={"agent_id": aid, "text": "Make it concise", "current": body},
    )
    assert response.status_code == 200
    assert (
        srv.app_runtime.loop_service.draft.call_args.kwargs["current"].objective
        == body["objective"]
    )


async def test_loop_api_cannot_claim_another_expert(env_alice_bob_agent):
    c, _srv, _alice, bob, aid = env_alice_bob_agent
    body = {
        "name": "Other",
        "agent_id": aid,
        "objective": "x",
        "instruction": "x",
        "human_review": {"checkpoints": [{"name": "阶段检查", "expected_outcome": "检查当前成果"}]},
        "criterion": {"description": "accept"},
    }
    assert (await c.post("/api/loops", headers=bob, json=body)).status_code == 403


async def test_numbered_judgment_http_and_binding_contract(env_alice_bob_agent):
    c, srv, alice, bob, aid = env_alice_bob_agent
    svc = srv.app_runtime.loop_service
    uid = svc.repos.agent_repo.get(aid).user_id
    body = {
        "name": "Human review",
        "agent_id": aid,
        "objective": "Prepare a report",
        "instruction": "Research sources",
        "criterion": {"description": "Owner accepts"},
        "human_review": {
            "checkpoints": [{"name": "Review", "expected_outcome": "Source-backed draft"}]
        },
    }
    row = (await c.post("/api/loops", headers=alice, json=body)).json()
    lid = row["loop_id"]
    svc.repos.loop_repo.claim(lid, "api-round", trial=True)
    svc.repos.loop_repo.finish_round("api-round", "ok", {})
    svc.repos.loop_repo.open_judgment(
        lid,
        "api-judgment",
        "api-round",
        "stage",
        {"summary": "Draft ready", "evidence": [], "checks": []},
    )
    response = await c.get(f"/api/loops/{lid}/judgments", headers=alice)
    assert response.status_code == 200 and response.json()[0]["code"].startswith("H")
    decision = {"judgment_id": "api-judgment", "action": "continue"}
    assert (
        await c.post(f"/api/loops/{lid}/judgments", headers=bob, json=decision)
    ).status_code == 404
    assert (
        await c.post(
            f"/api/loops/{lid}/judgments", headers=alice, json={**decision, "action": "complete"}
        )
    ).status_code == 400
    assert (
        await c.post(f"/api/loops/{lid}/judgments", headers=alice, json=decision)
    ).status_code == 200
    assert (
        await c.post(f"/api/loops/{lid}/judgments", headers=alice, json=decision)
    ).status_code == 409
    svc.repos.user_repo.set_permissions(uid, ["channels"])
    svc.repos.channel_repo.create(
        channel_id="binding-api",
        agent_id=aid,
        user_id=uid,
        kind="telegram",
        name="Owner",
        config_json="{}",
    )
    # Native channel API uses id, not channel_id.
    channels = (await c.get(f"/api/agents/{aid}/channels", headers=alice)).json()
    assert any(channel["id"] == "binding-api" for channel in channels)
    response = await c.post(
        "/api/loops/channel-bindings",
        headers=alice,
        json={"agent_id": aid, "channel_id": "binding-api"},
    )
    assert response.status_code == 201 and response.json()["code"]
    bindings = (await c.get("/api/loops/channel-bindings", headers=alice)).json()
    assert "challenge_hash" not in bindings[0]
    assert (await c.get("/api/loops/channel-bindings", headers=bob)).json() == []
    docs = c._transport.app.openapi()
    assert docs["paths"]["/api/loops/{loop_id}/judgments"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]


async def test_visual_builder_contract_is_typed_and_read_only(env_alice_bob_agent):
    c, srv, alice, bob, aid = env_alice_bob_agent
    request = {"agent_id": aid, "messages": [{"role": "user", "content": "Build a proposal loop"}]}
    assert (await c.post("/api/loops/builder", headers=bob, json=request)).status_code == 403
    assert (await c.get("/api/loops/capability", headers=alice)).json()["visual_builder"] is True
    srv.app_runtime.loop_service.build = AsyncMock(
        return_value=BuilderReply(
            message="I will build the stages.",
            question="Which output?",
            options=["Brief", "Report"],
        )
    )
    response = await c.post("/api/loops/builder", headers=alice, json=request)
    assert response.status_code == 200 and response.json()["ready"] is False
    assert (await c.get("/api/loops", headers=alice)).json() == []
    schemas = c._transport.app.openapi()["components"]["schemas"]
    assert "proposal" in schemas["BuilderReply"]["properties"]
    assert "instruction" in schemas["HumanCheckpoint"]["properties"]


async def test_task_trash_http_is_owner_scoped_and_restore_does_not_enable(env_alice_bob_agent):
    c, _srv, alice, bob, aid = env_alice_bob_agent
    body = {
        "name": "Disposable draft",
        "agent_id": aid,
        "objective": "No execution",
        "instruction": "Read only",
        "criterion": {"description": "Owner accepts"},
        "human_review": {"checkpoints": [{"name": "Review", "expected_outcome": "Review"}]},
    }
    lid = (await c.post("/api/loops", headers=alice, json=body)).json()["loop_id"]
    assert (await c.get("/api/loops/capability", headers=alice)).json()["task_trash"]
    assert (await c.delete(f"/api/loops/{lid}", headers=bob)).status_code == 404
    response = await c.delete(f"/api/loops/{lid}", headers=alice)
    assert response.status_code == 200 and response.json()["status"] == "deleted"
    assert (await c.get("/api/loops", headers=alice)).json() == []
    assert (await c.get("/api/loops/deleted", headers=bob)).json() == []
    assert (await c.get("/api/loops/deleted", headers=alice)).json()[0]["loop_id"] == lid
    assert (await c.post(f"/api/loops/{lid}/control/restore", headers=bob)).status_code == 404
    restored = (await c.post(f"/api/loops/{lid}/control/restore", headers=alice)).json()
    assert restored["status"] == "stopped" and not restored["enabled"]


async def test_dedicated_executor_is_owner_scoped_idempotent_and_preserves_existing(
    env_alice_bob_agent,
):
    import asyncio

    c, srv, alice, bob, original = env_alice_bob_agent
    srv.services.agent_repo.update_config(original, default_model="openai:gpt-4o-mini")
    before = srv.services.agent_repo.get(original)
    replies = await asyncio.gather(
        *[c.post("/api/loops/executor", headers=alice) for _ in range(3)]
    )
    assert all(r.status_code == 200 for r in replies), [r.text for r in replies]
    aid = replies[0].json()["agent_id"]
    assert all(r.json()["agent_id"] == aid for r in replies)
    assert replies[0].json()["name"] == "半人马环"
    created = srv.services.agent_repo.get(aid)
    assert created.user_id == before.user_id
    assert created.template_name == "centaurloop"
    assert not created.is_shared
    assert not srv.services.proactive_care_config_repo.get(aid).enabled
    assert created.default_model == before.default_model
    assert srv.services.agent_repo.get(original) == before
    cfg = srv.app_runtime.agent_registry.get_config(aid)
    assert "execute" in cfg["tools_disabled"]
    assert "cronjob_create" in cfg["tools_disabled"]
    assert "searchfree_search" not in cfg["tools_disabled"]
    assert (await c.get("/api/loops", headers=alice)).json() == []
    other = await c.post("/api/loops/executor", headers=bob)
    assert other.status_code == 200, other.text
    assert other.json()["agent_id"] != aid
    # Existing expert configuration is never reset or silently re-enabled.
    srv.services.agent_repo.set_enabled(aid, False)
    assert (await c.post("/api/loops/executor", headers=alice)).status_code == 403


async def test_dedicated_executor_rejects_reserved_identity_collision(env_alice_bob_agent):
    c, srv, alice, bob, original = env_alice_bob_agent
    uid = srv.services.agent_repo.get(original).user_id
    from octop.infra.agents.manager import AgentCreateSpec

    other_uid = (await c.get("/api/auth/me", headers=bob)).json()["id"]
    await srv.app_runtime.agent_registry.create(
        AgentCreateSpec(agent_id=f"centaurloop-{uid}", name="Unrelated", user_id=other_uid)
    )
    response = await c.post("/api/loops/executor", headers=alice)
    assert response.status_code in {400, 403}
    assert srv.services.agent_repo.get(f"centaurloop-{uid}").user_id == other_uid


async def test_overview_reports_are_owner_scoped_ordered_and_read_only(env_alice_bob_agent):
    import json

    c, srv, alice, bob, aid = env_alice_bob_agent
    svc = srv.app_runtime.loop_service
    repo = svc.repos.loop_repo
    body = {
        "name": "Daily summary",
        "agent_id": aid,
        "objective": "Summarize",
        "instruction": "Read",
        "human_review": {"checkpoints": [{"name": "Review", "expected_outcome": "Check"}]},
        "criterion": {"description": "Owner accepts"},
    }
    row = (await c.post("/api/loops", headers=alice, json=body)).json()
    lid = row["loop_id"]
    deleted = (await c.post("/api/loops", headers=alice, json={**body, "name": "Deleted"})).json()[
        "loop_id"
    ]
    # Recorded rows only: this test never schedules or executes a task.
    with repo._db.transaction() as db:
        for i in range(9):
            report = {
                "title": f"Report {i}",
                "overview": "Summary",
                "highlights": ["a", "b", "c", "d"],
            }
            decision = {"summary": f"Legacy {i}"} if i == 5 else {"report": report}
            db.execute(
                "INSERT INTO loop_rounds(round_id,loop_id,version,number,status,trial,result_json,started_at,finished_at) VALUES(?,?,1,?,'ok',0,?,?,?)",
                (f"overview-{i}", lid, i + 1, json.dumps({"decision": decision}), 100 + i, 200 + i),
            )
        for rid, loop_id, status, trial in [
            ("trial", lid, "ok", 1),
            ("failed", lid, "error", 0),
            ("uncertain", lid, "interrupted", 0),
            ("trashed", deleted, "ok", 0),
        ]:
            db.execute(
                "INSERT INTO loop_rounds(round_id,loop_id,version,number,status,trial,started_at,finished_at) VALUES(?,?,1,1,?,?,900,999)",
                (rid, loop_id, status, trial),
            )
        db.execute("UPDATE loops SET status='deleted' WHERE loop_id=?", (deleted,))
    response = await c.get("/api/loops/overview", headers=alice)
    assert response.status_code == 200
    results = response.json()
    assert [r["round_id"] for r in results] == ["trial", *[f"overview-{i}" for i in [8, 7, 6, 5]]]
    assert results[0]["trial"] is True
    assert all(not r["trial"] for r in results[1:])
    assert results[1]["highlights"] == ["a", "b", "c"]
    assert results[4]["legacy_summary"] == "Legacy 5"
    assert (await c.get("/api/loops/overview", headers=bob)).json() == []
    assert (await c.get(f"/api/loops/{lid}/rounds/overview-4", headers=alice)).json()["number"] == 5
    assert (await c.get(f"/api/loops/{lid}/rounds/overview-4", headers=bob)).status_code == 404
    assert (
        await c.get(f"/api/loops/{deleted}/rounds/overview-4", headers=alice)
    ).status_code == 404
    assert (await c.get(f"/api/loops/{lid}", headers=alice)).json()["status"] == "draft"
    assert not svc._tasks
    with repo._db.transaction() as db:
        db.execute("UPDATE agents SET enabled=0 WHERE agent_id=?", (aid,))
    assert (await c.get("/api/loops/overview", headers=alice)).json() == []
    schemas = c._transport.app.openapi()
    assert "/api/loops/overview" in schemas["paths"]

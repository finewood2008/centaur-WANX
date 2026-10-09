"""Archived personal-model settings must not change the native memory runtime."""


async def test_archived_model_does_not_replace_native_memory(env_with_agent):
    client, server, auth, aid = env_with_agent
    registry = server.app_runtime.agent_registry
    row = registry.get_row(aid)
    repo = server.services.repos.self_model_repo
    repo.enable(aid, row.user_id, True, 0)
    assert repo.guarded(aid)

    await registry.reload(aid)
    config = registry.harness_manager.get_agent(aid).config
    assert config.memory_recall_inject_enabled is True
    assert not any(type(m).__name__ == "SelfModelMiddleware" for m in config.middleware)
    assert repo.settings(aid, row.user_id)["enabled"]  # preserved archival data

    assert (
        await client.get(f"/api/agents/{aid}/memory/self-model", headers=auth)
    ).status_code >= 400
    schema = client._octop_app.openapi()
    assert not any("/memory/self-model" in path for path in schema["paths"])
    assert any("/memory/" in path for path in schema["paths"])

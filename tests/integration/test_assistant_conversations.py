"""Conversation boundaries and immutable revisions, using synthetic content."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from octop.infra.agents.assistant_space import SpaceGrantStore
from tests.support.auth import create_user, resolve_user_id


async def setup(client: Any, admin: Any, name: str) -> tuple[Any, str, str]:
    auth = await create_user(client, admin, username=name)
    aid = (await client.post("/api/assistant/profile", headers=auth)).json()["agent_id"]
    tid = (await client.post(f"/api/agents/{aid}/threads", headers=auth)).json()["thread_id"]
    return auth, aid, tid


async def test_context_is_per_conversation_and_cas(env_with_provider: Any) -> None:
    client, server, admin = env_with_provider
    alice, aid, a = await setup(client, admin, "context-alice")
    bob, _, foreign = await setup(client, admin, "context-bob")
    b = (await client.post(f"/api/agents/{aid}/threads", headers=alice)).json()["thread_id"]
    url = f"/api/assistant/conversations/{a}"
    assert (await client.get(url)).status_code == 401
    assert (await client.get(url, headers=bob)).status_code == 404
    assert (
        await client.get(f"/api/assistant/conversations/{foreign}", headers=alice)
    ).status_code == 404
    context = {
        "space": {"enabled": True, "selection": {"mode": "all"}},
        "knowledge": {"enabled": False},
    }
    draft = await client.post("/api/assistant/context/validate", headers=alice, json=context)
    assert draft.status_code == 200, draft.text
    uid = await resolve_user_id(client, admin, "context-alice")
    store = SpaceGrantStore(server.paths.root, uid)
    assert not list(store.directory.glob("*.json"))  # validation never grants access
    saved = await client.patch(url, headers=alice, json={"revision": 0, "context": context})
    assert saved.status_code == 200, saved.text
    assert saved.json()["context"]["space"]["enabled"]
    assert not (await client.get(f"/api/assistant/conversations/{b}", headers=alice)).json()[
        "context"
    ]["space"]["enabled"]
    conflict = await client.patch(url, headers=alice, json={"revision": 0, "context": context})
    assert conflict.status_code == 409
    grant = await client.post(
        "/api/assistant/space-grant",
        headers=alice,
        json={"enabled": True, "selection": {"mode": "all"}, "thread_id": a},
    )
    assert grant.status_code == 200, grant.text
    gid = grant.json()["grant_id"]
    off = await client.patch(
        url,
        headers=alice,
        json={
            "revision": 1,
            "context": {"space": {"enabled": False}, "knowledge": {"enabled": False}},
        },
    )
    assert off.status_code == 200
    assert store.get(gid, active=False)["enabled"] is False
    assert (
        await client.post(
            "/api/assistant/space-grant",
            headers=alice,
            json={"enabled": True, "selection": {"mode": "all"}, "thread_id": a},
        )
    ).status_code == 403


async def test_recent_open_is_navigation_and_owner_scoped(env_with_provider: Any) -> None:
    client, _, admin = env_with_provider
    owner, aid, older = await setup(client, admin, "recent-owner")
    other, _, foreign = await setup(client, admin, "recent-other")
    newer = (await client.post(f"/api/agents/{aid}/threads", headers=owner)).json()["thread_id"]
    base = "/api/assistant/conversations"
    assert (await client.post(f"{base}/{newer}/open", headers=owner)).status_code == 200
    assert (await client.post(f"{base}/{older}/open", headers=owner)).status_code == 200
    await client.get(f"{base}/{newer}", headers=owner)  # background reads do not move it
    assert (await client.get(base, headers=owner)).json()["recent_conversation_id"] == older
    assert (await client.post(f"{base}/{foreign}/open", headers=owner)).status_code == 404
    assert (await client.get(base, headers=other)).json()["recent_conversation_id"] is None
    assert (await client.get(base, headers=owner)).json()["recent_conversation_id"] == older


async def test_versions_copy_only_request_prefix_and_retain_source(
    env_with_provider: Any, monkeypatch: Any
) -> None:
    client, server, admin = env_with_provider
    auth, aid, tid = await setup(client, admin, "version-owner")
    original = [
        HumanMessage(content="first", id="h1"),
        AIMessage(content="first answer", id="a1"),
        HumanMessage(content="second", id="h2"),
        AIMessage(
            content="", id="t-call", tool_calls=[{"id": "tool-1", "name": "search", "args": {}}]
        ),
        ToolMessage(content="synthetic evidence", tool_call_id="tool-1", id="tool-result"),
        AIMessage(content="second answer", id="a2"),
    ]
    checkpoints = {tid: list(original)}

    async def get(config: Any) -> Any:
        return SimpleNamespace(
            values={"messages": checkpoints.get(config["configurable"]["thread_id"], [])}
        )

    async def update(config: Any, values: Any) -> None:
        checkpoints[config["configurable"]["thread_id"]] = list(values["messages"])

    harness = SimpleNamespace(graph=SimpleNamespace(aget_state=get, aupdate_state=update))
    monkeypatch.setattr(server.app_runtime.agent_registry, "get_agent", lambda _: harness)
    url = f"/api/assistant/conversations/{tid}"
    created = await client.post(
        url + "/versions",
        headers=auth,
        json={"revision": 0, "source_thread_id": tid, "message_id": "a2", "kind": "regenerate"},
    )
    assert created.status_code == 200, created.text
    value = created.json()
    new = value["active_thread_id"]
    assert new != tid and checkpoints[new] == original[:2]
    assert value["prepared_content"] == [{"type": "text", "text": "second"}]
    assert checkpoints[tid] == original
    listing = (await client.get("/api/assistant/conversations", headers=auth)).json()["items"]
    assert [r["thread_id"] for r in listing] == [tid]
    previous = await client.patch(url, headers=auth, json={"revision": 1, "active_thread_id": tid})
    assert previous.status_code == 200
    edited = await client.post(
        url + "/versions",
        headers=auth,
        json={
            "revision": 2,
            "source_thread_id": tid,
            "message_id": "h1",
            "kind": "edit",
            "text": "revised first",
        },
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["prepared_content"] == [{"type": "text", "text": "revised first"}]
    assert checkpoints[tid] == original
    assert len(edited.json()["versions"]) == 3
    bad = await client.post(
        url + "/versions",
        headers=auth,
        json={
            "revision": 3,
            "source_thread_id": edited.json()["active_thread_id"],
            "message_id": "foreign",
            "kind": "regenerate",
        },
    )
    assert bad.status_code == 404


async def test_running_conversation_allows_off_but_not_expansion(
    env_with_provider: Any, monkeypatch: Any
) -> None:
    client, server, admin = env_with_provider
    auth, _, tid = await setup(client, admin, "busy-context")
    url = f"/api/assistant/conversations/{tid}"
    monkeypatch.setattr(server.app_runtime.gateway.ws_hub, "is_turn_active", lambda _: True)
    denied = await client.patch(
        url,
        headers=auth,
        json={
            "revision": 0,
            "context": {
                "space": {"enabled": True, "selection": {"mode": "all"}},
                "knowledge": {"enabled": False},
            },
        },
    )
    assert denied.status_code == 409
    off = await client.patch(
        url,
        headers=auth,
        json={
            "revision": 0,
            "context": {"space": {"enabled": False}, "knowledge": {"enabled": False}},
        },
    )
    assert off.status_code == 200


async def test_native_channel_conversations_are_listed_once_with_original_source(
    env_with_provider: Any,
) -> None:
    client, server, admin = env_with_provider
    owner, aid, desktop = await setup(client, admin, "source-owner")
    other, _, _foreign = await setup(client, admin, "source-other")
    uid = await resolve_user_id(client, admin, "source-owner")
    registry = server.app_runtime.gateway.thread_registry
    channels = {}
    for kind in ["weixin", "wecom", "feishu", "dingtalk"]:
        channels[kind] = registry.create_thread(
            agent_id=aid,
            user_id=uid,
            channel_type=kind,
            session_key=f"{aid}:{kind}:synthetic-owner:dm",
            title=f"Synthetic {kind}",
        )
    response = await client.get("/api/assistant/conversations", headers=owner)
    assert response.status_code == 200
    rows = response.json()["items"]
    by_id = {row["thread_id"]: row for row in rows}
    assert len(by_id) == len(rows) == 5
    assert by_id[desktop]["channel_type"] == "dashboard"
    for kind, tid in channels.items():
        assert by_id[tid]["channel_type"] == kind
        assert "session_key" not in by_id[tid]
        opened = await client.get(f"/api/assistant/conversations/{tid}", headers=owner)
        assert opened.status_code == 200
        assert opened.json()["active_thread_id"] == tid
        assert (
            await client.get(f"/api/assistant/conversations/{tid}", headers=other)
        ).status_code == 404
    foreign_list = (await client.get("/api/assistant/conversations", headers=other)).json()["items"]
    assert not set(channels.values()).intersection(row["thread_id"] for row in foreign_list)


async def test_deleted_im_history_recovers_only_new_turns_once(
    env_with_provider: Any, monkeypatch: Any
) -> None:
    import time

    from octop.infra.agents.assistant_history import PREFERENCE_KEY

    client, server, admin = env_with_provider
    auth, aid, _desktop = await setup(client, admin, "recover-im-owner")
    other, _other_agent, _other_thread = await setup(client, admin, "recover-im-other")
    uid = await resolve_user_id(client, admin, "recover-im-owner")
    registry = server.app_runtime.gateway.thread_registry
    source = await registry.reset(
        agent_id=aid,
        user_id=uid,
        channel_type="weixin",
        channel_subject_id="synthetic-owner",
        channel_id="synthetic-wechat",
    )
    deleted = int(time.time()) - 100
    original = [
        HumanMessage(
            content="Deleted old question",
            id="old-u",
            additional_kwargs={"checkpoint_ts": (deleted - 10) * 1000},
        ),
        AIMessage(
            content="Deleted old answer",
            id="old-a",
            additional_kwargs={"checkpoint_ts": (deleted - 9) * 1000},
        ),
        HumanMessage(
            content="New private question",
            id="new-u",
            additional_kwargs={"checkpoint_ts": (deleted + 1) * 1000},
        ),
        AIMessage(
            content="New private answer",
            id="new-a",
            additional_kwargs={"checkpoint_ts": (deleted + 2) * 1000},
        ),
    ]
    checkpoints = {source: list(original)}

    async def get(config: Any) -> Any:
        return SimpleNamespace(
            values={"messages": checkpoints.get(config["configurable"]["thread_id"], [])}
        )

    async def update(config: Any, values: Any) -> None:
        checkpoints[config["configurable"]["thread_id"]] = list(values["messages"])

    harness = SimpleNamespace(graph=SimpleNamespace(aget_state=get, aupdate_state=update))
    monkeypatch.setattr(server.app_runtime.agent_registry, "get_agent", lambda _: harness)
    registry.touch_last_active(source)
    key = f"thread:{aid}:{source}"
    server.services.user_repo.set_preference(
        uid,
        PREFERENCE_KEY,
        {"revision": 1, "entries": {key: {"status": "trash", "deleted_at": deleted}}},
    )
    rows = (await client.get("/api/assistant/conversations", headers=auth)).json()["items"]
    recovered = [r for r in rows if r["thread_id"].startswith("channel-recovered-")]
    assert len(recovered) == 1
    new = recovered[0]["thread_id"]
    assert recovered[0]["channel_type"] == "weixin"
    assert checkpoints[source] == original and checkpoints[new] == original[2:]
    old = registry.get_thread(source)
    assert old is not None
    assert registry.get_bound_thread_id(old.session_key) == new
    stored = (await client.get("/api/assistant/history", headers=auth)).json()["entries"]
    assert stored[f"thread:{source}"]["status"] == "trash"
    assert f"thread:{new}" not in stored
    again = (await client.get("/api/assistant/conversations", headers=auth)).json()["items"]
    assert len([r for r in again if r["thread_id"].startswith("channel-recovered-")]) == 1
    assert (
        await client.get(f"/api/assistant/conversations/{new}", headers=other)
    ).status_code == 404


async def test_new_im_turn_rotates_deleted_binding_but_preserves_archive(
    env_with_provider: Any,
) -> None:
    import time

    from octop.infra.agents.assistant_history import PREFERENCE_KEY, rotate_trashed_channel

    client, server, admin = env_with_provider
    _auth, aid, _desktop = await setup(client, admin, "rotate-im-owner")
    uid = await resolve_user_id(client, admin, "rotate-im-owner")
    registry = server.app_runtime.gateway.thread_registry
    source = await registry.reset(
        agent_id=aid, user_id=uid, channel_type="weixin", channel_subject_id="synthetic-owner"
    )
    sk = registry.get_thread(source).session_key
    server.services.user_repo.set_preference(
        uid,
        PREFERENCE_KEY,
        {
            "entries": {
                f"thread:{aid}:{source}": {"status": "trash", "deleted_at": int(time.time())}
            }
        },
    )
    await rotate_trashed_channel(
        registry,
        server.services.user_repo,
        agent_id=aid,
        user_id=uid,
        session_key=sk,
        channel_type="weixin",
    )
    new = registry.get_bound_thread_id(sk)
    assert new != source and registry.get_thread(source) is not None
    assert registry.get_thread(new).channel_type == "weixin"
    server.services.user_repo.set_preference(
        uid, PREFERENCE_KEY, {"entries": {f"thread:{aid}:{new}": {"status": "archived"}}}
    )
    await rotate_trashed_channel(
        registry,
        server.services.user_repo,
        agent_id=aid,
        user_id=uid,
        session_key=sk,
        channel_type="weixin",
    )
    assert registry.get_bound_thread_id(sk) == new


async def test_new_conversation_defaults_are_selection_only_and_scoped(
    env_with_provider: Any,
) -> None:
    client, server, admin = env_with_provider
    owner, _, tid = await setup(client, admin, "defaults-owner")
    other, _, _ = await setup(client, admin, "defaults-other")
    base = "/api/assistant/context/defaults?data_scope=team"
    context = {
        "space": {"enabled": True, "selection": {"mode": "all"}},
        "knowledge": {"enabled": False},
    }
    assert (await client.get(base)).status_code == 401
    result = await client.patch(base, headers=owner, json=context)
    assert result.status_code == 200, result.text
    assert (await client.get(base, headers=owner)).json()["context"]["space"]["enabled"]
    assert not (await client.get(base, headers=other)).json()["context"]["space"]["enabled"]
    assert not (await client.get(base.replace("team", "personal"), headers=owner)).json()[
        "context"
    ]["space"]["enabled"]
    # Opening an existing conversation cannot change the remembered new-draft template.
    existing = await client.get(f"/api/assistant/conversations/{tid}", headers=owner)
    assert not existing.json()["context"]["space"]["enabled"]
    await client.post(f"/api/assistant/conversations/{tid}/open", headers=owner)
    assert (await client.get(base, headers=owner)).json()["context"]["space"]["selection"] == {
        "mode": "all"
    }
    uid = await resolve_user_id(client, admin, "defaults-owner")
    assert not list(SpaceGrantStore(server.paths.root, uid).directory.glob("*.json"))
    invalid = {
        **context,
        "space": {
            "enabled": True,
            "selection": {"mode": "folder", "space_id": "personal", "folder_id": "../outside"},
        },
    }
    invalid_result = await client.patch(base, headers=owner, json=invalid)
    assert invalid_result.status_code == 200
    assert invalid_result.json()["validation_errors"][0]["source"] == "space"
    assert (await client.get(base, headers=owner)).json()["validation_errors"]
    off = {"space": {"enabled": False}, "knowledge": {"enabled": False}}
    assert (await client.patch(base, headers=owner, json=off)).status_code == 200
    assert not (await client.get(base, headers=owner)).json()["context"]["space"]["enabled"]

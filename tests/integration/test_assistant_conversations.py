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

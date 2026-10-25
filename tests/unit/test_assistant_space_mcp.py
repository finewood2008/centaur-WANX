"""Native owner-space reads, protocol handshake, and account isolation."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from octop.infra.agents import assistant_space_mcp
from octop.infra.agents.assistant_space import SpaceGrantStore
from octop.infra.agents.assistant_space_mcp import OwnerSpaceReader
from octop.infra.personal_space.service import SpaceError


def upload(
    space: Any, data: bytes, name: str, space_id: str = "personal", parent: str = ""
) -> dict[str, Any]:
    identity = uuid.uuid4().hex
    space.upload_create(parent, name, len(data), identity, space_id)
    if data:
        space.upload_chunk(identity, 0, data, hashlib.sha256(data).hexdigest())
    return space.upload_complete(identity, hashlib.sha256(data).hexdigest())


def test_reader_traverses_all_owned_spaces_but_rejects_other_owners_and_trash(
    tmp_path: Path,
) -> None:
    reader, other = OwnerSpaceReader(tmp_path, 1), OwnerSpaceReader(tmp_path, 2)
    folder = reader.space.mkdir("", "Synthetic notes")
    entry = upload(reader.space, b"Synthetic marker alpha", "notes.txt", parent=folder["id"])
    connection = reader.space.approve("synthetic-helper", "Synthetic Agent")
    extra = upload(reader.space, b"Synthetic marker beta", "agent.txt", connection["space_id"])
    assert len(reader.spaces()) == 2
    assert {item["id"] for item in reader.search(".txt")["items"]} == {entry["id"], extra["id"]}
    assert reader.search("marker alpha", content=True)["items"][0]["id"] == entry["id"]
    text = reader.document(extra["id"], 0, 9)
    assert text["text"] == "Synthetic" and text["next_offset"] == 9
    assert "blob" not in text["source"]
    assert "storage" not in reader.spaces()[0]
    with pytest.raises(SpaceError):
        other.document(entry["id"])
    with pytest.raises(SpaceError):
        reader.document("../other")
    with pytest.raises(SpaceError, match="SPACE_VERSION_CONFLICT"):
        reader.read(entry["id"], 0, 100, expected=99)
    reader.space.trash(folder["id"])
    with pytest.raises(SpaceError):
        reader.document(entry["id"])


async def test_stdio_mcp_exposes_only_read_tools_and_preserves_source(tmp_path: Path) -> None:
    reader = OwnerSpaceReader(tmp_path, 1)
    item = upload(reader.space, b"Synthetic MCP document", "synthetic.txt")
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
    )
    picture = upload(reader.space, png, "synthetic.png")
    grant = SpaceGrantStore(tmp_path, 1).create({"mode": "all"})
    params = StdioServerParameters(
        command=sys.executable,
        args=[
            "-P",
            "-m",
            "octop.infra.agents.assistant_space_mcp",
            "--home",
            str(tmp_path),
            "--user-id",
            "1",
            "--grant-id",
            grant["id"],
            "--locale",
            "en",
        ],
        env={"PYTHONPATH": str(Path(assistant_space_mcp.__file__).resolve().parents[3])},
    )
    async with (
        asyncio.timeout(30),
        stdio_client(params) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        tools = (await session.list_tools()).tools
        assert {tool.name for tool in tools} == {
            "space_list_spaces",
            "space_list",
            "space_search",
            "space_read_document",
            "space_read_bytes",
            "space_read_image",
        }
        assert all(tool.annotations and tool.annotations.readOnlyHint for tool in tools)
        result = await session.call_tool("space_read_document", {"item_id": item["id"]})
        assert not result.isError and result.structuredContent["text"] == "Synthetic MCP document"
        binary = await session.call_tool(
            "space_read_bytes", {"item_id": picture["id"], "offset": 0, "length": 8}
        )
        assert base64.b64decode(binary.structuredContent["data"]) == png[:8]
        assert binary.structuredContent["next_offset"] == 8
        image = await session.call_tool("space_read_image", {"item_id": picture["id"]})
        assert not image.isError
        block = next(block for block in image.content if block.type == "image")
        assert block.mimeType == "image/png" and base64.b64decode(block.data) == png
        denied = await session.call_tool("space_read_document", {"item_id": "invalid"})
        assert denied.isError
        SpaceGrantStore(tmp_path, 1).revoke(grant["id"])
        revoked = await session.call_tool("space_read_document", {"item_id": item["id"]})
        assert revoked.isError
    assert reader.space.metadata(item["id"]) == item


def test_folder_scope_rejects_parent_siblings_and_other_spaces(tmp_path: Path) -> None:
    owner = OwnerSpaceReader(tmp_path, 1)
    folder = owner.space.mkdir("", "Allowed")
    nested = owner.space.mkdir(folder["id"], "Nested")
    inside = upload(owner.space, b"inside", "inside.txt", parent=nested["id"])
    outside = upload(owner.space, b"outside", "outside.txt")
    grant = SpaceGrantStore(tmp_path, 1).create(
        {"mode": "folder", "space_id": "personal", "folder_id": folder["id"]}
    )
    scoped = OwnerSpaceReader(tmp_path, 1, grant["id"])
    assert scoped.spaces()[0]["root"] == folder["id"]
    assert scoped.document(inside["id"])["text"] == "inside"
    assert {r["id"] for r in scoped.search(".txt")["items"]} == {inside["id"]}
    assert scoped.listing()["root"] == folder["id"]
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        scoped.document(outside["id"])
    outside_folder = owner.space.mkdir("", "Sibling")
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        scoped.listing(parent=outside_folder["id"])
    owner.space.move(nested["id"], outside_folder["id"], "Moved outside grant")
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        scoped.document(inside["id"])
    SpaceGrantStore(tmp_path, 1).revoke(grant["id"])
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        scoped.spaces()


def test_single_space_selection_and_expiry(tmp_path: Path) -> None:
    owner = OwnerSpaceReader(tmp_path, 1)
    outside = upload(owner.space, b"personal", "personal.txt")
    linked = owner.space.approve("synthetic-helper", "Selected space")
    inside = upload(owner.space, b"selected", "selected.txt", linked["space_id"])
    store = SpaceGrantStore(tmp_path, 1)
    grant = store.create({"mode": "space", "space_id": linked["space_id"]})
    scoped = OwnerSpaceReader(tmp_path, 1, grant["id"])
    assert [row["id"] for row in scoped.spaces()] == [linked["space_id"]]
    assert scoped.document(inside["id"])["text"] == "selected"
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        scoped.document(outside["id"])
    grant["expires"] = 0
    store.save(grant)
    with pytest.raises(SpaceError, match="SPACE_ACCESS_DENIED"):
        scoped.document(inside["id"])

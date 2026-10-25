"""Read-only native space MCP, bound to one authenticated WANX owner at creation."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import tempfile
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP, Image
from mcp.types import ToolAnnotations

from octop.i18n import tr
from octop.infra.agents.assistant_space import SpaceGrantStore
from octop.infra.knowledge.parse import parse_document
from octop.infra.personal_space.service import CHUNK_SIZE, SpaceError
from octop.infra.personal_space.workspaces import Workspaces

_PUBLIC_FIELDS = {
    "id",
    "space_id",
    "parent",
    "name",
    "kind",
    "size",
    "modified",
    "digest",
    "version",
}
_DOCUMENTS = {
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
    ".xlsm",
    ".xls",
    ".csv",
    ".tsv",
    ".html",
    ".htm",
    ".json",
}


class OwnerSpaceReader:
    def __init__(self, home: Path, user_id: int, grant_id: str | None = None) -> None:
        if user_id < 1:
            raise ValueError("invalid owner")
        self.space = Workspaces(home / ".wanx-personal-space", user_id)
        self.grants = SpaceGrantStore(home, user_id)
        self.grant_id = grant_id

    def grant(self) -> dict[str, Any]:
        return self.grants.get(self.grant_id)["selection"] if self.grant_id else {"mode": "all"}

    def allow(self, row: dict[str, Any]) -> None:
        selection = self.grant()
        if selection["mode"] == "all":
            return
        if row["space_id"] != selection["space_id"]:
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        if selection["mode"] == "folder":
            cursor = row
            while cursor["id"] != selection["folder_id"]:
                if not cursor["parent"]:
                    raise SpaceError("SPACE_ACCESS_DENIED", 403)
                cursor = self.space.metadata(cursor["parent"])

    def metadata(self, item_id: str) -> dict[str, Any]:
        row = self.space.metadata(item_id)
        self.allow(row)
        return row

    @staticmethod
    def public(row: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in row.items() if key in _PUBLIC_FIELDS}

    def spaces(self) -> list[dict[str, Any]]:
        selection = self.grant()
        rows = [
            {key: row[key] for key in ("id", "name", "root", "bytes")}
            for row in self.space.spaces()
            if row.get("trashed") is None
            and (selection["mode"] == "all" or row["id"] == selection["space_id"])
        ]
        if selection["mode"] == "folder":
            folder = self.metadata(selection["folder_id"])
            rows = [{"id": selection["space_id"], "name": folder["name"], "root": folder["id"]}]
        self.grant()
        return rows

    def listing(self, space_id: str = "personal", parent: str = "") -> dict[str, Any]:
        selection = self.grant()
        if selection["mode"] != "all" and space_id != selection["space_id"]:
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        if selection["mode"] == "folder" and not parent:
            parent = selection["folder_id"]
        result = self.space.listing(parent, False, space_id)
        if selection["mode"] != "all" and result["space_id"] != selection["space_id"]:
            raise SpaceError("SPACE_ACCESS_DENIED", 403)
        if result["parent"]:
            self.metadata(result["parent"])
        if selection["mode"] == "folder":
            crumbs = result["breadcrumbs"]
            index = next(
                (i for i, row in enumerate(crumbs) if row["id"] == selection["folder_id"]),
                len(crumbs),
            )
            result["breadcrumbs"] = crumbs[index:]
            result["root"] = selection["folder_id"]
        self.grant()
        return {**result, "items": [self.public(row) for row in result["items"]]}

    def read(
        self, item_id: str, offset: int, length: int, expected: int = 0
    ) -> tuple[bytes, dict[str, Any]]:
        before = self.metadata(item_id)
        if expected and before["version"] != expected:
            raise SpaceError("SPACE_VERSION_CONFLICT", 409)
        data, row = self.space.read_chunk(item_id, offset, length)
        after = self.metadata(item_id)
        if before["version"] != row["version"] or row["version"] != after["version"]:
            raise SpaceError("SPACE_VERSION_CONFLICT", 409)
        return data, self.public(row)

    def document(self, item_id: str, offset: int = 0, length: int = 12000) -> dict[str, Any]:
        if offset < 0 or not 1 <= length <= 32000:
            raise SpaceError("SPACE_INVALID_RANGE")
        row = self.metadata(item_id)
        if row["kind"] != "file":
            raise SpaceError("SPACE_NOT_FILE")
        if row["size"] > 32 * 1024 * 1024:
            raise SpaceError("SPACE_TEXT_LIMIT")
        chunks = []
        for position in range(0, row["size"], CHUNK_SIZE):
            data, _ = self.read(item_id, position, CHUNK_SIZE, row["version"])
            chunks.append(data)
        data = b"".join(chunks)
        if hashlib.sha256(data).hexdigest() != row["digest"]:
            raise SpaceError("SPACE_VERSION_CONFLICT", 409)
        suffix = Path(row["name"]).suffix.lower()
        if suffix in _DOCUMENTS:
            with tempfile.TemporaryDirectory(prefix="wanx-space-read-") as directory:
                file = Path(directory) / ("document" + suffix)
                file.write_bytes(data)
                text = parse_document(file)
        else:
            try:
                text = data.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = data.decode("gb18030")
            if "\x00" in text:
                raise SpaceError("SPACE_NOT_TEXT")
        self.grant()
        return {
            "source": self.public(row),
            "text": text[offset : offset + length],
            "total_characters": len(text),
            "next_offset": offset + length if offset + length < len(text) else None,
            "requires_ocr": suffix == ".pdf" and not text.strip(),
        }

    def search(
        self,
        query: str,
        space_id: str = "",
        offset: int = 0,
        limit: int = 30,
        content: bool = False,
    ) -> dict[str, Any]:
        if not query.strip() or len(query) > 200 or offset < 0 or not 1 <= limit <= 100:
            raise SpaceError("SPACE_INVALID_RANGE")
        needle = query.casefold()
        spaces = [row for row in self.spaces() if not space_id or row["id"] == space_id]
        queue = [(row["id"], row["root"]) for row in spaces]
        matches = []
        scanned = 0
        while queue and scanned < 50000:
            sid, parent = queue.pop(0)
            for item in self.listing(sid, parent)["items"]:
                scanned += 1
                if item["kind"] == "folder":
                    queue.append((sid, item["id"]))
                hit = needle in item["name"].casefold()
                snippet = ""
                if (
                    content
                    and not hit
                    and item["kind"] == "file"
                    and item["size"] <= 2 * 1024 * 1024
                ):
                    try:
                        text = self.document(item["id"], length=32000)["text"]
                        index = text.casefold().find(needle)
                        hit = index >= 0
                        if hit:
                            snippet = text[max(0, index - 80) : index + 200]
                    except (SpaceError, UnicodeError, ValueError):
                        pass
                if hit:
                    matches.append({**item, **({"snippet": snippet} if snippet else {})})
        return {
            "items": matches[offset : offset + limit],
            "total": len(matches),
            "next_offset": offset + limit if offset + limit < len(matches) else None,
            "scan_limit_reached": bool(queue),
        }


def build_mcp(home: Path, user_id: int, grant_id: str, locale: str = "zh") -> FastMCP:
    reader = OwnerSpaceReader(home, user_id, grant_id)
    server = FastMCP(
        "wanx-assistant-space",
        instructions=tr("assistant.space_instructions", locale),
        log_level="WARNING",
    )
    readonly = ToolAnnotations(
        readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False
    )

    @server.tool(annotations=readonly, description=tr("assistant.space_tools.spaces", locale))
    async def space_list_spaces() -> list[dict[str, Any]]:
        """List all active native spaces owned by the current account, including personal and Agent spaces."""
        return await asyncio.to_thread(reader.spaces)

    @server.tool(annotations=readonly, description=tr("assistant.space_tools.list", locale))
    async def space_list(space_id: str = "personal", parent: str = "") -> dict[str, Any]:
        """List files and folders in an owned space. Use folder IDs to traverse every descendant."""
        return await asyncio.to_thread(reader.listing, space_id, parent)

    @server.tool(annotations=readonly, description=tr("assistant.space_tools.search", locale))
    async def space_search(
        query: str, space_id: str = "", offset: int = 0, limit: int = 30, content: bool = False
    ) -> dict[str, Any]:
        """Search names across all owned spaces. content=True also searches the first 32000 extracted characters of documents up to 2 MiB. Results include source IDs; offsets page the results."""
        return await asyncio.to_thread(reader.search, query, space_id, offset, limit, content)

    @server.tool(annotations=readonly, description=tr("assistant.space_tools.document", locale))
    async def space_read_document(
        item_id: str, offset: int = 0, length: int = 12000
    ) -> dict[str, Any]:
        """Read owned text, PDF, Word, Excel, PowerPoint or HTML content up to 32 MiB. Character offsets page long documents. Image-only PDFs report requires_ocr."""
        return await asyncio.to_thread(reader.document, item_id, offset, length)

    @server.tool(annotations=readonly, description=tr("assistant.space_tools.bytes", locale))
    async def space_read_bytes(
        item_id: str, offset: int = 0, length: int = 1048576, expected: int = 0
    ) -> dict[str, Any]:
        """Read any owned file as base64 bytes, in chunks up to 4 MiB. Pass its observed version as expected to reject concurrent changes."""
        data, row = await asyncio.to_thread(reader.read, item_id, offset, length, expected)
        return {
            "source": row,
            "encoding": "base64",
            "data": base64.b64encode(data).decode(),
            "next_offset": offset + len(data) if offset + len(data) < row["size"] else None,
        }

    @server.tool(annotations=readonly, description=tr("assistant.space_tools.image", locale))
    async def space_read_image(item_id: str) -> Image:
        """Read an owned PNG, JPEG, GIF or WebP image up to 8 MiB for a vision-capable model."""
        row = await asyncio.to_thread(reader.metadata, item_id)
        formats = {".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif", ".webp": "webp"}
        image_format = formats.get(Path(row["name"]).suffix.lower())
        if not image_format or row["size"] > 8 * 1024 * 1024:
            raise SpaceError("SPACE_IMAGE_LIMIT")
        chunks = [
            await asyncio.to_thread(reader.read, item_id, position, CHUNK_SIZE, row["version"])
            for position in range(0, row["size"], CHUNK_SIZE)
        ]
        await asyncio.to_thread(reader.grant)
        return Image(data=b"".join(data for data, _ in chunks), format=image_format)

    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--user-id", type=int, required=True)
    parser.add_argument("--grant-id", required=True)
    parser.add_argument("--locale", choices=["zh", "en"], default="zh")
    arguments = parser.parse_args()
    build_mcp(arguments.home, arguments.user_id, arguments.grant_id, arguments.locale).run()

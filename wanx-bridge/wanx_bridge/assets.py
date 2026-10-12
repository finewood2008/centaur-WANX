"""Bounded immutable dashboard assets, separate from the upstream implementation."""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import re
from importlib.metadata import PackageNotFoundError, distribution
from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import Response

MAX_ASSET_BYTES = 8 * 1024 * 1024
MAX_RELEASE_BYTES = 256 * 1024 * 1024
CONTENT_TYPES = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}
ASSET_PATH = re.compile(r"^/assets/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|otf)$")


def installed_dashboard() -> Path | None:
    try:
        return Path(distribution("octop").locate_file("octop/dashboard"))
    except PackageNotFoundError:
        return None


def accepts_gzip(value: str) -> bool:
    encodings = {}
    for item in value.lower().split(","):
        name, *parameters = item.strip().split(";")
        quality = 1.0
        for parameter in parameters:
            key, _, val = parameter.strip().partition("=")
            if key == "q":
                try:
                    quality = float(val)
                except ValueError:
                    quality = 0
        encodings[name] = quality
    return encodings.get("gzip", encodings.get("*", 0)) > 0


class DashboardAssets:
    def __init__(self, root: Path | None):
        self.root = root.resolve() if root else None
        self._catalog: dict[str, Any] | None = None
        self._lock = asyncio.Lock()
        self._reads = asyncio.Semaphore(2)

    def _read(self, path: str) -> bytes:
        if not self.root or not ASSET_PATH.fullmatch(path):
            raise ValueError("invalid asset")
        asset = self.root / path[1:]
        if asset.is_symlink() or asset.resolve().parent != self.root / "assets":
            raise ValueError("invalid asset")
        with asset.open("rb") as stream:
            data = stream.read(MAX_ASSET_BYTES + 1)
        if len(data) > MAX_ASSET_BYTES:
            raise ValueError("asset too large")
        return data

    def _build(self) -> dict[str, Any]:
        entries = {}
        total = 0
        if self.root and (self.root / "assets").is_dir():
            for asset in sorted((self.root / "assets").iterdir()):
                path = "/assets/" + asset.name
                if not ASSET_PATH.fullmatch(path) or not asset.is_file():
                    continue
                try:
                    data = self._read(path)
                except (OSError, ValueError):
                    continue
                total += len(data)
                if total > MAX_RELEASE_BYTES or len(entries) >= 2048:
                    raise ValueError("release too large")
                content_type = CONTENT_TYPES[asset.suffix]
                entries[path] = {
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "size": len(data),
                    "contentType": content_type,
                }
        release = hashlib.sha256(json.dumps(entries, sort_keys=True).encode()).hexdigest()
        return {"version": 1, "release": release, "assets": entries}

    async def manifest(self) -> dict[str, Any]:
        async with self._lock:
            if self._catalog is None:
                self._catalog = await asyncio.to_thread(self._build)
            return self._catalog

    async def response(self, request: Request, path: str) -> Response | None:
        if (
            request.method not in {"GET", "HEAD"}
            or request.url.query
            or request.headers.get("range")
        ):
            return None
        catalog = await self.manifest()
        entry = catalog["assets"].get(path)
        if not entry:
            return None
        compressed = accepts_gzip(request.headers.get("accept-encoding", ""))
        etag = '"' + entry["sha256"] + ("-gzip" if compressed else "") + '"'
        headers = {
            "etag": etag,
            "vary": "Accept-Encoding",
            "cache-control": "private, no-cache",
            "content-type": entry["contentType"],
            "x-content-type-options": "nosniff",
        }
        async with self._reads:
            try:
                data = await asyncio.to_thread(self._read, path)
            except (OSError, ValueError):
                return None
            # A running deployment must never attach an old digest to changed bytes.
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                self._catalog = None
                return None
            if compressed:
                data = await asyncio.to_thread(gzip.compress, data, compresslevel=5, mtime=0)
                headers["content-encoding"] = "gzip"
        validators = [
            v.strip().removeprefix("W/")
            for v in request.headers.get("if-none-match", "").split(",")
        ]
        if etag in validators or "*" in validators:
            return Response(status_code=304, headers=headers)
        headers["content-length"] = str(len(data))
        return Response(b"" if request.method == "HEAD" else data, headers=headers)

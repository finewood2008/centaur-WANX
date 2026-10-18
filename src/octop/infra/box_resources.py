"""Box-wide WANX file usage and public egress address; never expose file paths/content."""

from __future__ import annotations

import ipaddress
import os
import socket
import sqlite3
import stat
import sys
import threading
import time
from contextlib import closing
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx
import psutil

_SCAN_LOCK = threading.Lock()
_NETWORK_LOCK = threading.Lock()
_PUBLIC_IP_CACHE: tuple[float, dict[str, Any]] | None = None
_PUBLIC_IP_URLS = ("https://4.ipw.cn/", "https://api64.ipify.org/")


def component_roots() -> tuple[Path, ...]:
    """Installed WANX code and its dedicated Python environment (not global Python)."""
    roots = [Path(__file__).resolve().parents[1]]
    if sys.prefix != sys.base_prefix:
        roots.append(Path(sys.prefix).resolve())
    browsers = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")
    if browsers and browsers != "0":
        roots.append(Path(browsers).expanduser())
    # Deployment-owned components may live outside OCTOP_HOME (desktop apps,
    # sidecars, dedicated model stores). Only the host deployment sets this list.
    for raw in os.environ.get("OCTOP_COMPONENT_ROOTS", "").split(os.pathsep):
        if raw.strip():
            directory = Path(raw.strip()).expanduser()
            if directory.is_absolute():
                directory = directory.resolve()
                if directory != Path(directory.anchor):
                    roots.append(directory)
    return tuple(roots)


def _external_spaces(home: Path) -> tuple[list[Path], bool]:
    """Only registered object directories, never an entire user-selected volume."""
    roots: list[Path] = []
    complete = True
    base = home / ".wanx-personal-space"
    if not base.exists():
        return roots, complete
    try:
        databases = list(base.glob("*/index.sqlite3"))
    except OSError:
        return roots, False
    for database in databases:
        if database.is_symlink() or database.parent.is_symlink():
            complete = False
            continue
        try:
            with closing(
                sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=1)
            ) as db:
                tables = {
                    row[0]
                    for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
                }
                if "space_storage" in tables:
                    roots.extend(
                        Path(row[0]) for row in db.execute("SELECT directory FROM space_storage")
                    )
                if "object_locations" in tables:
                    roots.extend(
                        Path(row[0])
                        for row in db.execute("SELECT DISTINCT directory FROM object_locations")
                    )
        except (OSError, sqlite3.Error):
            complete = False
    return roots, complete


def file_usage(roots: tuple[Path, ...]) -> dict[str, Any]:
    """Sum file lengths once across overlapping roots and hard links. Do not follow links."""
    seen: set[tuple[int, int]] = set()
    total = 0
    complete = True
    pending = list(dict.fromkeys(roots))
    while pending:
        path = pending.pop()
        try:
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                if path in roots:
                    complete = False
                continue
            identity = (info.st_dev, info.st_ino)
            if identity in seen:
                continue
            seen.add(identity)
            if stat.S_ISDIR(info.st_mode):
                with os.scandir(path) as entries:
                    pending.extend(Path(entry.path) for entry in entries)
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
        except FileNotFoundError:
            # Files can be rotated/deleted during a scan; missing registered roots
            # make the measurement incomplete instead of falsely reporting zero.
            if path in roots:
                complete = False
        except OSError:
            complete = False
    return {
        "bytes": total,
        "complete": complete,
        "collectedAt": time.time(),
        "scope": "wanx-managed-files",
    }


@lru_cache(maxsize=4)
def _storage(home: Path, components: tuple[Path, ...], bucket: int) -> dict[str, Any]:
    external, complete = _external_spaces(home)
    result = file_usage((home, *components, *external))
    result["complete"] = result["complete"] and complete
    return result


def network_addresses(container: bool) -> dict[str, Any]:
    addresses: set[str] = set()
    try:
        stats = psutil.net_if_stats()
        for name, values in psutil.net_if_addrs().items():
            if name in stats and not stats[name].isup:
                continue
            for value in values:
                if value.family not in {socket.AF_INET, socket.AF_INET6}:
                    continue
                address = ipaddress.ip_address(value.address.split("%", 1)[0])
                if not (
                    address.is_loopback
                    or address.is_link_local
                    or address.is_unspecified
                    or address.is_multicast
                    or (address.version == 4 and address in ipaddress.ip_network("198.18.0.0/15"))
                ):
                    addresses.add(str(address))
    except (OSError, ValueError, psutil.Error):
        pass
    return {
        "addresses": sorted(
            addresses, key=lambda value: (ipaddress.ip_address(value).version, value)
        ),
        "scope": "container" if container else "host",
    }


def _fetch_public_ip() -> str | None:
    # Fixed HTTPS endpoints; no account, session, host name or file data is sent.
    # Disable environment HTTP proxies, verify TLS, and bound both wait and body.
    with httpx.Client(timeout=2.0, trust_env=False, follow_redirects=False) as client:
        for url in _PUBLIC_IP_URLS:
            try:
                deadline = time.monotonic() + 2.0
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    body = b""
                    for chunk in response.iter_bytes():
                        body += chunk
                        if len(body) > 128 or time.monotonic() > deadline:
                            raise ValueError("Invalid address response")
                    address = ipaddress.ip_address(body.decode("ascii").strip())
                    if address.is_global and not address.is_multicast:
                        return str(address)
            except (httpx.HTTPError, ValueError):
                continue
    return None


def public_address() -> dict[str, Any]:
    global _PUBLIC_IP_CACHE
    with _NETWORK_LOCK:
        if _PUBLIC_IP_CACHE and time.monotonic() < _PUBLIC_IP_CACHE[0]:
            return dict(_PUBLIC_IP_CACHE[1])
        address = _fetch_public_ip()
        result = {"publicIp": address, "publicIpCollectedAt": time.time()}
        # Cache successes five minutes, retry outages after thirty seconds.
        _PUBLIC_IP_CACHE = (time.monotonic() + (300 if address else 30), result)
        return dict(result)


def box_resources(home: Path, *, container: bool = False) -> dict[str, Any]:
    home = home.resolve()
    with _SCAN_LOCK:
        storage = dict(_storage(home, component_roots(), int(time.monotonic() // 30)))
    network = network_addresses(container)
    network.update(public_address())
    return {"wanxStorage": storage, "network": network}

"""Apply first-install WANX knowledge defaults through supported upstream APIs."""

from __future__ import annotations

import argparse
import asyncio
import stat
import sys
from pathlib import Path

import httpx

from .admin_client import AdminClient, BridgeUpstreamError
from .knowledge_bundle import DEFAULT_MODEL

PENDING_FILE = ".wanx-knowledge-pending"


async def _wait_ready(client: AdminClient, timeout: float) -> None:
    try:
        async with asyncio.timeout(timeout):
            while True:
                try:
                    health = client._json(await client._request("GET", "/api/health"))
                    if health.get("ok") is True and health.get("db") is True:
                        return
                except BridgeUpstreamError:
                    pass
                await asyncio.sleep(0.5)
    except TimeoutError:
        raise BridgeUpstreamError("WANX_KNOWLEDGE_UPSTREAM_TIMEOUT") from None


async def bootstrap(
    root: Path,
    base_url: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    health_timeout: float = 180,
) -> bool:
    """Consume a WANX first-install marker; absence never reads secrets or uses HTTP.

    The installer must only create this marker for a new data directory. Existing
    installations are not inferred from knowledge capability: an explicit disabled
    choice has the same public representation as a never-configured installation.
    """
    pending = root / PENDING_FILE
    try:
        info = pending.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(info.st_mode):
        raise BridgeUpstreamError("WANX_KNOWLEDGE_PENDING_INVALID")

    client = AdminClient(base_url, root / "credential.json", transport=transport)
    try:
        await _wait_ready(client, health_timeout)
        capability = await client.request("GET", "/api/knowledge-bases/capability")
        checks = capability.get("checks")
        if not isinstance(checks, dict) or checks.get("deps_available") is not True:
            raise BridgeUpstreamError("WANX_KNOWLEDGE_RUNTIME_MISSING")
        # Do not send OCR or indexing settings: those are independently managed.
        model = {"model": DEFAULT_MODEL}
        probe = await client.request("POST", "/api/knowledge-bases/onnx-test", json=model)
        if probe.get("ok") is not True:
            raise BridgeUpstreamError("WANX_KNOWLEDGE_MODEL_NOT_READY")
        await client.request(
            "PUT",
            "/api/knowledge-bases/feature",
            json={"enabled": True, "backend": "onnx", **model},
        )
        capability = await client.request("GET", "/api/knowledge-bases/capability")
        if not all(
            capability.get(key) is True for key in ("feature_enabled", "prerequisites_ok", "usable")
        ):
            raise BridgeUpstreamError("WANX_KNOWLEDGE_ENABLE_FAILED")
        pending.unlink()
        return True
    finally:
        await client.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--local-required", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.local_required:
            raise BridgeUpstreamError("WANX_KNOWLEDGE_OFFLINE_REQUIRED")
        enabled = asyncio.run(bootstrap(args.root, args.base_url))
    except BridgeUpstreamError as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception:
        # HTTP failures and malformed credentials can contain sensitive values.
        # Keep CLI output bounded to an error code, never an exception traceback.
        print("WANX_KNOWLEDGE_BOOTSTRAP_FAILED", file=sys.stderr)
        return 1
    print("WANX_KNOWLEDGE_ENABLED" if enabled else "WANX_KNOWLEDGE_UNCHANGED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

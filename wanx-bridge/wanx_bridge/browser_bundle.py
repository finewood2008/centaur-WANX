"""Verify the image's browser runtime without customer profiles or network access.

Chromium is installed by the image's locked Playwright dependency. Keep it
outside /data: replacing a WANX image must also replace its browser binary,
without a customer data mount hiding the executable or retaining an old one.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import tempfile
from pathlib import Path
from urllib.parse import quote

DEFAULT_CACHE_DIR = Path("/app/browser_runtime")
SMOKE_TEXT = "万象浏览器离线验证"
SMOKE_HTML = f"<!doctype html><meta charset=utf-8><h1 id=ready>{SMOKE_TEXT}</h1>"
PNG_HEADER = b"\x89PNG\r\n\x1a\n"


def _verify_executable(cache_dir: Path, executable: str | None, expected: str) -> None:
    """Reject missing, mounted-over, or unexpected browser binaries."""
    root = cache_dir.resolve()
    if root == Path("/data") or Path("/data") in root.parents:
        raise RuntimeError("BROWSER_RUNTIME_PATH_INVALID: browser assets must be outside /data")
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if not configured or Path(configured).resolve() != root:
        raise RuntimeError(
            "BROWSER_RUNTIME_PATH_INVALID: Playwright cache does not match the bundle"
        )
    if not executable:
        raise RuntimeError("BROWSER_RUNTIME_MISSING: Octop cannot discover Chromium")
    browser = Path(executable).resolve()
    if root not in browser.parents or browser != Path(expected).resolve():
        raise RuntimeError("BROWSER_RUNTIME_MISMATCH: Octop is not using the image's Chromium")
    if not browser.is_file() or not os.access(browser, os.X_OK):
        raise RuntimeError("BROWSER_RUNTIME_MISSING: bundled Chromium is not executable")


def _available_port() -> int:
    # This verifier runs in an isolated build step. Never use a customer's
    # configured profile or one of the usual persistent CDP ports.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


async def verify_browser(cache_dir: Path = DEFAULT_CACHE_DIR) -> dict[str, object]:
    """Launch with Octop's own launcher and render a local page as the runtime UID.

    The image invokes this with ``RUN --network=none`` after ``USER 10003``.
    A temporary profile prevents any writes to the persistent customer volume.
    Failure propagates, preventing image publication.
    """
    if hasattr(os, "getuid") and os.getuid() == 0:
        raise RuntimeError("BROWSER_RUNTIME_ROOT: verification must run as the service user")

    from octop_browser.cdp.launcher import find_chrome, launch_or_attach, terminate_browser
    from octop_browser.profile import Profile
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        _verify_executable(cache_dir, find_chrome(), playwright.chromium.executable_path)
        with tempfile.TemporaryDirectory(prefix="wanx-browser-verify-") as temporary:
            profile = Profile(
                name=Path(temporary).name,
                data_dir=Path(temporary) / "profile",
                cdp_port=_available_port(),
            )
            launched = False
            try:
                ws_url = await asyncio.wait_for(launch_or_attach(profile, headless=True), 45)
                launched = True
                browser = await playwright.chromium.connect_over_cdp(ws_url, timeout=15000)
                context = browser.contexts[0]
                page = await context.new_page()
                await page.goto(f"data:text/html;charset=utf-8,{quote(SMOKE_HTML)}", timeout=15000)
                if await page.locator("#ready").inner_text(timeout=10000) != SMOKE_TEXT:
                    raise RuntimeError("BROWSER_RUNTIME_RENDER_FAILED: inline page did not render")
                screenshot = await page.screenshot(type="png", timeout=15000)
                if len(screenshot) <= len(PNG_HEADER) or not screenshot.startswith(PNG_HEADER):
                    raise RuntimeError("BROWSER_RUNTIME_RENDER_FAILED: screenshot is not a PNG")
                return {
                    "ready": True,
                    "browser_version": browser.version,
                    "rendered": True,
                    "non_root": True,
                }
            finally:
                # The native launch can time out just as CDP becomes ready;
                # attempt a scoped close even when launch did not return.
                stopped = await terminate_browser(profile, cdp_host="127.0.0.1")
                if launched and not stopped:
                    raise RuntimeError(
                        "BROWSER_RUNTIME_CLEANUP_FAILED: verification browser did not stop"
                    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("verify",))
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE_DIR)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(verify_browser(args.cache_dir))))


if __name__ == "__main__":
    main()

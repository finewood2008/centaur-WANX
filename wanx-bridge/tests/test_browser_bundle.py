"""Build verification exercises native discovery, rendering, and failure cleanup."""

from __future__ import annotations

import os
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from wanx_bridge import browser_bundle as bundle

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Linux container build verification")


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    cache = tmp_path / "image-assets"
    executable = cache / "chromium-1234" / "chrome-linux" / "chrome"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"browser")
    executable.chmod(0o755)
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(cache))
    monkeypatch.setenv("HOME", str(tmp_path / "customer-data"))
    monkeypatch.setattr(bundle.os, "getuid", lambda: 10003)
    page = types.SimpleNamespace(
        goto=AsyncMock(),
        locator=lambda selector: types.SimpleNamespace(
            inner_text=AsyncMock(return_value=bundle.SMOKE_TEXT)
        ),
        screenshot=AsyncMock(return_value=bundle.PNG_HEADER + b"rendered"),
    )
    browser = types.SimpleNamespace(
        contexts=[types.SimpleNamespace(new_page=AsyncMock(return_value=page))],
        version="test-chromium",
    )
    playwright = types.SimpleNamespace(
        chromium=types.SimpleNamespace(
            executable_path=str(executable),
            connect_over_cdp=AsyncMock(return_value=browser),
        )
    )

    class PlaywrightContext:
        async def __aenter__(self):
            return playwright

        async def __aexit__(self, *args):
            return False

    launcher = types.SimpleNamespace(
        find_chrome=lambda: str(executable),
        launch_or_attach=AsyncMock(return_value="ws://127.0.0.1/devtools/browser/fixture"),
        terminate_browser=AsyncMock(return_value=True),
    )
    monkeypatch.setitem(sys.modules, "octop_browser.cdp.launcher", launcher)
    monkeypatch.setitem(
        sys.modules, "octop_browser.profile", types.SimpleNamespace(Profile=types.SimpleNamespace)
    )
    monkeypatch.setitem(
        sys.modules,
        "playwright.async_api",
        types.SimpleNamespace(async_playwright=PlaywrightContext),
    )
    return types.SimpleNamespace(
        cache=cache, executable=executable, launcher=launcher, page=page, playwright=playwright
    )


async def test_native_launcher_uses_temporary_profile_and_renders_offline_page(runtime):
    result = await bundle.verify_browser(runtime.cache)
    assert result == {
        "ready": True,
        "browser_version": "test-chromium",
        "rendered": True,
        "non_root": True,
    }
    profile = runtime.launcher.launch_or_attach.call_args.args[0]
    assert runtime.launcher.launch_or_attach.call_args.kwargs == {"headless": True}
    assert Path(os.environ["HOME"]) not in profile.data_dir.parents
    assert not profile.data_dir.parent.exists()
    assert 0 < profile.cdp_port < 65536
    url = runtime.page.goto.call_args.args[0]
    assert url.startswith("data:text/html;charset=utf-8,")
    assert "https://" not in url and "http://" not in url
    runtime.launcher.terminate_browser.assert_awaited_once_with(profile, cdp_host="127.0.0.1")


async def test_root_cannot_pass_service_user_check(runtime, monkeypatch):
    monkeypatch.setattr(bundle.os, "getuid", lambda: 0)
    with pytest.raises(RuntimeError, match="BROWSER_RUNTIME_ROOT"):
        await bundle.verify_browser(runtime.cache)
    runtime.launcher.launch_or_attach.assert_not_awaited()


@pytest.mark.parametrize("kind", ["missing", "not_executable", "other_version", "outside"])
async def test_wrong_or_missing_chromium_fails_before_launch(runtime, monkeypatch, kind):
    if kind == "missing":
        runtime.launcher.find_chrome = lambda: None
    elif kind == "not_executable":
        runtime.executable.chmod(0o644)
    elif kind == "other_version":
        runtime.playwright.chromium.executable_path = str(runtime.cache / "old-chrome")
    else:
        runtime.launcher.find_chrome = lambda: "/usr/bin/chromium"
    with pytest.raises(RuntimeError, match="BROWSER_RUNTIME_(MISSING|MISMATCH)"):
        await bundle.verify_browser(runtime.cache)
    runtime.launcher.launch_or_attach.assert_not_awaited()


async def test_customer_mount_must_not_contain_bundled_runtime(runtime, monkeypatch):
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", "/data/browsers")
    with pytest.raises(RuntimeError, match="outside /data"):
        await bundle.verify_browser(Path("/data/browsers"))
    runtime.launcher.launch_or_attach.assert_not_awaited()


async def test_home_cache_fallback_cannot_hide_missing_image_environment(runtime, monkeypatch):
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH")
    with pytest.raises(RuntimeError, match="BROWSER_RUNTIME_PATH_INVALID"):
        await bundle.verify_browser(runtime.cache)
    runtime.launcher.launch_or_attach.assert_not_awaited()


async def test_failed_page_render_closes_browser_and_fails(runtime):
    runtime.page.locator = lambda selector: types.SimpleNamespace(
        inner_text=AsyncMock(return_value="wrong document")
    )
    with pytest.raises(RuntimeError, match="BROWSER_RUNTIME_RENDER_FAILED"):
        await bundle.verify_browser(runtime.cache)
    runtime.launcher.terminate_browser.assert_awaited_once()


@pytest.mark.parametrize("screenshot", [b"", bundle.PNG_HEADER, b"not-a-png"])
async def test_invalid_screenshot_fails_and_cleans_up(runtime, screenshot):
    runtime.page.screenshot.return_value = screenshot
    with pytest.raises(RuntimeError, match="BROWSER_RUNTIME_RENDER_FAILED"):
        await bundle.verify_browser(runtime.cache)
    runtime.launcher.terminate_browser.assert_awaited_once()


async def test_cdp_failure_does_not_leave_launched_verification_browser(runtime):
    runtime.playwright.chromium.connect_over_cdp.side_effect = RuntimeError("CDP failed")
    with pytest.raises(RuntimeError, match="CDP failed"):
        await bundle.verify_browser(runtime.cache)
    runtime.launcher.terminate_browser.assert_awaited_once()


async def test_launcher_failure_blocks_build(runtime):
    runtime.launcher.launch_or_attach.side_effect = RuntimeError("missing shared library")
    with pytest.raises(RuntimeError, match="missing shared library"):
        await bundle.verify_browser(runtime.cache)
    runtime.playwright.chromium.connect_over_cdp.assert_not_awaited()
    runtime.launcher.terminate_browser.assert_awaited_once()


async def test_cleanup_failure_cannot_report_ready(runtime):
    runtime.launcher.terminate_browser.return_value = False
    with pytest.raises(RuntimeError, match="BROWSER_RUNTIME_CLEANUP_FAILED"):
        await bundle.verify_browser(runtime.cache)

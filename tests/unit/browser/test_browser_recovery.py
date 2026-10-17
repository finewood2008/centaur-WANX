"""A stuck old tab must not make reconnect destroy the browser profile."""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from octop_browser.cdp.client import CDPSessionError
from octop_browser.profile import Profile

from octop.infra.browser import recovery


@pytest.fixture
def profile(tmp_path: Path) -> Profile:
    value = Profile(name="user-7", data_dir=tmp_path, cdp_port=9237)
    value.save_target("existing-page")
    (tmp_path / "login-state").write_text("preserve")
    return value


@pytest.mark.asyncio
@pytest.mark.parametrize("domain", ["Page", "DOM", "Runtime"])
async def test_attach_timeout_recovers_without_deleting_existing_page_or_data(
    profile: Profile, monkeypatch: pytest.MonkeyPatch, domain: str
) -> None:
    create = AsyncMock(
        side_effect=[CDPSessionError(f"Timeout waiting for response to {domain}.enable"), "session"]
    )
    new_page = AsyncMock(return_value="recovery-page")
    close_page = AsyncMock()
    monkeypatch.setattr(recovery, "_new_blank_target", new_page)
    monkeypatch.setattr(recovery, "_close_target", close_page)

    result = await recovery.create_with_page_recovery(create, profile, host="localhost")

    assert result == "session"
    assert create.await_count == 2
    new_page.assert_awaited_once_with(profile, "localhost")
    close_page.assert_not_awaited()
    assert profile.load_target() == "recovery-page"
    assert (profile.data_dir / "login-state").read_text() == "preserve"


@pytest.mark.asyncio
async def test_successful_attach_never_changes_the_active_page(
    profile: Profile, monkeypatch: pytest.MonkeyPatch
) -> None:
    new_page = AsyncMock()
    monkeypatch.setattr(recovery, "_new_blank_target", new_page)
    assert (
        await recovery.create_with_page_recovery(
            AsyncMock(return_value="session"), profile, host="localhost"
        )
        == "session"
    )
    new_page.assert_not_awaited()
    assert profile.load_target() == "existing-page"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "direct"),
    [
        (CDPSessionError("Connection lost: closed"), False),
        (CDPSessionError("Timeout waiting for response to Page.navigate"), False),
        (CDPSessionError("Timeout waiting for response to Page.enable"), True),
    ],
)
async def test_other_failures_and_direct_cdp_do_not_open_a_page(
    profile: Profile, monkeypatch: pytest.MonkeyPatch, error: Exception, direct: bool
) -> None:
    new_page = AsyncMock()
    monkeypatch.setattr(recovery, "_new_blank_target", new_page)
    with pytest.raises(CDPSessionError):
        await recovery.create_with_page_recovery(
            AsyncMock(side_effect=error), profile, host="localhost", direct_cdp=direct
        )
    new_page.assert_not_awaited()
    assert profile.load_target() == "existing-page"


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [RuntimeError("still stuck"), asyncio.CancelledError()])
async def test_failed_or_cancelled_recovery_restores_binding_and_closes_only_its_own_page(
    profile: Profile, monkeypatch: pytest.MonkeyPatch, failure: BaseException
) -> None:
    create = AsyncMock(
        side_effect=[CDPSessionError("Timeout waiting for response to Page.enable"), failure]
    )
    close_page = AsyncMock()
    monkeypatch.setattr(recovery, "_new_blank_target", AsyncMock(return_value="recovery-page"))
    monkeypatch.setattr(recovery, "_close_target", close_page)
    with pytest.raises(type(failure)):
        await recovery.create_with_page_recovery(create, profile, host="localhost")
    assert create.await_count == 2
    assert profile.load_target() == "existing-page"
    close_page.assert_awaited_once_with(profile, "localhost", "recovery-page")
    assert (profile.data_dir / "login-state").read_text() == "preserve"

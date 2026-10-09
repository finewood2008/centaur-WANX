"""The CentaurAI-WANX fork must not install upstream packages over its branding."""

from unittest.mock import Mock

import pytest
from click.testing import CliRunner

from octop.api.routers import update
from octop.cli.main import cli
from octop.infra.errors import OctopError
from octop.infra.setup import self_update


@pytest.mark.asyncio
async def test_wanx_update_status_never_queries_upstream(monkeypatch: pytest.MonkeyPatch) -> None:
    probe = Mock(side_effect=AssertionError("CentaurAI-WANX has no upstream update feed"))
    monkeypatch.setattr(update, "fetch_pypi_info", probe)
    for status in (
        await update.update_status(_=None, server=None),
        await update.check_for_updates(_=None, server=None),
    ):
        assert status["manual_updates_only"] is True
        assert status["has_update"] is False
        assert status["latest_version"] is None
        assert status["release_notes"] is None
        assert "codeup.aliyun.com" in status["source"]
    probe.assert_not_called()


@pytest.mark.asyncio
async def test_wanx_upgrade_rejected_before_any_install(monkeypatch: pytest.MonkeyPatch) -> None:
    install = Mock(side_effect=AssertionError("must not start an installer"))
    monkeypatch.setattr(self_update, "stash_console_scripts", install)
    result = self_update.run_upgrade(version="99.0.0")
    assert result.success is False
    assert "CentaurAI-WANX" in (result.error or "")
    with pytest.raises(OctopError, match="CentaurAI-WANX"):
        await update.trigger_upgrade(body=update.UpgradeBody(version="99.0.0"), server=None, _=None)
    install.assert_not_called()


def test_wanx_cli_update_uses_project_releases(monkeypatch: pytest.MonkeyPatch) -> None:
    probe = Mock(side_effect=AssertionError("must not probe PyPI"))
    monkeypatch.setattr("octop.cli.commands.update.fetch_pypi_info", probe)
    result = CliRunner().invoke(cli, ["update", "--yes"])
    assert result.exit_code == 0
    assert "CentaurAI-WANX" in result.output
    assert "codeup.aliyun.com" in result.output
    probe.assert_not_called()

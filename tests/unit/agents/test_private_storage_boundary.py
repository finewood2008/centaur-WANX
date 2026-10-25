from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from langgraph.prebuilt.tool_node import ToolCallRequest

from octop.infra.agents.middleware import private_storage


def test_live_actor_role_and_path_authority(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "service"))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    user = SimpleNamespace(id=2, role="user", disabled=False)
    guard = private_storage.PrivateStorageBoundary(SimpleNamespace(get=lambda _: user), workspace)
    monkeypatch.setattr(private_storage, "configurable_user_id", lambda: 2)
    handler = Mock(return_value="allowed")

    def call(name: str, args: dict[str, str]) -> object:
        request = ToolCallRequest(
            tool_call={"name": name, "args": args, "id": "test"}, tool=None, state={}, runtime=None
        )  # type: ignore[arg-type]
        return guard.wrap_tool_call(request, handler)

    assert call("read_file", {"path": "own.md"}) == "allowed"
    assert call("glob", {"path": ".", "pattern": "**/*.md"}) == "allowed"
    assert getattr(call("glob", {"pattern": "../../knowledge/**"}), "status", None) == "error"
    assert (
        getattr(
            call("browser_use", {"action": "navigate", "target_url": "file:///private/report"}),
            "status",
            None,
        )
        == "error"
    )
    for name in ["execute", "execute_shell_command", "acp_runner"]:
        assert getattr(call(name, {"command": "arbitrary host command"}), "status", None) == "error"
    assert getattr(call("grep", {"path": str(tmp_path)}), "status", None) == "error"
    assert (
        getattr(
            call("read_file", {"path": str(tmp_path / "service/knowledge/report.md")}),
            "status",
            None,
        )
        == "error"
    )
    user.role = "admin"
    assert call("execute", {"command": "admin host command"}) == "allowed"
    assert (
        getattr(
            call("read_file", {"path": str(tmp_path / "service/knowledge/report.md")}),
            "status",
            None,
        )
        == "error"
    )
    user.role = "user"
    assert getattr(call("execute", {"command": "old admin session"}), "status", None) == "error"
    user.disabled = True
    assert getattr(call("read_file", {"path": "own.md"}), "status", None) == "error"

"""Resolve real launch configuration without exposing credentials in diagnostics."""

import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from wanx_studio.codex_config import resolve_runtime, runtime_config
from wanx_studio.contracts import StudioError


@pytest.fixture
def managed(tmp_path):
    root = tmp_path / "component"
    binary = root / "node_modules" / ".bin" / ("codex.cmd" if os.name == "nt" else "codex")
    binary.parent.mkdir(parents=True)
    binary.write_text("synthetic executable")
    binary.chmod(0o700)
    provider = {
        "model": "gpt-test",
        "base_url": "http://127.0.0.1:8123/model-providers/qeetoken/v1",
        "api_key": "private-local-proxy-token",
        "reasoning": True,
        "reasoning_effort": "low",
    }
    service = SimpleNamespace(
        project_root=root,
        store=SimpleNamespace(root=tmp_path / "private-studio-state"),
        model=SimpleNamespace(device_managed=True, codex_provider=lambda: provider),
    )
    return service, binary, provider


@pytest.fixture
def host(tmp_path, monkeypatch):
    binary = tmp_path / "bin" / "codex"
    monkeypatch.setattr("shutil.which", lambda name: str(binary))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    return tmp_path / ".codex", binary


def test_managed_resolution_reports_source_without_private_launch_values(managed, monkeypatch):
    service, binary, provider = managed

    def forbidden(*args):
        raise AssertionError("managed runtime must not use ambient login")

    monkeypatch.setattr(Path, "home", forbidden)
    monkeypatch.setattr("shutil.which", forbidden)
    env, summary = resolve_runtime(service=service, owner="wanx:7")
    assert summary == {
        "configurationSource": "device-provider",
        "binarySource": "bundled",
        "model": "gpt-test",
        "reasoningEffort": "low",
    }
    assert env["WANX_CODEX_PATH"] == str(binary)
    assert env["WANX_CODEX_PROXY_TOKEN"] == provider["api_key"]
    assert Path(env["CODEX_HOME"]).is_dir()
    assert env["WANX_CODEX_CONFIG_STAMP"] == "0"
    assert not (Path(env["CODEX_HOME"]) / "auth.json").exists()
    report = json.dumps(summary)
    for secret in (provider["api_key"], provider["base_url"], str(binary), env["CODEX_HOME"]):
        assert secret not in report
    assert runtime_config(service=service, owner="wanx:7") == env


@pytest.mark.parametrize(
    "missing,code",
    [
        ("owner", "CODEX_OWNER_REQUIRED"),
        ("provider", "CODEX_DEVICE_PROVIDER_UNAVAILABLE"),
        ("binary", "CODEX_BUNDLE_MISSING"),
    ],
)
def test_managed_missing_dependencies_have_distinct_codes_and_legacy_none(managed, missing, code):
    service, binary, _ = managed
    owner = "wanx:7"
    if missing == "owner":
        owner = None
    elif missing == "provider":
        service.model.codex_provider = lambda: None
    else:
        binary.unlink()
    with pytest.raises(StudioError) as caught:
        resolve_runtime(service=service, owner=owner)
    assert caught.value.code == code
    assert caught.value.status == 409
    assert runtime_config(service=service, owner=owner) is None


def test_host_missing_binary_has_its_own_code(monkeypatch):
    monkeypatch.setattr("shutil.which", lambda _: None)
    with pytest.raises(StudioError, match="^CODEX_HOST_CLI_MISSING$"):
        resolve_runtime()
    assert runtime_config() is None


def test_host_without_config_keeps_default_model_and_creates_no_login_state(host):
    state, binary = host
    env, summary = resolve_runtime()
    assert summary == {
        "configurationSource": "host",
        "binarySource": "path",
        "model": None,
        "reasoningEffort": "medium",
    }
    assert env["WANX_CODEX_PATH"] == str(binary)
    assert "CODEX_HOME" not in env and "WANX_CODEX_PROXY_TOKEN" not in env
    assert not state.exists()


def test_host_summary_reads_only_model_and_never_includes_ambient_mcp_secrets(host):
    state, _ = host
    state.mkdir()
    (state / "config.toml").write_text(
        'model = "gpt-host"\nmodel_reasoning_effort = "xhigh"\n'
        '[mcp_servers.private_tool]\ncommand = "secret-command"\n'
        '[mcp_servers.private_tool.env]\nKEY = "private-config-secret"\n'
    )
    env, summary = resolve_runtime()
    assert summary["model"] == "gpt-host"
    # Both native workers explicitly use medium for the existing host path.
    assert summary["reasoningEffort"] == "medium"
    assert json.loads(env["WANX_CODEX_CONFIG"])["mcp_servers"] == {
        "private_tool": {"enabled": False}
    }
    assert "private-config-secret" not in json.dumps((env, summary))
    assert "secret-command" not in json.dumps((env, summary))


@pytest.mark.parametrize(
    "contents",
    [
        b'model = "private-invalid-secret',
        b"\xff",
        b'mcp_servers = "private-invalid-secret"',
        b'mcp_servers = ["private-invalid-secret"]',
        b'[mcp_servers]\nprivate_tool = "private-invalid-secret"',
        b"model = 42",
        b"model_provider = []",
        b"model_reasoning_effort = false",
        b"profile = 42",
    ],
)
def test_invalid_config_has_a_fixed_error_without_original_values(host, contents):
    state, _ = host
    state.mkdir()
    (state / "config.toml").write_bytes(contents)
    for read in (resolve_runtime, runtime_config):
        with pytest.raises(StudioError) as caught:
            read()
        assert caught.value.code == "CODEX_CONFIG_INVALID"
        assert caught.value.status == 409
        assert str(caught.value) == "CODEX_CONFIG_INVALID"
        assert "private-invalid-secret" not in repr(caught.value)


@pytest.mark.parametrize("operation", ["stat", "read_text"])
def test_unreadable_config_does_not_silently_use_defaults(host, monkeypatch, operation):
    state, _ = host
    state.mkdir()
    config = state / "config.toml"
    config.write_text('model = "gpt-host"')
    original = getattr(Path, operation)

    def denied(path, *args, **kwargs):
        if path == config:
            raise PermissionError("private filesystem diagnostic")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, operation, denied)
    with pytest.raises(StudioError) as caught:
        resolve_runtime()
    assert caught.value.code == "CODEX_STATE_UNAVAILABLE"
    assert caught.value.status == 503
    assert str(caught.value) == "CODEX_STATE_UNAVAILABLE"


def test_managed_state_creation_failure_is_sanitized(managed, monkeypatch):
    service, _, _ = managed
    state = service.store.root / "codex" / hashlib.sha256(b"wanx:7").hexdigest()
    original = Path.mkdir

    def denied(path, *args, **kwargs):
        if path == state:
            raise OSError("private storage path and credential diagnostic")
        return original(path, *args, **kwargs)

    monkeypatch.setattr(Path, "mkdir", denied)
    with pytest.raises(StudioError) as caught:
        resolve_runtime(service=service, owner="wanx:7")
    assert caught.value.code == "CODEX_STATE_UNAVAILABLE"
    assert caught.value.status == 503
    assert str(caught.value) == "CODEX_STATE_UNAVAILABLE"


def test_managed_config_failure_never_falls_back_to_host(managed, monkeypatch):
    service, _, _ = managed
    env, _ = resolve_runtime(service=service, owner="wanx:7")
    (Path(env["CODEX_HOME"]) / "config.toml").write_text("mcp_servers = 17")
    monkeypatch.setattr("shutil.which", lambda _: "personal-codex")
    with pytest.raises(StudioError, match="^CODEX_CONFIG_INVALID$"):
        runtime_config(service=service, owner="wanx:7")

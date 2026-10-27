"""Host preflight diagnoses the actual private configuration without model calls."""

import asyncio
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from wanx_studio.contracts import StudioError
from wanx_studio.native_codex import NativeCodex
from wanx_studio.runner import Runner


@pytest.fixture
def probe(monkeypatch, tmp_path):
    calls, stopped = [], []
    config = {"WANX_CODEX_PATH": "bundled-codex", "WANX_CODEX_PROXY_TOKEN": "private-token"}
    summary = {
        "configurationSource": "device-provider",
        "binarySource": "bundled",
        "model": "gpt-synthetic",
        "reasoningEffort": None,
    }
    monkeypatch.setattr("wanx_studio.runner.resolve_runtime", lambda *args: (config, summary))
    monkeypatch.setattr("wanx_studio.runner.shutil.which", lambda name: "node")

    class Process:
        returncode = 0

        async def communicate(self):
            return json.dumps(
                {
                    "available": True,
                    "modelCalls": 0,
                    "cliVersion": "0.160.1",
                    "nodeVersion": "22.14.0",
                }
            ).encode(), b""

    process = Process()

    async def spawn(*args, **kwargs):
        calls.append((args, kwargs))
        return process

    async def stop(value, **kwargs):
        assert kwargs == {"grace_seconds": 3}
        stopped.append(value)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    service = SimpleNamespace(project_root=tmp_path, native_codex=SimpleNamespace(stop=stop))
    return SimpleNamespace(
        runner=Runner(service),
        process=process,
        calls=calls,
        stopped=stopped,
        config=config,
        summary=summary,
    )


async def test_preflight_reports_actual_config_and_versions_without_private_environment(probe):
    result = await probe.runner.preflight(owner="owner")
    assert result["available"] and result["check"] == "protocol"
    assert result["configuration"] == probe.summary
    assert result["cliVersion"] == "0.160.1" and result["nodeVersion"] == "22.14.0"
    assert result["modelCalls"] == 0
    assert probe.calls[0][1]["env"]["WANX_CODEX_PROXY_TOKEN"] == "private-token"
    assert "private-token" not in json.dumps(result)
    assert probe.stopped == [probe.process]
    assert await probe.runner.preflight(owner="owner") == result
    assert len(probe.calls) == 1
    await probe.runner.preflight(fresh=True, owner="owner")
    assert len(probe.calls) == 2


async def test_turn_readiness_only_checks_configuration_and_never_claims_protocol_probe(probe):
    result = await probe.runner.preflight(for_turn=True, owner="owner")
    assert result["available"] and result["check"] == "configuration"
    assert result["modelCalls"] == 0 and "code" not in result
    assert not probe.calls and not probe.stopped


@pytest.mark.parametrize(
    "code",
    [
        "CODEX_OWNER_REQUIRED",
        "CODEX_DEVICE_PROVIDER_UNAVAILABLE",
        "CODEX_BUNDLE_MISSING",
        "CODEX_HOST_CLI_MISSING",
        "CODEX_CONFIG_INVALID",
        "CODEX_STATE_UNAVAILABLE",
    ],
)
async def test_configuration_failure_is_structured_without_starting_a_process(
    probe, monkeypatch, code
):
    def unavailable(*args):
        raise StudioError(code, 409)

    monkeypatch.setattr("wanx_studio.runner.resolve_runtime", unavailable)
    result = await probe.runner.preflight(owner="owner")
    assert result == {
        "available": False,
        "executor": "Codex",
        "transport": "app-server",
        "modelCalls": 0,
        "check": "protocol",
        "code": code,
    }
    assert not probe.calls


async def test_missing_node_is_diagnosed_before_spawn(probe, monkeypatch):
    monkeypatch.setattr("wanx_studio.runner.shutil.which", lambda name: None)
    result = await probe.runner.preflight(owner="owner")
    assert not result["available"] and result["code"] == "CODEX_NODE_MISSING"
    assert not probe.calls


@pytest.mark.parametrize(
    "error,code",
    [
        (FileNotFoundError("secret path"), "CODEX_NODE_MISSING"),
        (PermissionError("secret path"), "PREFLIGHT_FAILED"),
    ],
)
async def test_spawn_failure_never_exposes_exception_detail(probe, monkeypatch, error, code):
    async def spawn(*args, **kwargs):
        raise error

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    result = await probe.runner.preflight(owner="owner")
    assert not result["available"] and result["code"] == code
    assert "secret" not in json.dumps(result) and not probe.stopped


@pytest.mark.parametrize(
    "body,returncode",
    [
        (b"secret invalid JSON", 0),
        (b'{"available":true,"modelCalls":1}', 0),
        (b'{"available":true,"modelCalls":0}', 1),
    ],
)
async def test_invalid_or_failed_probe_cannot_report_available(probe, body, returncode):
    async def communicate():
        return body, b"private stderr"

    probe.process.communicate = communicate
    probe.process.returncode = returncode
    result = await probe.runner.preflight(owner="owner")
    assert not result["available"] and result["code"] == "PREFLIGHT_FAILED"
    assert "secret" not in json.dumps(result) and "private" not in json.dumps(result)
    assert probe.stopped == [probe.process]


async def test_probe_timeout_reaps_process_and_reports_fixed_code(probe):
    async def communicate():
        raise asyncio.TimeoutError("private diagnostic")

    probe.process.communicate = communicate
    result = await probe.runner.preflight(owner="owner")
    assert not result["available"] and result["code"] == "CODEX_PROBE_TIMEOUT"
    assert "private" not in json.dumps(result)
    assert probe.stopped == [probe.process]


async def test_cleanup_failure_does_not_report_a_successful_probe(probe):
    async def stop(value, **kwargs):
        raise RuntimeError("private cleanup diagnostic")

    probe.runner.svc.native_codex.stop = stop
    result = await probe.runner.preflight(owner="owner")
    assert not result["available"] and result["code"] == "CODEX_PROBE_CLEANUP_FAILED"
    assert "private" not in json.dumps(result)


@pytest.mark.skipif(os.name != "posix", reason="Codex app-server uses Unix sockets")
async def test_real_managed_preflight_uses_bundled_cli_without_model_requests(tmp_path):
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "node_modules/.bin/codex").is_file():
        pytest.skip("Install the pinned Builder Node dependencies for the real probe")
    provider = {
        "model": "gpt-synthetic",
        "base_url": "http://127.0.0.1:9/v1",
        "api_key": "synthetic-local-token",
        "reasoning": False,
        "reasoning_effort": None,
    }
    service = SimpleNamespace(
        project_root=root,
        store=SimpleNamespace(root=tmp_path),
        model=SimpleNamespace(device_managed=True, codex_provider=lambda: provider),
    )
    service.native_codex = NativeCodex(service)
    try:
        result = await Runner(service).preflight(owner="synthetic-owner")
        assert result["available"], result
        assert result["configuration"]["configurationSource"] == "device-provider"
        assert result["configuration"]["model"] == "gpt-synthetic"
        assert (
            result["cliVersion"]
            == json.loads((root / "package.json").read_text())["dependencies"]["@openai/codex"]
        )
        assert result["check"] == "protocol" and result["modelCalls"] == 0
        assert "synthetic-local-token" not in json.dumps(result)
        assert not list(tmp_path.rglob("auth.json"))
    finally:
        await service.native_codex.close()

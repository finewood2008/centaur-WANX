"""Private listener, durable identity and dual-listener supervision contracts."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from wanx_bridge import __main__ as runtime
from wanx_bridge.config import PlatformConfig
from wanx_bridge.upstream import BridgeUpstreamError


@pytest.fixture
def platform(tmp_path):
    return PlatformConfig(
        "box-test",
        "nexusaos-platform",
        Ed25519PrivateKey.generate(),
        Ed25519PrivateKey.generate().public_key(),
        tmp_path / "state",
    )


@pytest.fixture
def settings(monkeypatch):
    for name in os.environ:
        if name.startswith("WANX_BRIDGE_"):
            monkeypatch.delenv(name)
    return runtime.RuntimeConfig.from_env()


def test_runtime_defaults_and_ipv6(settings, monkeypatch):
    assert settings.issuer == "http://127.0.0.1:18089"
    assert settings.upstream_url == "http://127.0.0.1:18088"
    assert settings.bind_port == 8088
    assert settings.bind_host == "127.0.0.1"
    assert settings.credentials_file == Path("/data/.octop/credential.json")
    monkeypatch.setenv("WANX_BRIDGE_OIDC_HOST", "::1")
    assert runtime.RuntimeConfig.from_env().issuer == "http://[::1]:18089"


@pytest.mark.parametrize(
    "name,value",
    [
        ("WANX_BRIDGE_OIDC_HOST", "0.0.0.0"),
        ("WANX_BRIDGE_OIDC_HOST", "localhost"),
        ("WANX_BRIDGE_OIDC_PORT", "0"),
        ("WANX_BRIDGE_PORT", "18089"),
        ("WANX_BRIDGE_PORT", "18088"),
        ("WANX_BRIDGE_OIDC_PORT", "18088"),
        ("WANX_BRIDGE_PORT", "not-a-port"),
        ("WANX_BRIDGE_UPSTREAM_URL", "http://192.168.0.102:8088"),
    ],
)
def test_invalid_runtime_configuration(settings, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(runtime.RuntimeFailure, match="BOX_BRIDGE_CONFIG_INVALID"):
        runtime.RuntimeConfig.from_env()


def test_oidc_identity_is_persistent_and_device_bound(platform, settings):
    first = runtime.load_provider(platform, settings)
    second = runtime.load_provider(platform, settings)
    assert first.jwks() == second.jwks()
    assert first.client_secret == second.client_secret
    assert len(first.client_secret) >= 32
    if os.name == "posix":
        assert (platform.state_dir / "oidc-identity.json").stat().st_mode & 0o777 == 0o600
        assert platform.state_dir.stat().st_mode & 0o777 == 0o700
    other = PlatformConfig(
        "different-box",
        platform.issuer,
        platform.box_key,
        platform.platform_key,
        platform.state_dir,
    )
    with pytest.raises(runtime.RuntimeFailure, match="BOX_BRIDGE_IDENTITY_INVALID"):
        runtime.load_provider(other, settings)


@pytest.mark.skipif(os.name != "posix", reason="POSIX symlink and permissions contract")
@pytest.mark.parametrize("target", ["directory", "identity"])
def test_identity_refuses_symlinks(platform, settings, tmp_path, target):
    outside = tmp_path / "outside"
    if target == "directory":
        outside.mkdir()
        platform.state_dir.symlink_to(outside, target_is_directory=True)
    else:
        platform.state_dir.mkdir()
        outside.write_text("do not overwrite")
        (platform.state_dir / "oidc-identity.json").symlink_to(outside)
    with pytest.raises(runtime.RuntimeFailure, match="BOX_BRIDGE_IDENTITY_INVALID"):
        runtime.load_provider(platform, settings)
    if target == "identity":
        assert outside.read_text() == "do not overwrite"


def test_corrupt_identity_is_not_silently_replaced(platform, settings):
    runtime.load_provider(platform, settings)
    path = platform.state_dir / "oidc-identity.json"
    path.write_text("broken")
    with pytest.raises(runtime.RuntimeFailure, match="BOX_BRIDGE_IDENTITY_INVALID"):
        runtime.load_provider(platform, settings)
    assert path.read_text() == "broken"


async def test_private_routes_token_and_no_authorize(platform, settings):
    provider = runtime.load_provider(platform, settings)
    app = runtime.create_private_app(provider)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url=provider.issuer
    ) as client:
        assert (
            await client.get("/.well-known/openid-configuration")
        ).json() == provider.discovery()
        assert (await client.get("/jwks")).json() == provider.jwks()
        assert (await client.get("/authorize")).status_code == 404
        assert (await client.get("/docs")).status_code == 404
        verifier = "v" * 64
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        redirect = settings.upstream_url + "/api/auth/oidc/callback"
        code = provider.issue("account", "name", "n" * 32, challenge, redirect)
        form = {
            "grant_type": "authorization_code",
            "client_id": provider.client_id,
            "client_secret": provider.client_secret,
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": redirect,
        }
        response = await client.post("/token", data=form)
        assert response.status_code == 200
        assert response.json()["id_token"]
        assert response.headers["cache-control"] == "no-store"
        assert (await client.post("/token", data=form)).status_code == 400


@pytest.mark.parametrize(
    "body,ctype,status",
    [
        ("client_id=a&client_id=b", "application/x-www-form-urlencoded", 400),
        ("client_id=a&broken", "application/x-www-form-urlencoded", 400),
        ("x=" + "a" * 8192, "application/x-www-form-urlencoded", 413),
        ('{"code":"x"}', "application/json", 400),
    ],
)
async def test_private_rejects_invalid_body(platform, settings, body, ctype, status):
    provider = runtime.load_provider(platform, settings)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=runtime.create_private_app(provider)),
        base_url=provider.issuer,
    ) as client:
        response = await client.post("/token", content=body, headers={"Content-Type": ctype})
        assert response.status_code == status
        assert response.json() == {"error": "invalid_request"}


@pytest.fixture
def supervision(platform, settings, monkeypatch):
    events = []
    servers = []
    state = {"init_error": False, "public_exit": False}
    stop = asyncio.Event()

    class Auth:
        def __init__(self, _config):
            events.append("auth")

        def close(self):
            events.append("auth_closed")

    class Adapter:
        def __init__(self, *_args):
            events.append("adapter")

        async def initialize(self):
            events.append("initialize")
            if state["init_error"]:
                raise BridgeUpstreamError("BOX_UPSTREAM_OIDC_CONFLICT")

        async def close(self):
            events.append("adapter_closed")

    class Server:
        def __init__(self, _app, _host, port):
            self.name = "private" if port == settings.oidc_port else "public"
            self.started = False
            self.should_exit = False
            servers.append(self)

        async def serve(self):
            self.started = True
            events.append(self.name + "_started")
            if self.name == "public":
                if state["public_exit"]:
                    events.append("public_stopped")
                    return
                stop.set()
            while not self.should_exit:
                await asyncio.sleep(0.001)
            events.append(self.name + "_stopped")

    async def health(_url):
        assert servers[0].started
        events.append("health")

    monkeypatch.setattr(runtime.RuntimeConfig, "from_env", lambda: settings)
    monkeypatch.setattr(runtime.PlatformConfig, "from_env", lambda: platform)
    monkeypatch.setattr(runtime, "PlatformAuthService", Auth)
    monkeypatch.setattr(runtime, "OctopAdapter", Adapter)
    monkeypatch.setattr(runtime, "_new_server", Server)
    monkeypatch.setattr(runtime, "_wait_upstream", health)
    monkeypatch.setattr(runtime, "create_app", lambda *_args, **_kwargs: object())
    return events, servers, state, stop


async def test_supervision_orders_startup_and_closes_both(supervision):
    events, servers, _state, stop = supervision
    await runtime.run(stop)
    assert (
        events.index("private_started")
        < events.index("health")
        < events.index("initialize")
        < events.index("public_started")
    )
    assert all(server.should_exit for server in servers)
    assert events[-2:] == ["adapter_closed", "auth_closed"]
    assert "private_stopped" in events and "public_stopped" in events


async def test_model_poll_is_supervised_and_closed_without_blocking_public(
    supervision, monkeypatch, platform
):
    events, _servers, _state, stop = supervision

    class Models:
        def __init__(self, *_args, **_kwargs):
            pass

        def register_routes(self, _app):
            events.append("models_registered")

        async def poll(self):
            events.append("models_poll")
            try:
                await asyncio.Event().wait()
            finally:
                events.append("models_cancelled")

        async def close(self):
            events.append("models_closed")

    from types import SimpleNamespace

    monkeypatch.setattr(
        runtime.ModelProviderConfig,
        "from_env",
        lambda: SimpleNamespace(identity_device_id=platform.device_id),
    )
    monkeypatch.setattr(runtime, "ModelProviderCatalog", lambda config: config)
    monkeypatch.setattr(runtime, "ModelProviderRuntime", Models)
    monkeypatch.setattr(runtime, "AdminClient", lambda *_args: None)
    monkeypatch.setattr(
        runtime.PlatformAuthService, "assert_model_binding", lambda *_args: None, raising=False
    )
    await runtime.run(stop)
    assert events.index("models_registered") < events.index("private_started")
    assert events.index("initialize") < events.index("models_poll")
    assert "public_started" in events
    assert events.index("models_cancelled") < events.index("models_closed")


async def test_model_identity_mismatch_does_not_take_login_down(supervision, monkeypatch, capsys):
    events, _servers, _state, stop = supervision
    from types import SimpleNamespace

    monkeypatch.setattr(
        runtime.ModelProviderConfig,
        "from_env",
        lambda: SimpleNamespace(identity_device_id="another-box"),
    )
    await runtime.run(stop)
    assert "public_started" in events
    assert "MODEL_PROVIDER_DEVICE_IDENTITY_MISMATCH" in capsys.readouterr().err


async def test_initialization_failure_never_opens_public_and_closes_resources(supervision):
    events, servers, state, stop = supervision
    state["init_error"] = True
    with pytest.raises(BridgeUpstreamError, match="BOX_UPSTREAM_OIDC_CONFLICT"):
        await runtime.run(stop)
    assert len(servers) == 1
    assert "public_started" not in events
    assert "private_stopped" in events
    assert events[-2:] == ["adapter_closed", "auth_closed"]


async def test_one_listener_exit_stops_other(supervision):
    events, servers, state, stop = supervision
    state["public_exit"] = True
    with pytest.raises(runtime.RuntimeFailure, match="BOX_BRIDGE_LISTENER_FAILED"):
        await runtime.run(stop)
    assert all(server.should_exit for server in servers)
    assert "private_stopped" in events
    assert events[-2:] == ["adapter_closed", "auth_closed"]


async def test_stop_during_waiting_upstream_cancels_startup(supervision, monkeypatch):
    events, servers, _state, stop = supervision

    async def health(_url):
        stop.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(runtime, "_wait_upstream", health)
    await runtime.run(stop)
    assert len(servers) == 1
    assert "initialize" not in events
    assert events[-2:] == ["adapter_closed", "auth_closed"]


async def test_upstream_health_requires_valid_bounded_ready_body():
    responses = [
        httpx.Response(200, text="not-json"),
        httpx.Response(200, json={"ok": True, "db": False}),
        httpx.Response(200, text="x" * 8193),
        httpx.Response(200, json={"ok": True, "db": True}),
    ]

    def handle(request):
        assert request.url.path == "/api/health"
        return responses.pop(0)

    await runtime._wait_upstream("http://127.0.0.1:18088", transport=httpx.MockTransport(handle))
    assert not responses

"""Container launcher preserves the upstream lifecycle and TLS companion."""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI

from wanx_runtime import __main__ as launcher


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    events = []
    listeners = []
    config = SimpleNamespace(tls=object(), log_level="INFO")
    server = SimpleNamespace(
        services=SimpleNamespace(config=config), paths=SimpleNamespace(root=tmp_path)
    )

    async def start():
        events.append("server.start")

    async def stop():
        events.append("server.stop")

    server.start, server.stop = start, stop

    class Memory:
        def __init__(self, actual):
            assert actual is server

        async def start(self):
            events.append("memory.start")

        async def close(self):
            events.append("memory.close")

    class Listener:
        def __init__(self, config):
            self.config = config
            listeners.append(self)

        async def serve(self):
            events.append("serve")

    async def cancel(task):
        assert task == "background-task"
        events.append("background.cancel")

    plan = SimpleNamespace(
        dual_listeners=False,
        bind_host="127.0.0.1",
        http_port=18088,
        https_port=None,
        ssl_certfile=None,
        ssl_keyfile=None,
    )
    monkeypatch.setattr(launcher, "OctopServer", lambda: server)
    monkeypatch.setattr(launcher, "MemorySlimControl", Memory)
    monkeypatch.setattr(launcher, "_schedule_linux_bubblewrap_ensure", lambda: "background-task")
    monkeypatch.setattr(launcher, "_cancel_background_task", cancel)
    monkeypatch.setattr(launcher, "resolve_tls_paths", lambda *args: (None, None))
    monkeypatch.setattr(launcher, "build_listen_plan", lambda *args, **kwargs: plan)
    monkeypatch.setattr(launcher, "build_app", lambda actual: FastAPI())
    monkeypatch.setattr(
        launcher.uvicorn, "Config", lambda app, **kwargs: SimpleNamespace(app=app, **kwargs)
    )
    monkeypatch.setattr(launcher.uvicorn, "Server", Listener)
    return events, listeners, plan


@pytest.mark.asyncio
async def test_launcher_mounts_extension_and_preserves_shutdown(runtime):
    events, listeners, _ = runtime
    await launcher.run(host="127.0.0.1", port=18088)
    assert events == [
        "server.start",
        "memory.start",
        "serve",
        "memory.close",
        "background.cancel",
        "server.stop",
    ]
    assert listeners[0].config.port == 18088
    assert "/api/auth/application/exchange" in listeners[0].config.app.openapi()["paths"]


@pytest.mark.asyncio
async def test_launcher_keeps_tls_and_http_companion(runtime):
    _, listeners, plan = runtime
    plan.dual_listeners, plan.https_port = True, 8443
    plan.ssl_certfile, plan.ssl_keyfile = "certificate.pem", "key.pem"
    await launcher.run(host="127.0.0.1", port=18088)
    assert len(listeners) == 2
    assert listeners[0].config.port == 8443
    assert listeners[0].config.ssl_certfile == "certificate.pem"
    assert listeners[0].config.ssl_keyfile == "key.pem"
    assert listeners[1].config.port == 18088
    assert not hasattr(listeners[1].config, "ssl_keyfile")


@pytest.mark.asyncio
async def test_launcher_stops_domain_after_extension_startup_error(runtime, monkeypatch):
    events, _, _ = runtime

    def fail(app):
        raise RuntimeError("extension failed")

    monkeypatch.setattr(launcher, "install_application_exchange", fail)
    with pytest.raises(RuntimeError, match="extension failed"):
        await launcher.run(host="127.0.0.1", port=18088)
    assert events == ["server.start", "memory.close", "background.cancel", "server.stop"]

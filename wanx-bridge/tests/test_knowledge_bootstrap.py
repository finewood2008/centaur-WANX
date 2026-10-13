"""WANX first-install defaults must not change upgraded or deliberately disabled boxes."""

from __future__ import annotations

import json
import os

import httpx
import pytest

from wanx_bridge import knowledge_bootstrap as kb
from wanx_bridge.admin_client import BridgeUpstreamError


@pytest.fixture
def installation(tmp_path):
    (tmp_path / kb.PENDING_FILE).write_text("pending")
    credentials = tmp_path / "credential.json"
    credentials.write_text(json.dumps({"username": "admin", "password": "private-password"}))
    credentials.chmod(0o600)
    return tmp_path


class Upstream:
    def __init__(self):
        self.calls = []
        self.enabled = False
        self.probe_ok = True
        self.deps_available = True
        self.verify_ok = True
        self.put_status = 200
        self.health_ok = True
        self.expire_first_token = False
        self.logins = 0

    def __call__(self, request):
        path = request.url.path
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, path, body))
        if path == "/api/health":
            assert "authorization" not in request.headers
            return httpx.Response(200, json={"ok": self.health_ok, "db": True})
        if path == "/api/auth/captcha":
            return httpx.Response(200, json={"provider": "slider"})
        if path == "/api/auth/login":
            assert body == {"username": "admin", "password": "private-password"}
            self.logins += 1
            return httpx.Response(
                200,
                json={
                    "access_token": f"private-token-{self.logins}",
                    "user": {"id": 1, "role": "admin"},
                },
            )
        assert request.headers["authorization"] == f"Bearer private-token-{self.logins}"
        if self.expire_first_token and self.logins == 1:
            return httpx.Response(401, json={"error": "expired"})
        if path == "/api/knowledge-bases/capability":
            return httpx.Response(
                200,
                json={
                    "feature_enabled": self.enabled,
                    "prerequisites_ok": self.verify_ok,
                    "usable": self.enabled and self.verify_ok,
                    "checks": {"deps_available": self.deps_available},
                    "ocr": {"enabled": True, "backend": "remote"},
                    "chunk_size": 456,
                },
            )
        if path == "/api/knowledge-bases/onnx-test":
            assert body == {"model": kb.DEFAULT_MODEL}
            return httpx.Response(200, json={"ok": self.probe_ok, "error": "private-error"})
        if path == "/api/knowledge-bases/feature":
            assert body == {"enabled": True, "backend": "onnx", "model": kb.DEFAULT_MODEL}
            self.enabled = self.put_status == 200
            return httpx.Response(self.put_status, json={"private": "private-error"})
        raise AssertionError(path)


async def test_first_install_and_later_explicit_disable_are_preserved(installation):
    upstream = Upstream()
    transport = httpx.MockTransport(upstream)
    assert await kb.bootstrap(installation, "http://127.0.0.1:8088", transport=transport)
    assert not (installation / kb.PENDING_FILE).exists()
    assert [path for _, path, _ in upstream.calls] == [
        "/api/health",
        "/api/auth/captcha",
        "/api/auth/login",
        "/api/knowledge-bases/capability",
        "/api/knowledge-bases/onnx-test",
        "/api/knowledge-bases/feature",
        "/api/knowledge-bases/capability",
    ]
    upstream.enabled = False
    before = list(upstream.calls)
    (installation / "credential.json").unlink()
    assert not await kb.bootstrap(installation, "http://127.0.0.1:8088", transport=transport)
    assert upstream.calls == before
    assert upstream.enabled is False


async def test_upgrade_without_marker_never_reads_credentials_or_uses_network(tmp_path):
    (tmp_path / "credential.json").write_text("invalid private secret")

    def no_requests(request):
        raise AssertionError("upgrade must not make HTTP requests")

    assert not await kb.bootstrap(
        tmp_path, "http://127.0.0.1:8088", transport=httpx.MockTransport(no_requests)
    )


async def test_failed_probe_keeps_pending_and_can_retry(installation):
    upstream = Upstream()
    upstream.probe_ok = False
    with pytest.raises(BridgeUpstreamError, match="WANX_KNOWLEDGE_MODEL_NOT_READY"):
        await kb.bootstrap(
            installation, "http://127.0.0.1", transport=httpx.MockTransport(upstream)
        )
    assert (installation / kb.PENDING_FILE).exists()
    assert not any(method == "PUT" for method, _, _ in upstream.calls)
    upstream.probe_ok = True
    assert await kb.bootstrap(
        installation, "http://127.0.0.1", transport=httpx.MockTransport(upstream)
    )


@pytest.mark.parametrize("stage", ["deps", "put", "verify"])
async def test_failed_stage_keeps_pending(installation, stage):
    upstream = Upstream()
    if stage == "deps":
        upstream.deps_available = False
    elif stage == "put":
        upstream.put_status = 503
    else:
        upstream.verify_ok = False
    with pytest.raises(BridgeUpstreamError) as error:
        await kb.bootstrap(
            installation, "http://127.0.0.1", transport=httpx.MockTransport(upstream)
        )
    assert "private" not in str(error.value)
    assert (installation / kb.PENDING_FILE).exists()
    if stage == "deps":
        assert not any(path.endswith("onnx-test") for _, path, _ in upstream.calls)


async def test_health_timeout_does_not_login_or_consume_marker(installation):
    upstream = Upstream()
    upstream.health_ok = False
    with pytest.raises(BridgeUpstreamError, match="WANX_KNOWLEDGE_UPSTREAM_TIMEOUT"):
        await kb.bootstrap(
            installation,
            "http://127.0.0.1",
            transport=httpx.MockTransport(upstream),
            health_timeout=0.01,
        )
    assert (installation / kb.PENDING_FILE).exists()
    assert upstream.logins == 0


@pytest.mark.parametrize(
    "url",
    ["http://example.com", "http://192.168.0.102", "http://localhost", "http://x@127.0.0.1"],
)
async def test_non_loopback_rejected_before_requests(installation, url):
    upstream = Upstream()
    with pytest.raises(ValueError):
        await kb.bootstrap(installation, url, transport=httpx.MockTransport(upstream))
    assert upstream.calls == []
    assert (installation / kb.PENDING_FILE).exists()


async def test_reuses_admin_token_renewal(installation):
    upstream = Upstream()
    upstream.expire_first_token = True
    assert await kb.bootstrap(
        installation, "http://[::1]:8088", transport=httpx.MockTransport(upstream)
    )
    assert upstream.logins == 2


@pytest.mark.skipif(os.name != "posix", reason="POSIX credential ownership and permissions")
@pytest.mark.parametrize("invalid", ["public", "symlink", "owner"])
async def test_credential_rules_are_shared_with_bridge(installation, monkeypatch, invalid):
    credentials = installation / "credential.json"
    if invalid == "public":
        credentials.chmod(0o644)
    elif invalid == "symlink":
        target = installation / "actual-secret.json"
        credentials.rename(target)
        credentials.symlink_to(target)
    else:
        monkeypatch.setattr("wanx_bridge.admin_client.os.geteuid", lambda: os.getuid() + 1)
    upstream = Upstream()
    with pytest.raises(BridgeUpstreamError, match="BOX_UPSTREAM_CREDENTIALS_INVALID"):
        await kb.bootstrap(
            installation, "http://127.0.0.1", transport=httpx.MockTransport(upstream)
        )
    assert upstream.logins == 0
    assert (installation / kb.PENDING_FILE).exists()


@pytest.mark.parametrize(
    "failure", [ValueError("private-password private-token"), RuntimeError("secret")]
)
def test_cli_sanitizes_failure_and_exits_nonzero(installation, monkeypatch, capsys, failure):
    async def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(kb, "bootstrap", fail)
    assert kb.main(["--root", str(installation), "--base-url", "http://127.0.0.1"]) == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == "WANX_KNOWLEDGE_BOOTSTRAP_FAILED\n"
    assert (installation / kb.PENDING_FILE).exists()


def test_cli_skip_without_pending(tmp_path, capsys):
    assert kb.main(["--root", str(tmp_path), "--base-url", "http://127.0.0.1"]) == 0
    assert capsys.readouterr().out == "WANX_KNOWLEDGE_UNCHANGED\n"

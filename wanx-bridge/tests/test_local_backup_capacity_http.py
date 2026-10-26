"""Fixed provider quota errors across real TLS, signatures and SQLite rollback."""

import os
import ssl
from contextlib import asynccontextmanager

import httpx
import pytest
from test_local_backup_io import FixtureIO, proof
from test_local_ledger import NOW, activate
from test_local_ledger import ledger as _ledger
from test_local_ledger import provisioned as _provisioned
from test_local_trust_runtime import configured as _configured
from test_local_trust_runtime import running

from wanx_bridge import local_backup_io as backup
from wanx_bridge import local_trust_protocol as evidence
from wanx_bridge.local_trust_config import LocalTrustConfig
from wanx_bridge.local_trust_runtime import server_for
from wanx_bridge.local_trust_service import LocalTrustService

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Private ledger requires POSIX")


@pytest.fixture
def provisioned(tmp_path):
    directory = tmp_path / "ledger"
    directory.mkdir(mode=0o700)
    return _provisioned.__wrapped__(directory)


@pytest.fixture
def ledger(provisioned):
    yield from _ledger.__wrapped__(provisioned)


@pytest.fixture
def configured(tmp_path):
    directory = tmp_path / "listener"
    directory.mkdir(mode=0o700)
    yield from _configured.__wrapped__(directory)


class ProviderQuotaError(RuntimeError):
    """Match the independently installed OS provider's RuntimeError contract."""


class RefusingIO(FixtureIO):
    def __init__(self, error):
        super().__init__()
        self.error = error
        self.attempts = 0

    def backup_io(self, operation, body, authorization, now):
        self.attempts += 1
        if self.error is not None:
            raise self.error
        return super().backup_io(operation, body, authorization, now)


@asynccontextmanager
async def https_client(ledger, configured):
    config = LocalTrustConfig.load(configured.filename)
    service = LocalTrustService(ledger.authority, clock=lambda: NOW + 11)
    listener = server_for(config, service)
    context = ssl.create_default_context(cafile=str(config.tls_certificate))
    async with (
        running(listener, configured.sock),
        httpx.AsyncClient(base_url=config.base_url, verify=context, trust_env=False) as client,
    ):
        yield client


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error,status,code",
    [
        (RuntimeError("LOCAL_BACKUP_CAPACITY"), 429, "LOCAL_TRUST_CAPACITY"),
        (ProviderQuotaError("LOCAL_BACKUP_CAPACITY"), 429, "LOCAL_TRUST_CAPACITY"),
        (RuntimeError("/private/provider/path"), 503, "LOCAL_TRUST_UNAVAILABLE"),
        (RuntimeError("LOCAL_BACKUP_CAPACITY: /private/path"), 503, "LOCAL_TRUST_UNAVAILABLE"),
        (RuntimeError("LOCAL_BACKUP_CAPACITY", "/private/path"), 503, "LOCAL_TRUST_UNAVAILABLE"),
        (ValueError("LOCAL_BACKUP_CAPACITY"), 503, "LOCAL_TRUST_UNAVAILABLE"),
    ],
)
async def test_provider_rejection_preserves_nonce_for_same_signed_retry(
    ledger, configured, error, status, code
):
    activate(ledger)
    provider = RefusingIO(error)
    ledger.authority.configure_operation_provider(provider)
    bundle = ledger.provisioned.bundle
    body = {
        "archiveBytes": backup.MAX_ARCHIVE,
        "archiveSha256": evidence._encode(b"a" * 32),
        "source": {key: bundle[key] for key in ("boxId", "baseUrl", "boxKey", "tlsSpkiSha256")},
    }
    signed, payload = proof(ledger, "source.begin", body, NOW + 11)
    request = {"body": body, "proof": signed}
    path = "/local-trust/v2/backup-io/source.begin"
    async with https_client(ledger, configured) as client:
        rejected = await client.post(path, json=request)
        assert rejected.status_code == status
        assert rejected.json() == {"code": code}
        assert rejected.headers["cache-control"] == "no-store"
        assert provider.attempts == 1
        assert provider.calls == []
        assert (
            ledger.authority._db.execute(
                "SELECT consumed FROM challenges WHERE nonce=?", (payload["nonce"],)
            ).fetchone()[0]
            is None
        )

        provider.error = None
        accepted = await client.post(path, json=request)
        assert accepted.status_code == 200, accepted.text
        result = backup.verify_response(
            accepted.json(),
            bundle["boxKey"],
            box_id=bundle["boxId"],
            operation="source.begin",
            nonce=payload["nonce"],
            request=body,
        )
        assert result["body"]["uploadId"] == "upload:fixture"
        assert provider.attempts == 2 and len(provider.calls) == 1
        replay = await client.post(path, json=request)
        assert replay.status_code == 400
        assert replay.json() == {"code": "LOCAL_TRUST_CHALLENGE_INVALID"}
        assert provider.attempts == 2


@pytest.mark.asyncio
async def test_quota_text_on_non_backup_route_stays_generic(ledger, configured, monkeypatch):
    def fail(now):
        raise ProviderQuotaError("LOCAL_BACKUP_CAPACITY")

    monkeypatch.setattr(ledger.authority, "auth_challenge_v2", fail)
    async with https_client(ledger, configured) as client:
        response = await client.post("/local-trust/v2/auth/challenge", json={})
        assert response.status_code == 503
        assert response.json() == {"code": "LOCAL_TRUST_UNAVAILABLE"}

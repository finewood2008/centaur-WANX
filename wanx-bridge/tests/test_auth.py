import asyncio
import os
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from wanx_bridge.auth import PlatformAuthService, fingerprint
from wanx_bridge.config import BridgeAuthError, PlatformConfig


@pytest.fixture
def setup_auth(tmp_path):
    platform_key = Ed25519PrivateKey.generate()
    config = PlatformConfig(
        "box",
        "nexusaos-platform",
        Ed25519PrivateKey.generate(),
        platform_key.public_key(),
        tmp_path,
    )
    auth = PlatformAuthService(config)
    yield auth, platform_key, config
    auth.close()


def issue(auth, key, **changes):
    account = changes.get("sub", "account")
    client = changes.get("client_id", "client")
    network = changes.get("network_session_id", "network")
    receipt = auth.challenge(account, client, network)["challengeReceipt"]
    proof = jwt.decode(receipt, options={"verify_signature": False})
    claims = {
        **proof,
        "iss": "nexusaos-platform",
        "aud": "wanx-p2p-login",
        "ownership_epoch": 1,
        "authorization_version": 1,
        "client_session_version": 0,
        "account_auth_version": 0,
        "role": "user",
        "membership_id": "member",
        "membership_version": 1,
        "display_name": "Name",
        "lease_exp": proof["iat"] + 120,
        **changes,
    }
    return jwt.encode(
        claims, key, algorithm="EdDSA", headers={"kid": fingerprint(key.public_key())}
    )


class Adapter:
    async def login(self, claims):
        return {
            "access_token": "private-upstream-jwt",
            "expires_at": time.time() + 3600,
            "user": {"username": claims["sub"], "role": claims["role"]},
        }


@pytest.mark.asyncio
async def test_model_lease_rejects_superseded_platform_authority_without_requiring_online_owner(
    setup_auth,
):
    auth, key, _ = setup_auth
    snapshot = {"ownershipEpoch": 1, "authVersion": 1}
    auth.assert_model_binding(snapshot)
    await auth.exchange(issue(auth, key), Adapter())
    auth.assert_model_binding(snapshot)
    # The platform may observe withdrawal/transfer before the next model poll.
    await auth.exchange(issue(auth, key, authorization_version=2), Adapter())
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_AUTHORIZATION_CHANGED"):
        auth.assert_model_binding(snapshot)
    auth.assert_model_binding({"ownershipEpoch": 1, "authVersion": 2})
    await auth.exchange(issue(auth, key, sub="new-owner", ownership_epoch=2), Adapter())
    with pytest.raises(BridgeAuthError, match="MODEL_PROVIDER_AUTHORIZATION_CHANGED"):
        auth.assert_model_binding({"ownershipEpoch": 1, "authVersion": 99})
    auth.assert_model_binding({"ownershipEpoch": 2, "authVersion": 1})


@pytest.mark.asyncio
async def test_exchange_replay_and_restart(setup_auth):
    auth, key, config = setup_auth
    grant = issue(auth, key)
    result = await auth.exchange(grant, Adapter())
    session = auth.authorize(result["access_token"])
    assert session.upstream_token == "private-upstream-jwt"
    assert result["access_token"] != session.upstream_token
    assert result["user"]["username"] == "account"
    with pytest.raises(BridgeAuthError):
        await auth.exchange(grant, Adapter())
    second = PlatformAuthService(config)
    try:
        with pytest.raises(BridgeAuthError):
            second.authorize(result["access_token"])
        with pytest.raises(BridgeAuthError):
            await second.exchange(grant, Adapter())
        raw = config.state_dir.joinpath("auth.sqlite3").read_bytes()
        assert result["access_token"].encode() not in raw
        assert session.upstream_token.encode() not in raw
    finally:
        second.close()


@pytest.mark.asyncio
async def test_pending_challenge_survives_restart(setup_auth):
    auth, key, config = setup_auth
    grant = issue(auth, key)
    second = PlatformAuthService(config)
    try:
        result = await second.exchange(grant, Adapter())
        assert second.authorize(result["access_token"])
    finally:
        second.close()


@pytest.mark.parametrize(
    "field,value",
    [
        ("ownership_epoch", 0),
        ("authorization_version", -1),
        ("membership_version", 0),
        ("account_auth_version", -1),
        ("client_session_version", -1),
        ("account_auth_version", True),
        ("role", "owner"),
        ("aud", ["wanx-p2p-login"]),
        ("contract", "bad"),
        ("device_id", "other"),
    ],
)
@pytest.mark.asyncio
async def test_invalid_claims(setup_auth, field, value):
    auth, key, _ = setup_auth
    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key, **{field: value}), Adapter())


@pytest.mark.asyncio
async def test_tampered_signature(setup_auth):
    auth, key, _ = setup_auth
    grant = issue(auth, key)
    header, payload, signature = grant.split(".")
    replacement = ("A" if signature[0] != "A" else "B") + signature[1:]
    with pytest.raises(BridgeAuthError):
        await auth.exchange(".".join((header, payload, replacement)), Adapter())


@pytest.mark.asyncio
async def test_concurrent_replay_only_one_upstream_login(setup_auth):
    auth, key, _ = setup_auth
    grant = issue(auth, key)
    calls = []

    class Counting(Adapter):
        async def login(self, claims):
            calls.append(1)
            await asyncio.sleep(0.01)
            return await super().login(claims)

    results = await asyncio.gather(
        *(auth.exchange(grant, Counting()) for _ in range(8)), return_exceptions=True
    )
    assert sum(isinstance(r, dict) for r in results) == 1
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_delayed_old_exchange_cannot_restore_authority(setup_auth):
    auth, key, _ = setup_auth
    entered, release = asyncio.Event(), asyncio.Event()

    class Slow(Adapter):
        async def login(self, claims):
            entered.set()
            await release.wait()
            return await super().login(claims)

    old = asyncio.create_task(auth.exchange(issue(auth, key), Slow()))
    await entered.wait()
    new_task = asyncio.create_task(
        auth.exchange(issue(auth, key, account_auth_version=1), Adapter())
    )
    await asyncio.sleep(0.01)
    assert not new_task.done()
    release.set()
    oldest, newest = await asyncio.gather(old, new_task)
    with pytest.raises(BridgeAuthError):
        auth.authorize(oldest["access_token"])
    assert auth.authorize(newest["access_token"])


@pytest.mark.asyncio
async def test_account_revocation_invalidates_other_clients(setup_auth):
    auth, key, _ = setup_auth
    old = await auth.exchange(issue(auth, key, client_id="old-client"), Adapter())
    old_session = auth.authorize(old["access_token"])
    await auth.exchange(issue(auth, key, client_id="new-client", account_auth_version=1), Adapter())
    with pytest.raises(BridgeAuthError):
        auth.assert_live(old_session)
    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key, client_id="third-client"), Adapter())


@pytest.mark.asyncio
async def test_ownership_change_invalidates_all_accounts(setup_auth):
    auth, key, _ = setup_auth
    first = await auth.exchange(issue(auth, key), Adapter())
    old = auth.authorize(first["access_token"])
    await auth.exchange(issue(auth, key, sub="new-owner", ownership_epoch=2), Adapter())
    with pytest.raises(BridgeAuthError):
        auth.assert_live(old)
    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key, sub="third-account"), Adapter())


@pytest.mark.asyncio
async def test_membership_change_invalidates_streams(setup_auth):
    auth, key, _ = setup_auth
    first = await auth.exchange(issue(auth, key, role="admin"), Adapter())
    old = auth.authorize(first["access_token"])
    await auth.exchange(issue(auth, key, role="user", membership_version=2), Adapter())
    with pytest.raises(BridgeAuthError):
        auth.assert_live(old)
    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key, role="admin"), Adapter())


@pytest.mark.asyncio
async def test_renewal_keeps_stream_but_not_expired_initial_token(setup_auth, monkeypatch):
    auth, key, _ = setup_auth
    now = int(time.time())
    first = await auth.exchange(issue(auth, key, exp=now + 10, lease_exp=now + 10), Adapter())
    old = auth.authorize(first["access_token"])
    second = await auth.exchange(issue(auth, key), Adapter())
    assert auth.authorize(second["access_token"]).sid == old.sid
    monkeypatch.setattr(time, "time", lambda: now + 20)
    auth.assert_live(old)
    with pytest.raises(BridgeAuthError):
        auth.authorize(first["access_token"])
    monkeypatch.setattr(time, "time", lambda: now + 121)
    with pytest.raises(BridgeAuthError):
        auth.assert_live(old)


@pytest.mark.asyncio
async def test_upstream_expiration_caps_stream(setup_auth, monkeypatch):
    auth, key, _ = setup_auth
    now = time.time()

    class Short(Adapter):
        async def login(self, claims):
            result = await super().login(claims)
            result["expires_at"] = now + 5
            return result

    first = await auth.exchange(issue(auth, key), Short())
    session = auth.authorize(first["access_token"])
    await auth.exchange(issue(auth, key), Adapter())
    monkeypatch.setattr(time, "time", lambda: now + 6)
    with pytest.raises(BridgeAuthError):
        auth.assert_live(session)


@pytest.mark.skipif(os.name != "posix", reason="POSIX permissions")
def test_state_permissions(setup_auth):
    auth, _, config = setup_auth
    assert config.state_dir.stat().st_mode & 0o777 == 0o700
    assert auth.store.path.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_role_change_requires_version_advance_even_across_clients(setup_auth):
    auth, key, _ = setup_auth
    now = int(time.time())
    await auth.exchange(issue(auth, key, iat=now - 2, exp=now + 58, lease_exp=now + 118), Adapter())
    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key, role="admin", client_id="different"), Adapter())


@pytest.mark.asyncio
async def test_client_version_does_not_revoke_other_clients(setup_auth):
    auth, key, _ = setup_auth
    first = await auth.exchange(issue(auth, key, client_id="first"), Adapter())
    second = await auth.exchange(issue(auth, key, client_id="second"), Adapter())
    await auth.exchange(issue(auth, key, client_id="second", client_session_version=1), Adapter())
    assert auth.authorize(first["access_token"])
    with pytest.raises(BridgeAuthError):
        auth.authorize(second["access_token"])


@pytest.mark.parametrize(
    "changes", [{"nonce": "wrong"}, {"extra": 1}, {"exp": 1}, {"lease_exp": 1}, {"iat": True}]
)
@pytest.mark.asyncio
async def test_invalid_context_and_lease(setup_auth, changes):
    auth, key, _ = setup_auth
    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key, **changes), Adapter())


@pytest.mark.asyncio
async def test_upstream_nonfinite_expiry_rejected(setup_auth):
    auth, key, _ = setup_auth

    class Invalid(Adapter):
        async def login(self, claims):
            result = await super().login(claims)
            result["expires_at"] = float("nan")
            return result

    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key), Invalid())


@pytest.mark.asyncio
async def test_cancelled_exchange_finishes_upstream_role_before_successor(setup_auth):
    auth, key, _ = setup_auth
    entered, release = asyncio.Event(), asyncio.Event()
    upstream_roles = []

    class Roles(Adapter):
        async def login(self, claims):
            if claims["role"] == "admin":
                entered.set()
                await release.wait()
            upstream_roles.append(claims["role"])
            return await super().login(claims)

    old = asyncio.create_task(auth.exchange(issue(auth, key, role="admin"), Roles()))
    await entered.wait()
    old.cancel()
    new = asyncio.create_task(
        auth.exchange(issue(auth, key, role="user", membership_version=2), Roles())
    )
    await asyncio.sleep(0.01)
    assert upstream_roles == []
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await old
    await new
    assert upstream_roles == ["admin", "user"]


@pytest.mark.asyncio
async def test_stale_grant_never_reaches_upstream_role_mutation(setup_auth):
    auth, key, _ = setup_auth
    stale = issue(auth, key, role="admin")
    await auth.exchange(issue(auth, key, role="user", membership_version=2), Adapter())

    class Unexpected(Adapter):
        async def login(self, claims):
            pytest.fail("stale grant must fail before upstream login")

    with pytest.raises(BridgeAuthError):
        await auth.exchange(stale, Unexpected())


def test_challenges_are_bounded_and_expired_entries_reclaimed(setup_auth, monkeypatch):
    import wanx_bridge.store as store_module

    auth, _, _ = setup_auth
    monkeypatch.setattr(store_module, "MAX_IDENTITY_CHALLENGES", 2)
    monkeypatch.setattr(store_module, "MAX_CHALLENGES", 3)
    auth.challenge("account", "client", "network")
    auth.challenge("account", "client", "network")
    with pytest.raises(BridgeAuthError) as exc:
        auth.challenge("account", "client", "network")
    assert exc.value.status == 429
    auth.challenge("other", "other", "network")
    with pytest.raises(BridgeAuthError):
        auth.challenge("third", "third", "network")
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 61)
    auth.challenge("account", "client", "network")
    assert auth.store.db.execute("SELECT COUNT(*) FROM challenges").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_lease_capacity_preserves_existing_authority_watermarks(setup_auth, monkeypatch):
    import wanx_bridge.store as store_module

    auth, key, _ = setup_auth
    monkeypatch.setattr(store_module, "MAX_LEASE_IDENTITIES", 1)
    first = await auth.exchange(issue(auth, key), Adapter())
    with pytest.raises(BridgeAuthError) as exc:
        await auth.exchange(issue(auth, key, client_id="other"), Adapter())
    assert exc.value.code == "BOX_PLATFORM_CAPACITY"
    assert auth.authorize(first["access_token"])
    await auth.exchange(issue(auth, key), Adapter())


@pytest.mark.asyncio
async def test_expired_token_hashes_and_retired_contexts_reclaimed(setup_auth, monkeypatch):
    auth, key, _ = setup_auth
    await auth.exchange(issue(auth, key), Adapter())
    await auth.exchange(issue(auth, key, account_auth_version=1), Adapter())
    assert auth.store.db.execute("SELECT COUNT(*) FROM retired").fetchone()[0] == 1
    now = time.time()
    monkeypatch.setattr(time, "time", lambda: now + 121)
    auth.challenge("account", "client", "network")
    assert auth.store.db.execute("SELECT COUNT(*) FROM retired").fetchone()[0] == 0
    assert auth.store.db.execute("SELECT COUNT(*) FROM tokens").fetchone()[0] == 0
    # Authority versions are durable even after every short-lived item expires.
    assert auth.store.db.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 1


@pytest.mark.skipif(os.name != "posix", reason="POSIX symlink semantics")
def test_state_database_symlink_rejected_without_touching_target(tmp_path):
    from wanx_bridge.store import Store

    target = tmp_path / "target"
    target.write_text("private external data")
    target.chmod(0o644)
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    (state_dir / "auth.sqlite3").symlink_to(target)
    with pytest.raises(BridgeAuthError):
        Store(state_dir)
    assert target.read_text() == "private external data"
    assert target.stat().st_mode & 0o777 == 0o644


@pytest.mark.asyncio
async def test_adapter_failure_does_not_activate_grant(setup_auth):
    auth, key, _ = setup_auth
    grant = issue(auth, key)

    class Failed(Adapter):
        async def login(self, claims):
            raise RuntimeError("upstream unavailable")

    with pytest.raises(RuntimeError):
        await auth.exchange(grant, Failed())
    assert (
        auth.store.db.execute(
            "SELECT COUNT(*) FROM leases WHERE json_extract(context,'$.lease_exp') > 0"
        ).fetchone()[0]
        == 0
    )
    assert auth.sessions == {}
    with pytest.raises(BridgeAuthError):
        await auth.exchange(grant, Adapter())


@pytest.mark.asyncio
async def test_role_change_revokes_prior_stream_before_adapter_and_failure_cannot_restore(
    setup_auth,
):
    auth, key, _ = setup_auth
    first = await auth.exchange(issue(auth, key, role="admin"), Adapter())
    old = auth.authorize(first["access_token"])

    class FailedRoleUpdate(Adapter):
        async def login(self, claims):
            with pytest.raises(BridgeAuthError):
                auth.assert_live(old)
            raise RuntimeError("upstream update failed")

    with pytest.raises(RuntimeError):
        await auth.exchange(issue(auth, key, role="user", membership_version=2), FailedRoleUpdate())
    with pytest.raises(BridgeAuthError):
        auth.assert_live(old)
    with pytest.raises(BridgeAuthError):
        await auth.exchange(issue(auth, key, role="admin"), Adapter())
    retry = await auth.exchange(issue(auth, key, role="user", membership_version=2), Adapter())
    assert auth.authorize(retry["access_token"])


@pytest.mark.asyncio
async def test_same_authority_failed_renewal_keeps_existing_stream(setup_auth):
    auth, key, _ = setup_auth
    first = await auth.exchange(issue(auth, key), Adapter())
    old = auth.authorize(first["access_token"])

    class FailedRenewal(Adapter):
        async def login(self, claims):
            auth.assert_live(old)
            raise RuntimeError("transient upstream failure")

    with pytest.raises(RuntimeError):
        await auth.exchange(issue(auth, key), FailedRenewal())
    auth.assert_live(old)

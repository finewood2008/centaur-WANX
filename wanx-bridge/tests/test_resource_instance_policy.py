"""Expert sharing is explicit signed metadata, never inferred from a display name."""

# Imported pytest fixtures are intentionally reused as test arguments.
# ruff: noqa: F811

import base64
import hashlib

import pytest
from test_resources import setup, signed  # noqa: F401

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resources_contract import canonical, validate_package, verify_envelope


def policy_package(private, scope, *, kind="expert"):
    package, _, envelope = signed(private, kind=kind)
    if scope != "absent":
        package["metadata"]["expertInstanceScope"] = scope
    raw = canonical(package)
    envelope["payload"]["metadata"] = package["metadata"]
    envelope["payload"]["package"].update(
        sha256=hashlib.sha256(raw).hexdigest(), sizeBytes=len(raw)
    )
    envelope["signature"]["signatureBase64"] = base64.b64encode(
        private.sign(canonical(envelope["payload"]))
    ).decode()
    return package, raw, envelope


@pytest.mark.parametrize("scope", ["absent", "application", "account"])
def test_expert_scope_is_accepted_in_signed_package(setup, scope):
    private, trust, _ = setup
    package, raw, envelope = policy_package(private, scope)
    payload = verify_envelope(envelope, trust)
    assert validate_package(raw, payload) == package


@pytest.mark.parametrize("scope", [None, True, 1, "global", "ACCOUNT", [], {}])
def test_unknown_expert_scope_is_rejected_even_if_signed(setup, scope):
    private, trust, _ = setup
    _, raw, envelope = policy_package(private, scope)
    for check in (
        lambda: verify_envelope(envelope, trust),
        lambda: validate_package(raw, envelope["payload"]),
    ):
        with pytest.raises(BridgeAuthError, match="RESOURCE_INSTANCE_SCOPE_INVALID"):
            check()


@pytest.mark.parametrize("scope", ["application", "account"])
def test_skill_package_cannot_define_expert_scope(setup, scope):
    private, trust, _ = setup
    _, _, envelope = policy_package(private, scope, kind="skill-package")
    with pytest.raises(BridgeAuthError, match="RESOURCE_INSTANCE_SCOPE_INVALID"):
        verify_envelope(envelope, trust)


def test_sharing_cannot_be_enabled_without_resigning(setup):
    private, trust, _ = setup
    _, _, envelope = policy_package(private, "application")
    envelope["payload"]["metadata"]["expertInstanceScope"] = "account"
    with pytest.raises(BridgeAuthError, match="RESOURCE_SIGNATURE_INVALID"):
        verify_envelope(envelope, trust)

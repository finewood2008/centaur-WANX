"""Team identity v1: cloud identity evidence never grants local authority."""

from __future__ import annotations

import jwt
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from . import local_management_protocol as wire
from . import local_trust_protocol as evidence

ACTIONS = frozenset(
    {
        "team.activate",
        "team.invite-create",
        "team.invite-revoke",
        "team.member-admit",
        "team.member-link",
        "team.member-role",
        "team.member-suspend",
        "team.member-revoke",
        "team.resource-set",
        "team.migration-authorize",
        "team.device-resources",
    }
)
ASSOCIATION_ACTIONS = frozenset({"team.activate", "team.member-admit", "team.member-link"})
READ_OPERATIONS = frozenset(
    {
        "team-state",
        "self-member",
        "team-association",
        "team-request",
        "self-resources",
        "team-device-review",
    }
)
PERMISSIONS = {
    "owner": [
        "applications.manage",
        "members.manage",
        "members.read",
        "resources.manage",
        "roles.manage",
    ],
    "manager": ["applications.manage", "members.read", "resources.manage"],
    "member": [],
}
POLICY_FIELDS = {
    "schemaVersion",
    "type",
    "issuer",
    "audience",
    "kid",
    "publicKey",
    "maximumProofLifetimeSeconds",
}
REQUEST_FIELDS = {
    "schemaVersion",
    "purpose",
    "boxId",
    "boxKeyThumbprint",
    "ownershipEpoch",
    "invitationId",
    "principalId",
    "target",
}
CLOUD_FIELDS = {
    "schemaVersion",
    "purpose",
    "issuer",
    "audience",
    "subject",
    "jti",
    "issuedAt",
    "expiresAt",
    "boxId",
    "boxKeyThumbprint",
    "ownershipEpoch",
    "requestDigest",
    "invitationId",
    "targetAccessKeyThumbprint",
    "targetApprovalKeyThumbprint",
    "clientId",
    "clientKeyThumbprint",
    "nonce",
}
ASSOCIATION_FIELDS = {
    "schemaVersion",
    "purpose",
    "boxId",
    "boxKeyThumbprint",
    "ownershipEpoch",
    "cloudProofDigest",
    "issuer",
    "subject",
    "clientId",
    "clientKeyThumbprint",
    "requestDigest",
    "invitationId",
    "principalId",
    "bindingId",
    "membershipId",
    "membershipRevision",
    "roleId",
    "authorityDigest",
    "rosterVersion",
    "rosterDigest",
    "authorizationVersion",
    "issuedAt",
    "status",
    "expiresAt",
}
TARGET_POLICY_FIELDS = {
    "capabilities",
    "grants",
    "delegableGrants",
    "expiresAt",
    "delegationExpiresAt",
}


def need(condition, code="LOCAL_BINDING_INVALID"):
    evidence._require(condition, code)


def validate_policy(value):
    evidence._fields(value, POLICY_FIELDS)
    need(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    need(value["type"] == "centuarai-team-identity-policy")
    need(
        value["issuer"] == "nexusaos-platform"
        and value["audience"] == "centuarai-local-team-identity"
    )
    evidence._token(value["kid"])
    need(
        type(value["maximumProofLifetimeSeconds"]) is int
        and value["maximumProofLifetimeSeconds"] == 300
    )
    evidence._fields(value["publicKey"], {"kty", "crv", "x"})
    need(value["publicKey"]["kty"] == "OKP" and value["publicKey"]["crv"] == "Ed25519")
    evidence._decode(value["publicKey"]["x"], 32)


def validate_request(value):
    from .local_ledger_protocol import target

    evidence._fields(value, REQUEST_FIELDS)
    need(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    need(value["purpose"] == "centuarai.team-membership.request")
    for name in ("boxId", "principalId"):
        evidence._token(value[name])
    evidence._digest(value["boxKeyThumbprint"])
    evidence._integer(value["ownershipEpoch"])
    if value["invitationId"] is not None:
        evidence._digest(value["invitationId"])
    target(value["target"])


def request_digest(value):
    validate_request(value)
    return wire.digest(value)


def proof_digest(proof):
    import hashlib

    need(type(proof) is str and 1 <= len(proof) <= 16384)
    try:
        return evidence._encode(hashlib.sha256(proof.encode("ascii")).digest())
    except UnicodeError:
        need(False)


def validate_cloud(value):
    evidence._fields(value, CLOUD_FIELDS)
    need(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    need(value["purpose"] == "centuarai.team.identity-association")
    need(
        value["issuer"] == "nexusaos-platform"
        and value["audience"] == "centuarai-local-team-identity"
    )
    for name in ("subject", "boxId", "clientId"):
        evidence._token(value[name])
    for name in (
        "jti",
        "boxKeyThumbprint",
        "requestDigest",
        "targetAccessKeyThumbprint",
        "targetApprovalKeyThumbprint",
        "clientKeyThumbprint",
        "nonce",
    ):
        evidence._digest(value[name])
    if value["invitationId"] is not None:
        evidence._digest(value["invitationId"])
    evidence._integer(value["ownershipEpoch"])
    evidence._window(value)
    need(value["expiresAt"] <= value["issuedAt"] + 300)


def verify_cloud(proof, policy, request, now):
    validate_policy(policy)
    validate_request(request)
    need(type(proof) is str and 1 <= len(proof) <= 8192, "LOCAL_TRUST_IDENTITY_DENIED")
    try:
        pieces = proof.split(".")
        need(len(pieces) == 3, "LOCAL_TRUST_IDENTITY_DENIED")
        for piece in pieces[:2]:
            raw = evidence._decode(piece)
            parsed = evidence._parse(raw)
            need(wire.canonical(parsed) == raw, "LOCAL_TRUST_IDENTITY_DENIED")
        evidence._decode(pieces[2], 64)
        header = jwt.get_unverified_header(proof)
        need(
            header
            == {"alg": "EdDSA", "typ": "centuarai-team-cloud-identity+jws", "kid": policy["kid"]},
            "LOCAL_TRUST_IDENTITY_DENIED",
        )
        key = Ed25519PublicKey.from_public_bytes(evidence._decode(policy["publicKey"]["x"], 32))
        value = jwt.decode(
            proof,
            key,
            algorithms=["EdDSA"],
            options={
                "verify_aud": False,
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
            },
        )
        validate_cloud(value)
        need(value["issuedAt"] <= now < value["expiresAt"], "LOCAL_BINDING_EXPIRED")
        need(
            all(
                value[name] == request[name]
                for name in ("boxId", "boxKeyThumbprint", "ownershipEpoch", "invitationId")
            ),
            "LOCAL_TRUST_IDENTITY_DENIED",
        )
        need(value["requestDigest"] == request_digest(request), "LOCAL_TRUST_IDENTITY_DENIED")
        need(
            all(
                value["target" + name[0].upper() + name[1:] + "Thumbprint"]
                == evidence.public_key_thumbprint(request["target"][name])
                for name in ("accessKey", "approvalKey")
            ),
            "LOCAL_TRUST_IDENTITY_DENIED",
        )
        return value
    except (jwt.PyJWTError, ValueError, TypeError, KeyError):
        need(False, "LOCAL_TRUST_IDENTITY_DENIED")


def _target_policy(value):
    from .local_ledger_protocol import _expiry, capabilities
    from .local_resource_catalog import validate_resource_grants

    evidence._fields(value, TARGET_POLICY_FIELDS)
    capabilities(value["capabilities"])
    validate_resource_grants(value["grants"])
    validate_resource_grants(value["delegableGrants"], empty=True)
    allowed = {row["resourceId"]: set(row["actions"]) for row in value["grants"]}
    need(
        all(
            set(row["actions"]) <= allowed.get(row["resourceId"], set())
            for row in value["delegableGrants"]
        )
    )
    for field in ("expiresAt", "delegationExpiresAt"):
        _expiry(value[field])
    need(
        value["expiresAt"] is None
        or value["delegationExpiresAt"] is not None
        and value["delegationExpiresAt"] <= value["expiresAt"]
    )


def validate_args(action, value):
    need(action in ACTIONS)
    if action in ASSOCIATION_ACTIONS:
        evidence._fields(
            value,
            {"request", "cloudProof"} | ({"cloudPolicy"} if action == "team.activate" else set()),
        )
        validate_request(value["request"])
        need(type(value["cloudProof"]) is str and 1 <= len(value["cloudProof"]) <= 8192)
        if action == "team.activate":
            validate_policy(value["cloudPolicy"])
        need((value["request"]["invitationId"] is not None) == (action == "team.member-admit"))
    elif action == "team.invite-create":
        evidence._fields(value, {"invitationId", "roleId", "targetPolicy", "expiresAt"})
        evidence._digest(value["invitationId"])
        need(value["roleId"] in ("manager", "member"))
        _target_policy(value["targetPolicy"])
        evidence._integer(value["expiresAt"])
    elif action == "team.invite-revoke":
        evidence._fields(value, {"invitationId"})
        evidence._digest(value["invitationId"])
    elif action in ("team.member-role", "team.member-suspend", "team.member-revoke"):
        evidence._fields(
            value, {"principalId"} | ({"roleId"} if action == "team.member-role" else set())
        )
        evidence._token(value["principalId"])
        if action == "team.member-role":
            need(value["roleId"] in ("manager", "member"))
    elif action == "team.resource-set":
        from .local_resource_catalog import validate_resource_grants

        evidence._fields(value, {"resourceId", "expectedRevision", "grants"})
        need(type(value["resourceId"]) is str and value["resourceId"].startswith("team:"))
        validate_resource_grants([{"resourceId": value["resourceId"], "actions": ["read"]}])
        need(type(value["expectedRevision"]) is int and value["expectedRevision"] >= 0)
        need(type(value["grants"]) is list and len(value["grants"]) <= 64)
        ids = []
        for grant in value["grants"]:
            evidence._fields(grant, {"principalId", "actions"})
            evidence._token(grant["principalId"])
            validate_resource_grants(
                [{"resourceId": value["resourceId"], "actions": grant["actions"]}]
            )
            ids.append(grant["principalId"])
        need(ids == sorted(set(ids)))
    elif action == "team.device-resources":
        from .local_resource_catalog import validate_resource_grants

        evidence._fields(value, {"principalId", "bindingId", "expectedBindingRevision", "grants"})
        evidence._token(value["principalId"])
        evidence._token(value["bindingId"])
        evidence._integer(value["expectedBindingRevision"])
        validate_resource_grants(value["grants"])
    elif action == "team.migration-authorize":
        evidence._fields(
            value,
            {
                "principalId",
                "membershipId",
                "planDigest",
                "sourceUserId",
                "targetNamespace",
                "targetBindingId",
                "expiresAt",
            },
        )
        evidence._token(value["principalId"])
        evidence._token(value["targetBindingId"])
        for name in ("membershipId", "planDigest", "targetNamespace"):
            evidence._digest(value[name])
        evidence._integer(value["sourceUserId"])
        evidence._integer(value["expiresAt"])


def sign_request(value, key, *, purpose="request-access"):
    need(purpose in ("request-access", "request-approval"))
    return wire._sign(value, key, "centuarai-team-" + purpose + "+jws", validate_request)


def verify_request(proof, *, purpose="request-access"):
    need(purpose in ("request-access", "request-approval"))
    value = wire._decode(proof, "centuarai-team-" + purpose + "+jws", validate_request)
    evidence._verify(
        proof,
        evidence._public_key(
            value["target"]["accessKey" if purpose == "request-access" else "approvalKey"]
        ),
    )
    return value


def validate_association(value):
    evidence._fields(value, ASSOCIATION_FIELDS)
    need(type(value["schemaVersion"]) is int and value["schemaVersion"] == 1)
    need(value["purpose"] == "centuarai.team.association")
    for field in ("boxId", "issuer", "subject", "clientId", "principalId", "bindingId"):
        evidence._token(value[field])
    for field in (
        "boxKeyThumbprint",
        "cloudProofDigest",
        "clientKeyThumbprint",
        "requestDigest",
        "membershipId",
        "authorityDigest",
        "rosterDigest",
    ):
        evidence._digest(value[field])
    for field in (
        "ownershipEpoch",
        "membershipRevision",
        "rosterVersion",
        "authorizationVersion",
        "issuedAt",
    ):
        evidence._integer(value[field])
    if value["invitationId"] is not None:
        evidence._digest(value["invitationId"])
    if value["expiresAt"] is not None:
        evidence._integer(value["expiresAt"])
    need(value["roleId"] in PERMISSIONS and value["status"] in ("active", "suspended", "revoked"))


def sign_association(value, key):
    return wire._sign(value, key, "centuarai-team-association+jws", validate_association)


def verify_association(proof, key):
    value = wire._decode(proof, "centuarai-team-association+jws", validate_association)
    evidence._verify(proof, evidence._public_key(key))
    return value


def validate_request_read(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "requestId",
            "nonce",
            "issuedAt",
            "expiresAt",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.team-request.read"
    )
    evidence._token(value["boxId"])
    for name in ("boxKeyThumbprint", "requestId", "nonce"):
        evidence._digest(value[name])
    evidence._integer(value["ownershipEpoch"])
    evidence._window(value)
    need(value["expiresAt"] <= value["issuedAt"] + 60)


def sign_request_read(value, key):
    return wire._sign(value, key, "centuarai-team-request-read+jws", validate_request_read)


def decode_request_read(proof):
    return wire._decode(proof, "centuarai-team-request-read+jws", validate_request_read)


def validate_member_summary(value):
    evidence._fields(
        value,
        {
            "membershipId",
            "principalId",
            "issuer",
            "subject",
            "roleId",
            "status",
            "revision",
            "createdAt",
            "expiresAt",
        },
    )
    evidence._digest(value["membershipId"])
    for name in ("principalId", "issuer", "subject"):
        evidence._token(value[name])
    for name in ("revision", "createdAt"):
        evidence._integer(value[name])
    if value["expiresAt"] is not None:
        evidence._integer(value["expiresAt"])
    need(value["roleId"] in PERMISSIONS and value["status"] in ("active", "suspended", "revoked"))


def validate_response_body(kind, value):
    if kind == "team-policy":
        validate_policy(value["policy"])
    elif kind == "self-member":
        if value["member"] is not None:
            validate_member_summary(value["member"])
    elif kind == "team-association":
        need(type(value["receipt"]) is str and 1 <= len(value["receipt"]) <= 16384)
    elif kind == "self-resources":
        from .local_resource_catalog import validate_resource_grants

        for name in ("principalId", "bindingId"):
            evidence._token(value[name])
        evidence._integer(value["bindingRevision"])
        validate_resource_grants(value["approvedGrants"], empty=True)
        available = value["availableGrants"]
        need(type(available) is list and len(available) <= 65)
        need(
            [grant["resourceId"] for grant in available]
            == sorted(set(grant["resourceId"] for grant in available))
        )
        for grant in available:
            validate_resource_grants([grant])
            need(grant["resourceId"].startswith("team:"))
    elif kind == "team-device-review":
        for name in ("requestId", "mutationDigest"):
            evidence._digest(value[name])
        target = value["target"]
        evidence._fields(
            target,
            {
                "bindingId",
                "principalId",
                "clientId",
                "role",
                "bindingRevision",
                "accessKey",
                "approvalKey",
            },
        )
        for name in ("bindingId", "principalId", "clientId"):
            evidence._token(target[name])
        evidence._integer(target["bindingRevision"])
        need(target["role"] in ("use", "manage"))
        evidence._public_key(target["accessKey"])
        if target["role"] == "manage":
            evidence._public_key(target["approvalKey"])
        else:
            need(target["approvalKey"] is None)
    elif kind == "team-state":
        for name in ("members", "invitations", "resources", "requests"):
            need(type(value[name]) is list and len(value[name]) <= 128)
        for member in value["members"]:
            validate_member_summary(member)
        for invitation in value["invitations"]:
            evidence._fields(
                invitation,
                {
                    "invitationId",
                    "roleId",
                    "targetPolicy",
                    "expiresAt",
                    "status",
                    "revision",
                    "createdAt",
                    "usedByMembershipId",
                },
            )
            validate_args(
                "team.invite-create",
                {
                    key: invitation[key]
                    for key in ("invitationId", "roleId", "targetPolicy", "expiresAt")
                },
            )
            need(invitation["status"] in ("pending", "used", "revoked", "expired"))
            for name in ("revision", "createdAt"):
                evidence._integer(invitation[name])
            if invitation["usedByMembershipId"] is not None:
                evidence._digest(invitation["usedByMembershipId"])
        for resource in value["resources"]:
            evidence._fields(resource, {"resourceId", "revision", "grants"})
            evidence._integer(resource["revision"])
            validate_args(
                "team.resource-set",
                {
                    "resourceId": resource["resourceId"],
                    "expectedRevision": resource["revision"],
                    "grants": resource["grants"],
                },
            )
        for request in value["requests"]:
            evidence._fields(
                request,
                {"requestId", "principalId", "invitationId", "subject", "expiresAt", "state"},
            )
            for name in ("requestId", "invitationId"):
                evidence._digest(request[name])
            for name in ("principalId", "subject"):
                evidence._token(request[name])
            evidence._integer(request["expiresAt"])
            need(request["state"] == "pending")
    elif kind in ("team-request", "team-request-receipt"):
        evidence._digest(value["requestId"])
        evidence._integer(value["expiresAt"])
        need(value["state"] in ("pending", "approved", "expired", "cancelled"))
        if kind == "team-request":
            validate_request(value["request"])
            need(request_digest(value["request"]) == value["requestId"])
            need(type(value["cloudProof"]) is str and 1 <= len(value["cloudProof"]) <= 8192)
            for name in ("review", "targetAccessProof", "targetApprovalProof", "receipt"):
                need(
                    value[name] is None
                    or type(value[name]) is str
                    and 1 <= len(value[name]) <= 16384
                )
    else:
        need(False)

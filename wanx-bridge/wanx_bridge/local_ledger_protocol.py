"""Finite v2 ledger wire domains. Validation never establishes actor authority."""

from __future__ import annotations

from cryptography.hazmat.primitives.asymmetric import rsa

from . import local_management_protocol as wire
from . import local_team_protocol as team_protocol
from . import local_trust_protocol as evidence
from .local_resource_catalog import validate_resource_grants

CAPABILITIES = frozenset(
    {
        "backup.create",
        "backup.restore",
        "device.approve_manage",
        "device.approve_use",
        "device.review_descendants",
        "device.revoke",
        "member.invite",
        "member.revoke",
        "ownership.transfer",
        "recovery.configure",
    }
)
INVITED_CAPABILITIES = CAPABILITIES - {"member.invite", "member.revoke", "ownership.transfer"}
ACTIONS = frozenset(
    {
        "owner-policy.activate-v2",
        "device.add-manager",
        "principal.invite",
        "device.revoke",
        "device.review-descendants",
        "principal.revoke",
        "recovery.setup",
        "recovery.rotate",
        "recovery.recover",
        "backup.create",
        "backup.restore",
        "ownership.transfer-prepare",
        "network-wifi.authorize",
        "network-wifi.revoke",
    }
)
ACTIONS |= team_protocol.ACTIONS
TYPES = {
    name: "centuarai-local-ledger-" + name + "+jws"
    for name in (
        "prepare",
        "mutation",
        "target-access",
        "target-approval",
        "recovery-material",
        "source-recovery",
        "read",
        "response",
    )
}
TYPES["auth-challenge"] = "centuarai-local-ledger.auth-challenge+jws"
TYPES["auth-mutation-challenge"] = "centuarai-local-ledger.auth-mutation-challenge+jws"
PROOF_FIELDS = {
    "mutationProof",
    "targetAccessProof",
    "targetApprovalProof",
    "recoveryMaterialProof",
    "sourceRecoveryProof",
}
_COMMON = evidence._BOX_FIELDS | {
    "schemaVersion",
    "purpose",
    "requestId",
    "challenge",
    "issuedAt",
    "expiresAt",
    "actor",
    "action",
    "args",
}


def capabilities(value):
    evidence._require(
        type(value) is list
        and len(value) <= len(CAPABILITIES)
        and all(type(item) is str and item in CAPABILITIES for item in value)
    )
    evidence._require(value == sorted(set(value)))


def actor(value):
    evidence._fields(value, {"kind", "principalId", "bindingId", "keyVersion"})
    evidence._require(value["kind"] in ("binding", "recovery"))
    evidence._token(value["principalId"])
    evidence._integer(value["keyVersion"])
    if value["kind"] == "binding":
        evidence._token(value["bindingId"])
    else:
        evidence._require(value["bindingId"] is None)


def _counter(value):
    evidence._require(type(value) is int and 0 <= value <= evidence.SAFE_INTEGER)


def _tokens(value, *, minimum=1, maximum=16):
    evidence._require(type(value) is list and minimum <= len(value) <= maximum)
    for item in value:
        evidence._token(item)
    evidence._require(value == sorted(set(value)))


def _expiry(value):
    if value is not None:
        evidence._integer(value)


def rsa_public_key(value):
    evidence._fields(value, {"kty", "n", "e"})
    evidence._require(value["kty"] == "RSA" and value["e"] == "AQAB")
    modulus = evidence._decode(value["n"], 384)
    number = int.from_bytes(modulus, "big")
    evidence._require(number.bit_length() == 3072 and number % 2 == 1)
    return rsa.RSAPublicNumbers(65537, number).public_key()


def recovery(value):
    evidence._fields(value, {"recoveryId", "version", "signingKey", "backupKey"})
    evidence._digest(value["recoveryId"])
    evidence._integer(value["version"])
    evidence._public_key(value["signingKey"])
    rsa_public_key(value["backupKey"])


def target(value, *, full=True):
    fields = {"clientId", "accessKey", "approvalKey", "keyProtection"}
    if full:
        fields |= {"capabilities", "grants", "delegableGrants", "expiresAt", "delegationExpiresAt"}
    evidence._fields(value, fields)
    evidence._token(value["clientId"])
    evidence._require(value["keyProtection"] == "software-passphrase-v1")
    evidence._require(
        evidence.public_key_thumbprint(value["accessKey"])
        != evidence.public_key_thumbprint(value["approvalKey"])
    )
    if full:
        capabilities(value["capabilities"])
        validate_resource_grants(value["grants"])
        validate_resource_grants(value["delegableGrants"], empty=True)
        _expiry(value["expiresAt"])
        _expiry(value["delegationExpiresAt"])
        allowed = {grant["resourceId"]: set(grant["actions"]) for grant in value["grants"]}
        evidence._require(
            all(
                set(grant["actions"]) <= allowed.get(grant["resourceId"], set())
                for grant in value["delegableGrants"]
            )
        )
        evidence._require(
            value["expiresAt"] is None
            or value["delegationExpiresAt"] is not None
            and value["delegationExpiresAt"] <= value["expiresAt"]
        )


def validate_args(action, value):
    evidence._require(type(action) is str and action in ACTIONS)
    if action in team_protocol.ACTIONS:
        return team_protocol.validate_args(action, value)
    if action == "network-wifi.authorize":
        evidence._fields(value, {"bindingId", "expiresAt", "delegable"})
        evidence._token(value["bindingId"])
        _expiry(value["expiresAt"])
        evidence._require(type(value["delegable"]) is bool)
    elif action == "network-wifi.revoke":
        evidence._fields(value, {"bindingId"})
        evidence._token(value["bindingId"])
    elif action == "owner-policy.activate-v2":
        evidence._fields(value, {"capabilities"})
        capabilities(value["capabilities"])
        evidence._require("device.approve_use" in value["capabilities"])
    elif action in ("device.add-manager", "principal.invite"):
        evidence._fields(
            value, {"target"} | ({"principalId"} if action == "principal.invite" else set())
        )
        if action == "principal.invite":
            evidence._token(value["principalId"])
        target(value["target"])
        # This release deliberately closes cross-principal network delegation.
        if action == "principal.invite":
            evidence._require(
                all(item["resourceId"] != "network:wifi" for item in value["target"]["grants"])
            )
    elif action == "device.revoke":
        evidence._fields(value, {"bindingId", "mode"})
        evidence._token(value["bindingId"])
        evidence._require(value["mode"] in ("normal", "emergency-lock"))
    elif action == "device.review-descendants":
        evidence._fields(value, {"bindingIds"})
        _tokens(value["bindingIds"])
    elif action == "principal.revoke":
        evidence._fields(value, {"principalId"})
        evidence._token(value["principalId"])
    elif action in ("recovery.setup", "recovery.rotate", "recovery.recover"):
        fields = {"expectedRecoveryVersion", "newRecovery"}
        if action == "recovery.recover":
            fields |= {"expectedPrincipalSecurityVersion", "target"}
        evidence._fields(value, fields)
        _counter(value["expectedRecoveryVersion"])
        recovery(value["newRecovery"])
        evidence._require(value["newRecovery"]["version"] == value["expectedRecoveryVersion"] + 1)
        evidence._require(
            value["expectedRecoveryVersion"] == 0
            if action == "recovery.setup"
            else value["expectedRecoveryVersion"] > 0
        )
        if action == "recovery.recover":
            evidence._integer(value["expectedPrincipalSecurityVersion"])
            target(value["target"], full=False)
    elif action == "ownership.transfer-prepare":
        evidence._fields(
            value,
            {
                "transferId",
                "dataDisposition",
                "expectedOwnerPrincipalId",
                "scopeManifestDigest",
                "retainedIndependentBackups",
            },
        )
        evidence._digest(value["transferId"])
        evidence._digest(value["scopeManifestDigest"])
        evidence._token(value["expectedOwnerPrincipalId"])
        evidence._require(
            value["dataDisposition"] == "erase-local"
            and value["retainedIndependentBackups"] is True
        )
    elif action == "backup.create":
        evidence._fields(
            value,
            {
                "scopeProfile",
                "resourceIds",
                "expectedRecoveryVersion",
                "recipientKeyThumbprint",
                "targetId",
                "includeBusinessSecrets",
            },
        )
        evidence._token(value["scopeProfile"])
        evidence._token(value["targetId"])
        _tokens(value["resourceIds"])
        evidence._require("network:wifi" not in value["resourceIds"])
        evidence._integer(value["expectedRecoveryVersion"])
        evidence._digest(value["recipientKeyThumbprint"])
        evidence._require(type(value["includeBusinessSecrets"]) is bool)
    else:
        evidence._fields(
            value,
            {
                "backupId",
                "archiveSha256",
                "sourceBoxKeyThumbprint",
                "manifestSha256",
                "targetDescriptorDigest",
                "scopeProfile",
                "resourceIds",
                "ownerMapping",
                "sourceId",
            },
        )
        for name in (
            "backupId",
            "archiveSha256",
            "sourceBoxKeyThumbprint",
            "manifestSha256",
            "targetDescriptorDigest",
        ):
            evidence._digest(value[name])
        for name in ("scopeProfile", "sourceId"):
            evidence._token(value[name])
        _tokens(value["resourceIds"])
        evidence._require("network:wifi" not in value["resourceIds"])
        mapping = value["ownerMapping"]
        evidence._require(type(mapping) is list and 1 <= len(mapping) <= 16)
        identifiers = []
        for item in mapping:
            evidence._fields(item, {"sourcePrincipalId", "targetPrincipalId", "resourceIds"})
            evidence._token(item["sourcePrincipalId"])
            evidence._token(item["targetPrincipalId"])
            _tokens(item["resourceIds"])
            identifiers.append((item["sourcePrincipalId"], item["targetPrincipalId"]))
        evidence._require(identifiers == sorted(set(identifiers)))


def validate_prepare(value):
    _common(value, mutation=False)


def validate_mutation(value):
    _common(value, mutation=True)


def _common(value, *, mutation):
    evidence._fields(value, _COMMON | ({"effectsDigest"} if mutation else set()))
    evidence._require(type(value["schemaVersion"]) is int and value["schemaVersion"] == 2)
    evidence._require(
        value["purpose"] == "centuarai.local-ledger." + ("mutation" if mutation else "prepare")
    )
    evidence.validate_box_context({key: value[key] for key in evidence._BOX_FIELDS})
    for field in ("requestId", "challenge"):
        evidence._digest(value[field])
    evidence._window(value)
    actor(value["actor"])
    validate_args(value["action"], value["args"])
    if mutation:
        evidence._digest(value["effectsDigest"])


def decode_prepare(proof):
    return wire._decode(proof, TYPES["prepare"], validate_prepare)


def verify_prepare(proof, key):
    value = decode_prepare(proof)
    evidence._verify(proof, evidence._public_key(key))
    return value


def decode_mutation(proof):
    return wire._decode(proof, TYPES["mutation"], validate_mutation)


def verify_mutation(proof, key):
    value = decode_mutation(proof)
    evidence._verify(proof, evidence._public_key(key))
    return value


def verify_additional_proof(proof, mutation, key, *, purpose):
    evidence._require(
        purpose in ("target-access", "target-approval", "recovery-material", "source-recovery")
    )
    value = wire._decode(proof, TYPES[purpose], validate_mutation)
    evidence._require(value == mutation, "LOCAL_BINDING_CONTEXT_MISMATCH")
    evidence._verify(proof, evidence._public_key(key))


def sign_prepare(value, key):
    return wire._sign(value, key, TYPES["prepare"], validate_prepare)


def sign_mutation(value, key, *, purpose="mutation"):
    evidence._require(
        purpose
        in ("mutation", "target-access", "target-approval", "recovery-material", "source-recovery")
    )
    return wire._sign(value, key, TYPES[purpose], validate_mutation)


def validate_read(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "nonce",
            "issuedAt",
            "expiresAt",
            "actor",
            "operation",
            "requestId",
            "bindingId",
        },
    )
    evidence._require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 2
        and value["purpose"] == "centuarai.local-ledger.read"
    )
    evidence._token(value["boxId"])
    evidence._digest(value["boxKeyThumbprint"])
    evidence._integer(value["ownershipEpoch"])
    evidence._digest(value["nonce"])
    evidence._window(value)
    evidence._require(value["expiresAt"] <= value["issuedAt"] + 60)
    actor(value["actor"])
    operation = value["operation"]
    evidence._require(
        operation
        in (
            "self-binding",
            "principal-state",
            "membership-directory",
            "mutation-status",
            "operation-status",
            "transfer-status",
            "data-effect",
            "recovery-state",
            *sorted(team_protocol.READ_OPERATIONS),
        )
    )
    if operation == "self-binding":
        evidence._require(
            value["actor"]["kind"] == "binding"
            and value["bindingId"] == value["actor"]["bindingId"]
            and value["requestId"] is None
        )
    elif operation in (
        "mutation-status",
        "operation-status",
        "transfer-status",
        "data-effect",
        "team-association",
        "team-request",
        "team-device-review",
    ):
        evidence._digest(value["requestId"])
        evidence._require(value["bindingId"] is None)
    else:
        evidence._require(value["requestId"] is None and value["bindingId"] is None)


def validate_auth_challenge(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "actor",
            "clientNonce",
            "issuedAt",
            "expiresAt",
        },
    )
    evidence._require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 2
        and value["purpose"] == "centuarai.local-ledger.auth-challenge"
    )
    evidence._token(value["boxId"])
    evidence._digest(value["boxKeyThumbprint"])
    evidence._digest(value["clientNonce"])
    actor(value["actor"])
    if value["ownershipEpoch"] is None:
        evidence._require(value["actor"]["kind"] == "recovery")
    else:
        evidence._integer(value["ownershipEpoch"])
    evidence._window(value)
    evidence._require(value["expiresAt"] <= value["issuedAt"] + 60)


def decode_auth_challenge(proof):
    return wire._decode(proof, TYPES["auth-challenge"], validate_auth_challenge)


def sign_auth_challenge(value, key):
    return wire._sign(value, key, TYPES["auth-challenge"], validate_auth_challenge)


def verify_auth_challenge(proof, key):
    value = decode_auth_challenge(proof)
    evidence._verify(proof, evidence._public_key(key))
    return value


def validate_auth_mutation_challenge(value):
    evidence._require(
        type(value) is dict
        and "action" in value
        and type(value["action"]) is str
        and value["action"] in ACTIONS
    )
    copy = dict(value)
    del copy["action"]
    evidence._require(copy.get("purpose") == "centuarai.local-ledger.auth-mutation-challenge")
    copy["purpose"] = "centuarai.local-ledger.auth-challenge"
    validate_auth_challenge(copy)


def decode_auth_mutation_challenge(proof):
    return wire._decode(proof, TYPES["auth-mutation-challenge"], validate_auth_mutation_challenge)


def sign_auth_mutation_challenge(value, key):
    return wire._sign(
        value, key, TYPES["auth-mutation-challenge"], validate_auth_mutation_challenge
    )


def verify_auth_mutation_challenge(proof, key):
    value = decode_auth_mutation_challenge(proof)
    evidence._verify(proof, evidence._public_key(key))
    return value


def decode_read(proof):
    return wire._decode(proof, TYPES["read"], validate_read)


def verify_read(proof, key):
    value = decode_read(proof)
    evidence._verify(proof, evidence._public_key(key))
    return value


def sign_read(value, key):
    return wire._sign(value, key, TYPES["read"], validate_read)


_EFFECT_FIELDS = {
    "targetPrincipalId",
    "targetBindingIds",
    "targetSummaries",
    "revokedBindings",
    "suspendedBindings",
    "invalidatedRequests",
    "principalSecurityVersionBefore",
    "principalSecurityVersionAfter",
    "recoveryVersionBefore",
    "recoveryVersionAfter",
    "recoveryBefore",
    "recoveryAfter",
    "remainingIndependentManagers",
    "verifiedRecoveryAvailable",
    "grantsBefore",
    "grantsAfter",
    "capabilitiesBefore",
    "capabilitiesAfter",
    "resultingAuthority",
    "redacted",
    "ownershipStateAfter",
    "requiresVerifiedErase",
}
_RECOVERY_FIELDS = {
    "principalId",
    "recoveryId",
    "version",
    "status",
    "signingKey",
    "backupKey",
    "grants",
    "delegableGrants",
    "capabilities",
    "expiresAt",
    "delegationExpiresAt",
    "establishedAt",
    "establishedSequence",
    "retiredAtSequence",
}
_COMMIT_DERIVED = {"establishedAt", "establishedSequence", "retiredAtSequence"}


def public_recovery(value, *, review=False):
    evidence._fields(value, _RECOVERY_FIELDS - _COMMIT_DERIVED if review else _RECOVERY_FIELDS)
    evidence._token(value["principalId"])
    evidence._digest(value["recoveryId"])
    evidence._integer(value["version"])
    evidence._require(value["status"] in ("active", "retired"))
    evidence._public_key(value["signingKey"])
    rsa_public_key(value["backupKey"])
    validate_resource_grants(value["grants"], empty=True)
    validate_resource_grants(value["delegableGrants"], empty=True)
    capabilities(value["capabilities"])
    _expiry(value["expiresAt"])
    _expiry(value["delegationExpiresAt"])
    if not review:
        evidence._integer(value["establishedAt"])
        evidence._integer(value["establishedSequence"])
        _expiry(value["retiredAtSequence"])


def principal_record(value):
    evidence._fields(
        value,
        {
            "principalId",
            "ownershipEpoch",
            "status",
            "principalSecurityVersion",
            "createdSequence",
            "recoveryVersion",
        },
    )
    evidence._token(value["principalId"])
    evidence._require(value["status"] in ("active", "suspended", "revoked"))
    for field in ("ownershipEpoch", "principalSecurityVersion", "createdSequence"):
        evidence._integer(value[field])
    _counter(value["recoveryVersion"])


def binding_record(value, context):
    extensions = {
        "bindingRevision",
        "ownershipEpoch",
        "capabilities",
        "createdByBindingId",
        "createdByRecoveryId",
        "sourceRequestId",
        "sourceEventSequence",
    }
    evidence._fields(value, evidence._BINDING_FIELDS | extensions)
    evidence._roster(
        {**context, "bindings": [{key: value[key] for key in evidence._BINDING_FIELDS}]}
    )
    for field in ("bindingRevision", "ownershipEpoch", "sourceEventSequence"):
        evidence._integer(value[field])
    capabilities(value["capabilities"])
    if value["createdByBindingId"] is not None:
        evidence._token(value["createdByBindingId"])
    if value["createdByRecoveryId"] is not None:
        evidence._digest(value["createdByRecoveryId"])
    evidence._digest(value["sourceRequestId"])
    evidence._require(
        value["canApproveUseDevices"] == ("device.approve_use" in value["capabilities"])
    )
    if value["role"] == "use":
        evidence._require(
            value["approvalKey"] is None
            and not value["capabilities"]
            and not value["delegableGrants"]
        )
    else:
        evidence._require(value["approvalKey"] is not None)


def resource_grant(value):
    evidence._fields(
        value,
        {
            "grantId",
            "ownershipEpoch",
            "principalId",
            "bindingId",
            "resourceId",
            "resourceScope",
            "resourceNamespaceId",
            "actions",
            "delegableActions",
            "expiresAt",
            "delegationExpiresAt",
            "status",
            "sourceGrantIds",
            "sourceBindingId",
            "createdSequence",
            "revision",
        },
    )
    for field in ("grantId", "principalId", "resourceId", "resourceNamespaceId"):
        evidence._token(value[field])
    for field in ("bindingId", "sourceBindingId"):
        if value[field] is not None:
            evidence._token(value[field])
    for field in ("ownershipEpoch", "createdSequence", "revision"):
        evidence._integer(value[field])
    _tokens(value["sourceGrantIds"], minimum=0, maximum=256)
    evidence._require(
        value["resourceScope"] in ("principal-private", "shared", "team-shared")
        and value["status"] in ("active", "suspended", "revoked")
    )
    validate_resource_grants([{"resourceId": value["resourceId"], "actions": value["actions"]}])
    evidence._require(
        type(value["delegableActions"]) is list
        and all(type(item) is str for item in value["delegableActions"])
        and value["delegableActions"] == sorted(set(value["delegableActions"]))
    )
    evidence._require(set(value["delegableActions"]) <= set(value["actions"]))
    _expiry(value["expiresAt"])
    _expiry(value["delegationExpiresAt"])


def _sorted_records(values, field, validator):
    evidence._require(type(values) is list and len(values) <= 4096)
    for row in values:
        validator(row)
    ids = [row[field] for row in values]
    evidence._require(ids == sorted(set(ids)))


def validate_effects(value):
    evidence._fields(value, _EFFECT_FIELDS)
    if value["targetPrincipalId"] is not None:
        evidence._token(value["targetPrincipalId"])
    _tokens(value["targetBindingIds"], minimum=0)
    for field in ("revokedBindings", "suspendedBindings", "invalidatedRequests"):
        evidence._fields(value[field], {"count", "digest"})
        _counter(value[field]["count"])
        evidence._digest(value[field]["digest"])
    for field in ("principalSecurityVersionBefore", "principalSecurityVersionAfter"):
        _expiry(value[field])
    for field in ("recoveryVersionBefore", "recoveryVersionAfter"):
        if value[field] is not None:
            _counter(value[field])
    for field in ("recoveryBefore", "recoveryAfter"):
        if value[field] is not None:
            public_recovery(value[field], review=True)
    _counter(value["remainingIndependentManagers"])
    for field in ("verifiedRecoveryAvailable", "redacted", "requiresVerifiedErase"):
        evidence._require(type(value[field]) is bool)
    for field in ("grantsBefore", "grantsAfter"):
        if value[field] is not None:
            validate_resource_grants(value[field], empty=True)
    for field in ("capabilitiesBefore", "capabilitiesAfter"):
        if value[field] is not None:
            capabilities(value[field])
    evidence._require(
        value["ownershipStateAfter"]
        in ("unclaimed_ready", "owned", "transfer_frozen", "erase_pending")
    )
    summaries = value["targetSummaries"]
    evidence._require(type(summaries) is list and len(summaries) <= 16)
    for item in summaries:
        evidence._fields(
            item,
            {
                "bindingId",
                "principalId",
                "clientId",
                "role",
                "accessKeyThumbprint",
                "approvalKeyThumbprint",
                "bindingRevision",
                "status",
                "capabilities",
                "expiresAt",
                "delegationExpiresAt",
            },
        )
        for field in ("bindingId", "principalId", "clientId"):
            evidence._token(item[field])
        evidence._digest(item["accessKeyThumbprint"])
        if item["approvalKeyThumbprint"] is not None:
            evidence._digest(item["approvalKeyThumbprint"])
        evidence._integer(item["bindingRevision"])
        evidence._require(
            item["role"] in ("manage", "use")
            and item["status"] in ("active", "suspended", "revoked")
        )
        capabilities(item["capabilities"])
        _expiry(item["expiresAt"])
        _expiry(item["delegationExpiresAt"])
    authority = value["resultingAuthority"]
    if authority is not None:
        evidence._fields(
            authority,
            {"grants", "delegableGrants", "expiresAt", "delegationExpiresAt", "capabilities"},
        )
        validate_resource_grants(authority["grants"], empty=True)
        validate_resource_grants(authority["delegableGrants"], empty=True)
        capabilities(authority["capabilities"])
        _expiry(authority["expiresAt"])
        _expiry(authority["delegationExpiresAt"])


def validate_response(value):
    evidence._fields(
        value, {"schemaVersion", "purpose", "boxId", "boxKeyThumbprint", "kind", "issuedAt", "body"}
    )
    evidence._require(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 2
        and value["purpose"] == "centuarai.local-ledger.response"
    )
    evidence._token(value["boxId"])
    evidence._digest(value["boxKeyThumbprint"])
    evidence._integer(value["issuedAt"])
    fields = {
        "mutation-challenge": {"context", "actor", "action", "challenge", "issuedAt", "expiresAt"},
        "mutation-review": {"mutation", "effects"},
        "mutation-ack": {
            "requestId",
            "mutationDigest",
            "action",
            "effectsDigest",
            "eventId",
            "eventDigest",
            "ownershipEpoch",
            "rosterVersion",
            "rosterDigest",
            "policyVersion",
            "authorizationVersion",
            "committedAt",
            "ownershipState",
            "result",
        },
        "read-challenge": {"context", "nonce", "issuedAt", "expiresAt"},
        "self-binding": {
            "bindingId",
            "principalId",
            "clientId",
            "bindingOwnershipEpoch",
            "currentContext",
            "status",
            "principalStatus",
            "ownershipState",
            "bindingRevision",
            "principalSecurityVersion",
            "authorizationVersion",
        },
        "principal-state": {"context", "projection", "projectionDigest"},
        "membership-directory": {"context", "members"},
        "mutation-status": {"requestId", "mutationDigest", "action", "state", "ack"},
        "recovery-state": {"principalId", "principalSecurityVersion", "configuration"},
        "operation-status": {"status", "operationEventDigest"},
        "transfer-status": {
            "requestId",
            "transferId",
            "state",
            "sourceOwnershipEpoch",
            "checkpoint",
            "updatedAt",
            "resetEvidenceDigest",
            "preparedDeliveryDigest",
        },
        "migration-ack": {
            "fromSchema",
            "toSchema",
            "sourceCheckpoint",
            "context",
            "eventDigest",
            "authorizationVersion",
        },
        "checkpoint": {"context", "eventDigest", "authorizationVersion"},
        "restore-key-received": {"operationId", "archiveSha256", "receivedAt"},
        "team-policy": {"context", "policy"},
        "team-state": {"context", "members", "invitations", "resources", "requests"},
        "self-member": {"context", "member"},
        "self-resources": {
            "context",
            "principalId",
            "bindingId",
            "bindingRevision",
            "approvedGrants",
            "availableGrants",
        },
        "team-device-review": {"context", "requestId", "mutationDigest", "target"},
        "team-association": {"receipt"},
        "team-request": {
            "requestId",
            "request",
            "cloudProof",
            "state",
            "expiresAt",
            "review",
            "targetAccessProof",
            "targetApprovalProof",
            "receipt",
        },
        "team-request-receipt": {"requestId", "state", "expiresAt"},
        "migration-consumed": {
            "requestId",
            "planDigest",
            "principalId",
            "membershipId",
            "ownershipEpoch",
            "consumedAt",
        },
    }
    kind = value["kind"]
    evidence._require(type(kind) is str and kind in fields)
    body = value["body"]
    evidence._fields(body, fields[kind])
    if "context" in body:
        evidence.validate_box_context(body["context"])
        evidence._require(
            body["context"]["boxId"] == value["boxId"]
            and body["context"]["boxKeyThumbprint"] == value["boxKeyThumbprint"]
        )
    if kind == "migration-consumed":
        for name in ("requestId", "planDigest", "membershipId"):
            evidence._digest(body[name])
        evidence._token(body["principalId"])
        evidence._integer(body["ownershipEpoch"])
        evidence._integer(body["consumedAt"])
        evidence._require(body["consumedAt"] == value["issuedAt"])
    elif kind.startswith("team-") or kind in ("self-member", "self-resources"):
        team_protocol.validate_response_body(kind, body)
    elif kind == "transfer-status":
        for field in ("requestId", "transferId"):
            evidence._digest(body[field])
        evidence._integer(body["sourceOwnershipEpoch"])
        evidence._integer(body["updatedAt"])
        evidence._require(
            body["updatedAt"] <= value["issuedAt"]
            and body["state"] in ("frozen", "erase_pending", "redelivery_ready")
        )
        checkpoint = body["checkpoint"]
        evidence._fields(checkpoint, {"context", "eventDigest", "authorizationVersion"})
        evidence.validate_box_context(checkpoint["context"])
        evidence._digest(checkpoint["eventDigest"])
        evidence._integer(checkpoint["authorizationVersion"])
        evidence._require(
            checkpoint["context"]["boxId"] == value["boxId"]
            and checkpoint["context"]["boxKeyThumbprint"] == value["boxKeyThumbprint"]
            and checkpoint["context"]["ownershipEpoch"]
            == body["sourceOwnershipEpoch"] + (1 if body["state"] == "redelivery_ready" else 0)
        )
        for field in ("resetEvidenceDigest", "preparedDeliveryDigest"):
            if body[field] is not None:
                evidence._digest(body[field])
        evidence._require(
            (body["resetEvidenceDigest"] is None) == (body["state"] == "frozen")
            and (body["preparedDeliveryDigest"] is None) == (body["state"] != "redelivery_ready")
        )
    elif kind in ("mutation-challenge", "read-challenge"):
        evidence._window(body)
        evidence._digest(body["challenge"] if kind == "mutation-challenge" else body["nonce"])
        evidence._require(body["issuedAt"] == value["issuedAt"])
        if kind == "mutation-challenge":
            actor(body["actor"])
            evidence._require(body["action"] in ACTIONS)
        else:
            evidence._require(body["expiresAt"] <= body["issuedAt"] + 60)
    elif kind == "mutation-review":
        validate_mutation(body["mutation"])
        validate_effects(body["effects"])
        evidence._require(wire.digest(body["effects"]) == body["mutation"]["effectsDigest"])
    elif kind == "mutation-ack":
        for name in ("requestId", "mutationDigest", "effectsDigest", "eventDigest", "rosterDigest"):
            evidence._digest(body[name])
        evidence._token(body["eventId"])
        evidence._require(body["action"] in ACTIONS)
        for name in (
            "ownershipEpoch",
            "rosterVersion",
            "policyVersion",
            "authorizationVersion",
            "committedAt",
        ):
            evidence._integer(body[name])
        evidence._fields(
            body["result"],
            {
                "principalId",
                "bindingId",
                "principalSecurityVersion",
                "recoveryVersion",
                "transferId",
                "operationId",
            },
        )
        for name in ("principalId", "bindingId"):
            if body["result"][name] is not None:
                evidence._token(body["result"][name])
        _expiry(body["result"]["principalSecurityVersion"])
        if body["result"]["recoveryVersion"] is not None:
            _counter(body["result"]["recoveryVersion"])
        for name in ("transferId", "operationId"):
            if body["result"][name] is not None:
                evidence._digest(body["result"][name])
        evidence._require(
            body["ownershipState"]
            in ("owned", "transfer_frozen", "erase_pending", "unclaimed_ready")
            and body["committedAt"] == value["issuedAt"]
        )
    elif kind == "principal-state":
        projection = body["projection"]
        evidence._fields(
            projection,
            {
                "principal",
                "ownershipView",
                "bindings",
                "grants",
                "recoverySummary",
                "qualifiedOriginalOwnerRoot",
            },
        )
        principal_record(projection["principal"])
        evidence._fields(
            projection["ownershipView"],
            {"ownershipEpoch", "state", "isOwnerPrincipal", "allowedOwnerActions"},
        )
        ownership = projection["ownershipView"]
        evidence._integer(ownership["ownershipEpoch"])
        evidence._require(
            ownership["ownershipEpoch"] == body["context"]["ownershipEpoch"]
            and ownership["state"]
            in ("owned", "transfer_frozen", "erase_pending", "unclaimed_ready")
            and type(ownership["isOwnerPrincipal"]) is bool
        )
        capabilities(ownership["allowedOwnerActions"])
        evidence._require(
            set(ownership["allowedOwnerActions"])
            <= {"member.invite", "member.revoke", "ownership.transfer"}
        )
        _sorted_records(
            projection["bindings"], "bindingId", lambda row: binding_record(row, body["context"])
        )
        _sorted_records(projection["grants"], "grantId", resource_grant)
        evidence._require(
            all(
                row["principalId"] == projection["principal"]["principalId"]
                for row in projection["bindings"] + projection["grants"]
            )
        )
        if projection["recoverySummary"] is not None:
            public_recovery(projection["recoverySummary"])
            evidence._require(
                projection["recoverySummary"]["principalId"]
                == projection["principal"]["principalId"]
                and projection["recoverySummary"]["status"] == "active"
            )
        evidence._require(
            type(projection["qualifiedOriginalOwnerRoot"]) is bool
            and wire.digest(projection) == body["projectionDigest"]
        )
    elif kind == "self-binding":
        for name in ("bindingId", "principalId", "clientId"):
            evidence._token(body[name])
        for name in (
            "bindingOwnershipEpoch",
            "bindingRevision",
            "principalSecurityVersion",
            "authorizationVersion",
        ):
            evidence._integer(body[name])
        evidence.validate_box_context(body["currentContext"])
        evidence._require(
            body["currentContext"]["boxId"] == value["boxId"]
            and body["currentContext"]["boxKeyThumbprint"] == value["boxKeyThumbprint"]
            and body["status"] in ("active", "suspended", "revoked")
            and body["principalStatus"] in ("active", "suspended", "revoked")
            and body["ownershipState"]
            in ("owned", "transfer_frozen", "erase_pending", "unclaimed_ready")
        )
    elif kind == "membership-directory":

        def member(row):
            evidence._fields(
                row, {"principalId", "status", "createdSequence", "createdEventDigest"}
            )
            evidence._token(row["principalId"])
            evidence._integer(row["createdSequence"])
            evidence._digest(row["createdEventDigest"])
            evidence._require(row["status"] in ("active", "suspended", "revoked"))

        _sorted_records(body["members"], "principalId", member)
    elif kind == "mutation-status":
        for name in ("requestId", "mutationDigest"):
            evidence._digest(body[name])
        evidence._require(
            body["action"] in ACTIONS
            and body["state"] in ("prepared", "committed", "cancelled", "expired")
        )
        if body["state"] == "committed":
            ack = wire._decode(body["ack"], TYPES["response"], validate_response)
            evidence._require(
                ack["kind"] == "mutation-ack"
                and ack["boxId"] == value["boxId"]
                and ack["boxKeyThumbprint"] == value["boxKeyThumbprint"]
                and all(
                    ack["body"][name] == body[name]
                    for name in ("requestId", "mutationDigest", "action")
                )
            )
        else:
            evidence._require(body["ack"] is None)
    elif kind == "recovery-state":
        evidence._token(body["principalId"])
        evidence._integer(body["principalSecurityVersion"])
        if body["configuration"] is not None:
            public_recovery(body["configuration"])
            evidence._require(
                body["configuration"]["principalId"] == body["principalId"]
                and body["configuration"]["status"] == "active"
            )
    elif kind in ("migration-ack", "checkpoint"):
        evidence._digest(body["eventDigest"])
        evidence._integer(body["authorizationVersion"])
        if kind == "migration-ack":
            evidence._require(
                type(body["fromSchema"]) is int
                and body["fromSchema"] == 1
                and type(body["toSchema"]) is int
                and body["toSchema"] == 2
            )
            source = body["sourceCheckpoint"]
            evidence._fields(
                source, {"ownershipEpoch", "rosterVersion", "rosterDigest", "eventDigest"}
            )
            evidence._integer(source["ownershipEpoch"])
            _counter(source["rosterVersion"])
            evidence._digest(source["rosterDigest"])
            evidence._digest(source["eventDigest"])
    elif kind == "operation-status":
        from .local_ledger_operations import operation_status

        operation_status(body["status"])
        evidence._digest(body["operationEventDigest"])
        evidence._require(body["status"]["updatedAt"] == value["issuedAt"])
    elif kind == "restore-key-received":
        evidence._digest(body["operationId"])
        evidence._digest(body["archiveSha256"])
        evidence._integer(body["receivedAt"])
        evidence._require(body["receivedAt"] == value["issuedAt"])
    wire.canonical(value)


def sign_response(owner, kind, body, now):
    payload = {
        "schemaVersion": 2,
        "purpose": "centuarai.local-ledger.response",
        "boxId": owner.bundle["boxId"],
        "boxKeyThumbprint": evidence.public_key_thumbprint(owner.bundle["boxKey"]),
        "kind": kind,
        "issuedAt": now,
        "body": body,
    }
    typ, maximum = _response_encoding(kind)
    return wire._sign(payload, owner._key, typ, validate_response, max_bytes=maximum)


def _response_encoding(kind):
    # A fixed operation returns several individually bounded proofs for review.
    # It cannot enlarge any request, mutation or ordinary response proof.
    if kind == "team-request":
        return "centuarai-local-team-request-response+jws", 65536
    return TYPES["response"], evidence.MAX_JWS_BYTES


def verify_response(proof, box_key, *, box_id, kind):
    typ, maximum = _response_encoding(kind)
    value = wire._decode(proof, typ, validate_response, max_bytes=maximum)
    evidence._verify(proof, evidence._public_key(box_key))
    evidence._require(
        value["boxId"] == box_id
        and value["kind"] == kind
        and value["boxKeyThumbprint"] == evidence.public_key_thumbprint(box_key),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    if kind == "mutation-status" and value["body"]["ack"] is not None:
        verify_response(value["body"]["ack"], box_key, box_id=box_id, kind="mutation-ack")
    return value

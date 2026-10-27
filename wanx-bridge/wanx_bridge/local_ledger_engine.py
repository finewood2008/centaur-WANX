"""Versioned ledger operations on the authority's existing SQLite transaction.

No connection, clock, cloud lookup or background writer is created here. Pure
transition calculation is shared by live commits and startup history replay.
"""

from __future__ import annotations

import copy
import json

from . import local_ledger_protocol as protocol
from . import local_management_protocol as wire
from . import local_trust_protocol as evidence
from .local_ledger_migration import build_v2_origin, persist_snapshot, public_archive_digest
from .local_resource_catalog import resolve_resource, validate_resource_grants

ACTION_EVENTS = {
    "owner-policy.activate-v2": "owner-policy.activated",
    "device.add-manager": "binding.manager-added",
    "principal.invite": "principal.invited",
    "device.revoke": "binding.revoked",
    "device.review-descendants": "binding.descendants-reviewed",
    "principal.revoke": "principal.revoked",
    "recovery.setup": "recovery.configured",
    "recovery.rotate": "recovery.rotated",
    "recovery.recover": "principal.recovered",
    "backup.create": "backup.operation-authorized",
    "backup.restore": "backup.operation-authorized",
    "ownership.transfer-prepare": "ownership.transfer-frozen",
    "network-wifi.authorize": "network-wifi.authorized",
    "network-wifi.revoke": "network-wifi.revoked",
}
ACTION_CAPS = {
    "device.add-manager": "device.approve_manage",
    "principal.invite": "member.invite",
    "device.revoke": "device.revoke",
    "device.review-descendants": "device.review_descendants",
    "principal.revoke": "member.revoke",
    "recovery.setup": "recovery.configure",
    "recovery.rotate": "recovery.configure",
    "backup.create": "backup.create",
    "backup.restore": "backup.restore",
    "ownership.transfer-prepare": "ownership.transfer",
}
ACTION_EVENTS.update({action: action + ".committed" for action in protocol.team_protocol.ACTIONS})


def need(value, code="LOCAL_TRUST_AUTHORIZATION_DENIED"):
    evidence._require(value, code)


def clone(value):
    return copy.deepcopy(value)


def lookup(values, field, value):
    return next((item for item in values if item[field] == value), None)


def minimum(*values):
    limited = [value for value in values if value is not None]
    return min(limited) if limited else None


def live(expiry, now):
    return expiry is None or now < expiry


def limited(value, ceiling):
    return ceiling is None or value is not None and value <= ceiling


def grant_list(records, *, delegate=False):
    result = {}
    for row in records:
        result.setdefault(row["resourceId"], set()).update(
            row["delegableActions"] if delegate else row["actions"]
        )
    return [
        {"resourceId": key, "actions": sorted(actions)}
        for key, actions in sorted(result.items())
        if actions
    ]


def subset(wanted, ceiling):
    allowed = {row["resourceId"]: set(row["actions"]) for row in ceiling}
    return all(set(row["actions"]) <= allowed.get(row["resourceId"], set()) for row in wanted)


def principal(snapshot, principal_id):
    return lookup(snapshot["principals"], "principalId", principal_id)


def binding(snapshot, binding_id):
    return lookup(snapshot["bindings"], "bindingId", binding_id)


def recovery(snapshot, principal_id):
    return next(
        (
            row
            for row in snapshot["recoveryConfigurations"]
            if row["principalId"] == principal_id and row["status"] == "active"
        ),
        None,
    )


def principal_projection(snapshot, member, row):
    owner = snapshot["ownership"]
    return {
        "principal": member,
        "ownershipView": {
            "ownershipEpoch": owner["ownershipEpoch"],
            "state": owner["state"],
            "isOwnerPrincipal": owner["ownerPrincipalId"] == member["principalId"],
            "allowedOwnerActions": sorted(
                cap
                for cap in row["capabilities"]
                if cap in ("member.invite", "member.revoke", "ownership.transfer")
                and owner["ownerPrincipalId"] == member["principalId"]
            ),
        },
        "bindings": [
            item for item in snapshot["bindings"] if item["principalId"] == member["principalId"]
        ],
        "grants": [
            item for item in snapshot["grants"] if item["principalId"] == member["principalId"]
        ],
        "recoverySummary": recovery(snapshot, member["principalId"]),
        "qualifiedOriginalOwnerRoot": owner["originalOwnerBindingId"] == row["bindingId"]
        and not owner["extendedOwnerPolicyActivated"],
    }


def validate_read_capacity(snapshot, context, now, *, reserve=0):
    """Reject growth before committing a scoped roster that cannot be read."""
    header = {"alg": "ES256", "typ": protocol.TYPES["response"]}
    overhead = len(evidence._encode(wire.canonical(header))) + 2 + 86

    def terminal_capacity(value, field=None):
        """Reserve terminal representations before growth, never at revocation."""
        if type(value) is dict:
            return {key: terminal_capacity(item, key) for key, item in value.items()}
        if type(value) is list:
            return [terminal_capacity(item) for item in value]
        if type(value) is bool:
            return False  # The longer JSON boolean.
        if type(value) is int or value is None and field == "retiredAtSequence":
            return 9007199254740991
        if field == "usedByMembershipId" and value is None:
            return evidence._encode(bytes(32))
        if type(value) is str:
            return {
                "status": "suspended",
                "state": "transfer_frozen",
                "role": "manage",
                "roleId": "manager",
            }.get(field, value)
        return value

    def check(kind, body):
        value = {
            "schemaVersion": 2,
            "purpose": "centuarai.local-ledger.response",
            "boxId": context["boxId"],
            "boxKeyThumbprint": context["boxKeyThumbprint"],
            "kind": kind,
            "issuedAt": now,
            "body": body,
        }
        if "team" in snapshot:
            value = terminal_capacity(value)
        size = overhead + len(evidence._encode(wire.canonical(value)))
        need(size + reserve <= evidence.MAX_JWS_BYTES, "LOCAL_TRUST_CAPACITY")

    for member in snapshot["principals"]:
        if member["ownershipEpoch"] != context["ownershipEpoch"]:
            continue
        for row in snapshot["bindings"]:
            if (
                row["principalId"] == member["principalId"]
                and row["role"] == "manage"
                and row["status"] == "active"
            ):
                projection = principal_projection(snapshot, member, row)
                check(
                    "principal-state",
                    {
                        "context": context,
                        "projection": projection,
                        "projectionDigest": wire.digest(projection),
                    },
                )
    members = [
        {field: item[field] for field in ("principalId", "status", "createdSequence")}
        | {"createdEventDigest": evidence._encode(bytes(32))}
        for item in snapshot["principals"]
        if item["ownershipEpoch"] == context["ownershipEpoch"]
    ]
    check("membership-directory", {"context": context, "members": members})
    if "team" in snapshot:
        from .local_team_ledger import summary

        check(
            "team-state",
            {
                "context": context,
                "members": [summary(item) for item in snapshot["team"]["members"]],
                "invitations": snapshot["team"]["invitations"],
                "resources": snapshot["team"]["resources"],
                "requests": [
                    {
                        "requestId": evidence._encode(bytes(32)),
                        "principalId": "x" * 128,
                        "invitationId": evidence._encode(bytes(32)),
                        "subject": "x" * 128,
                        "expiresAt": 9007199254740991,
                        "state": "pending",
                    }
                ]
                * 8,
            },
        )


def binding_valid(snapshot, row, now, *, delegation=False, seen=None):
    if row is None:
        return False
    seen = set() if seen is None else set(seen)
    if row["bindingId"] in seen:
        return False
    seen.add(row["bindingId"])
    member = principal(snapshot, row["principalId"])
    if not (
        snapshot["ownership"]["state"] == "owned"
        and row["ownershipEpoch"] == snapshot["ownership"]["ownershipEpoch"]
        and member
        and member["ownershipEpoch"] == row["ownershipEpoch"]
        and member["status"] == "active"
        and row["status"] == "active"
        and live(row["expiresAt"], now)
        and (not delegation or live(row["delegationExpiresAt"], now))
    ):
        return False
    parent = row["createdByBindingId"]
    predecessor = binding(snapshot, parent) if parent is not None else None
    # An explicit invitation creates a new principal and empty private
    # namespace. Its creator remains audit provenance, not continuing access to
    # the inviter's private authority. Shared-resource edges are checked by the
    # separate resource graph; they are never revived by this exception.
    if predecessor is not None and predecessor["principalId"] != row["principalId"]:
        return True
    return parent is None or binding_valid(snapshot, predecessor, now, delegation=True, seen=seen)


def effective_grants(snapshot, row, now, *, delegation=False):
    if not binding_valid(snapshot, row, now, delegation=delegation):
        return []
    records = {record["grantId"]: record for record in snapshot["grants"]}

    def valid(record, seen):
        if record["grantId"] in seen:
            return False
        seen = seen | {record["grantId"]}
        if not (
            record["status"] == "active"
            and record["ownershipEpoch"] == snapshot["ownership"]["ownershipEpoch"]
            and live(record["expiresAt"], now)
            and (not delegation or live(record["delegationExpiresAt"], now))
        ):
            return False
        if record["sourceBindingId"] is not None and not binding_valid(
            snapshot, binding(snapshot, record["sourceBindingId"]), now, delegation=True
        ):
            return False
        return all(
            source in records and valid(records[source], seen)
            for source in record["sourceGrantIds"]
        )

    principal_records = [
        record
        for record in records.values()
        if record["bindingId"] is None
        and record["principalId"] == row["principalId"]
        and valid(record, set())
    ]
    result = []
    for record in records.values():
        if record["bindingId"] != row["bindingId"] or not valid(record, set()):
            continue
        ceilings = [
            item
            for item in principal_records
            if item["resourceNamespaceId"] == record["resourceNamespaceId"]
        ]
        actions = set().union(*(set(item["actions"]) for item in ceilings)) if ceilings else set()
        delegates = (
            set().union(*(set(item["delegableActions"]) for item in ceilings))
            if ceilings
            else set()
        )
        value = clone(record)
        value["actions"] = sorted(set(record["actions"]) & actions)
        value["delegableActions"] = sorted(
            set(record["delegableActions"]) & delegates & set(value["actions"])
        )
        value["expiresAt"] = minimum(record["expiresAt"], *(item["expiresAt"] for item in ceilings))
        value["delegationExpiresAt"] = minimum(
            record["delegationExpiresAt"], *(item["delegationExpiresAt"] for item in ceilings)
        )
        if value["actions"]:
            result.append(value)
    return result


def authority_actor(snapshot, actor, now, *, historical=False):
    protocol.actor(actor)
    member = principal(snapshot, actor["principalId"])
    need(member is not None)
    if actor["kind"] == "binding":
        row = binding(snapshot, actor["bindingId"])
        need(row is not None and row["principalId"] == actor["principalId"])
        # A use binding has an access key version of one but no approval key.
        version = row["approvalKeyVersion"] if row["approvalKeyVersion"] is not None else 1
        need(actor["keyVersion"] == version)
        if not historical:
            need(binding_valid(snapshot, row, now, delegation=True))
        return row
    row = recovery(snapshot, actor["principalId"])
    need(
        row is not None
        and actor["keyVersion"] == row["version"]
        and member["recoveryVersion"] == row["version"]
    )
    need(
        member["status"] in ("active", "suspended")
        and member["ownershipEpoch"] == snapshot["ownership"]["ownershipEpoch"]
        and snapshot["ownership"]["state"] == "owned"
        and live(row["expiresAt"], now)
        and live(row["delegationExpiresAt"], now)
    )
    return row


def actor_key(row, actor, *, prepare=False):
    return (
        row["signingKey"]
        if actor["kind"] == "recovery"
        else row["accessKey"]
        if prepare
        else row["approvalKey"]
    )


def assert_unused(snapshot, target=None, new_recovery=None):
    used = {row["thumbprint"] for row in snapshot["keyHistory"]}
    keys = []
    if target is not None:
        need(
            not any(row["clientId"] == target["clientId"] for row in snapshot["bindings"]),
            "LOCAL_BINDING_CLIENT_REUSE",
        )
        keys += [
            evidence.public_key_thumbprint(target[field])
            for field in ("accessKey", "approvalKey")
            if target.get(field) is not None
        ]
    if new_recovery is not None:
        need(
            not any(
                row["recoveryId"] == new_recovery["recoveryId"]
                for row in snapshot["recoveryConfigurations"]
            ),
            "LOCAL_BINDING_KEY_REUSE",
        )
        keys += [
            evidence.public_key_thumbprint(new_recovery["signingKey"]),
            wire.digest(new_recovery["backupKey"]),
        ]
    need(len(keys) == len(set(keys)) and not used.intersection(keys), "LOCAL_BINDING_KEY_REUSE")


def _sort(snapshot):
    for name, field in (
        ("principals", "principalId"),
        ("bindings", "bindingId"),
        ("grants", "grantId"),
        ("recoveryConfigurations", "recoveryId"),
    ):
        snapshot[name].sort(key=lambda row: row[field])
    snapshot["keyHistory"].sort(key=lambda row: (row["purpose"], row["thumbprint"]))


def _new_binding(
    snapshot, mutation, target, principal_id, now, sequence, parent=None, recovery_id=None
):
    identifier = "binding:" + wire.digest(
        {"requestId": mutation["requestId"], "clientId": target["clientId"]}
    )
    value = {
        "bindingId": identifier,
        "principalId": principal_id,
        "clientId": target["clientId"],
        "role": "manage",
        "status": "active",
        "accessKey": target["accessKey"],
        "approvalKey": target["approvalKey"],
        "approvalKeyVersion": 1,
        "canApproveUseDevices": "device.approve_use" in target["capabilities"],
        "delegableGrants": target["delegableGrants"],
        "expiresAt": target["expiresAt"],
        "delegationExpiresAt": target["delegationExpiresAt"],
        "establishedAt": now,
        "establishedVersion": sequence,
        "bindingRevision": 1,
        "ownershipEpoch": snapshot["ownership"]["ownershipEpoch"],
        "capabilities": target["capabilities"],
        "createdByBindingId": parent,
        "createdByRecoveryId": recovery_id,
        "sourceRequestId": mutation["requestId"],
        "sourceEventSequence": sequence,
    }
    snapshot["bindings"].append(value)
    for field in ("accessKey", "approvalKey"):
        snapshot["keyHistory"].append(
            {
                "thumbprint": evidence.public_key_thumbprint(target[field]),
                "purpose": field,
                "firstSequence": sequence,
                "retiredAtSequence": None,
            }
        )
    return value


def _new_grants(snapshot, row, target, sequence, *, sources=(), principal_grants=False):
    delegates = {item["resourceId"]: item["actions"] for item in target["delegableGrants"]}
    for resource in target["grants"]:
        if resource["resourceId"].startswith("team:"):
            resolved = resolve_resource(
                row["principalId"],
                resource["resourceId"],
                box_id=snapshot["team"]["boxId"],
                ownership_epoch=row["ownershipEpoch"],
            )
        else:
            resolved = resolve_resource(row["principalId"], resource["resourceId"])
        binding_id = None if principal_grants else row["bindingId"]
        identifier = "grant:" + wire.digest(
            {
                "requestId": row["sourceRequestId"],
                "resourceId": resource["resourceId"],
                "principal": principal_grants,
            }
        )
        parents = [
            item["grantId"] for item in sources if item["resourceId"] == resource["resourceId"]
        ]
        snapshot["grants"].append(
            {
                "grantId": identifier,
                "ownershipEpoch": row["ownershipEpoch"],
                "principalId": row["principalId"],
                "bindingId": binding_id,
                "resourceId": resource["resourceId"],
                "resourceScope": resolved["scope"],
                "resourceNamespaceId": resolved["namespaceId"],
                "actions": resource["actions"],
                "delegableActions": delegates.get(resource["resourceId"], []),
                "expiresAt": target["expiresAt"],
                "delegationExpiresAt": target["delegationExpiresAt"],
                "status": "active",
                "sourceGrantIds": sorted(parents),
                "sourceBindingId": row["createdByBindingId"] if parents else None,
                "createdSequence": sequence,
                "revision": 1,
            }
        )


def descendants(snapshot, identifiers):
    found = set(identifiers)
    while True:
        additional = {
            row["bindingId"]
            for row in snapshot["bindings"]
            if row["createdByBindingId"] in found
            and binding(snapshot, row["createdByBindingId"])["principalId"] == row["principalId"]
        }
        if additional <= found:
            return found - set(identifiers)
        found |= additional


def effect_scope(mutation, effects, box_id):
    action = mutation["action"]
    if action in ("device.revoke", "team.device-resources"):
        return {"kind": "binding", "id": mutation["args"]["bindingId"]}
    if action in ("ownership.transfer-prepare", "team.activate", "team.resource-set"):
        return {"kind": "ownership", "id": box_id}
    return {"kind": "principal", "id": effects["targetPrincipalId"]}


def retire_bindings(snapshot, revoked, suspended, sequence):
    for row in snapshot["bindings"]:
        new_status = (
            "revoked"
            if row["bindingId"] in revoked
            else "suspended"
            if row["bindingId"] in suspended
            else None
        )
        if new_status and row["status"] != "revoked":
            row["status"] = new_status
            row["bindingRevision"] += 1
            if new_status == "revoked":
                thumbs = {
                    evidence.public_key_thumbprint(row[field])
                    for field in ("accessKey", "approvalKey")
                    if row[field] is not None
                }
                for key in snapshot["keyHistory"]:
                    if key["thumbprint"] in thumbs:
                        key["retiredAtSequence"] = sequence
    for row in snapshot["grants"]:
        if row["bindingId"] in revoked or row["bindingId"] in suspended:
            if row["status"] != "revoked":
                row["status"] = "revoked" if row["bindingId"] in revoked else "suspended"
                row["revision"] += 1


def summary(row):
    return {
        **{
            name: row[name]
            for name in (
                "bindingId",
                "principalId",
                "clientId",
                "role",
                "bindingRevision",
                "status",
                "capabilities",
                "expiresAt",
                "delegationExpiresAt",
            )
        },
        "accessKeyThumbprint": evidence.public_key_thumbprint(row["accessKey"]),
        "approvalKeyThumbprint": evidence.public_key_thumbprint(row["approvalKey"])
        if row["approvalKey"]
        else None,
    }


def record_delta(before, after, invalidated):
    result = {}
    for name, field in (
        ("principals", "principalId"),
        ("bindings", "bindingId"),
        ("grants", "grantId"),
        ("recoveryConfigurations", "recoveryId"),
    ):
        old = {row[field]: row for row in before[name]}
        result[name] = [row for row in after[name] if old.get(row[field]) != row]
    result["ownership"] = after["ownership"] if before["ownership"] != after["ownership"] else None
    oldkeys = {row["thumbprint"]: row for row in before["keyHistory"]}
    result["retiredSigningKeyThumbprints"] = sorted(
        row["thumbprint"]
        for row in after["keyHistory"]
        if row["retiredAtSequence"] is not None and oldkeys.get(row["thumbprint"]) != row
    )
    result["invalidatedRequestIds"] = sorted(invalidated)
    if before.get("team") != after.get("team"):
        result["team"] = clone(after.get("team"))
    return result


def transition(snapshot, mutation, now, sequence, *, invalidated=()):
    """Compute the complete result; callers separately verify every required PoP."""
    if mutation["action"] in protocol.team_protocol.ACTIONS:
        from .local_team_ledger import transition as team_transition

        return team_transition(snapshot, mutation, now, sequence, invalidated=invalidated)
    need(
        not ("team" in snapshot and mutation["action"] == "principal.invite"),
        "LOCAL_TRUST_CLOUD_IDENTITY_REQUIRED",
    )
    before = snapshot
    snapshot = clone(snapshot)
    actor = mutation["actor"]
    actor_row = authority_actor(snapshot, actor, now)
    action, args = mutation["action"], mutation["args"]
    member = principal(snapshot, actor["principalId"])
    if action == "recovery.recover":
        need(actor["kind"] == "recovery")
    else:
        need(
            actor["kind"] == "binding"
            and actor_row["role"] == "manage"
            and actor_row["approvalKey"] is not None
        )
        if action in ACTION_CAPS:
            need(ACTION_CAPS[action] in actor_row["capabilities"])
    if action in ("principal.invite", "principal.revoke", "ownership.transfer-prepare"):
        need(actor["principalId"] == snapshot["ownership"]["ownerPrincipalId"])
    target_principal = args.get("principalId", actor["principalId"])
    target_ids, revoked, suspended = [], set(), set()
    current_recovery = recovery(snapshot, target_principal)
    recovery_before = clone(current_recovery)
    result_authority = None
    result_binding = None
    capabilities_before = clone(actor_row.get("capabilities", []))
    before_grants = (
        grant_list(effective_grants(snapshot, actor_row, now))
        if actor["kind"] == "binding"
        else clone(actor_row["grants"])
    )
    old_security = member["principalSecurityVersion"]
    old_recovery_version = member["recoveryVersion"]
    if action == "owner-policy.activate-v2":
        owner = snapshot["ownership"]
        need(
            not owner["extendedOwnerPolicyActivated"]
            and owner["originalOwnerBindingId"] == actor["bindingId"]
            and owner["ownerPrincipalId"] == actor["principalId"],
            "LOCAL_TRUST_POLICY_ACTIVATION_DENIED",
        )
        actor_row["capabilities"] = args["capabilities"]
        actor_row["canApproveUseDevices"] = "device.approve_use" in args["capabilities"]
        actor_row["bindingRevision"] += 1
        owner["extendedOwnerPolicyActivated"] = True
        snapshot["policyVersion"] += 1
        target_ids = [actor_row["bindingId"]]
    elif action in ("device.add-manager", "principal.invite"):
        target = args["target"]
        assert_unused(snapshot, target=target)
        need(
            set(target["capabilities"]) <= set(actor_row["capabilities"]),
            "LOCAL_BINDING_SCOPE_EXCEEDED",
        )
        sources = effective_grants(snapshot, actor_row, now, delegation=True)
        need(
            subset(target["grants"], grant_list(sources, delegate=True))
            and subset(target["delegableGrants"], grant_list(sources, delegate=True)),
            "LOCAL_BINDING_SCOPE_EXCEEDED",
        )
        limit = minimum(
            actor_row["expiresAt"],
            actor_row["delegationExpiresAt"],
            *(minimum(row["expiresAt"], row["delegationExpiresAt"]) for row in sources),
        )
        need(
            limited(target["expiresAt"], limit)
            and limited(target["delegationExpiresAt"], limit)
            and live(target["expiresAt"], now)
            and live(target["delegationExpiresAt"], now),
            "LOCAL_BINDING_LIFETIME_EXCEEDED",
        )
        if action == "principal.invite":
            need(
                set(target["capabilities"]) <= protocol.INVITED_CAPABILITIES,
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            need(principal(snapshot, target_principal) is None, "LOCAL_TRUST_PRINCIPAL_REUSE")
            member = {
                "principalId": target_principal,
                "ownershipEpoch": snapshot["ownership"]["ownershipEpoch"],
                "status": "active",
                "principalSecurityVersion": 1,
                "createdSequence": sequence,
                "recoveryVersion": 0,
            }
            snapshot["principals"].append(member)
            old_security, old_recovery_version = None, None
        result_binding = _new_binding(
            snapshot,
            mutation,
            target,
            target_principal,
            now,
            sequence,
            parent=actor_row["bindingId"],
        )
        if action == "principal.invite":
            _new_grants(snapshot, result_binding, target, sequence, principal_grants=True)
            sources = []  # New private namespace; never delegate inviter's data.
        _new_grants(snapshot, result_binding, target, sequence, sources=sources)
        target_ids = [result_binding["bindingId"]]
        result_authority = {
            name: target[name]
            for name in (
                "grants",
                "delegableGrants",
                "expiresAt",
                "delegationExpiresAt",
                "capabilities",
            )
        }
    elif action == "device.revoke":
        target = binding(snapshot, args["bindingId"])
        need(
            target is not None
            and target["principalId"] == actor["principalId"]
            and target["status"] != "revoked"
        )
        target_ids = [target["bindingId"]]
        revoked = set(target_ids)
        suspended = descendants(snapshot, revoked) - revoked
        retire_bindings(snapshot, revoked, suspended, sequence)
    elif action == "principal.revoke":
        member = principal(snapshot, target_principal)
        need(
            member is not None
            and target_principal != snapshot["ownership"]["ownerPrincipalId"]
            and member["status"] != "revoked"
        )
        old_security, old_recovery_version = (
            member["principalSecurityVersion"],
            member["recoveryVersion"],
        )
        revoked = {
            row["bindingId"]
            for row in snapshot["bindings"]
            if row["principalId"] == target_principal
        }
        suspended = descendants(snapshot, revoked) - revoked
        retire_bindings(snapshot, revoked, suspended, sequence)
        member["status"] = "revoked"
        member["principalSecurityVersion"] += 1
        for record in snapshot["grants"]:
            if record["principalId"] == target_principal and record["status"] != "revoked":
                record["status"] = "revoked"
                record["revision"] += 1
        if current_recovery:
            current_recovery["status"] = "retired"
            current_recovery["retiredAtSequence"] = sequence
            retired_keys = {
                evidence.public_key_thumbprint(current_recovery["signingKey"]),
                wire.digest(current_recovery["backupKey"]),
            }
            for historical in snapshot["keyHistory"]:
                if historical["thumbprint"] in retired_keys:
                    historical["retiredAtSequence"] = sequence
    elif action == "device.review-descendants":
        target_ids = args["bindingIds"]
        sources = effective_grants(snapshot, actor_row, now, delegation=True)
        replacement_limit = minimum(
            actor_row["expiresAt"],
            actor_row["delegationExpiresAt"],
            *(minimum(row["expiresAt"], row["delegationExpiresAt"]) for row in sources),
        )
        for identifier in target_ids:
            target = binding(snapshot, identifier)
            need(
                target is not None
                and target["principalId"] == actor["principalId"]
                and target["status"] == "suspended"
            )
            need(
                actor_row["bindingId"] not in descendants(snapshot, {identifier})
                and actor_row["bindingId"] != identifier
            )
            need(set(target["capabilities"]) <= set(actor_row["capabilities"]))
            need(
                live(target["expiresAt"], now)
                and live(target["delegationExpiresAt"], now)
                and limited(target["expiresAt"], replacement_limit)
                and limited(target["delegationExpiresAt"], replacement_limit),
                "LOCAL_BINDING_LIFETIME_EXCEEDED",
            )
            for grant in snapshot["grants"]:
                if grant["bindingId"] == identifier:
                    need(
                        subset(
                            [{"resourceId": grant["resourceId"], "actions": grant["actions"]}],
                            grant_list(sources, delegate=True),
                        )
                    )
                    matching = [row for row in sources if row["resourceId"] == grant["resourceId"]]
                    need(
                        limited(
                            grant["expiresAt"],
                            minimum(
                                *(
                                    minimum(row["expiresAt"], row["delegationExpiresAt"])
                                    for row in matching
                                )
                            ),
                        )
                    )
                    need(
                        limited(grant["delegationExpiresAt"], replacement_limit),
                        "LOCAL_BINDING_LIFETIME_EXCEEDED",
                    )
                    grant.update(
                        status="active",
                        sourceGrantIds=sorted(row["grantId"] for row in matching),
                        sourceBindingId=actor_row["bindingId"],
                        revision=grant["revision"] + 1,
                    )
            target.update(
                status="active",
                createdByBindingId=actor_row["bindingId"],
                bindingRevision=target["bindingRevision"] + 1,
            )
    elif action.startswith("recovery."):
        need(
            args["expectedRecoveryVersion"] == member["recoveryVersion"],
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        new = args["newRecovery"]
        assert_unused(snapshot, new_recovery=new, target=args.get("target"))
        if action == "recovery.setup":
            need(current_recovery is None and member["recoveryVersion"] == 0)
        else:
            need(
                current_recovery is not None
                and current_recovery["version"] == member["recoveryVersion"]
            )
        if action == "recovery.recover":
            need(
                args["expectedPrincipalSecurityVersion"] == member["principalSecurityVersion"],
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            principal_records = [
                row
                for row in snapshot["grants"]
                if row["principalId"] == actor["principalId"]
                and row["bindingId"] is None
                and row["status"] == "active"
                and live(row["expiresAt"], now)
            ]
            ceiling = grant_list(principal_records)
            restored = []
            for grant in current_recovery["grants"]:
                allowed = next(
                    (
                        set(row["actions"])
                        for row in ceiling
                        if row["resourceId"] == grant["resourceId"]
                    ),
                    set(),
                )
                actions = sorted(set(grant["actions"]) & allowed)
                if actions:
                    restored.append({"resourceId": grant["resourceId"], "actions": actions})
            need(restored)
            delegates = [
                {
                    "resourceId": row["resourceId"],
                    "actions": sorted(
                        set(row["actions"])
                        & next(
                            (
                                set(item["actions"])
                                for item in restored
                                if item["resourceId"] == row["resourceId"]
                            ),
                            set(),
                        )
                    ),
                }
                for row in current_recovery["delegableGrants"]
            ]
            delegates = [row for row in delegates if row["actions"]]
            first_manager = min(
                (
                    row
                    for row in snapshot["bindings"]
                    if row["principalId"] == actor["principalId"] and row["role"] == "manage"
                ),
                key=lambda row: row["establishedVersion"],
            )
            result_authority = {
                "grants": restored,
                "delegableGrants": delegates,
                "capabilities": sorted(
                    set(current_recovery["capabilities"]) & set(first_manager["capabilities"])
                ),
                "expiresAt": minimum(
                    current_recovery["expiresAt"], *(row["expiresAt"] for row in principal_records)
                ),
                "delegationExpiresAt": minimum(
                    current_recovery["delegationExpiresAt"],
                    *(row["delegationExpiresAt"] for row in principal_records),
                ),
            }
            revoked = {
                row["bindingId"]
                for row in snapshot["bindings"]
                if row["principalId"] == actor["principalId"] and row["status"] != "revoked"
            }
            suspended = descendants(snapshot, revoked) - revoked
            retire_bindings(snapshot, revoked, suspended, sequence)
            member["status"] = "active"
            member["principalSecurityVersion"] += 1
            target = {**args["target"], **result_authority}
            result_binding = _new_binding(
                snapshot,
                mutation,
                target,
                target_principal,
                now,
                sequence,
                recovery_id=new["recoveryId"],
            )
            _new_grants(snapshot, result_binding, target, sequence)
            target_ids = [result_binding["bindingId"]]
        else:
            sources = effective_grants(snapshot, actor_row, now, delegation=True)
            result_authority = {
                "grants": grant_list(sources),
                "delegableGrants": grant_list(sources, delegate=True),
                "capabilities": actor_row["capabilities"],
                "expiresAt": minimum(
                    actor_row["expiresAt"],
                    actor_row["delegationExpiresAt"],
                    *(row["expiresAt"] for row in sources),
                ),
                "delegationExpiresAt": minimum(
                    actor_row["expiresAt"],
                    actor_row["delegationExpiresAt"],
                    *(row["delegationExpiresAt"] for row in sources),
                ),
            }
        if current_recovery:
            current_recovery["status"] = "retired"
            current_recovery["retiredAtSequence"] = sequence
            retired = {
                evidence.public_key_thumbprint(current_recovery["signingKey"]),
                wire.digest(current_recovery["backupKey"]),
            }
            for row in snapshot["keyHistory"]:
                if row["thumbprint"] in retired:
                    row["retiredAtSequence"] = sequence
        configured = {
            **new,
            **result_authority,
            "principalId": actor["principalId"],
            "status": "active",
            "establishedAt": now,
            "establishedSequence": sequence,
            "retiredAtSequence": None,
        }
        snapshot["recoveryConfigurations"].append(configured)
        member["recoveryVersion"] = new["version"]
        for purpose, thumb in (
            ("recoverySigningKey", evidence.public_key_thumbprint(new["signingKey"])),
            ("backupKey", wire.digest(new["backupKey"])),
        ):
            snapshot["keyHistory"].append(
                {
                    "thumbprint": thumb,
                    "purpose": purpose,
                    "firstSequence": sequence,
                    "retiredAtSequence": None,
                }
            )
    elif action in ("network-wifi.authorize", "network-wifi.revoke"):
        target = binding(snapshot, args["bindingId"])
        need(target is not None and target["principalId"] == actor["principalId"])
        need(target["role"] == "manage" and target["approvalKey"] is not None)
        need(binding_valid(snapshot, target, now))
        owner = snapshot["ownership"]
        governance = actor["principalId"] == owner["ownerPrincipalId"] and (
            actor["bindingId"] == owner["originalOwnerBindingId"]
            or "ownership.transfer" in actor_row["capabilities"]
        )
        sources = [
            item
            for item in effective_grants(snapshot, actor_row, now, delegation=True)
            if item["resourceId"] == "network:wifi" and "write" in item["delegableActions"]
        ]
        target_ids = [target["bindingId"]]
        if action == "network-wifi.authorize":
            need(
                bool(sources) or governance and target["bindingId"] == actor["bindingId"],
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            need(
                not any(
                    item["resourceId"] == "network:wifi"
                    for item in effective_grants(snapshot, target, now)
                ),
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            deadline = args["expiresAt"]
            limits = [actor_row["expiresAt"], actor_row["delegationExpiresAt"], target["expiresAt"]]
            principal_network = [
                item
                for item in snapshot["grants"]
                if item["resourceId"] == "network:wifi"
                and item["principalId"] == actor["principalId"]
                and item["bindingId"] is None
                and item["status"] == "active"
                and live(item["expiresAt"], now)
            ]
            limits += [
                minimum(item["expiresAt"], item["delegationExpiresAt"])
                for item in principal_network
            ]
            if sources:
                limits += [
                    minimum(item["expiresAt"], item["delegationExpiresAt"]) for item in sources
                ]
            ceiling = minimum(*limits)
            need(deadline is None or deadline > now, "LOCAL_BINDING_EXPIRED")
            need(
                ceiling is None or deadline is not None and deadline <= ceiling,
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            network = [{"resourceId": "network:wifi", "actions": ["write"]}]
            grant_target = {
                "grants": network,
                "delegableGrants": network if args["delegable"] else [],
                "expiresAt": deadline,
                "delegationExpiresAt": deadline,
            }
            grant_row = {
                **target,
                "sourceRequestId": mutation["requestId"],
                "createdByBindingId": actor["bindingId"] if sources else None,
            }
            if not principal_network:
                need(
                    governance and target["bindingId"] == actor["bindingId"],
                    "LOCAL_BINDING_SCOPE_EXCEEDED",
                )
                _new_grants(
                    snapshot,
                    grant_row,
                    {**grant_target, "delegableGrants": network},
                    sequence,
                    principal_grants=True,
                )
            _new_grants(snapshot, grant_row, grant_target, sequence, sources=sources)
            target["delegableGrants"] = sorted(
                [item for item in target["delegableGrants"] if item["resourceId"] != "network:wifi"]
                + grant_target["delegableGrants"],
                key=lambda item: item["resourceId"],
            )
        else:
            target_network = [
                grant
                for grant in snapshot["grants"]
                if grant["bindingId"] == target["bindingId"]
                and grant["resourceId"] == "network:wifi"
                and grant["status"] == "active"
            ]
            need(
                governance
                or target["bindingId"] == actor["bindingId"]
                or bool(sources)
                and all(grant["sourceBindingId"] == actor["bindingId"] for grant in target_network),
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            for grant in snapshot["grants"]:
                if (
                    grant["bindingId"] == target["bindingId"]
                    and grant["resourceId"] == "network:wifi"
                    and grant["status"] == "active"
                ):
                    grant["status"] = "revoked"
                    grant["revision"] += 1
            target["delegableGrants"] = [
                item for item in target["delegableGrants"] if item["resourceId"] != "network:wifi"
            ]
        target["bindingRevision"] += 1
        result_authority = {
            "grants": grant_list(effective_grants(snapshot, target, now)),
            "delegableGrants": grant_list(
                effective_grants(snapshot, target, now, delegation=True), delegate=True
            ),
            "capabilities": target["capabilities"],
            "expiresAt": target["expiresAt"],
            "delegationExpiresAt": target["delegationExpiresAt"],
        }
    elif action == "ownership.transfer-prepare":
        need(args["expectedOwnerPrincipalId"] == snapshot["ownership"]["ownerPrincipalId"])
        snapshot["ownership"].update(state="transfer_frozen", pendingTransferId=args["transferId"])
    elif action.startswith("backup."):
        available_resources = {row["resourceId"]: set(row["actions"]) for row in before_grants}
        required_action = "read" if action == "backup.create" else "write"
        need(
            all(
                required_action in available_resources.get(resource, set())
                for resource in args["resourceIds"]
            ),
            "LOCAL_BINDING_SCOPE_EXCEEDED",
        )
        if action == "backup.create":
            need(
                current_recovery is not None
                and current_recovery["version"] == args["expectedRecoveryVersion"]
                and wire.digest(current_recovery["backupKey"]) == args["recipientKeyThumbprint"]
                and live(current_recovery["expiresAt"], now)
                and live(current_recovery["delegationExpiresAt"], now),
                "LOCAL_TRUST_RECOVERY_VERSION_MISMATCH",
            )
        else:
            need(
                current_recovery is not None
                and live(current_recovery["expiresAt"], now)
                and live(current_recovery["delegationExpiresAt"], now),
                "LOCAL_TRUST_RECOVERY_REQUIRED",
            )
            need(
                all(
                    mapping["targetPrincipalId"] == actor["principalId"]
                    and set(mapping["resourceIds"]) <= set(args["resourceIds"])
                    for mapping in args["ownerMapping"]
                ),
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
    else:
        need(False, "LOCAL_BINDING_INVALID")
    remaining = [
        row
        for row in snapshot["bindings"]
        if row["principalId"] == target_principal
        and row["role"] == "manage"
        and row["approvalKey"] is not None
        and bool(
            set(row["capabilities"])
            & {"device.approve_use", "device.approve_manage", "recovery.configure"}
        )
        and binding_valid(snapshot, row, now, delegation=True)
    ]
    current_recovery = recovery(snapshot, target_principal)
    available = bool(
        current_recovery
        and live(current_recovery["expiresAt"], now)
        and live(current_recovery["delegationExpiresAt"], now)
    )
    if action == "device.revoke" and not remaining and not available:
        need(args["mode"] == "emergency-lock", "LOCAL_TRUST_LAST_MANAGER")
        member["status"] = "suspended"
        member["principalSecurityVersion"] += 1
    snapshot["authorizationVersion"] += 1
    if "team" in snapshot:
        from .local_team_ledger import synchronize_associations

        synchronize_associations(before, snapshot, now)
    _sort(snapshot)
    redacted = action == "principal.revoke" or any(
        binding(before, item) and binding(before, item)["principalId"] != actor["principalId"]
        for item in suspended
    )
    visible = [
        identifier
        for identifier in target_ids
        if binding(before, identifier)
        and binding(before, identifier)["principalId"] == actor["principalId"]
    ]
    effects = {
        "targetPrincipalId": target_principal,
        "targetBindingIds": sorted(target_ids),
        "targetSummaries": [summary(binding(before, identifier)) for identifier in sorted(visible)],
        **{
            name: {"count": len(values), "digest": wire.digest(sorted(values))}
            for name, values in (
                ("revokedBindings", revoked),
                ("suspendedBindings", suspended),
                ("invalidatedRequests", invalidated),
            )
        },
        "principalSecurityVersionBefore": old_security,
        "principalSecurityVersionAfter": member["principalSecurityVersion"],
        "recoveryVersionBefore": old_recovery_version,
        "recoveryVersionAfter": member["recoveryVersion"],
        "recoveryBefore": {
            key: value
            for key, value in recovery_before.items()
            if key not in protocol._COMMIT_DERIVED
        }
        if action.startswith("recovery.") and recovery_before
        else None,
        "recoveryAfter": {
            key: value
            for key, value in current_recovery.items()
            if key not in protocol._COMMIT_DERIVED
        }
        if action.startswith("recovery.") and current_recovery
        else None,
        "remainingIndependentManagers": len(remaining),
        "verifiedRecoveryAvailable": available,
        "grantsBefore": None if redacted else before_grants,
        "grantsAfter": None
        if redacted
        else result_authority["grants"]
        if result_authority
        else before_grants,
        "capabilitiesBefore": None if redacted else capabilities_before,
        "capabilitiesAfter": None
        if redacted
        else result_authority["capabilities"]
        if result_authority
        else actor_row.get("capabilities", []),
        "resultingAuthority": result_authority,
        "redacted": redacted,
        "ownershipStateAfter": snapshot["ownership"]["state"],
        "requiresVerifiedErase": action == "ownership.transfer-prepare",
    }
    protocol.validate_effects(effects)
    result = {
        "principalId": target_principal,
        "bindingId": result_binding["bindingId"] if result_binding else None,
        "principalSecurityVersion": member["principalSecurityVersion"],
        "recoveryVersion": member["recoveryVersion"],
        "transferId": args["transferId"] if action == "ownership.transfer-prepare" else None,
        "operationId": mutation["requestId"] if action.startswith("backup.") else None,
    }
    return snapshot, effects, record_delta(before, snapshot, invalidated), result


def verify_proofs(snapshot, mutation, proofs, now, *, operation_plan=None):
    evidence._fields(proofs, protocol.PROOF_FIELDS)
    actor = mutation["actor"]
    row = authority_actor(snapshot, actor, now)
    need(actor_key(row, actor) is not None)
    need(
        protocol.verify_mutation(proofs["mutationProof"], actor_key(row, actor)) == mutation,
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    action, args = mutation["action"], mutation["args"]
    target_required = (
        action
        in (
            "device.add-manager",
            "principal.invite",
            "recovery.recover",
            "team.migration-authorize",
            "team.device-resources",
        )
        or action in protocol.team_protocol.ASSOCIATION_ACTIONS
    )
    target = None
    if action in ("team.device-resources", "team.migration-authorize"):
        target = binding(
            snapshot, args["bindingId" if action == "team.device-resources" else "targetBindingId"]
        )
        need(target is not None)
    elif target_required:
        target = (
            args["request"]["target"]
            if action in protocol.team_protocol.ASSOCIATION_ACTIONS
            else args["target"]
        )
    recovery_required = action.startswith("recovery.")
    source_required = action == "backup.restore"
    for field, required in (
        ("targetAccessProof", target_required),
        ("targetApprovalProof", target_required and target["approvalKey"] is not None),
        ("recoveryMaterialProof", recovery_required),
        ("sourceRecoveryProof", source_required),
    ):
        need(
            type(proofs[field]) is str if required else proofs[field] is None,
            "LOCAL_BINDING_INVALID",
        )
    if target_required:
        need(target is not None)
        protocol.verify_additional_proof(
            proofs["targetAccessProof"],
            mutation,
            target["accessKey"],
            purpose="target-access",
        )
        if target["approvalKey"] is not None:
            protocol.verify_additional_proof(
                proofs["targetApprovalProof"],
                mutation,
                target["approvalKey"],
                purpose="target-approval",
            )
    if recovery_required:
        protocol.verify_additional_proof(
            proofs["recoveryMaterialProof"],
            mutation,
            args["newRecovery"]["signingKey"],
            purpose="recovery-material",
        )
    if source_required:
        from .local_ledger_operations import validate_plan

        need(operation_plan is not None, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
        validate_plan(operation_plan, mutation)
        protocol.verify_additional_proof(
            proofs["sourceRecoveryProof"],
            mutation,
            operation_plan["sourceHeader"]["sourceRecoverySigningKey"],
            purpose="source-recovery",
        )


def admit(snapshot, context, request, now, sequence, *, approval_proof=None, request_proof=None):
    before = snapshot
    snapshot = clone(snapshot)
    root = approval_proof is None
    assert_unused(snapshot, target=request)
    need(request["issuedAt"] <= now < request["expiresAt"], "LOCAL_BINDING_EXPIRED")
    need(
        all(
            request[field] == context[field]
            for field in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
        ),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    validate_resource_grants(request["grants"])
    approval = None
    if root:
        need(
            snapshot["ownership"]["state"] == "unclaimed_ready"
            and snapshot["ownership"]["ownerPrincipalId"] is None,
            "LOCAL_TRUST_ALREADY_OWNED",
        )
        need(principal(snapshot, request["principalId"]) is None, "LOCAL_TRUST_PRINCIPAL_REUSE")
        snapshot["principals"].append(
            {
                "principalId": request["principalId"],
                "ownershipEpoch": context["ownershipEpoch"],
                "status": "active",
                "principalSecurityVersion": 1,
                "createdSequence": sequence,
                "recoveryVersion": 0,
            }
        )
        target = {
            **request,
            "capabilities": ["device.approve_use"],
            "delegableGrants": request["grants"],
            "expiresAt": request["grantExpiresAt"],
            "delegationExpiresAt": None,
        }
        new = _new_binding(snapshot, request, target, request["principalId"], now, sequence)
        snapshot["ownership"].update(
            state="owned",
            ownerPrincipalId=request["principalId"],
            originalOwnerBindingId=new["bindingId"],
            extendedOwnerPolicyActivated=False,
        )
        _new_grants(snapshot, new, target, sequence, principal_grants=True)
        _new_grants(snapshot, new, target, sequence)
    else:
        state = {
            **context,
            "bindings": [
                {key: row[key] for key in evidence._BINDING_FIELDS} for row in snapshot["bindings"]
            ],
        }
        approval = evidence.verify_approval_signature(approval_proof, request_proof, state, now)
        parent = binding(snapshot, approval["approverBindingId"])
        need(
            binding_valid(snapshot, parent, now, delegation=True)
            and "device.approve_use" in parent["capabilities"]
        )
        sources = effective_grants(snapshot, parent, now, delegation=True)
        need(
            subset(request["grants"], grant_list(sources, delegate=True)),
            "LOCAL_BINDING_SCOPE_EXCEEDED",
        )
        limit = minimum(
            parent["expiresAt"],
            parent["delegationExpiresAt"],
            *(minimum(row["expiresAt"], row["delegationExpiresAt"]) for row in sources),
        )
        need(limited(request["grantExpiresAt"], limit), "LOCAL_BINDING_LIFETIME_EXCEEDED")
        target = {
            **request,
            "capabilities": [],
            "delegableGrants": [],
            "expiresAt": request["grantExpiresAt"],
            "delegationExpiresAt": None,
        }
        # Reuse the complete internal initializer, then erase manager-only fields
        # before this candidate can enter the resulting state or signed event.
        new = {
            "bindingId": "binding:"
            + wire.digest({"requestId": request["requestId"], "clientId": request["clientId"]}),
            "principalId": request["principalId"],
            "clientId": request["clientId"],
            "role": "use",
            "status": "active",
            "accessKey": request["accessKey"],
            "approvalKey": None,
            "approvalKeyVersion": None,
            "canApproveUseDevices": False,
            "delegableGrants": [],
            "expiresAt": request["grantExpiresAt"],
            "delegationExpiresAt": None,
            "establishedAt": now,
            "establishedVersion": sequence,
            "bindingRevision": 1,
            "ownershipEpoch": context["ownershipEpoch"],
            "capabilities": [],
            "createdByBindingId": parent["bindingId"],
            "createdByRecoveryId": None,
            "sourceRequestId": request["requestId"],
            "sourceEventSequence": sequence,
        }
        snapshot["bindings"].append(new)
        snapshot["keyHistory"].append(
            {
                "thumbprint": evidence.public_key_thumbprint(new["accessKey"]),
                "purpose": "accessKey",
                "firstSequence": sequence,
                "retiredAtSequence": None,
            }
        )
        _new_grants(snapshot, new, target, sequence, sources=sources)
    snapshot["authorizationVersion"] += 1
    _sort(snapshot)
    return snapshot, new, approval, record_delta(before, snapshot, ())


def read_snapshot(db, meta):
    """Read a security snapshot from an already consistent caller transaction."""
    result = {
        "schemaVersion": 2,
        "ownership": clone(meta["ownership"]),
        "policyVersion": meta["policyVersion"],
        "authorizationVersion": meta["authorizationVersion"],
        "dataPlanePolicy": meta["dataPlanePolicy"],
    }
    if "team" in meta:
        result["team"] = clone(meta["team"])
    for name, table, order in (
        ("principals", "principals", "principal_id"),
        ("bindings", "bindings_v2", "binding_id"),
        ("grants", "resource_grants", "grant_id"),
        ("recoveryConfigurations", "recovery_configurations", "recovery_id"),
        ("keyHistory", "signing_key_history", "thumbprint"),
    ):
        result[name] = [
            json.loads(row[0]) for row in db.execute(f"SELECT value FROM {table} ORDER BY {order}")
        ]
    _sort(result)
    return result


class LedgerV2:
    def __init__(self, owner):
        self.owner = owner
        self.db = owner._db
        self.effect_provider = None
        self.effect_generation = wire.digest(
            {
                "purpose": "centuarai.local-ledger.unknown-effect-generation",
                "bootId": owner._boot_id,
            }
        )
        from .local_ledger_operations import LedgerOperations
        from .local_ledger_transfer import LedgerTransfer

        self.operations = LedgerOperations(self)
        self.transfer = LedgerTransfer(self)

    def snapshot(self, meta):
        return read_snapshot(self.db, meta)

    def validate_startup(self, meta):
        from .local_authority_store import _read

        descriptor = {
            "schemaVersion": 2,
            "boxId": self.owner.bundle["boxId"],
            "boxKeyThumbprint": evidence.public_key_thumbprint(self.owner.bundle["boxKey"]),
            "policy": "local-trust-required",
        }
        need(
            evidence._parse(_read(self.owner.directory, "local-trust-required.json")) == descriptor,
            "LOCAL_TRUST_STATE_INVALID",
        )
        origin_row = self.db.execute("SELECT value FROM ledger_origin WHERE singleton=1").fetchone()
        need(origin_row is not None, "LOCAL_TRUST_STATE_INVALID")
        origin = evidence._parse(origin_row[0].encode("ascii"))
        evidence._fields(origin, {"archive", "sourceSchema", "anchor"})
        source, snapshot = build_v2_origin(origin["archive"], self.owner.bundle)
        anchor = origin["anchor"]
        expected_anchor = {
            "fromSchema": 1,
            "toSchema": 2,
            "bootstrapBundleDigest": wire.digest(self.owner.bundle),
            "sourceSchemaDigest": wire.digest(origin["sourceSchema"]),
            "sourceCheckpoint": {
                name: source[name]
                for name in ("ownershipEpoch", "rosterVersion", "rosterDigest", "eventDigest")
            },
            "sourceEvidenceDigest": public_archive_digest(origin["archive"]),
            "sourceClockHighWater": source["lastSeenNow"],
        }
        need(anchor == expected_anchor, "LOCAL_TRUST_STATE_INVALID")
        current_provisioning = None
        previous, version, timestamp = (
            source["eventDigest"],
            source["rosterVersion"],
            source["lastSeenNow"],
        )
        events = self.db.execute("SELECT * FROM ledger_events ORDER BY seq").fetchall()
        need(bool(events), "LOCAL_TRUST_STATE_INVALID")
        for position, row in enumerate(events):
            event = evidence._parse(row["value"].encode("ascii"))
            evidence._fields(
                event,
                {
                    "schemaVersion",
                    "eventId",
                    "sequence",
                    "eventType",
                    "previousEventDigest",
                    "ownershipEpoch",
                    "requestId",
                    "mutationDigest",
                    "actor",
                    "effectsDigest",
                    "authorizationVersion",
                    "policyVersion",
                    "committedAt",
                    "rosterDigest",
                    "body",
                },
            )
            need(
                type(event["schemaVersion"]) is int
                and event["schemaVersion"] == 2
                and event["sequence"] == row["seq"] == version + 1
                and event["previousEventDigest"] == previous
                and wire.digest(event) == row["digest"]
                and timestamp <= event["committedAt"] <= meta["lastSeenNow"],
                "LOCAL_TRUST_STATE_INVALID",
            )
            if position == 0:
                need(
                    event["eventType"] == "schema.migrated"
                    and event["body"] == anchor
                    and all(
                        event[field] is None
                        for field in ("requestId", "mutationDigest", "actor", "effectsDigest")
                    ),
                    "LOCAL_TRUST_STATE_INVALID",
                )
                ack = protocol.verify_response(
                    row["ack"],
                    self.owner.bundle["boxKey"],
                    box_id=self.owner.bundle["boxId"],
                    kind="migration-ack",
                )
                need(
                    ack["body"]
                    == {
                        "fromSchema": 1,
                        "toSchema": 2,
                        "sourceCheckpoint": anchor["sourceCheckpoint"],
                        "context": {
                            "boxId": meta["boxId"],
                            "boxKeyThumbprint": meta["boxKeyThumbprint"],
                            "ownershipEpoch": event["ownershipEpoch"],
                            "rosterVersion": event["sequence"],
                            "rosterDigest": event["rosterDigest"],
                            "policyVersion": event["policyVersion"],
                        },
                        "eventDigest": row["digest"],
                        "authorizationVersion": 1,
                    },
                    "LOCAL_TRUST_STATE_INVALID",
                )
            elif event["eventType"] in ("ownership.erase-started", "ownership.redelivery-ready"):
                from .local_ledger_transfer import transition as transfer_transition

                body = {key: value for key, value in event["body"].items() if key != "delta"}
                saved_transfer = self.transfer._saved_transfer(body["transferId"])
                need(
                    body["scopeManifestDigest"]
                    == saved_transfer["mutation"]["args"]["scopeManifestDigest"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
                snapshot, delta = transfer_transition(
                    snapshot, event["eventType"], body, event["sequence"], self.owner.bundle
                )
                need(
                    delta == event["body"]["delta"]
                    and all(
                        event[field] is None
                        for field in ("requestId", "mutationDigest", "actor", "effectsDigest")
                    ),
                    "LOCAL_TRUST_STATE_INVALID",
                )
                if event["eventType"] == "ownership.redelivery-ready":
                    current_provisioning = body["newProvisioning"]
                ack = protocol.verify_response(
                    row["ack"], self.owner.bundle["boxKey"], box_id=meta["boxId"], kind="checkpoint"
                )
                need(
                    ack["body"]
                    == {
                        "context": {
                            "boxId": meta["boxId"],
                            "boxKeyThumbprint": meta["boxKeyThumbprint"],
                            "ownershipEpoch": event["ownershipEpoch"],
                            "rosterVersion": event["sequence"],
                            "rosterDigest": event["rosterDigest"],
                            "policyVersion": event["policyVersion"],
                        },
                        "eventDigest": row["digest"],
                        "authorizationVersion": event["authorizationVersion"],
                    },
                    "LOCAL_TRUST_STATE_INVALID",
                )
            elif event["eventType"] in ("root.established", "binding.use-added"):
                context = {
                    "boxId": meta["boxId"],
                    "boxKeyThumbprint": meta["boxKeyThumbprint"],
                    "ownershipEpoch": snapshot["ownership"]["ownershipEpoch"],
                    "rosterVersion": version,
                    "rosterDigest": wire.digest(snapshot),
                    "policyVersion": snapshot["policyVersion"],
                }
                if event["eventType"] == "root.established":
                    evidence._fields(
                        event["body"],
                        {
                            "rootPayload",
                            "accessProof",
                            "approvalProof",
                            "secretProof",
                            "provisioningRecordDigest",
                            "delta",
                        },
                    )
                    value = wire.verify_first_root_proofs(
                        event["body"]["accessProof"],
                        event["body"]["approvalProof"],
                        event["body"]["secretProof"],
                    )
                    need(
                        value == event["body"]["rootPayload"]
                        and value["provisioningId"] == snapshot["ownership"]["provisioningId"]
                        and value["grants"] == self.owner.bundle["grants"]
                        and event["body"]["provisioningRecordDigest"]
                        == wire.digest(current_provisioning or self.owner.bundle),
                        "LOCAL_TRUST_STATE_INVALID",
                    )
                    after, new, _, delta = admit(
                        snapshot, context, value, event["committedAt"], event["sequence"]
                    )
                    digest = wire.first_root_digest(value)
                else:
                    evidence._fields(event["body"], {"requestProof", "approvalProof", "delta"})
                    value = evidence.verify_request_proof(event["body"]["requestProof"])
                    after, new, _, delta = admit(
                        snapshot,
                        context,
                        value,
                        event["committedAt"],
                        event["sequence"],
                        approval_proof=event["body"]["approvalProof"],
                        request_proof=event["body"]["requestProof"],
                    )
                    digest = evidence.request_digest(value)
                need(
                    delta == event["body"]["delta"]
                    and event["requestId"] == value["requestId"]
                    and event["mutationDigest"] == digest
                    and event["effectsDigest"] is None,
                    "LOCAL_TRUST_STATE_INVALID",
                )
                snapshot = after
                ack = wire.verify_response(
                    row["ack"],
                    self.owner.bundle["boxKey"],
                    box_id=self.owner.bundle["boxId"],
                    kind="binding-ack",
                )
                need(
                    ack["body"] == self._binding_ack_body(event, value, new, digest, snapshot),
                    "LOCAL_TRUST_STATE_INVALID",
                )
                stored = self.owner._existing(value["requestId"])
                need(
                    stored is not None
                    and stored["state"] == "approved"
                    and stored["ack"] == row["ack"]
                    and stored["digest"] == digest
                    and json.loads(stored["value"]) == value,
                    "LOCAL_TRUST_STATE_INVALID",
                )
                checkpoint = protocol.verify_response(
                    row["checkpoint"],
                    self.owner.bundle["boxKey"],
                    box_id=self.owner.bundle["boxId"],
                    kind="checkpoint",
                )
                need(
                    checkpoint["body"]
                    == {
                        "context": {
                            **context,
                            "rosterVersion": event["sequence"],
                            "rosterDigest": event["rosterDigest"],
                            "policyVersion": event["policyVersion"],
                        },
                        "eventDigest": row["digest"],
                        "authorizationVersion": event["authorizationVersion"],
                    }
                    and checkpoint["issuedAt"] == event["committedAt"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
            else:
                need(event["eventType"] in set(ACTION_EVENTS.values()), "LOCAL_TRUST_STATE_INVALID")
                evidence._fields(event["body"], {"mutation", "proofs", "delta"})
                mutation = event["body"]["mutation"]
                protocol.validate_mutation(mutation)
                context = {
                    "boxId": meta["boxId"],
                    "boxKeyThumbprint": meta["boxKeyThumbprint"],
                    "ownershipEpoch": snapshot["ownership"]["ownershipEpoch"],
                    "rosterVersion": version,
                    "rosterDigest": wire.digest(snapshot),
                    "policyVersion": snapshot["policyVersion"],
                }
                need(
                    all(mutation[key] == value for key, value in context.items())
                    and mutation["issuedAt"] <= event["committedAt"] < mutation["expiresAt"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
                saved_for_replay = self._mutation(mutation["requestId"])
                need(saved_for_replay is not None, "LOCAL_TRUST_STATE_INVALID")
                original_actor = authority_actor(snapshot, mutation["actor"], event["committedAt"])
                original_access_key = actor_key(original_actor, mutation["actor"], prepare=True)
                original_prepare = {
                    key: value for key, value in mutation.items() if key != "effectsDigest"
                }
                original_prepare["purpose"] = "centuarai.local-ledger.prepare"
                need(
                    saved_for_replay["prepare"] == original_prepare
                    and saved_for_replay["actorAccessKey"] == original_access_key
                    and protocol.verify_prepare(
                        saved_for_replay["prepareProof"], original_access_key
                    )
                    == original_prepare,
                    "LOCAL_TRUST_STATE_INVALID",
                )
                verify_proofs(
                    snapshot,
                    mutation,
                    event["body"]["proofs"],
                    event["committedAt"],
                    operation_plan=saved_for_replay.get("operationPlan")
                    if saved_for_replay
                    else None,
                )
                snapshot, effects, delta, result = transition(
                    snapshot,
                    mutation,
                    event["committedAt"],
                    event["sequence"],
                    invalidated=event["body"]["delta"]["invalidatedRequestIds"],
                )
                need(
                    delta == event["body"]["delta"]
                    and effects == self._stored_effects(mutation["requestId"])
                    and wire.digest(effects) == mutation["effectsDigest"] == event["effectsDigest"]
                    and event["eventType"] == ACTION_EVENTS[mutation["action"]]
                    and event["actor"] == mutation["actor"]
                    and event["requestId"] == mutation["requestId"]
                    and event["mutationDigest"] == wire.digest(mutation),
                    "LOCAL_TRUST_STATE_INVALID",
                )
                ack = protocol.verify_response(
                    row["ack"],
                    self.owner.bundle["boxKey"],
                    box_id=self.owner.bundle["boxId"],
                    kind="mutation-ack",
                )
                need(
                    ack["body"] == self._ack_body(event, row["digest"], mutation, result),
                    "LOCAL_TRUST_STATE_INVALID",
                )
                saved = self._mutation(mutation["requestId"])
                need(
                    saved is not None
                    and saved["state"] == "committed"
                    and saved["ack"] == row["ack"]
                    and saved["mutation"] == mutation
                    and saved["proofs"] == event["body"]["proofs"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
            need(
                event["rosterDigest"] == wire.digest(snapshot)
                and event["authorizationVersion"] == snapshot["authorizationVersion"]
                and event["policyVersion"] == snapshot["policyVersion"]
                and event["ownershipEpoch"] == snapshot["ownership"]["ownershipEpoch"]
                and ack["issuedAt"] == event["committedAt"]
                and (
                    event["eventType"] in ("root.established", "binding.use-added")
                    or row["checkpoint"] == row["ack"]
                ),
                "LOCAL_TRUST_STATE_INVALID",
            )
            previous, version, timestamp = row["digest"], event["sequence"], event["committedAt"]
        need(
            snapshot == self.snapshot(meta)
            and previous == meta["eventDigest"]
            and version == meta["rosterVersion"]
            and wire.digest(snapshot) == meta["rosterDigest"]
            and meta["ownershipEpoch"] == snapshot["ownership"]["ownershipEpoch"]
            and meta["principalId"] == snapshot["ownership"]["ownerPrincipalId"],
            "LOCAL_TRUST_STATE_INVALID",
        )
        expected_bindings = [
            {key: row[key] for key in evidence._BINDING_FIELDS} for row in snapshot["bindings"]
        ]
        need(self.owner._bindings() == expected_bindings, "LOCAL_TRUST_STATE_INVALID")
        expected_keys = {
            (evidence.public_key_thumbprint(row[field]), row["bindingId"], field)
            for row in snapshot["bindings"]
            for field in ("accessKey", "approvalKey")
            if row[field] is not None
        }
        need(
            set(
                tuple(row)
                for row in self.db.execute("SELECT thumbprint,binding_id,purpose FROM keys")
            )
            == expected_keys,
            "LOCAL_TRUST_STATE_INVALID",
        )
        self.operations.verify_history(meta)
        need(
            meta.get("currentProvisioning") == current_provisioning
            and meta["provisioningId"] == snapshot["ownership"]["provisioningId"],
            "LOCAL_TRUST_STATE_INVALID",
        )
        if snapshot["ownership"]["state"] == "unclaimed_ready":
            if current_provisioning is not None:
                from .local_ledger_transfer import credential_commitment

                need(
                    meta["claimSecretSha256"] is not None
                    and credential_commitment(current_provisioning, meta["claimSecretSha256"])
                    == current_provisioning["credentialCommitment"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
            else:
                need(
                    meta["claimSecretSha256"] == self.owner.bundle["claimSecretSha256"],
                    "LOCAL_TRUST_STATE_INVALID",
                )
        else:
            need(meta["claimSecretSha256"] is None, "LOCAL_TRUST_STATE_INVALID")

    def _mutation(self, request_id):
        row = self.db.execute(
            "SELECT state,value FROM mutation_requests WHERE request_id=?", (request_id,)
        ).fetchone()
        if row is None:
            return None
        value = json.loads(row["value"])
        need(value["state"] == row["state"], "LOCAL_TRUST_STATE_INVALID")
        return value

    def _stored_effects(self, request_id):
        value = self._mutation(request_id)
        need(value is not None, "LOCAL_TRUST_STATE_INVALID")
        return value["effects"]

    def maintenance(self, now, *, restart=False):
        for row in self.db.execute(
            "SELECT request_id,value FROM mutation_requests WHERE state='prepared'"
        ).fetchall():
            value = json.loads(row["value"])
            if restart or value["mutation"]["expiresAt"] <= now:
                value["state"] = "expired"
                self.db.execute(
                    "UPDATE mutation_requests SET state='expired',value=? WHERE request_id=?",
                    (wire.canonical(value).decode("ascii"), row["request_id"]),
                )
        self.db.execute(
            "DELETE FROM mutation_requests WHERE state IN ('expired','cancelled') AND json_extract(value,'$.mutation.expiresAt')<=?",
            (now - 3600,),
        )

    def mutation_challenge(self, actor, action, now):
        protocol.actor(actor)
        need(type(action) is str and action in protocol.ACTIONS, "LOCAL_BINDING_INVALID")
        with self.owner._transaction(now) as meta:
            nonce = self.owner._challenge(meta, "mutation-v2", now)
            return protocol.sign_response(
                self.owner,
                "mutation-challenge",
                {
                    "context": self.owner._context(meta),
                    "actor": actor,
                    "action": action,
                    "challenge": nonce,
                    "issuedAt": now,
                    "expiresAt": now + 300,
                },
                now,
            )

    def _invalidated(self, mutation, snapshot):
        action, args = mutation["action"], mutation["args"]
        principals = (
            {args["principalId"]}
            if action
            in ("principal.revoke", "team.member-suspend", "team.member-revoke", "team.member-role")
            else {mutation["actor"]["principalId"]}
            if action == "recovery.recover"
            else set()
        )
        identifiers = set()
        if action == "device.revoke":
            identifiers = {args["bindingId"]} | descendants(snapshot, {args["bindingId"]})
        result = []
        for row in self.db.execute(
            "SELECT request_id,kind,value,approval FROM requests WHERE state='pending'"
        ):
            request = json.loads(row["value"])
            if row["kind"] == "team":
                request = request["request"]
                if (
                    action == "team.invite-revoke"
                    and request["invitationId"] == args["invitationId"]
                ):
                    result.append(row["request_id"])
            if request["principalId"] in principals or action == "ownership.transfer-prepare":
                result.append(row["request_id"])
        for row in self.db.execute(
            "SELECT request_id,value FROM mutation_requests WHERE state='prepared'"
        ):
            value = json.loads(row["value"])["mutation"]
            if row["request_id"] != mutation["requestId"] and (
                value["actor"]["principalId"] in principals
                or value["actor"]["bindingId"] in identifiers
                or action == "ownership.transfer-prepare"
                or action == "team.invite-revoke"
                and value["action"] == "team.member-admit"
                and value["args"]["request"]["invitationId"] == args["invitationId"]
            ):
                result.append(row["request_id"])
        return sorted(set(result))

    def prepare_mutation(self, prepare_proof, now):
        value = protocol.decode_prepare(prepare_proof)
        with self.owner._transaction(now) as meta:
            snapshot = self.snapshot(meta)
            row = authority_actor(snapshot, value["actor"], now)
            protocol.verify_prepare(prepare_proof, actor_key(row, value["actor"], prepare=True))
            self._validate_team_configuration(value, snapshot)
            need(
                all(value[key] == item for key, item in self.owner._context(meta).items()),
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            existing = self._mutation(value["requestId"])
            if existing:
                need(
                    existing["prepare"] == value
                    and existing["state"] == "prepared"
                    and now < value["expiresAt"],
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                return existing["review"]
            from .local_team_service import TeamService

            TeamService(self.owner).check_prepared_request(value, now)
            need(
                self.db.execute(
                    "SELECT COUNT(*) FROM mutation_requests WHERE state='prepared'"
                ).fetchone()[0]
                < 128,
                "LOCAL_TRUST_CAPACITY",
            )
            need(not self.owner._existing(value["requestId"]), "LOCAL_TRUST_REQUEST_CONFLICT")
            self.owner._consume_challenge(value, "mutation-v2", now, value["requestId"], meta)
            mutation = {
                **value,
                "purpose": "centuarai.local-ledger.mutation",
                "effectsDigest": evidence._encode(bytes(32)),
            }
            proposed, effects, _, _ = transition(
                snapshot,
                mutation,
                now,
                meta["rosterVersion"] + 1,
                invalidated=self._invalidated(mutation, snapshot),
            )
            validate_read_capacity(
                proposed,
                {
                    **self.owner._context(meta),
                    "rosterVersion": meta["rosterVersion"] + 1,
                    "rosterDigest": wire.digest(proposed),
                },
                now,
                reserve=1024
                if value["action"] in ("device.add-manager", "principal.invite")
                else 0,
            )
            mutation["effectsDigest"] = wire.digest(effects)
            operation_plan = (
                self.operations.prepare_plan(mutation, snapshot, now)
                if value["action"].startswith("backup.")
                else None
            )
            review = protocol.sign_response(
                self.owner, "mutation-review", {"mutation": mutation, "effects": effects}, now
            )
            saved = {
                "state": "prepared",
                "prepare": value,
                "prepareProof": prepare_proof,
                "mutation": mutation,
                "effects": effects,
                "review": review,
                "proofs": None,
                "ack": None,
                "actorAccessKey": actor_key(row, value["actor"], prepare=True),
                "operationPlan": operation_plan,
                "transferPlan": self.transfer.prepare_plan(mutation, snapshot, now)
                if value["action"] == "ownership.transfer-prepare"
                else None,
            }
            self.db.execute(
                "INSERT INTO mutation_requests VALUES (?,?,?)",
                (value["requestId"], "prepared", wire.canonical(saved).decode("ascii")),
            )
            return review

    def _validate_team_configuration(self, value, snapshot):
        configured = getattr(self.owner, "_team_identity_policy", None)
        if value["action"] == "team.activate":
            need(
                configured is not None and value["args"]["cloudPolicy"] == configured,
                "LOCAL_TRUST_IDENTITY_POLICY_REQUIRED",
            )
        if "team" in snapshot:
            need(
                configured is not None and snapshot["team"]["cloudPolicy"] == configured,
                "LOCAL_TRUST_IDENTITY_POLICY_REQUIRED",
            )

    @staticmethod
    def _ack_body(event, event_digest, mutation, result):
        return {
            "requestId": mutation["requestId"],
            "mutationDigest": wire.digest(mutation),
            "action": mutation["action"],
            "effectsDigest": mutation["effectsDigest"],
            "eventId": event["eventId"],
            "eventDigest": event_digest,
            **{
                field: event[field]
                for field in (
                    "ownershipEpoch",
                    "rosterDigest",
                    "policyVersion",
                    "authorizationVersion",
                    "committedAt",
                )
            },
            "rosterVersion": event["sequence"],
            "ownershipState": "transfer_frozen"
            if mutation["action"] == "ownership.transfer-prepare"
            else "owned",
            "result": result,
        }

    def commit_mutation(
        self,
        mutation_proof,
        target_access_proof,
        target_approval_proof,
        recovery_material_proof,
        source_recovery_proof,
        now,
    ):
        value = protocol.decode_mutation(mutation_proof)
        proofs = {
            "mutationProof": mutation_proof,
            "targetAccessProof": target_access_proof,
            "targetApprovalProof": target_approval_proof,
            "recoveryMaterialProof": recovery_material_proof,
            "sourceRecoveryProof": source_recovery_proof,
        }
        with self.owner._transaction(now) as meta:
            saved = self._mutation(value["requestId"])
            need(saved is not None and saved["mutation"] == value, "LOCAL_TRUST_REQUEST_CONFLICT")
            if saved["state"] == "committed":
                # Exact historical proofs authenticate only this immutable ACK;
                # revoked actors get no present authority or fresh metadata.
                need(saved["proofs"] == proofs, "LOCAL_TRUST_REQUEST_CONFLICT")
                return saved["ack"]
            need(saved["state"] == "prepared", "LOCAL_TRUST_REQUEST_TERMINAL")
            need(value["issuedAt"] <= now < value["expiresAt"], "LOCAL_BINDING_EXPIRED")
            need(
                all(value[key] == item for key, item in self.owner._context(meta).items()),
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            snapshot = self.snapshot(meta)
            self._validate_team_configuration(value, snapshot)
            verify_proofs(snapshot, value, proofs, now, operation_plan=saved.get("operationPlan"))
            if value["action"].startswith("backup."):
                need(
                    self.operations.prepare_plan(value, snapshot, now) == saved["operationPlan"],
                    "LOCAL_BINDING_CONTEXT_MISMATCH",
                )
            if value["action"] == "ownership.transfer-prepare":
                need(
                    self.transfer.prepare_plan(value, snapshot, now) == saved["transferPlan"],
                    "LOCAL_BINDING_CONTEXT_MISMATCH",
                )
                need(
                    not self.db.execute(
                        "SELECT 1 FROM mutation_requests WHERE state='committed' AND json_extract(value,'$.mutation.action')='ownership.transfer-prepare' AND json_extract(value,'$.mutation.args.transferId')=?",
                        (value["args"]["transferId"],),
                    ).fetchone(),
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
            after, effects, delta, result = transition(
                snapshot,
                value,
                now,
                meta["rosterVersion"] + 1,
                invalidated=self._invalidated(value, snapshot),
            )
            need(
                effects == saved["effects"] and wire.digest(effects) == value["effectsDigest"],
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            validate_read_capacity(
                after,
                {
                    **self.owner._context(meta),
                    "rosterVersion": meta["rosterVersion"] + 1,
                    "rosterDigest": wire.digest(after),
                },
                now,
                reserve=1024
                if value["action"] in ("device.add-manager", "principal.invite")
                else 0,
            )
            event = {
                "schemaVersion": 2,
                "eventId": "event:"
                + wire.digest(
                    {"requestId": value["requestId"], "mutationDigest": wire.digest(value)}
                ),
                "sequence": meta["rosterVersion"] + 1,
                "eventType": ACTION_EVENTS[value["action"]],
                "previousEventDigest": meta["eventDigest"],
                "ownershipEpoch": after["ownership"]["ownershipEpoch"],
                "requestId": value["requestId"],
                "mutationDigest": wire.digest(value),
                "actor": value["actor"],
                "effectsDigest": value["effectsDigest"],
                "authorizationVersion": after["authorizationVersion"],
                "policyVersion": after["policyVersion"],
                "committedAt": now,
                "rosterDigest": wire.digest(after),
                "body": {"mutation": value, "proofs": proofs, "delta": delta},
            }
            event_digest = wire.digest(event)
            ack = protocol.sign_response(
                self.owner, "mutation-ack", self._ack_body(event, event_digest, value, result), now
            )
            persist_snapshot(self.db, after)
            meta.update(
                ownership=after["ownership"],
                ownershipEpoch=after["ownership"]["ownershipEpoch"],
                principalId=after["ownership"]["ownerPrincipalId"],
                rosterVersion=event["sequence"],
                rosterDigest=event["rosterDigest"],
                eventDigest=event_digest,
                policyVersion=after["policyVersion"],
                authorizationVersion=after["authorizationVersion"],
            )
            if "team" in after:
                meta["team"] = after["team"]
            self.owner._save_meta(meta)
            saved.update(state="committed", proofs=proofs, ack=ack)
            self.db.execute(
                "UPDATE mutation_requests SET state='committed',value=? WHERE request_id=?",
                (wire.canonical(saved).decode("ascii"), value["requestId"]),
            )
            self.db.execute(
                "INSERT INTO ledger_events VALUES (?,?,?,?,?)",
                (event["sequence"], event_digest, wire.canonical(event).decode("ascii"), ack, ack),
            )
            if value["action"].startswith("backup."):
                self.operations.create(value, saved["operationPlan"], event_digest, now)
            for identifier in delta["invalidatedRequestIds"]:
                self.db.execute(
                    "UPDATE requests SET state='expired' WHERE request_id=? AND state='pending'",
                    (identifier,),
                )
                other = self._mutation(identifier)
                if other and other["state"] == "prepared":
                    other["state"] = "cancelled"
                    self.db.execute(
                        "UPDATE mutation_requests SET state='cancelled',value=? WHERE request_id=?",
                        (wire.canonical(other).decode("ascii"), identifier),
                    )
            if value["action"] == "team.member-admit":
                self.db.execute(
                    "UPDATE requests SET state='approved',ack=? WHERE request_id=? AND kind='team' AND state='pending'",
                    (ack, protocol.team_protocol.request_digest(value["args"]["request"])),
                )
            self.owner._observe_commit(value["requestId"])
            return ack

    def auth_challenge_v2(self, now):
        with self.owner._transaction(now) as meta:
            nonce = self.owner._challenge(meta, "read-v2", now, ttl=60)
            return protocol.sign_response(
                self.owner,
                "read-challenge",
                {
                    "context": self.owner._context(meta),
                    "nonce": nonce,
                    "issuedAt": now,
                    "expiresAt": now + 60,
                },
                now,
            )

    def authenticated_challenge_v2(self, proof, now):
        return self._authenticated_challenge(proof, now)

    def authenticated_mutation_challenge_v2(self, proof, now):
        return self._authenticated_challenge(proof, now, mutation=True)

    def _authenticated_challenge(self, proof, now, *, mutation=False):
        """Registered key possession reserves only this actor's nonce quota."""
        import secrets

        with self.owner._transaction(now) as meta:
            try:
                value = (
                    protocol.decode_auth_mutation_challenge
                    if mutation
                    else protocol.decode_auth_challenge
                )(proof)
                snapshot = self.snapshot(meta)
                identity = value["actor"]
                if identity["kind"] == "binding":
                    row = authority_actor(snapshot, identity, now, historical=True)
                    key, epoch = row["accessKey"], row["ownershipEpoch"]
                else:
                    configs = [
                        item
                        for item in snapshot["recoveryConfigurations"]
                        if item["principalId"] == identity["principalId"]
                        and item["version"] == identity["keyVersion"]
                    ]
                    need(len(configs) == 1)
                    member = principal(snapshot, identity["principalId"])
                    need(member is not None)
                    key, epoch = configs[0]["signingKey"], member["ownershipEpoch"]
                (
                    protocol.verify_auth_mutation_challenge
                    if mutation
                    else protocol.verify_auth_challenge
                )(proof, key)
                need(
                    value["boxId"] == meta["boxId"]
                    and value["boxKeyThumbprint"] == meta["boxKeyThumbprint"]
                    and (value["ownershipEpoch"] is None or value["ownershipEpoch"] == epoch)
                    and value["issuedAt"] <= now < value["expiresAt"]
                )
            except evidence.BindingProtocolError as exc:
                raise evidence.BindingProtocolError("LOCAL_TRUST_CHALLENGE_DENIED") from exc
            kind = ("mutation-v2-auth:" if mutation else "read-v2-auth:") + wire.digest(identity)

            def response(context, nonce, issued, expires):
                body = {
                    "context": context,
                    "challenge" if mutation else "nonce": nonce,
                    "issuedAt": issued,
                    "expiresAt": expires,
                }
                if mutation:
                    body.update(actor=identity, action=value["action"])
                return protocol.sign_response(
                    self.owner, "mutation-challenge" if mutation else "read-challenge", body, issued
                )

            nonce_digest = wire.digest(value["clientNonce"])
            proof_digest = wire.digest(value)
            existing = self.db.execute(
                "SELECT * FROM challenges WHERE kind=? AND json_extract(context,'$.clientNonceDigest')=?",
                (kind, nonce_digest),
            ).fetchone()
            if existing is not None:
                wrapper = json.loads(existing["context"])
                need(
                    existing["boot_id"] == self.owner._boot_id
                    and existing["consumed"] is None
                    and wrapper["proofDigest"] == proof_digest,
                    "LOCAL_TRUST_CHALLENGE_DENIED",
                )
                return response(
                    wrapper["context"],
                    existing["nonce"],
                    existing["issued_at"],
                    existing["expires_at"],
                )
            need(
                self.db.execute(
                    "SELECT COUNT(*) FROM challenges WHERE kind=? AND consumed IS NULL AND boot_id=?",
                    (kind, self.owner._boot_id),
                ).fetchone()[0]
                < 8,
                "LOCAL_TRUST_CAPACITY",
            )
            need(
                self.db.execute("SELECT COUNT(*) FROM challenges WHERE kind=?", (kind,)).fetchone()[
                    0
                ]
                < 1024,
                "LOCAL_TRUST_CAPACITY",
            )
            nonce = secrets.token_urlsafe(32)
            context = self.owner._context(meta)
            wrapper = {
                "context": context,
                "clientNonceDigest": nonce_digest,
                "proofDigest": proof_digest,
            }
            if mutation:
                wrapper["action"] = value["action"]
            expires = now + 300 if mutation else value["expiresAt"]
            self.db.execute(
                "INSERT INTO challenges VALUES (?,?,?,?,?,?,NULL)",
                (
                    nonce,
                    kind,
                    wire.canonical(wrapper).decode("ascii"),
                    now,
                    expires,
                    self.owner._boot_id,
                ),
            )
            return response(context, nonce, now, expires)

    def read_v2(self, proof, now):
        value = protocol.decode_read(proof)
        with self.owner._transaction(now) as meta:
            snapshot = self.snapshot(meta)
            operation = value["operation"]
            try:
                if operation in ("mutation-status", "transfer-status"):
                    saved = self._mutation(value["requestId"])
                    need(saved is not None)
                    if operation == "transfer-status":
                        need(
                            saved["state"] == "committed"
                            and saved["mutation"]["action"] == "ownership.transfer-prepare"
                            and saved["mutation"]["actor"] == value["actor"]
                            and value["actor"]["kind"] == "binding"
                        )
                    if saved["mutation"]["actor"] == value["actor"]:
                        key = saved["actorAccessKey"]
                        row = None
                    else:
                        row = authority_actor(snapshot, value["actor"], now)
                        need(
                            value["actor"]["kind"] == "binding"
                            and row["role"] == "manage"
                            and row["principalId"] == saved["mutation"]["actor"]["principalId"]
                        )
                        key = row["accessKey"]
                else:
                    row = authority_actor(
                        snapshot, value["actor"], now, historical=operation == "self-binding"
                    )
                    key = actor_key(row, value["actor"], prepare=True)
                protocol.verify_read(proof, key)
                need(
                    value["boxId"] == meta["boxId"]
                    and value["boxKeyThumbprint"] == meta["boxKeyThumbprint"]
                    and value["ownershipEpoch"] == meta["ownershipEpoch"]
                )
                self.owner._consume_challenge(
                    value, "read-v2", now, value["nonce"], meta, field="nonce"
                )
            except evidence.BindingProtocolError as exc:
                raise evidence.BindingProtocolError("LOCAL_TRUST_READ_DENIED") from exc
            member = principal(snapshot, value["actor"]["principalId"])
            if operation in protocol.team_protocol.READ_OPERATIONS:
                from .local_team_service import TeamService

                body = TeamService(self.owner).read_body(operation, value, snapshot, row, meta, now)
            elif operation == "self-binding":
                body = {
                    "bindingId": row["bindingId"],
                    "principalId": row["principalId"],
                    "clientId": row["clientId"],
                    "bindingOwnershipEpoch": row["ownershipEpoch"],
                    "currentContext": self.owner._context(meta),
                    "status": "suspended"
                    if row["status"] == "active" and not binding_valid(snapshot, row, now)
                    else row["status"],
                    "principalStatus": member["status"],
                    "ownershipState": snapshot["ownership"]["state"],
                    "bindingRevision": row["bindingRevision"],
                    "principalSecurityVersion": member["principalSecurityVersion"],
                    "authorizationVersion": meta["authorizationVersion"],
                }
            elif operation == "principal-state":
                need(
                    value["actor"]["kind"] == "binding" and row["role"] == "manage",
                    "LOCAL_TRUST_READ_DENIED",
                )
                projection = principal_projection(snapshot, member, row)
                body = {
                    "context": self.owner._context(meta),
                    "projection": projection,
                    "projectionDigest": wire.digest(projection),
                }
            elif operation == "membership-directory":
                need(
                    value["actor"]["kind"] == "binding"
                    and row["role"] == "manage"
                    and row["principalId"] == snapshot["ownership"]["ownerPrincipalId"]
                    and bool(set(row["capabilities"]) & {"member.invite", "member.revoke"}),
                    "LOCAL_TRUST_READ_DENIED",
                )
                members = []
                for item in snapshot["principals"]:
                    if item["ownershipEpoch"] != meta["ownershipEpoch"]:
                        continue
                    event = self.db.execute(
                        "SELECT digest FROM ledger_events WHERE seq=?", (item["createdSequence"],)
                    ).fetchone()
                    if event is None:
                        event = self.db.execute(
                            "SELECT digest FROM events WHERE seq=?", (item["createdSequence"],)
                        ).fetchone()
                    need(event is not None, "LOCAL_TRUST_STATE_INVALID")
                    members.append(
                        {name: item[name] for name in ("principalId", "status", "createdSequence")}
                        | {"createdEventDigest": event[0]}
                    )
                body = {"context": self.owner._context(meta), "members": members}
            elif operation == "mutation-status":
                body = {
                    "requestId": value["requestId"],
                    "mutationDigest": wire.digest(saved["mutation"]),
                    "action": saved["mutation"]["action"],
                    "state": saved["state"],
                    "ack": saved["ack"] if saved["state"] == "committed" else None,
                }
            elif operation == "transfer-status":
                body = self.transfer.read_status(saved)
            elif operation == "recovery-state":
                need(
                    value["actor"]["kind"] == "recovery"
                    or row["role"] == "manage"
                    and "recovery.configure" in row["capabilities"],
                    "LOCAL_TRUST_READ_DENIED",
                )
                body = {
                    "principalId": member["principalId"],
                    "principalSecurityVersion": member["principalSecurityVersion"],
                    "configuration": recovery(snapshot, member["principalId"]),
                }
            elif operation == "data-effect":
                from .local_data_protocol import sign_data_response

                saved = self._mutation(value["requestId"])
                need(
                    saved is not None
                    and saved["state"] == "committed"
                    and value["actor"]["kind"] == "binding"
                    and row["role"] == "manage",
                    "LOCAL_TRUST_READ_DENIED",
                )
                mutation = saved["mutation"]
                required = ACTION_CAPS.get(
                    mutation["action"],
                    "recovery.configure"
                    if mutation["action"] == "recovery.recover"
                    else "device.approve_use",
                )
                need(
                    required in row["capabilities"]
                    and row["principalId"] == mutation["actor"]["principalId"],
                    "LOCAL_TRUST_READ_DENIED",
                )
                ack = protocol.verify_response(
                    saved["ack"],
                    self.owner.bundle["boxKey"],
                    box_id=meta["boxId"],
                    kind="mutation-ack",
                )["body"]
                scope = effect_scope(mutation, saved["effects"], meta["boxId"])
                expected = {
                    "operationId": value["requestId"],
                    "targetScope": scope,
                    "authorizationVersion": ack["authorizationVersion"],
                    "committedAtMs": ack["committedAt"] * 1000,
                    "deadlineMs": ack["committedAt"] * 1000 + 5000,
                }
                observed = (
                    self.effect_provider(value["requestId"], clone(expected))
                    if self.effect_provider
                    else None
                )
                if observed is None:
                    observed = {
                        **expected,
                        "effectState": "unknown",
                        "gateway": {
                            "generation": self.effect_generation,
                            "targetSessions": 0,
                            "closedSessions": 0,
                            "pendingSessions": 0,
                        },
                        "native": {
                            "targetOperations": 0,
                            "closedOperations": 0,
                            "pendingOperations": 0,
                            "unknownOperations": 0,
                        },
                        "observedAtMs": now * 1000,
                        "evidenceDigest": wire.digest(
                            {"purpose": "centuarai.local-ledger.effect-unobserved", **expected}
                        ),
                    }
                need(
                    type(observed) is dict
                    and all(observed.get(key) == item for key, item in expected.items()),
                    "LOCAL_TRUST_STATE_INVALID",
                )
                return sign_data_response(
                    self.owner._key,
                    box_id=meta["boxId"],
                    kind="effect",
                    body=observed,
                    now_ms=now * 1000,
                )
            elif operation == "operation-status":
                job = self.operations._get(value["requestId"])
                saved = self._mutation(value["requestId"])
                need(
                    saved is not None
                    and value["actor"]["kind"] == "binding"
                    and row["role"] == "manage"
                    and row["principalId"] == saved["mutation"]["actor"]["principalId"]
                    and saved["mutation"]["action"] in row["capabilities"],
                    "LOCAL_TRUST_READ_DENIED",
                )
                return job["signedStatus"]
            else:
                need(False, "LOCAL_TRUST_OPERATION_UNAVAILABLE")
            return protocol.sign_response(self.owner, operation, body, now)

    def get_authorization(self, binding_id, now):
        evidence._token(binding_id)
        with self.owner._transaction(now) as meta:
            snapshot = self.snapshot(meta)
            row = binding(snapshot, binding_id)
            need(binding_valid(snapshot, row, now), "LOCAL_TRUST_ACCESS_DENIED")
            grants = effective_grants(snapshot, row, now)
            need(bool(grants), "LOCAL_TRUST_ACCESS_DENIED")
            member = principal(snapshot, row["principalId"])
            limits = [row["expiresAt"], *(item["expiresAt"] for item in grants)]
            parent = row["createdByBindingId"]
            while parent is not None:
                predecessor = binding(snapshot, parent)
                if predecessor["principalId"] != row["principalId"]:
                    break
                limits += [predecessor["expiresAt"], predecessor["delegationExpiresAt"]]
                parent = predecessor["createdByBindingId"]
            result = {
                **self.owner._context(meta),
                "authorizationVersion": meta["authorizationVersion"],
                "bindingId": row["bindingId"],
                "bindingRevision": row["bindingRevision"],
                "principalId": row["principalId"],
                "principalSecurityVersion": member["principalSecurityVersion"],
                "clientId": row["clientId"],
                "accessKey": row["accessKey"],
                "status": row["status"],
                "principalStatus": member["status"],
                "ownershipState": snapshot["ownership"]["state"],
                "grants": grant_list(grants),
                "expiresAt": minimum(*limits),
            }
            if "team" in snapshot:
                from .local_team_ledger import filter_grants, team_authorization

                result["team"] = team_authorization(snapshot, row, now)
                need(result["team"] is not None, "LOCAL_TRUST_CLOUD_IDENTITY_REQUIRED")
                result["grants"] = filter_grants(snapshot, row, result["grants"], now)
                need(bool(result["grants"]), "LOCAL_TRUST_ACCESS_DENIED")
            return result

    def get_effect_commit(self, request_id):
        """Private immutable commit metadata for the colocated effect tracker."""
        evidence._digest(request_id)
        with self.owner._lock:
            need(not self.owner._closed, "LOCAL_TRUST_CLOSED")
            meta = self.owner._meta()
            need(meta["bootId"] == self.owner._boot_id, "LOCAL_TRUST_BOOT_MISMATCH")
            saved = self._mutation(request_id)
            need(saved is not None and saved["state"] == "committed", "LOCAL_TRUST_REQUEST_DENIED")
            ack = protocol.verify_response(
                saved["ack"], self.owner.bundle["boxKey"], box_id=meta["boxId"], kind="mutation-ack"
            )["body"]
            row = self.db.execute(
                "SELECT value FROM ledger_events WHERE digest=?", (ack["eventDigest"],)
            ).fetchone()
            need(row is not None, "LOCAL_TRUST_STATE_INVALID")
            event = json.loads(row[0])
            mutation = saved["mutation"]
            action = mutation["action"]
            target_scope = effect_scope(mutation, saved["effects"], meta["boxId"])
            if target_scope["kind"] == "ownership":
                affected = [
                    row["bindingId"]
                    for row in self.snapshot(meta)["bindings"]
                    if row["ownershipEpoch"] == ack["ownershipEpoch"]
                ]
            else:
                affected = [
                    row["bindingId"]
                    for row in event["body"]["delta"]["bindings"]
                    if row["status"] in ("revoked", "suspended")
                ]
                if action == "team.device-resources":
                    identifiers = {mutation["args"]["bindingId"]}
                    affected.extend(identifiers | descendants(self.snapshot(meta), identifiers))
            jobs = []
            for job_row in self.db.execute(
                "SELECT operation_id,value FROM local_operations ORDER BY operation_id"
            ):
                job = json.loads(job_row["value"])
                source = self._mutation(job["status"]["requestId"])
                source_actor = source["mutation"]["actor"]
                if not (
                    source_actor["bindingId"] in affected
                    or action == "ownership.transfer-prepare"
                    or action in ("recovery.rotate", "recovery.recover")
                    and source_actor["principalId"] == saved["effects"]["targetPrincipalId"]
                ):
                    continue
                source_ack = protocol.verify_response(
                    source["ack"],
                    self.owner.bundle["boxKey"],
                    box_id=meta["boxId"],
                    kind="mutation-ack",
                )["body"]
                if (
                    source_ack["rosterVersion"] >= ack["rosterVersion"]
                    or source_ack["ownershipEpoch"] != ack["ownershipEpoch"]
                ):
                    continue
                # A terminal SQL phase is not a physical worker closure receipt.
                # Retain every known attempt, including superseded/terminal ones.
                versions = self.db.execute(
                    "SELECT json_extract(value,'$.attempt') attempt,MAX(json_extract(value,'$.stateVersion')) version FROM operation_events WHERE operation_id=? GROUP BY json_extract(value,'$.attempt') ORDER BY attempt LIMIT ?",
                    (job_row["operation_id"], 129 - len(jobs)),
                )
                for version in versions:
                    jobs.append(
                        {
                            "operationId": job_row["operation_id"],
                            "attempt": version["attempt"],
                            "stateVersion": version["version"],
                            "bindingId": source_actor["bindingId"],
                            "principalId": source_actor["principalId"],
                            "ownershipEpoch": source_ack["ownershipEpoch"],
                            "authorizationVersion": source_ack["authorizationVersion"],
                        }
                    )
                if len(jobs) > 128:
                    break
            return {
                "operationId": request_id,
                "authorizationVersion": ack["authorizationVersion"],
                "committedAtMs": ack["committedAt"] * 1000,
                "deadlineMs": ack["committedAt"] * 1000 + 5000,
                "targetScope": target_scope,
                "affectedBindingIds": sorted(set(affected)),
                "affectedJobs": jobs[:128],
                "affectedJobsComplete": len(jobs) <= 128,
            }

    @staticmethod
    def _binding_ack_body(event, request, row, digest, snapshot):
        return {
            "requestId": request["requestId"],
            "requestDigest": digest,
            "bindingId": row["bindingId"],
            "principalId": row["principalId"],
            "clientId": row["clientId"],
            "role": row["role"],
            "accessKeyThumbprint": evidence.public_key_thumbprint(row["accessKey"]),
            "ownershipEpoch": event["ownershipEpoch"],
            "rosterVersion": event["sequence"],
            "rosterDigest": event["rosterDigest"],
            "policyVersion": event["policyVersion"],
            "committedAt": event["committedAt"],
            "recoveryConfigured": recovery(snapshot, row["principalId"]) is not None,
        }

    def _commit_admission(
        self, meta, request, digest, snapshot, new, delta, body, now, approval=None
    ):
        import secrets

        root = new["role"] == "manage"
        validate_read_capacity(
            snapshot,
            {
                **self.owner._context(meta),
                "rosterVersion": meta["rosterVersion"] + 1,
                "rosterDigest": wire.digest(snapshot),
            },
            now,
            reserve=1024,
        )
        event = {
            "schemaVersion": 2,
            "eventId": "event:" + secrets.token_urlsafe(32),
            "sequence": meta["rosterVersion"] + 1,
            "eventType": "root.established" if root else "binding.use-added",
            "previousEventDigest": meta["eventDigest"],
            "ownershipEpoch": snapshot["ownership"]["ownershipEpoch"],
            "requestId": request["requestId"],
            "mutationDigest": digest,
            "actor": None
            if root
            else {
                "kind": "binding",
                "principalId": request["principalId"],
                "bindingId": approval["approverBindingId"],
                "keyVersion": approval["approvalKeyVersion"],
            },
            "effectsDigest": None,
            "authorizationVersion": snapshot["authorizationVersion"],
            "policyVersion": snapshot["policyVersion"],
            "committedAt": now,
            "rosterDigest": wire.digest(snapshot),
            "body": {**body, "delta": delta},
        }
        event_digest = wire.digest(event)
        ack = self.owner._signed(
            meta, "binding-ack", self._binding_ack_body(event, request, new, digest, snapshot), now
        )
        persist_snapshot(self.db, snapshot)
        meta.update(
            ownership=snapshot["ownership"],
            ownershipEpoch=snapshot["ownership"]["ownershipEpoch"],
            principalId=snapshot["ownership"]["ownerPrincipalId"],
            rosterVersion=event["sequence"],
            rosterDigest=event["rosterDigest"],
            eventDigest=event_digest,
            policyVersion=snapshot["policyVersion"],
            authorizationVersion=snapshot["authorizationVersion"],
        )
        if root:
            meta["claimSecretSha256"] = None
        self.owner._save_meta(meta)
        checkpoint = protocol.sign_response(
            self.owner,
            "checkpoint",
            {
                "context": self.owner._context(meta),
                "eventDigest": event_digest,
                "authorizationVersion": meta["authorizationVersion"],
            },
            now,
        )
        self.db.execute(
            "INSERT INTO ledger_events VALUES (?,?,?,?,?)",
            (
                event["sequence"],
                event_digest,
                wire.canonical(event).decode("ascii"),
                ack,
                checkpoint,
            ),
        )
        parent = binding(snapshot, approval["approverBindingId"]) if approval else None
        self.db.execute(
            "UPDATE requests SET state='approved',ack=?,approval=?,approval_key=? WHERE request_id=?",
            (
                ack,
                wire.canonical(approval).decode("ascii") if approval else None,
                wire.canonical(parent["approvalKey"]).decode("ascii") if parent else None,
                request["requestId"],
            ),
        )
        self.owner._observe_commit()
        return ack

    def first_root_challenge(self, now):
        with self.owner._transaction(now) as meta:
            need(
                meta["ownership"]["state"] == "unclaimed_ready"
                and meta["claimSecretSha256"] is not None,
                "LOCAL_TRUST_ALREADY_OWNED",
            )
            nonce = self.owner._challenge(meta, "root", now)
            return self.owner._signed(
                meta,
                "first-root-challenge",
                {
                    "provisioningId": meta["provisioningId"],
                    "ownershipEpoch": meta["ownershipEpoch"],
                    "challenge": nonce,
                    "issuedAt": now,
                    "expiresAt": now + 300,
                    "grants": meta["initialGrants"],
                },
                now,
            )

    def commit_first_root(self, access_proof, approval_proof, secret_proof, now):
        with self.owner._transaction(now) as meta:
            value = wire.verify_first_root_proofs(access_proof, approval_proof, secret_proof)
            digest = wire.first_root_digest(value)
            existing = self.owner._existing(value["requestId"])
            if existing is not None:
                need(
                    existing["kind"] == "root"
                    and existing["digest"] == digest
                    and existing["state"] == "approved"
                    and existing["ack"] is not None,
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                return existing["ack"]
            need(
                meta["ownership"]["state"] == "unclaimed_ready"
                and meta["claimSecretSha256"] is not None,
                "LOCAL_TRUST_ALREADY_OWNED",
            )
            wire.verify_first_root_proofs(
                access_proof,
                approval_proof,
                secret_proof,
                evidence._decode(meta["claimSecretSha256"], 32),
            )
            need(
                value["provisioningId"] == meta["provisioningId"]
                and value["grants"] == meta["initialGrants"],
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            need(self._mutation(value["requestId"]) is None, "LOCAL_TRUST_REQUEST_CONFLICT")
            self.owner._consume_challenge(value, "root", now, value["requestId"], meta)
            after, new, _, delta = admit(
                self.snapshot(meta),
                self.owner._context(meta),
                value,
                now,
                meta["rosterVersion"] + 1,
            )
            self.owner._capacity()
            self.db.execute(
                "INSERT INTO requests VALUES (?, 'root', ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL)",
                (
                    value["requestId"],
                    digest,
                    wire.canonical(value).decode("ascii"),
                    access_proof,
                    value["expiresAt"],
                ),
            )
            return self._commit_admission(
                meta,
                value,
                digest,
                after,
                new,
                delta,
                {
                    "rootPayload": value,
                    "accessProof": access_proof,
                    "approvalProof": approval_proof,
                    "secretProof": secret_proof,
                    "provisioningRecordDigest": wire.digest(
                        meta.get("currentProvisioning") or self.owner.bundle
                    ),
                },
                now,
            )

    def request_challenge(self, now):
        with self.owner._transaction(now) as meta:
            need(meta["ownership"]["state"] == "owned", "LOCAL_TRUST_NOT_OWNED")
            nonce = self.owner._challenge(meta, "use", now)
            return self.owner._signed(
                meta,
                "binding-challenge",
                {
                    "context": self.owner._context(meta),
                    "challenge": nonce,
                    "issuedAt": now,
                    "expiresAt": now + 300,
                },
                now,
            )

    def submit_request(self, request_proof, now):
        with self.owner._transaction(now) as meta:
            request = evidence.verify_request_proof(request_proof)
            digest = evidence.request_digest(request)
            existing = self.owner._existing(request["requestId"])
            if existing:
                need(
                    existing["kind"] == "use"
                    and existing["digest"] == digest
                    and existing["receipt"] is not None,
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                self.owner._saved_request(existing)
                return existing["receipt"]
            snapshot = self.snapshot(meta)
            member = principal(snapshot, request["principalId"])
            need(
                member is not None
                and member["status"] == "active"
                and snapshot["ownership"]["state"] == "owned"
                and member["ownershipEpoch"] == meta["ownershipEpoch"],
                "LOCAL_TRUST_REQUEST_DENIED",
            )
            evidence.validate_request_context(
                request, {**self.owner._context(meta), "challenge": request["challenge"]}, now
            )
            validate_resource_grants(request["grants"])
            assert_unused(snapshot, target=request)
            need(self._mutation(request["requestId"]) is None, "LOCAL_TRUST_REQUEST_CONFLICT")
            self.owner._consume_challenge(request, "use", now, request["requestId"], meta)
            self.owner._capacity()
            need(
                self.db.execute("SELECT COUNT(*) FROM requests WHERE state='pending'").fetchone()[0]
                < 128,
                "LOCAL_TRUST_CAPACITY",
            )
            self.db.execute(
                "INSERT INTO requests VALUES (?, 'use', ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL)",
                (
                    request["requestId"],
                    digest,
                    wire.canonical(request).decode("ascii"),
                    request_proof,
                    request["expiresAt"],
                ),
            )
            receipt = self.owner._receipt(meta, self.owner._existing(request["requestId"]), now)
            self.db.execute(
                "UPDATE requests SET receipt=? WHERE request_id=?", (receipt, request["requestId"])
            )
            return receipt

    def approve_request(self, request_id, approval_proof, now):
        evidence._digest(request_id)
        with self.owner._transaction(now) as meta:
            saved = self.owner._existing(request_id)
            need(saved is not None and saved["kind"] == "use", "LOCAL_TRUST_REQUEST_DENIED")
            request = self.owner._saved_request(saved)
            if saved["state"] == "approved":
                wire.verify_saved_approval(
                    approval_proof, json.loads(saved["approval"]), json.loads(saved["approval_key"])
                )
                return saved["ack"]
            need(saved["state"] == "pending", "LOCAL_TRUST_REQUEST_TERMINAL")
            after, new, approval, delta = admit(
                self.snapshot(meta),
                self.owner._context(meta),
                request,
                now,
                meta["rosterVersion"] + 1,
                approval_proof=approval_proof,
                request_proof=saved["request_jws"],
            )
            return self._commit_admission(
                meta,
                request,
                saved["digest"],
                after,
                new,
                delta,
                {"requestProof": saved["request_jws"], "approvalProof": approval_proof},
                now,
                approval,
            )

    def cancel_request(self, cancel_proof, now):
        with self.owner._transaction(now) as meta:
            locator = evidence.decode_cancel_payload(cancel_proof)
            saved = self.owner._existing(locator["requestId"])
            need(saved is not None and saved["kind"] == "use", "LOCAL_TRUST_REQUEST_DENIED")
            evidence.verify_cancel_proof(cancel_proof, self.owner._saved_request(saved), now)
            self.db.execute(
                "UPDATE requests SET state='cancelled' WHERE request_id=? AND state='pending'",
                (locator["requestId"],),
            )
            return self.owner._receipt(meta, self.owner._existing(locator["requestId"]), now)

    def auth_challenge(self, now):
        with self.owner._transaction(now) as meta:
            need(meta["ownership"]["state"] == "owned", "LOCAL_TRUST_NOT_OWNED")
            nonce = self.owner._challenge(meta, "read", now, ttl=60)
            return self.owner._signed(
                meta,
                "auth-challenge",
                {
                    "nonce": nonce,
                    "issuedAt": now,
                    "expiresAt": now + 60,
                    "ownershipEpoch": meta["ownershipEpoch"],
                },
                now,
            )

    def read_state(self, proof, now):
        need(False, "LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED")

    def read_request(self, proof, now):
        with self.owner._transaction(now) as meta:
            try:
                value = wire.decode_read_proof(proof)
                need(value["operation"] == "request")
                saved = self.owner._existing(value["requestId"])
                need(saved is not None and saved["kind"] == "use")
                request = self.owner._saved_request(saved)
                snapshot = self.snapshot(meta)
                manager = lookup(snapshot["bindings"], "clientId", value["clientId"])
                manager_actor = None
                if (
                    manager
                    and manager["role"] == "manage"
                    and manager["principalId"] == request["principalId"]
                    and binding_valid(snapshot, manager, now)
                ):
                    key = manager["accessKey"]
                    manager_actor = {
                        "kind": "binding",
                        "principalId": manager["principalId"],
                        "bindingId": manager["bindingId"],
                        "keyVersion": manager["approvalKeyVersion"],
                    }
                else:
                    need(request["clientId"] == value["clientId"])
                    key = request["accessKey"]
                wire.verify_read_proof(proof, key)
                need(
                    all(
                        value[field] == meta[field]
                        for field in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
                    )
                )
                nonce = self.db.execute(
                    "SELECT kind FROM challenges WHERE nonce=?", (value["nonce"],)
                ).fetchone()
                if manager_actor and nonce and nonce["kind"].startswith("read-v2-auth:"):
                    # The v1 request wire has no actor. Derive it only from the
                    # current manager whose access proof was just verified.
                    self.owner._consume_challenge(
                        {**value, "actor": manager_actor},
                        "read-v2",
                        now,
                        value["nonce"],
                        meta,
                        field="nonce",
                    )
                else:
                    self.owner._consume_challenge(
                        value, "read", now, value["nonce"], meta, field="nonce"
                    )
            except evidence.BindingProtocolError as exc:
                raise evidence.BindingProtocolError("LOCAL_TRUST_READ_DENIED") from exc
            return self.owner._signed(
                meta,
                "request",
                {
                    "requestId": saved["request_id"],
                    "requestDigest": saved["digest"],
                    "state": saved["state"],
                    "requestJws": saved["request_jws"],
                    "ack": saved["ack"],
                },
                now,
            )

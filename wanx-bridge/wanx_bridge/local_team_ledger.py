"""Deterministic team transitions in the existing signed local-authority ledger."""

from __future__ import annotations

from . import local_management_protocol as wire
from . import local_team_protocol as team_wire

MAX_MEMBERS = 32
MAX_INVITATIONS = 128
MAX_RESOURCES = 64


def member_for(snapshot, principal_id):
    return next(
        (
            row
            for row in snapshot.get("team", {}).get("members", [])
            if row["principalId"] == principal_id
        ),
        None,
    )


def summary(member):
    return {
        name: member[name]
        for name in (
            "membershipId",
            "principalId",
            "issuer",
            "subject",
            "roleId",
            "status",
            "revision",
            "createdAt",
            "expiresAt",
        )
    }


def synchronize_associations(before, after, now):
    """A device/authority change has a durable projection revision, never a read-time one."""
    from . import local_ledger_engine as engine

    for member in after.get("team", {}).get("members", []):
        previous = member_for(before, member["principalId"])
        if previous is None:
            continue
        old_device = engine.binding(before, member["bindingId"])
        device = engine.binding(after, member["bindingId"])
        old_principal = engine.principal(before, member["principalId"])
        current_principal = engine.principal(after, member["principalId"])
        if old_principal["status"] != current_principal["status"]:
            member["status"] = current_principal["status"]
        if old_device != device or old_principal["status"] != current_principal["status"]:
            if member["revision"] == previous["revision"]:
                member["revision"] += 1
            member["authorityDigest"] = wire.digest(
                {
                    "capabilities": device["capabilities"],
                    "grants": engine.grant_list(engine.effective_grants(after, device, now)),
                    "delegableGrants": engine.grant_list(
                        engine.effective_grants(after, device, now, delegation=True), delegate=True
                    ),
                    "expiresAt": device["expiresAt"],
                    "delegationExpiresAt": device["delegationExpiresAt"],
                }
            )


def team_authorization(snapshot, row, now):
    from .local_ledger_engine import binding_valid, effective_grants, grant_list, live, need

    member = member_for(snapshot, row["principalId"])
    if member is None:
        return None
    need(
        member["status"] == "active"
        and live(member["expiresAt"], now)
        and binding_valid(snapshot, row, now)
    )
    management = next(
        (
            item["actions"]
            for item in grant_list(effective_grants(snapshot, row, now))
            if item["resourceId"] == "team:management"
        ),
        [],
    )
    permissions = [
        permission
        for permission in team_wire.PERMISSIONS[member["roleId"]]
        if ("read" if permission == "members.read" else "write") in management
    ]
    return {
        "schemaVersion": 1,
        "boxId": snapshot["team"]["boxId"],
        "ownershipEpoch": row["ownershipEpoch"],
        "principalId": row["principalId"],
        "membershipId": member["membershipId"],
        "membershipRevision": member["revision"],
        "roleId": member["roleId"],
        "permissions": permissions,
    }


def filter_grants(snapshot, row, grants, now):
    current = team_authorization(snapshot, row, now)
    result = []
    for grant in grants:
        resource = grant["resourceId"]
        if not resource.startswith("team:"):
            result.append(grant)
            continue
        if current is None:
            continue
        if resource == "team:management":
            if current["permissions"]:
                result.append(grant)
            continue
        record = next(
            (item for item in snapshot["team"]["resources"] if item["resourceId"] == resource), None
        )
        allowed = (
            next(
                (
                    item["actions"]
                    for item in record["grants"]
                    if item["principalId"] == row["principalId"]
                ),
                [],
            )
            if record
            else []
        )
        actions = sorted(set(grant["actions"]) & set(allowed))
        if actions:
            result.append({**grant, "actions": actions})
    return result


def _association(snapshot, mutation, row, policy, now, sequence, *, role_id, result_binding):
    from .local_ledger_engine import clone, live, need

    request, proof = mutation["args"]["request"], mutation["args"]["cloudProof"]
    cloud = team_wire.verify_cloud(proof, policy, request, now)
    need(
        all(
            request[key] == mutation[key] for key in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
        ),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    members = snapshot["team"]["members"]
    need(len(members) < MAX_MEMBERS, "LOCAL_TRUST_CAPACITY")
    need(
        not any(item["principalId"] == request["principalId"] for item in members),
        "LOCAL_TRUST_IDENTITY_CONFLICT",
    )
    need(
        not any(
            item["issuer"] == cloud["issuer"]
            and (item["cloudJti"] == cloud["jti"] or item["subject"] == cloud["subject"])
            for item in members
        ),
        "LOCAL_TRUST_IDENTITY_CONFLICT",
    )
    need(live(result_binding["expiresAt"], now), "LOCAL_BINDING_EXPIRED")
    member = {
        "membershipId": wire.digest(
            {
                "purpose": "centuarai.team.membership",
                "requestId": mutation["requestId"],
                "principalId": request["principalId"],
            }
        ),
        "principalId": request["principalId"],
        "issuer": cloud["issuer"],
        "subject": cloud["subject"],
        "roleId": role_id,
        "status": "active",
        "revision": 1,
        "createdAt": now,
        "expiresAt": result_binding["expiresAt"],
        "bindingId": result_binding["bindingId"],
        "cloudJti": cloud["jti"],
        "cloudProofDigest": team_wire.proof_digest(proof),
        "clientId": cloud["clientId"],
        "clientKeyThumbprint": cloud["clientKeyThumbprint"],
        "requestDigest": team_wire.request_digest(request),
        "invitationId": request["invitationId"],
        "createdSequence": sequence,
        "authorityDigest": wire.digest(
            {key: request["target"][key] for key in team_wire.TARGET_POLICY_FIELDS}
        ),
    }
    members.append(member)
    return clone(member)


def _target_existing(snapshot, request, now):
    from .local_ledger_engine import binding_valid, effective_grants, grant_list, need

    target = request["target"]
    row = next(
        (item for item in snapshot["bindings"] if item["clientId"] == target["clientId"]), None
    )
    need(
        row is not None
        and row["principalId"] == request["principalId"]
        and row["role"] == "manage"
        and binding_valid(snapshot, row, now, delegation=True)
    )
    need(
        all(
            target[key] == row[key]
            for key in (
                "accessKey",
                "approvalKey",
                "capabilities",
                "expiresAt",
                "delegationExpiresAt",
            )
        ),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    need(
        target["delegableGrants"]
        == grant_list(effective_grants(snapshot, row, now, delegation=True), delegate=True),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    return row, grant_list(effective_grants(snapshot, row, now))


def transition(snapshot, mutation, now, sequence, *, invalidated=()):
    from . import local_ledger_engine as engine
    from . import local_ledger_protocol as protocol

    before = snapshot
    snapshot = engine.clone(snapshot)
    action, args, actor = mutation["action"], mutation["args"], mutation["actor"]
    row = engine.authority_actor(snapshot, actor, now)
    engine.need(
        actor["kind"] == "binding" and row["role"] == "manage" and row["approvalKey"] is not None
    )
    owner = snapshot["ownership"]["ownerPrincipalId"]
    engine.need(snapshot["ownership"]["state"] == "owned")
    if action == "team.device-resources":
        engine.need(
            actor["principalId"] == owner
            and "member.invite" in row["capabilities"]
            or actor["principalId"] == args["principalId"]
            and bool(set(row["capabilities"]) & {"device.approve_use", "device.approve_manage"})
        )
    elif action == "team.resource-set":
        auth = team_authorization(snapshot, row, now)
        engine.need(auth is not None and "resources.manage" in auth["permissions"])
    else:
        engine.need(actor["principalId"] == owner and "member.invite" in row["capabilities"])
    if action == "team.activate":
        engine.need("team" not in snapshot, "LOCAL_TRUST_REQUEST_CONFLICT")
        engine.need(args["request"]["principalId"] == owner)
        snapshot["team"] = {
            "schemaVersion": 1,
            "boxId": mutation["boxId"],
            "cloudPolicy": engine.clone(args["cloudPolicy"]),
            "members": [],
            "invitations": [],
            "resources": [],
            "migrations": [],
        }
    else:
        engine.need("team" in snapshot, "LOCAL_TRUST_TEAM_REQUIRED")
        own_member = member_for(snapshot, actor["principalId"])
        engine.need(own_member is not None and own_member["status"] == "active")
        if action not in ("team.device-resources", "team.resource-set"):
            auth = team_authorization(snapshot, row, now)
            engine.need(auth is not None and "members.manage" in auth["permissions"])
    team = snapshot["team"]
    affected = args.get("principalId", actor["principalId"])
    targets, revoked, suspended = [], set(), set()
    result_binding = None
    old_principal = engine.principal(before, affected)
    old_security = old_principal["principalSecurityVersion"] if old_principal else None

    if action == "team.invite-create":
        invitation_id, target = args["invitationId"], args["targetPolicy"]
        engine.need(
            not any(item["invitationId"] == invitation_id for item in team["invitations"]),
            "LOCAL_TRUST_REQUEST_CONFLICT",
        )
        engine.need(len(team["invitations"]) < MAX_INVITATIONS, "LOCAL_TRUST_CAPACITY")
        engine.need(now < args["expiresAt"] <= now + 7 * 86400, "LOCAL_BINDING_EXPIRED")
        engine.need(
            set(target["capabilities"]) <= set(row["capabilities"]) & protocol.INVITED_CAPABILITIES,
            "LOCAL_BINDING_SCOPE_EXCEEDED",
        )
        _validate_target_grants(snapshot, row, target, now, args["roleId"])
        team["invitations"].append(
            {
                **engine.clone(args),
                "status": "pending",
                "revision": 1,
                "createdAt": now,
                "usedByMembershipId": None,
            }
        )
    elif action == "team.invite-revoke":
        invitation = next(
            (item for item in team["invitations"] if item["invitationId"] == args["invitationId"]),
            None,
        )
        engine.need(
            invitation is not None and invitation["status"] == "pending",
            "LOCAL_TRUST_REQUEST_TERMINAL",
        )
        invitation.update(status="revoked", revision=invitation["revision"] + 1)
    elif action in team_wire.ASSOCIATION_ACTIONS:
        request = args["request"]
        affected = request["principalId"]
        old_principal = engine.principal(before, affected)
        old_security = old_principal["principalSecurityVersion"] if old_principal else None
        if action == "team.member-admit":
            invitation = next(
                (
                    item
                    for item in team["invitations"]
                    if item["invitationId"] == request["invitationId"]
                ),
                None,
            )
            engine.need(
                invitation is not None
                and invitation["status"] == "pending"
                and now < invitation["expiresAt"],
                "LOCAL_TRUST_INVITATION_DENIED",
            )
            target = request["target"]
            engine.need(
                {key: target[key] for key in team_wire.TARGET_POLICY_FIELDS}
                == invitation["targetPolicy"],
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            engine.assert_unused(snapshot, target=target)
            engine.need(engine.principal(snapshot, affected) is None, "LOCAL_TRUST_PRINCIPAL_REUSE")
            engine.need(
                set(target["capabilities"])
                <= set(row["capabilities"]) & protocol.INVITED_CAPABILITIES,
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            _validate_target_grants(snapshot, row, target, now, invitation["roleId"])
            snapshot["principals"].append(
                {
                    "principalId": affected,
                    "ownershipEpoch": mutation["ownershipEpoch"],
                    "status": "active",
                    "principalSecurityVersion": 1,
                    "createdSequence": sequence,
                    "recoveryVersion": 0,
                }
            )
            result_binding = engine._new_binding(
                snapshot, mutation, target, affected, now, sequence, parent=row["bindingId"]
            )
            # A member receives its own namespace, never the inviter's files.
            engine._new_grants(snapshot, result_binding, target, sequence, principal_grants=True)
            engine._new_grants(snapshot, result_binding, target, sequence)
            role_id = invitation["roleId"]
        else:
            result_binding, existing = _target_existing(snapshot, request, now)
            if action == "team.activate":
                engine.need(result_binding["bindingId"] == actor["bindingId"])
                wanted = request["target"]["grants"]
                management = [
                    {"resourceId": "team:management", "actions": ["execute", "read", "write"]}
                ]
                engine.need(
                    wanted == sorted(existing + management, key=lambda value: value["resourceId"]),
                    "LOCAL_BINDING_SCOPE_EXCEEDED",
                )
                management_target = {
                    **request["target"],
                    "grants": management,
                    "delegableGrants": [],
                }
                # Only the new control scope is added by explicit owner dual-key approval.
                projected = {**result_binding, "sourceRequestId": mutation["requestId"]}
                engine._new_grants(
                    snapshot, projected, management_target, sequence, principal_grants=True
                )
                engine._new_grants(snapshot, projected, management_target, sequence)
                result_binding["bindingRevision"] += 1
                role_id = "owner"
            else:
                engine.need(request["target"]["grants"] == existing, "LOCAL_BINDING_SCOPE_EXCEEDED")
                role_id = "member"
        associated = _association(
            snapshot,
            mutation,
            row,
            team["cloudPolicy"],
            now,
            sequence,
            role_id=role_id,
            result_binding=result_binding,
        )
        if action == "team.member-admit":
            invitation.update(
                status="used",
                revision=invitation["revision"] + 1,
                usedByMembershipId=associated["membershipId"],
            )
        targets = [result_binding["bindingId"]]
    elif action in ("team.member-role", "team.member-suspend", "team.member-revoke"):
        member = member_for(snapshot, affected)
        engine.need(
            member is not None and member["status"] != "revoked" and affected != owner,
            "LOCAL_TRUST_LAST_MANAGER",
        )
        if action == "team.member-role":
            engine.need(member["status"] == "active")
            member["roleId"] = args["roleId"]
        else:
            member["status"] = "suspended" if action.endswith("suspend") else "revoked"
            principal = engine.principal(snapshot, affected)
            principal["status"] = member["status"]
            targets = [
                item["bindingId"]
                for item in snapshot["bindings"]
                if item["principalId"] == affected
            ]
            revoked = set(targets) if action.endswith("revoke") else set()
            suspended = engine.descendants(snapshot, set(targets)) - revoked
            suspended |= set(targets) - revoked
            engine.retire_bindings(snapshot, revoked, suspended, sequence)
        member["revision"] += 1
        engine.principal(snapshot, affected)["principalSecurityVersion"] += 1
        for device in snapshot["bindings"]:
            if device["principalId"] == affected and action == "team.member-role":
                device["bindingRevision"] += 1
                targets.append(device["bindingId"])
    elif action == "team.resource-set":
        engine.need(args["resourceId"] != "team:management", "LOCAL_BINDING_SCOPE_EXCEEDED")
        for grant in args["grants"]:
            member = member_for(snapshot, grant["principalId"])
            engine.need(member is not None and member["status"] == "active")
        record = next(
            (item for item in team["resources"] if item["resourceId"] == args["resourceId"]), None
        )
        engine.need(
            args["expectedRevision"] == (record["revision"] if record else 0),
            "LOCAL_TRUST_REQUEST_CONFLICT",
        )
        if record is None:
            engine.need(len(team["resources"]) < MAX_RESOURCES, "LOCAL_TRUST_CAPACITY")
            record = {"resourceId": args["resourceId"], "revision": 0, "grants": []}
            team["resources"].append(record)
        record.update(revision=record["revision"] + 1, grants=engine.clone(args["grants"]))
    elif action == "team.device-resources":
        member = member_for(snapshot, affected)
        device = engine.binding(snapshot, args["bindingId"])
        engine.need(
            member is not None
            and member["status"] == "active"
            and device is not None
            and device["principalId"] == affected
            and engine.binding_valid(snapshot, device, now)
        )
        engine.need(
            device["bindingRevision"] == args["expectedBindingRevision"],
            "LOCAL_TRUST_REQUEST_CONFLICT",
        )
        original = engine.grant_list(engine.effective_grants(snapshot, device, now))
        engine.need(
            [grant for grant in args["grants"] if not grant["resourceId"].startswith("team:")]
            == [grant for grant in original if not grant["resourceId"].startswith("team:")],
            "LOCAL_BINDING_SCOPE_EXCEEDED",
        )
        for grant in args["grants"]:
            if grant["resourceId"] == "team:management":
                engine.need(
                    bool(team_wire.PERMISSIONS[member["roleId"]]), "LOCAL_BINDING_SCOPE_EXCEEDED"
                )
            elif grant["resourceId"].startswith("team:"):
                resource = next(
                    (
                        item
                        for item in team["resources"]
                        if item["resourceId"] == grant["resourceId"]
                    ),
                    None,
                )
                allowed = (
                    next(
                        (
                            item["actions"]
                            for item in resource["grants"]
                            if item["principalId"] == affected
                        ),
                        [],
                    )
                    if resource
                    else []
                )
                engine.need(set(grant["actions"]) <= set(allowed), "LOCAL_BINDING_SCOPE_EXCEEDED")
        for grant in snapshot["grants"]:
            if grant["bindingId"] == device["bindingId"] and grant["status"] != "revoked":
                grant.update(status="revoked", revision=grant["revision"] + 1)
        projected = {**device, "sourceRequestId": mutation["requestId"]}
        wanted = {grant["resourceId"]: set(grant["actions"]) for grant in args["grants"]}
        delegates = [
            {
                "resourceId": item["resourceId"],
                "actions": sorted(set(item["actions"]) & wanted.get(item["resourceId"], set())),
            }
            for item in device["delegableGrants"]
            if set(item["actions"]) & wanted.get(item["resourceId"], set())
        ]
        target = {
            "grants": args["grants"],
            "delegableGrants": delegates,
            "expiresAt": device["expiresAt"],
            "delegationExpiresAt": device["delegationExpiresAt"],
        }
        engine._new_grants(snapshot, projected, target, sequence, principal_grants=True)
        engine._new_grants(snapshot, projected, target, sequence)
        device.update(bindingRevision=device["bindingRevision"] + 1, delegableGrants=delegates)
        engine.principal(snapshot, affected)["principalSecurityVersion"] += 1
        member["revision"] += 1
        targets = [device["bindingId"]]
        result_binding = device
    elif action == "team.migration-authorize":
        member = member_for(snapshot, affected)
        engine.need(
            member is not None
            and member["status"] == "active"
            and member["membershipId"] == args["membershipId"]
        )
        engine.need(now < args["expiresAt"] <= now + 300, "LOCAL_BINDING_EXPIRED")
        target = engine.binding(snapshot, args["targetBindingId"])
        engine.need(
            target is not None
            and target["principalId"] == affected
            and target["role"] == "manage"
            and engine.binding_valid(snapshot, target, now, delegation=True)
        )
        from centuarai_local_data_gate.protocol import principal_namespace

        engine.need(
            args["targetNamespace"]
            == principal_namespace(
                mutation["boxKeyThumbprint"], mutation["ownershipEpoch"], affected
            ),
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        engine.need(len(team["migrations"]) < 128, "LOCAL_TRUST_CAPACITY")
        team["migrations"].append(
            {
                **engine.clone(args),
                "requestId": mutation["requestId"],
                "membershipRevision": member["revision"],
                "authorizationVersion": snapshot["authorizationVersion"] + 1,
            }
        )

    snapshot["authorizationVersion"] += 1
    synchronize_associations(before, snapshot, now)
    if action == "team.activate":
        snapshot["policyVersion"] += 1
    for field, identifier in (
        ("members", "membershipId"),
        ("invitations", "invitationId"),
        ("resources", "resourceId"),
        ("migrations", "requestId"),
    ):
        team[field].sort(key=lambda value: value[identifier])
    engine._sort(snapshot)
    current = engine.principal(snapshot, affected)
    remaining = [
        item
        for item in snapshot["bindings"]
        if item["principalId"] == affected
        and item["role"] == "manage"
        and engine.binding_valid(snapshot, item, now, delegation=True)
    ]
    recovery = engine.recovery(snapshot, affected)
    effects = {
        "targetPrincipalId": affected,
        "targetBindingIds": sorted(targets),
        "targetSummaries": [],
        **{
            name: {"count": len(ids), "digest": wire.digest(sorted(ids))}
            for name, ids in (
                ("revokedBindings", revoked),
                ("suspendedBindings", suspended),
                ("invalidatedRequests", invalidated),
            )
        },
        "principalSecurityVersionBefore": old_security,
        "principalSecurityVersionAfter": current["principalSecurityVersion"],
        "recoveryVersionBefore": old_principal["recoveryVersion"] if old_principal else None,
        "recoveryVersionAfter": current["recoveryVersion"],
        "recoveryBefore": None,
        "recoveryAfter": None,
        "remainingIndependentManagers": len(remaining),
        "verifiedRecoveryAvailable": bool(recovery and engine.live(recovery["expiresAt"], now)),
        "grantsBefore": None,
        "grantsAfter": None,
        "capabilitiesBefore": None,
        "capabilitiesAfter": None,
        "resultingAuthority": None,
        "redacted": True,
        "ownershipStateAfter": "owned",
        "requiresVerifiedErase": False,
    }
    protocol.validate_effects(effects)
    delta = engine.record_delta(before, snapshot, invalidated)
    delta["team"] = engine.clone(team)
    result = {
        "principalId": affected,
        "bindingId": result_binding["bindingId"] if result_binding else None,
        "principalSecurityVersion": current["principalSecurityVersion"],
        "recoveryVersion": current["recoveryVersion"],
        "transferId": None,
        "operationId": None,
    }
    return snapshot, effects, delta, result


def _validate_target_grants(snapshot, actor, target, now, role_id):
    from . import local_ledger_engine as engine

    sources = engine.effective_grants(snapshot, actor, now, delegation=True)
    private = [item for item in target["grants"] if not item["resourceId"].startswith("team:")]
    private_delegate = [
        item for item in target["delegableGrants"] if not item["resourceId"].startswith("team:")
    ]
    engine.need(
        engine.subset(private, engine.grant_list(sources, delegate=True))
        and engine.subset(private_delegate, engine.grant_list(sources, delegate=True)),
        "LOCAL_BINDING_SCOPE_EXCEEDED",
    )
    for item in target["grants"]:
        if item["resourceId"] == "team:management":
            engine.need(role_id == "manager", "LOCAL_BINDING_SCOPE_EXCEEDED")
        elif item["resourceId"].startswith("team:"):
            engine.need(
                any(
                    record["resourceId"] == item["resourceId"]
                    for record in snapshot["team"]["resources"]
                ),
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
    limit = engine.minimum(
        actor["expiresAt"],
        actor["delegationExpiresAt"],
        *(engine.minimum(row["expiresAt"], row["delegationExpiresAt"]) for row in sources),
    )
    engine.need(
        engine.limited(target["expiresAt"], limit)
        and engine.limited(target["delegationExpiresAt"], limit)
        and engine.live(target["expiresAt"], now)
        and engine.live(target["delegationExpiresAt"], now),
        "LOCAL_BINDING_LIFETIME_EXCEEDED",
    )

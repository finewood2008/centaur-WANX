"""Bounded pending team requests and authenticated projections, one authority DB."""

from __future__ import annotations

import json

from . import local_ledger_protocol as protocol
from . import local_management_protocol as wire
from . import local_team_ledger as teams
from . import local_team_protocol as team_wire
from . import local_trust_protocol as evidence


class TeamService:
    def __init__(self, owner):
        self.owner = owner
        self.db = owner._db

    def policy(self, now):
        with self.owner._transaction(now) as meta:
            self.owner._v2()
            policy = getattr(self.owner, "_team_identity_policy", None)
            team_wire.need(policy is not None, "LOCAL_TRUST_IDENTITY_POLICY_REQUIRED")
            return protocol.sign_response(
                self.owner,
                "team-policy",
                {"context": self.owner._context(meta), "policy": policy},
                now,
            )

    def submit(self, request_proof, approval_proof, cloud_proof, now):
        request = team_wire.verify_request(request_proof)
        team_wire.need(
            team_wire.verify_request(approval_proof, purpose="request-approval") == request,
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        identifier = team_wire.request_digest(request)
        with self.owner._transaction(now) as meta:
            snapshot = self.owner._v2().snapshot(meta)
            team_wire.need("team" in snapshot, "LOCAL_TRUST_TEAM_REQUIRED")
            team = snapshot["team"]
            team_wire.need(
                all(
                    request[field] == meta[field]
                    for field in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
                ),
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            cloud = team_wire.verify_cloud(cloud_proof, team["cloudPolicy"], request, now)
            team_wire.need(
                not any(
                    member["issuer"] == cloud["issuer"] and member["subject"] == cloud["subject"]
                    for member in team["members"]
                ),
                "LOCAL_TRUST_IDENTITY_CONFLICT",
            )
            invitation = next(
                (
                    row
                    for row in team["invitations"]
                    if row["invitationId"] == request["invitationId"]
                ),
                None,
            )
            team_wire.need(
                invitation is not None
                and invitation["status"] == "pending"
                and now < invitation["expiresAt"],
                "LOCAL_TRUST_INVITATION_DENIED",
            )
            team_wire.need(
                {key: request["target"][key] for key in team_wire.TARGET_POLICY_FIELDS}
                == invitation["targetPolicy"],
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            from .local_ledger_engine import assert_unused, principal

            team_wire.need(
                principal(snapshot, request["principalId"]) is None, "LOCAL_TRUST_PRINCIPAL_REUSE"
            )
            assert_unused(snapshot, target=request["target"])
            existing = self._row(identifier)
            if existing is not None:
                value = json.loads(existing["value"])
                team_wire.need(
                    value["request"] == request and value["cloudProof"] == cloud_proof,
                    "LOCAL_TRUST_REQUEST_CONFLICT",
                )
                return self._receipt(existing, now)
            team_wire.need(self.owner._existing(identifier) is None, "LOCAL_TRUST_REQUEST_CONFLICT")
            pending = [
                json.loads(row["value"])
                for row in self.db.execute(
                    "SELECT value FROM requests WHERE kind='team' AND state='pending'"
                )
            ]
            team_wire.need(len(pending) < 8, "LOCAL_TRUST_CAPACITY")
            team_wire.need(
                sum(
                    value["request"]["invitationId"] == request["invitationId"] for value in pending
                )
                < 2,
                "LOCAL_TRUST_CAPACITY",
            )
            team_wire.need(
                sum(value["subject"] == cloud["subject"] for value in pending) < 2,
                "LOCAL_TRUST_CAPACITY",
            )
            team_wire.need(
                not any(value["cloudJti"] == cloud["jti"] for value in pending),
                "LOCAL_TRUST_REQUEST_CONFLICT",
            )
            self.owner._capacity()
            expires = min(cloud["expiresAt"], invitation["expiresAt"])
            value = {
                "request": request,
                "cloudProof": cloud_proof,
                "subject": cloud["subject"],
                "cloudJti": cloud["jti"],
                "targetAccessProof": None,
                "targetApprovalProof": None,
            }
            self.db.execute(
                "INSERT INTO requests(request_id,kind,digest,value,request_jws,state,expires_at,approval) VALUES (?,'team',?,?,?,'pending',?,?)",
                (
                    identifier,
                    identifier,
                    wire.canonical(value).decode("ascii"),
                    request_proof,
                    expires,
                    approval_proof,
                ),
            )
            return self._receipt(self._row(identifier), now)

    def _row(self, identifier):
        return self.db.execute(
            "SELECT * FROM requests WHERE request_id=? AND kind='team'", (identifier,)
        ).fetchone()

    def _receipt(self, row, now):
        return protocol.sign_response(
            self.owner,
            "team-request-receipt",
            {"requestId": row["request_id"], "state": row["state"], "expiresAt": row["expires_at"]},
            now,
        )

    def _review(self, identifier, now):
        matches = []
        for row in self.db.execute("SELECT value FROM mutation_requests WHERE state='prepared'"):
            saved = json.loads(row[0])
            mutation = saved["mutation"]
            if (
                mutation["action"] == "team.member-admit"
                and mutation["expiresAt"] > now
                and team_wire.request_digest(mutation["args"]["request"]) == identifier
            ):
                matches.append(saved)
        team_wire.need(len(matches) <= 1, "LOCAL_TRUST_STATE_INVALID")
        return matches[0] if matches else None

    def request_body(self, identifier, now):
        row = self._row(identifier)
        team_wire.need(row is not None, "LOCAL_TRUST_READ_DENIED")
        saved = json.loads(row["value"])
        review = self._review(identifier, now) if row["state"] == "pending" else None
        return {
            "requestId": identifier,
            "request": saved["request"],
            "cloudProof": saved["cloudProof"],
            "state": row["state"],
            "expiresAt": row["expires_at"],
            "review": review["review"] if review else None,
            "targetAccessProof": saved["targetAccessProof"] if row["state"] == "pending" else None,
            "targetApprovalProof": saved["targetApprovalProof"]
            if row["state"] == "pending"
            else None,
            "receipt": row["ack"],
        }

    def read_request(self, proof, now):
        value = team_wire.decode_request_read(proof)
        with self.owner._transaction(now) as meta:
            row = self._row(value["requestId"])
            team_wire.need(row is not None, "LOCAL_TRUST_READ_DENIED")
            saved = json.loads(row["value"])
            evidence._verify(proof, evidence._public_key(saved["request"]["target"]["accessKey"]))
            team_wire.need(
                value["issuedAt"] <= now < value["expiresAt"]
                and all(
                    value[field] == meta[field]
                    for field in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
                ),
                "LOCAL_TRUST_READ_DENIED",
            )
            return protocol.sign_response(
                self.owner, "team-request", self.request_body(value["requestId"], now), now
            )

    def consent(self, identifier, access_proof, approval_proof, now):
        evidence._digest(identifier)
        with self.owner._transaction(now):
            row, saved = self._row(identifier), self._review(identifier, now)
            team_wire.need(
                row is not None
                and row["state"] == "pending"
                and now < row["expires_at"]
                and saved is not None,
                "LOCAL_TRUST_REQUEST_TERMINAL",
            )
            value = json.loads(row["value"])
            mutation = saved["mutation"]
            team_wire.need(
                mutation["args"]["request"] == value["request"]
                and mutation["args"]["cloudProof"] == value["cloudProof"],
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
            protocol.verify_additional_proof(
                access_proof,
                mutation,
                value["request"]["target"]["accessKey"],
                purpose="target-access",
            )
            protocol.verify_additional_proof(
                approval_proof,
                mutation,
                value["request"]["target"]["approvalKey"],
                purpose="target-approval",
            )
            value.update(targetAccessProof=access_proof, targetApprovalProof=approval_proof)
            preview = self.request_body(identifier, now)
            preview.update(targetAccessProof=access_proof, targetApprovalProof=approval_proof)
            envelope = {
                "schemaVersion": 2,
                "purpose": "centuarai.local-ledger.response",
                "boxId": self.owner.bundle["boxId"],
                "boxKeyThumbprint": evidence.public_key_thumbprint(self.owner.bundle["boxKey"]),
                "kind": "team-request",
                "issuedAt": now,
                "body": preview,
            }
            header = {"alg": "ES256", "typ": "centuarai-local-team-request-response+jws"}
            size = (
                len(evidence._encode(wire.canonical(header)))
                + len(evidence._encode(wire.canonical(envelope)))
                + 88
            )
            team_wire.need(size <= 65536, "LOCAL_TRUST_CAPACITY")
            self.db.execute(
                "UPDATE requests SET value=? WHERE request_id=? AND kind='team'",
                (wire.canonical(value).decode("ascii"), identifier),
            )
            return self._receipt(row, now)

    def check_prepared_request(self, mutation, now):
        if mutation["action"] != "team.member-admit":
            return
        identifier = team_wire.request_digest(mutation["args"]["request"])
        row = self._row(identifier)
        team_wire.need(
            row is not None and row["state"] == "pending" and now < row["expires_at"],
            "LOCAL_TRUST_REQUEST_TERMINAL",
        )
        value = json.loads(row["value"])
        team_wire.need(
            value["request"] == mutation["args"]["request"]
            and value["cloudProof"] == mutation["args"]["cloudProof"],
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        existing = self._review(identifier, now)
        team_wire.need(
            existing is None or existing["mutation"]["requestId"] == mutation["requestId"],
            "LOCAL_TRUST_REQUEST_CONFLICT",
        )

    def read_body(self, operation, value, snapshot, row, meta, now):
        own = teams.member_for(snapshot, row["principalId"])
        if operation == "self-member":
            return {
                "context": self.owner._context(meta),
                "member": teams.summary(own) if own else None,
            }
        authorization = teams.team_authorization(snapshot, row, now)
        team_wire.need(authorization is not None, "LOCAL_TRUST_READ_DENIED")
        permissions = authorization["permissions"]
        if operation == "self-resources":
            from .local_ledger_engine import effective_grants, grant_list

            available = []
            for resource in snapshot["team"]["resources"]:
                for grant in resource["grants"]:
                    if grant["principalId"] == row["principalId"]:
                        available.append(
                            {
                                "resourceId": resource["resourceId"],
                                "actions": list(grant["actions"]),
                            }
                        )
            if team_wire.PERMISSIONS[own["roleId"]]:
                available.append(
                    {"resourceId": "team:management", "actions": ["execute", "read", "write"]}
                )
            return {
                "context": self.owner._context(meta),
                "principalId": row["principalId"],
                "bindingId": row["bindingId"],
                "bindingRevision": row["bindingRevision"],
                "approvedGrants": grant_list(effective_grants(snapshot, row, now)),
                "availableGrants": sorted(available, key=lambda grant: grant["resourceId"]),
            }
        if operation == "team-device-review":
            from .local_ledger_engine import binding, binding_valid

            saved = self.owner._v2()._mutation(value["requestId"])
            team_wire.need(
                saved is not None and saved["state"] == "prepared", "LOCAL_TRUST_READ_DENIED"
            )
            mutation = saved["mutation"]
            team_wire.need(
                mutation["action"] == "team.device-resources"
                and now < mutation["expiresAt"]
                and all(mutation[name] == item for name, item in self.owner._context(meta).items()),
                "LOCAL_TRUST_READ_DENIED",
            )
            target = binding(snapshot, mutation["args"]["bindingId"])
            team_wire.need(binding_valid(snapshot, target, now), "LOCAL_TRUST_READ_DENIED")
            team_wire.need(
                row["bindingId"] == target["bindingId"] or mutation["actor"] == value["actor"],
                "LOCAL_TRUST_READ_DENIED",
            )
            return {
                "context": self.owner._context(meta),
                "requestId": value["requestId"],
                "mutationDigest": wire.digest(mutation),
                "target": {
                    name: target[name]
                    for name in (
                        "bindingId",
                        "principalId",
                        "clientId",
                        "role",
                        "bindingRevision",
                        "accessKey",
                        "approvalKey",
                    )
                },
            }
        if operation == "team-state":
            team_wire.need("members.read" in permissions, "LOCAL_TRUST_READ_DENIED")
            requests = []
            if "members.manage" in permissions:
                for item in self.db.execute(
                    "SELECT * FROM requests WHERE kind='team' AND state='pending' ORDER BY request_id"
                ):
                    saved = json.loads(item["value"])
                    requests.append(
                        {
                            "requestId": item["request_id"],
                            "principalId": saved["request"]["principalId"],
                            "invitationId": saved["request"]["invitationId"],
                            "subject": saved["subject"],
                            "expiresAt": item["expires_at"],
                            "state": "pending",
                        }
                    )
            invitations = []
            if "members.manage" in permissions:
                invitations = [
                    {
                        **item,
                        "status": "expired"
                        if item["status"] == "pending" and item["expiresAt"] <= now
                        else item["status"],
                    }
                    for item in snapshot["team"]["invitations"]
                ]
            return {
                "context": self.owner._context(meta),
                "members": [teams.summary(item) for item in snapshot["team"]["members"]],
                "invitations": invitations,
                "resources": snapshot["team"]["resources"]
                if "resources.manage" in permissions
                else [],
                "requests": requests,
            }
        if operation == "team-request":
            team_wire.need("members.manage" in permissions, "LOCAL_TRUST_READ_DENIED")
            return self.request_body(value["requestId"], now)
        if operation == "team-association":
            member = next(
                (
                    item
                    for item in snapshot["team"]["members"]
                    if item["membershipId"] == value["requestId"]
                ),
                None,
            )
            team_wire.need(
                member is not None
                and (
                    member["principalId"] == row["principalId"] or "members.manage" in permissions
                ),
                "LOCAL_TRUST_READ_DENIED",
            )
            return {"receipt": self.association_receipt(member, snapshot, meta, now)}
        team_wire.need(False, "LOCAL_TRUST_READ_DENIED")

    def association_receipt(self, member, snapshot, meta, now):
        from .local_ledger_engine import binding, minimum, principal

        device = binding(snapshot, member["bindingId"])
        status = member["status"]
        if status == "active" and (
            device["status"] != "active"
            or principal(snapshot, member["principalId"])["status"] != "active"
        ):
            status = "revoked" if device["status"] == "revoked" else "suspended"
        receipt = {
            "schemaVersion": 1,
            "purpose": "centuarai.team.association",
            **{
                field: meta[field]
                for field in (
                    "boxId",
                    "boxKeyThumbprint",
                    "ownershipEpoch",
                    "rosterVersion",
                    "rosterDigest",
                    "authorizationVersion",
                )
            },
            **{
                field: member[field]
                for field in (
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
                    "roleId",
                    "authorityDigest",
                )
            },
            "membershipRevision": member["revision"],
            "issuedAt": now,
            "status": status,
            "expiresAt": minimum(member["expiresAt"], device["expiresAt"]),
        }
        return team_wire.sign_association(receipt, self.owner._key)

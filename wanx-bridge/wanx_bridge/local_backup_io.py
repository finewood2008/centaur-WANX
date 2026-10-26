"""Fixed authenticated backup I/O; chunks stay outside bounded signed receipts."""

from __future__ import annotations

import base64
import binascii
import hashlib
from urllib.parse import urlsplit

from . import local_ledger_protocol as protocol
from . import local_management_protocol as wire
from . import local_trust_protocol as evidence
from .local_ledger_operations import SOURCE_TYPE, header_schema, source_payload

PROOF_TYPE = "centuarai-local-backup-io+jws"
RESPONSE_TYPE = "centuarai-local-backup-io-response+jws"
OPERATIONS = frozenset(
    {
        "targets.list",
        "source.begin",
        "source.append",
        "source.finalize",
        "source.read",
        "archive.read",
        "transfer.plan",
    }
)
MAX_ARCHIVE = 209715200
MAX_CHUNK = 1048576


def need(value, code="LOCAL_BINDING_INVALID"):
    evidence._require(value, code)


def descriptor(value):
    evidence._fields(value, {"boxId", "baseUrl", "boxKey", "tlsSpkiSha256"})
    evidence._token(value["boxId"])
    evidence._public_key(value["boxKey"])
    evidence._digest(value["tlsSpkiSha256"])
    origin = value["baseUrl"]
    need(
        type(origin) is str
        and origin.isascii()
        and 1 <= len(origin) <= 512
        and "\\" not in origin
        and not any(ord(char) <= 32 or ord(char) == 127 for char in origin)
    )
    try:
        parsed = urlsplit(origin)
        need(
            parsed.scheme == "https"
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and parsed.path in ("", "/")
            and (parsed.port is None or 0 < parsed.port < 65536)
        )
    except ValueError as exc:
        raise evidence.BindingProtocolError() from exc


def chunk(value):
    need(type(value) is str and value.isascii() and len(value) <= ((MAX_CHUNK + 2) // 3) * 4)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise evidence.BindingProtocolError() from exc
    need(len(decoded) <= MAX_CHUNK and base64.b64encode(decoded).decode("ascii") == value)
    return decoded


def request_body(operation, value):
    need(operation in OPERATIONS)
    if operation in ("targets.list", "transfer.plan"):
        evidence._fields(value, set())
    elif operation == "source.begin":
        evidence._fields(value, {"archiveBytes", "archiveSha256", "source"})
        evidence._integer(value["archiveBytes"])
        need(value["archiveBytes"] <= MAX_ARCHIVE)
        evidence._digest(value["archiveSha256"])
        descriptor(value["source"])
    elif operation == "source.append":
        evidence._fields(value, {"uploadId", "offset", "chunkBase64"})
        evidence._token(value["uploadId"])
        protocol._counter(value["offset"])
        need(value["offset"] < MAX_ARCHIVE and len(chunk(value["chunkBase64"])) > 0)
    elif operation in ("source.finalize", "source.read"):
        field = "uploadId" if operation == "source.finalize" else "sourceId"
        evidence._fields(value, {field})
        evidence._token(value[field])
    else:
        evidence._fields(value, {"operationId", "offset", "length"})
        evidence._digest(value["operationId"])
        protocol._counter(value["offset"])
        evidence._integer(value["length"])
        need(value["offset"] <= MAX_ARCHIVE and value["length"] <= MAX_CHUNK)


def proof_schema(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "principalSecurityVersion",
            "nonce",
            "issuedAt",
            "expiresAt",
            "actor",
            "operation",
            "bodySha256",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-backup.io"
        and value["operation"] in OPERATIONS
    )
    evidence._token(value["boxId"])
    for field in ("boxKeyThumbprint", "nonce", "bodySha256"):
        evidence._digest(value[field])
    for field in ("ownershipEpoch", "principalSecurityVersion"):
        evidence._integer(value[field])
    protocol.actor(value["actor"])
    need(value["actor"]["kind"] == "binding")
    evidence._window(value)
    need(value["expiresAt"] <= value["issuedAt"] + 60)


def response_body(operation, value):
    if operation == "transfer.plan":
        evidence._fields(
            value,
            {
                "type",
                "scopeManifestDigest",
                "resetPlanDigest",
                "dataDisposition",
                "retainedIndependentBackups",
                "scope",
            },
        )
        need(
            value["type"] == "ownership-transfer-plan"
            and value["dataDisposition"] == "erase-local"
            and value["retainedIndependentBackups"] is True
        )
        evidence._digest(value["scopeManifestDigest"])
        evidence._digest(value["resetPlanDigest"])
        scope = value["scope"]
        evidence._fields(
            scope,
            {
                "resourceRoots",
                "cacheRoots",
                "preservedSecurityRoots",
                "affectedPrincipals",
                "affectedBindings",
                "retainedExternalBackups",
            },
        )
        paths = []
        for field in ("resourceRoots", "cacheRoots", "preservedSecurityRoots"):
            values = scope[field]
            need(type(values) is list and 1 <= len(values) <= 64)
            for path in values:
                need(
                    type(path) is str
                    and path.isascii()
                    and 1 < len(path) <= 256
                    and path.startswith("/")
                    and all(part not in ("", ".", "..") for part in path.split("/")[1:])
                    and "\\" not in path
                    and not any(ord(char) < 32 or ord(char) == 127 for char in path)
                )
            need(values == sorted(set(values)))
            paths.extend(values)
        need(
            len(paths) <= 64
            and len(paths) == len(set(paths))
            and scope["retainedExternalBackups"] is True
        )
        protocol._counter(scope["affectedPrincipals"])
        protocol._counter(scope["affectedBindings"])
        need(
            value["scopeManifestDigest"]
            == wire.digest(
                {
                    "purpose": "centuarai.local-ledger.transfer-scope",
                    "resetPlanDigest": value["resetPlanDigest"],
                    "scope": scope,
                }
            ),
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
    elif operation == "targets.list":
        evidence._fields(value, {"type", "targets"})
        need(
            value["type"] == "backup-targets"
            and type(value["targets"]) is list
            and len(value["targets"]) <= 1
        )
        for target in value["targets"]:
            evidence._fields(
                target,
                {
                    "targetId",
                    "kind",
                    "durability",
                    "scopeProfiles",
                    "resourceIds",
                    "maxArchiveBytes",
                },
            )
            profiles = target["scopeProfiles"]
            catalog = {
                "semantica-private-v1": ["semantica"],
                "wanx-personal-v1": ["clipboard", "space:personal"],
            }
            need(type(profiles) is list and 1 <= len(profiles) <= len(catalog))
            need(all(type(profile) is str and profile in catalog for profile in profiles))
            need(profiles == sorted(set(profiles)))
            resources = sorted({resource for profile in profiles for resource in catalog[profile]})
            need(
                target
                == {
                    "targetId": "local-managed",
                    "kind": "local-managed",
                    "durability": "same-box",
                    "scopeProfiles": profiles,
                    "resourceIds": resources,
                    "maxArchiveBytes": MAX_ARCHIVE,
                }
            )
    elif operation == "source.begin":
        evidence._fields(
            value, {"type", "uploadId", "offset", "chunkMaxBytes", "archiveMaxBytes", "expiresAt"}
        )
        need(
            value["type"] == "backup-source-upload"
            and type(value["offset"]) is int
            and value["offset"] == 0
            and type(value["chunkMaxBytes"]) is int
            and value["chunkMaxBytes"] == MAX_CHUNK
            and type(value["archiveMaxBytes"]) is int
            and value["archiveMaxBytes"] == MAX_ARCHIVE
        )
        evidence._token(value["uploadId"])
        evidence._integer(value["expiresAt"])
    elif operation == "source.append":
        evidence._fields(value, {"type", "uploadId", "offset", "expiresAt"})
        need(value["type"] == "backup-source-upload-progress")
        evidence._token(value["uploadId"])
        protocol._counter(value["offset"])
        need(value["offset"] <= MAX_ARCHIVE)
        evidence._integer(value["expiresAt"])
    elif operation in ("source.finalize", "source.read"):
        evidence._fields(
            value,
            {
                "type",
                "sourceId",
                "archiveBytes",
                "archiveSha256",
                "source",
                "header",
                "sourceProof",
                "expiresAt",
            },
        )
        need(value["type"] == "backup-source")
        evidence._token(value["sourceId"])
        evidence._integer(value["archiveBytes"])
        need(value["archiveBytes"] <= MAX_ARCHIVE)
        evidence._digest(value["archiveSha256"])
        evidence._integer(value["expiresAt"])
        descriptor(value["source"])
        header_schema(value["header"])
        signed = wire._decode(value["sourceProof"], SOURCE_TYPE, source_payload)
        evidence._verify(value["sourceProof"], evidence._public_key(value["source"]["boxKey"]))
        header = value["header"]
        need(
            signed["boxId"] == value["source"]["boxId"] == header["sourceBoxId"]
            and signed["boxKeyThumbprint"]
            == evidence.public_key_thumbprint(value["source"]["boxKey"])
            == header["sourceBoxKeyThumbprint"]
            and signed["headerSha256"] == wire.digest(header)
            and signed["backupId"] == header["backupId"]
            and signed["manifestSha256"] == header["manifestSha256"]
            and signed["scopeDigest"] == header["scopeDigest"]
            and signed["createdAt"] == header["createdAt"],
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
    else:
        evidence._fields(
            value,
            {
                "type",
                "operationId",
                "backupId",
                "archiveSha256",
                "offset",
                "length",
                "totalBytes",
                "contentSha256",
                "eof",
            },
        )
        need(value["type"] == "backup-archive-range" and type(value["eof"]) is bool)
        for field in ("operationId", "backupId", "archiveSha256", "contentSha256"):
            evidence._digest(value[field])
        for field in ("offset", "length"):
            protocol._counter(value[field])
        evidence._integer(value["totalBytes"])
        need(
            value["length"] <= MAX_CHUNK
            and value["offset"] + value["length"] <= value["totalBytes"] <= MAX_ARCHIVE
            and value["eof"] == (value["offset"] + value["length"] == value["totalBytes"])
        )


def response_schema(value):
    evidence._fields(
        value,
        {
            "schemaVersion",
            "purpose",
            "boxId",
            "boxKeyThumbprint",
            "operation",
            "nonce",
            "requestBodySha256",
            "issuedAt",
            "body",
        },
    )
    need(
        type(value["schemaVersion"]) is int
        and value["schemaVersion"] == 1
        and value["purpose"] == "centuarai.local-backup.io-response"
        and value["operation"] in OPERATIONS
    )
    evidence._token(value["boxId"])
    for field in ("boxKeyThumbprint", "nonce", "requestBodySha256"):
        evidence._digest(value[field])
    evidence._integer(value["issuedAt"])
    response_body(value["operation"], value["body"])


def verify_response(value, box_key, *, box_id, operation, nonce, request):
    """Verify the fixed requested domain and optional chunk, never incoming dispatch."""
    evidence._fields(value, {"receipt", "contentBase64"})
    payload = wire._decode(value["receipt"], RESPONSE_TYPE, response_schema)
    evidence._verify(value["receipt"], evidence._public_key(box_key))
    need(
        payload["boxId"] == box_id
        and payload["boxKeyThumbprint"] == evidence.public_key_thumbprint(box_key)
        and payload["operation"] == operation
        and payload["nonce"] == nonce
        and payload["requestBodySha256"] == wire.digest(request),
        "LOCAL_BINDING_CONTEXT_MISMATCH",
    )
    body = payload["body"]
    if operation == "archive.read":
        content = chunk(value["contentBase64"])
        need(
            body["operationId"] == request["operationId"]
            and body["offset"] == request["offset"]
            and body["length"]
            == len(content)
            == min(request["length"], body["totalBytes"] - body["offset"])
        )
        need(
            body["contentSha256"] == evidence._encode(hashlib.sha256(content).digest()),
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
    else:
        need(value["contentBase64"] is None)
    return payload


def backup_io(ledger, operation, body, proof, now, *, preflight=False):
    from .local_ledger_engine import authority_actor, clone, effective_grants, grant_list, principal

    with ledger.owner._transaction(now) as meta:
        request_body(operation, body)
        payload = wire._decode(proof, PROOF_TYPE, proof_schema)
        need(
            payload["operation"] == operation and payload["bodySha256"] == wire.digest(body),
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        snapshot = ledger.snapshot(meta)
        actor = authority_actor(snapshot, payload["actor"], now)
        member = principal(snapshot, actor["principalId"])
        required = (
            "ownership.transfer"
            if operation == "transfer.plan"
            else "backup.create"
            if operation in ("targets.list", "archive.read")
            else "backup.restore"
        )
        need(
            actor["role"] == "manage" and required in actor["capabilities"],
            "LOCAL_TRUST_AUTHORIZATION_DENIED",
        )
        if operation == "transfer.plan":
            need(
                actor["principalId"] == snapshot["ownership"]["ownerPrincipalId"],
                "LOCAL_TRUST_AUTHORIZATION_DENIED",
            )
        evidence._verify(proof, evidence._public_key(actor["accessKey"]))
        need(
            payload["principalSecurityVersion"] == member["principalSecurityVersion"]
            and all(
                payload[field] == meta[field]
                for field in ("boxId", "boxKeyThumbprint", "ownershipEpoch")
            ),
            "LOCAL_BINDING_CONTEXT_MISMATCH",
        )
        provider = ledger.operations.provider
        need(
            provider is not None and callable(getattr(provider, "backup_io", None)),
            "LOCAL_TRUST_OPERATION_UNAVAILABLE",
        )
        grants = grant_list(effective_grants(snapshot, actor, now))
        authorization = {
            "boxId": meta["boxId"],
            "boxKeyThumbprint": meta["boxKeyThumbprint"],
            "principalId": member["principalId"],
            "bindingId": actor["bindingId"],
            "ownershipEpoch": meta["ownershipEpoch"],
            "principalSecurityVersion": member["principalSecurityVersion"],
            "policyVersion": meta["policyVersion"],
            "grants": grants,
            "capabilities": actor["capabilities"],
            "operation": None,
            "transferSummary": {
                "affectedPrincipals": sum(
                    row["ownershipEpoch"] == meta["ownershipEpoch"]
                    for row in snapshot["principals"]
                ),
                "affectedBindings": sum(
                    row["ownershipEpoch"] == meta["ownershipEpoch"] for row in snapshot["bindings"]
                ),
            }
            if operation == "transfer.plan"
            else None,
        }
        job = None
        if operation == "archive.read":
            job = ledger.operations._get(body["operationId"])
            saved = ledger._mutation(body["operationId"])
            need(
                saved is not None
                and saved["mutation"]["actor"]["principalId"] == member["principalId"]
                and saved["mutation"]["action"] == "backup.create"
                and job["status"]["state"] == "completed",
                "LOCAL_TRUST_AUTHORIZATION_DENIED",
            )
            readable = {row["resourceId"] for row in grants if "read" in row["actions"]}
            need(
                set(saved["mutation"]["args"]["resourceIds"]) <= readable,
                "LOCAL_BINDING_SCOPE_EXCEEDED",
            )
            authorization["operation"] = {
                "mutation": clone(saved["mutation"]),
                "status": clone(job["status"]),
                "plan": clone(job["plan"]),
            }
        if preflight:
            need(operation in ("source.finalize", "transfer.plan"))
            ledger.db.execute("SAVEPOINT backup_preflight_nonce")
            ledger.owner._consume_challenge(
                payload, "read-v2", now, payload["nonce"], meta, field="nonce"
            )
            ledger.db.execute("ROLLBACK TO backup_preflight_nonce")
            ledger.db.execute("RELEASE backup_preflight_nonce")
            return {"authorization": clone(authorization), "checkedAt": now}
        ledger.owner._consume_challenge(
            payload, "read-v2", now, payload["nonce"], meta, field="nonce"
        )
        supplied = provider.backup_io(operation, clone(body), clone(authorization), now)
        evidence._fields(supplied, {"body", "contentBase64"})
        result = supplied["body"]
        response_body(operation, result)
        if operation == "archive.read":
            raw = chunk(supplied["contentBase64"])
            completed = job["status"]["result"]
            need(
                result["operationId"] == body["operationId"]
                and result["backupId"] == completed["backupId"]
                and result["archiveSha256"] == completed["archiveSha256"]
                and result["totalBytes"] == completed["bytes"]
                and result["offset"] == body["offset"]
                and result["length"]
                == len(raw)
                == min(body["length"], result["totalBytes"] - body["offset"])
            )
            need(
                result["contentSha256"] == evidence._encode(hashlib.sha256(raw).digest()),
                "LOCAL_BINDING_CONTEXT_MISMATCH",
            )
        else:
            need(supplied["contentBase64"] is None)
            if operation == "source.append":
                need(
                    result["uploadId"] == body["uploadId"]
                    and result["offset"] == body["offset"] + len(chunk(body["chunkBase64"]))
                )
            elif operation == "source.read":
                need(result["sourceId"] == body["sourceId"])
            elif operation == "targets.list":
                readable = {row["resourceId"] for row in grants if "read" in row["actions"]}
                need(
                    all(set(target["resourceIds"]) <= readable for target in result["targets"]),
                    "LOCAL_BINDING_SCOPE_EXCEEDED",
                )
            elif operation == "transfer.plan":
                need(
                    all(
                        result["scope"][field] == authorization["transferSummary"][field]
                        for field in ("affectedPrincipals", "affectedBindings")
                    ),
                    "LOCAL_BINDING_CONTEXT_MISMATCH",
                )
        receipt = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-backup.io-response",
            "boxId": meta["boxId"],
            "boxKeyThumbprint": meta["boxKeyThumbprint"],
            "operation": operation,
            "nonce": payload["nonce"],
            "requestBodySha256": wire.digest(body),
            "issuedAt": now,
            "body": result,
        }
        return {
            "receipt": wire._sign(receipt, ledger.owner._key, RESPONSE_TYPE, response_schema),
            "contentBase64": supplied["contentBase64"],
        }

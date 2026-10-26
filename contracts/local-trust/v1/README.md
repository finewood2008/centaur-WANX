# Local device binding evidence v1

Status: development contract, 2026-10-25. This module is not connected to a runtime route, IPC, platform login, authorization snapshot, or data session. It cannot establish the first trusted identity. Signature validation is evidence validation, **not** proof of user presence, native confirmation, or completed enrollment.

## Scope and standards

Only adding a **use** device to an existing local principal is represented. New principals, manager/recovery devices, role changes, key rotation, migration and first claim are unsupported. Cloud account IDs, legacy grants, DeviceKey and manufacturer certificates do not establish approval authority.

Use [JWS Compact Serialization](https://www.rfc-editor.org/rfc/rfc7515) with fixed [ES256](https://www.rfc-editor.org/rfc/rfc7518#section-3.4), P-256 public JWKs and [RFC 7638 SHA-256 thumbprints](https://www.rfc-editor.org/rfc/rfc7638). A signature is 64-byte `R || S`, unpadded base64url; existing Consumer DER/base64 signatures are incompatible. Neither `alg` nor a verification key is chosen from untrusted header metadata.

Canonical JSON uses the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) **restricted profile** supported by this schema: ASCII field names and token strings, safe integers, booleans, null, arrays and objects. Sort object keys recursively; emit compact UTF-8 JSON. Floats, negative zero, Unicode, duplicate/unknown fields and noncanonical wire bytes are rejected. This is not a general-purpose JCS implementation. Arrays are already sorted and unique according to their schema; validators do not repair them.

Limits: complete JWS at most 16,384 ASCII bytes; positive integers at most `9007199254740991`; token IDs match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Digests, request IDs and challenges are canonical base64url encodings of exactly 32 bytes (43 characters). Public JWKs have **exactly** `crv="P-256"`, `kty="EC"`, `x`, `y`; each coordinate is 32 bytes, and the point must be valid. Private parameters and key metadata are rejected.

## Request

Every field is mandatory; no default authority or omitted null fields:

| Field | Constraint |
| --- | --- |
| `schemaVersion` | integer `1` |
| `purpose` | `centuarai.local-device-binding.request` |
| `boxId` | token ID |
| `boxKeyThumbprint` | digest of the independently verified box public key |
| `ownershipEpoch`, `rosterVersion`, `policyVersion` | positive safe integers |
| `rosterDigest` | digest of the expected local roster checkpoint |
| `requestId`, `challenge` | random 32-byte values; challenge must come from the box |
| `issuedAt`, `expiresAt` | Unix seconds; `0 < issuedAt < expiresAt <= issuedAt + 300` |
| `principalId`, `clientId` | explicit local principal and new local installation IDs |
| `accessKey` | exact public JWK |
| `approvalKey` | explicit `null`; this operation cannot grant approval capability |
| `role` | `use` |
| `grants` | 1–16 objects with exactly `resourceId` (token) and `actions`; sorted by resource ID, no duplicates |
| `grants[].actions` | nonempty sorted unique subset of `execute`, `read`, `write` |
| `delegationAllowed` | literal `false` |
| `grantExpiresAt` | explicit `null`, or safe integer at least `expiresAt`; no implicit unlimited grant |

These resource/action tokens are protocol bounds, not a mapping into today's data plane. Such mapping requires a subsequent authorization implementation.

`requestDigest = base64url(SHA-256(canonical_request))`. Applicant proof is a JWS over the **complete canonical request**, with exact protected header `{"alg":"ES256","typ":"centuarai-device-binding-request+jws"}`. The request's `accessKey` verifies this proof; it conveys possession only, never existing trust. A different field value creates a different digest. ECDSA's randomized signature bytes are not the request identity.

`verify_request_proof` validates syntax, canonical encoding and signature, including for an exact terminal retry. `validate_request_context` additionally requires `issuedAt <= now < expiresAt`, matching current box/checkpoint/policy fields and the issued challenge. Callers must perform the latter at any new acceptance point; verifying a signature alone does not prove freshness.

Context has the box/checkpoint fields (`boxId`, `boxKeyThumbprint`, `ownershipEpoch`, `rosterVersion`, `rosterDigest`, `policyVersion`) and `challenge`. All are supplied from trusted local state, never copied from a request as an authorization decision.

## Approval signature evidence

Approval payload has exactly:

```json
{
  "schemaVersion": 1,
  "purpose": "centuarai.local-device-binding.approval",
  "requestDigest": "<32-byte digest>",
  "approverBindingId": "existing-manager-binding",
  "approvalKeyVersion": 1,
  "approvedAt": 1792886400,
  "expiresAt": 1792886700
}
```

Exact protected header: `{"alg":"ES256","typ":"centuarai-device-binding-approval+jws"}`. Signature is verified only against the existing binding's **separate approval key**. Require `request.issuedAt <= approvedAt <= now < expiresAt <= request.expiresAt`; the digest must match the full request.

`verify_approval_signature(approval_jws, request_jws, trusted_state, now)` verifies applicant proof, request time, current box/checkpoint/policy and these local-state constraints. `trusted_state` has the six box/checkpoint fields above plus `bindings`, which must come from an independently established local roster, including revoked-key history. Each binding has exactly:

- `bindingId`, `principalId`, `clientId`: token IDs.
- `role`: `manage` or `use`; `status`: `active`, `suspended` or `revoked`.
- `accessKey`: public JWK; `approvalKey`: separate public JWK or null; `approvalKeyVersion`: positive integer when a key exists, otherwise null.
- `canApproveUseDevices`: boolean; `delegableGrants`: same grant structure (may be empty).
- `expiresAt`: null or positive safe integer; `delegationExpiresAt`: independent effective expiry of the delegable resources (the conservative earliest expiry when resource lifetimes differ), null only if all delegated authority is unlimited. `establishedAt` and `establishedVersion` are positive safe integers.

The entire roster must have unique binding IDs, client IDs and key thumbprints across access/approval purposes and history. Conflicting duplicate rows fail closed; validators cannot pick the first/last matching active row to override a revoked record. Roles without approval capability cannot acquire it through a conflicting key purpose.

The approver must be active, role `manage`, explicitly able to approve use devices, and belong to the **same principal**. Its distinct approval key/version must match the evidence. Its establishment time/version must be no later than the request's issue time/expected roster version, and it and its delegable authority must remain unexpired. Requested resources/actions and grant lifetime must be a subset of that approver's delegable authority. A finite binding or delegation limit cannot approve an unlimited or longer grant.

Reject the target client ID if it appears in any binding, and reject the new access key if it matches any historical access/approval key, including suspended/revoked bindings. Empty rosters, self-approval, cross-member approvals and keys from the envelope are never bootstrap exceptions. Unknown or malformed local-state fields fail closed.

The returned object is only validated **signature evidence**. It does not attest to hardware key protection or per-operation user verification. Native key activation, trustworthy request display, first-root provenance, current-state transactional revalidation, persistence, signed box ACK and a real access check are still required before enrollment can complete. No boolean `verified=true` or cloud login can replace these requirements.

## Cancellation evidence and pending request journal

Cancellation payload has exactly `schemaVersion=1`, `purpose="centuarai.local-device-binding.cancel"`, `requestId`, `requestDigest`, `issuedAt`, `expiresAt`. Its lifetime is at most 300 seconds and requires `issuedAt <= now < expiresAt`. Exact header type is `centuarai-device-binding-cancel+jws`; the saved request's access key verifies it. The request ID/digest must match. Cancellation cannot change requested authority.

The independent SQLite journal stores **pending evidence only**. It exposes challenge issuance, signed request submission/idempotent retry and signed cancellation. There is no approve, commit-binding, seed-manager, grant, session, or migration method. States are `pending`, `cancelled`, `expired`; terminal states cannot revive.

- `issue_challenge(context, now)` takes the six trusted box/checkpoint fields, generates a random challenge and a 300-second expiry. This local argument is not itself a root of trust.
- `submit(request_jws, now)` checks proof, exact request ID/digest, the saved challenge/context, and current challenge lifetime in `BEGIN IMMEDIATE`. A challenge can be consumed by only one request. The request lifetime must fit the saved challenge lifetime. Exact retries verify the original key proof and return the same receipt/state; ID/content conflicts fail.
- `cancel(cancel_jws, now)` verifies the saved request key, then arbitrates with expiry and submission under the same transaction. Expiry wins at the exact deadline. Retries cannot recreate a pending request.
- Receipts expose only `requestId`, `requestDigest`, `state`, `expiresAt`; no private roster or identity metadata. Future HTTP polling requires its own fresh authenticated transport/proof; replaying a stored proposal is not a fresh general authentication credential.
- A required caller-supplied `boot_id` is persisted. On a new boot generation, all uncommitted pending requests expire and unconsumed challenges become unusable. Multiple connections in one boot must use the same value. Each operation compares the saved active boot ID inside its transaction; an older connection cannot continue writing or change the generation back. Previously retired boot IDs cannot reopen the journal. Runtime boot identity acquisition and multi-worker startup coordination are not yet wired.
- `now` must be a positive safe integer from the box's trusted clock, not a request field. The journal persists the latest observed time for each active boot and rejects backward movement. Expired evidence must not revive after a failed operation followed by a clock rollback. A new boot invalidates pending evidence before resetting this clock fence; this does not by itself establish trustworthy wall time for the future data plane.
- Caps: 128 unconsumed live challenges, 128 pending requests, and 4096 retained request IDs. At capacity, reject new evidence; do not delete replay tombstones or affect existing data sessions. Challenge tombstones may be removed only once expired, because signed request freshness then forbids their reuse. The 4096 cap is intentionally conservative and cumulative: runtime integration must define controlled archival/retention before long-term operation, not clear the journal to bypass replay protection.
- This journal is a box-side POSIX implementation; Windows without a reviewed ACL adapter fails closed. It is not the authoritative roster and is not installed by deployment. Existing `auth.sqlite3` and cloud snapshots remain separate. Future signed ACK/authorization event commits require a different, reviewed integration.

## Acceptance and file ownership

Main owns this contract, shared `vectors.json`, cross-language tests and OS implementation notes. Python protocol/tests, JS protocol/tests and SQLite journal/tests have separate owners. Test keys are synthetic and public fixtures; no real user keys or credentials are loaded.

Acceptance: cross-language canonical bytes/digests/thumbprints agree; each implementation verifies signatures from the other; field substitution, unknown algorithms/fields, noncanonical encodings, expired/old-state approvals, self/cross-member approval, key reuse and scope/lifetime escalation fail. Two independent SQLite connections race on one challenge; only one request wins. Cancellation, expiry, restart and retries do not resurrect requests. Existing Bridge/client tests must remain compatible; no runtime route or authorization grant is added.

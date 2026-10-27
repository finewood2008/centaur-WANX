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


## Team cloud identity extension

The team client uses the Consumer cloud account for every person's registration and login. A cloud account identifies the person; the box ledger establishes membership and device authority. A correct password, cloud access token, invitation, or identity proof alone cannot create a data session. Native WANX users remain `role=user`; the local principal namespace, not an email/phone/native username match, identifies business data.

The current wire schemas are defined in `wanx_bridge/local_team_protocol.py`, `wanx-team-client/device-trust/ledger-contract.mjs`, and Admin `module_nexus/service/team_identity_protocol.py`. All three use exact fields, canonical base64url, bounded ASCII JSON and safe integers. Cloud identity uses Ed25519; target possession, independent manager approval and box acknowledgements use separate ES256 keys/purposes. A 32-byte digest may start with `_` or `-`.

### Enrollment and projection

1. Provision the box's root-owned `team-identity.json` cloud verification pin and register its public box authority against the exact cloud device/binding/epoch. Neither operation creates members or grants.
2. An existing trusted owner device associates its Consumer identity and approves `team.activate`. Existing native administrators are never imported as approval authorities.
3. The owner creates a bounded invitation. The applicant signs in or registers through Consumer, creates local access/approval keys in its private vault, and requests a cloud proof bound to the complete request digest, box/key/epoch, invitation and both target key thumbprints. Proof lifetime is at most 300 seconds.
4. The applicant verifies the complete prepared mutation and confirms target possession. The owner independently signs that same reviewed mutation with its ApprovalKey. Merely submitting a request or knowing an invitation cannot commit membership.
5. The box transaction consumes the evidence, commits the principal/binding/membership and issues a signed association receipt. The cloud verifies that receipt against its separately provisioned box pin before projecting minimal per-client access. Device projection ACK is still required for remote connectivity.
6. Exact retries are read-only. Wrong keys/box/epoch, old versions, expired/replayed proofs and changed request fields fail. Terminal memberships/grants do not revive. A revoked cloud subject cannot silently create a replacement local principal; a future explicit rejoin/migration ceremony would need a separate contract.

Admin endpoints are `POST /app-api/v1/team/identity-proofs` (Consumer request-signature authentication), `POST /app-api/v1/team/associations/sync` (bounded signed box evidence), and `GET /app-api/v1/team/associations/{association_id}` (the current Consumer identity). A valid login never repairs or creates a revoked cloud grant. An already established association may receive newer valid box state after normal cloud logout/login, but current account/client/key/member/grant and expiry checks still apply. An unavailable cloud prevents new identity association; it does not replace or revoke independently valid local device authority.

### Team authorization

`owner`, `manager` and `member` are local team roles. Their versioned permissions are metadata inside the verified native GateContext. Management additionally requires the current `team:management` resource, so a published application's child channel cannot inherit administration merely because the person is a manager. Sensitive membership changes still require independent local management approval.

Effective access is the intersection of the current membership/role, team resource ACL, trusted device ceiling, current data-session grant and exact operation. Resource IDs are explicit (`team:application:<application-id>`, `team:agent:<id>`, `team:knowledge:<UUID>`, `team:space:<id>`); sharing never silently adopts another member's private data. Native resource/company registries bind objects to box and ownership epoch. `PUT /api/admin/applications/{id}/access` uses a current signed `membership_id` in required mode; a caller-selected native `user_id` is rejected.

Existing devices receive new resources through `team.device-resources`, with compare-and-swap binding revision and the full proposed replacement grant set. `self-resources` exposes only the caller's approved device grants and available own-member ACL. `team-device-review` discloses only the prepared target public keys to the original approving actor or exact target device, bound to the current checkpoint, request ID, mutation digest and expiry. Use devices prove their access key; management devices also prove their approval key. The owner/authorized independent approver confirms the complete mutation; use devices cannot approve their own expansion.

`team-request` responses have the dedicated `centuarai-local-team-request-response+jws` type and a 64 KiB envelope bound. Other signed response/proof limits remain unchanged. Terminal pending responses remove target proofs while retaining the signed committed acknowledgement.

### Company applications and Studio

Members read only an explicitly granted published app via `GET /api/app-studio/apps/{application-id}` and `/install`. They do not receive the workbench project list, private drafts or management API. A dynamic app channel can open and invoke only its own sealed published runtime. Every runtime operation rechecks publication state, membership and exact application scope. Revoking an app/member/device invalidates existing access rather than merely hiding the catalog entry.

Studio native helpers require a real GateContext from the data gate. Selected materials add exact current resource requirements, monotonically within an HTTP operation and bounded by its session grants. A background `GateTaskContext` inherits that final bounded set and cannot append resources or start an unrelated project. Private files retain their current principal's namespace; shared knowledge is read through signed finite Semantica child hops, never a legacy JWT or public warehouse key. Each read and write is checked before and after native work.

The team knowledge MCP bridge retains warehouse metadata, document listing, graph, search and evidence reads. Its main-process memory capability is bound to the current profile, principal, device, epoch, data session and exact warehouse. Lock, logout, profile change and authority loss invalidate it. The bridge accepts only bounded read operations for that warehouse; old public keys, injected warehouse selectors, owner views and write operations cannot substitute for the capability. Search evidence and graph evidence both retain the server's current document/workspace checks.

A build/interview/edit gets an independent short-lived task lease before execution. Closing its initiating HTTP response does not stop an authorized task. Membership/device revocation, lost lease or changed scope cancels it. Nested edit/build continuations remain within the same project and authority. File threads and native process groups must actually drain before a closed acknowledgement. Repeated cancellation and an already-exited group leader do not bypass cleanup. If cleanup itself is interrupted or physical exit cannot be confirmed, the operation remains unknown and retains its capacity/inventory reservation; it never emits a successful close acknowledgement.

### Migration and recovery

`tools/team_identity_migration.py dry-run` creates a content-digested plan from explicit offline roots and an exact old-user to new-local-principal mapping. Publication needs a committed `team.migration-authorize` mutation and a root-owned private plan. The root controller verifies fixed service/container/process/mount inventories, stops writers, stages paired databases/files, journals publication and consumes the permit through the authority's root-only broker. A password/cloud token, arbitrary path/command in a plan, or a second writable authority DB connection cannot authorize migration.

Old passwords, sessions, admin roles, access keys and native local-login credentials are not transferred. Old company publications/access decisions need explicit review before registration and republication under the new team authority. Unknown identity references, nonempty/conflicting targets, active jobs/uploads, reconnect-only integrations and legacy Semantica owner objects are blockers. Reports/warehouses whose ownership cannot be proven are retained and explicitly rejected for automatic mapping. Source-code text and user documents are never rewritten by a generic recursive UID replacement.

A full erase/redelivery removes the old active team graph and shared ACL from the new epoch. Signed historical ledger events remain audit evidence. This release implements initial registration within one ownership context. It does not implement cloud team re-registration after redelivery, owner-binding change or epoch advancement: the create-only registry and immutable provisioning bundle reject that changed context. A new owner cannot reactivate the former cloud team by signing in or rerunning the importer. A separately reviewed re-registration/rotation flow is required; deleting pins, editing the bundle or reusing old receipts is not a supported recovery procedure.


Migration visibility changes only after the authority consumes the exact completed plan under its current checkpoint and the root controller resumes the fixed writers. Long copies/hashes precede fresh permit checks, with another check immediately before each short rename. A read-only permission check and a filesystem rename are not one cross-process atomic transaction: revocation in that short interval can leave invisible intermediate files. It must still prevent permit consumption and automatic writer restart. Recovery keeps the fixed journal and frozen services; the implementation does not claim a single atomic transaction across all databases and files.

Team membership/invitation/resource counts are hard upper bounds, not a promise that all maxima fit simultaneously. The signed state envelope also bounds total serialized policy size; growth can fail earlier with a capacity error. Admission reserves room for subsequent suspend/revoke/terminal transitions so a full state cannot prevent security reductions. It never discards replay tombstones to make room.

# Local device management v1

Development scope, 2026-10-25: establish one independently provisioned first manager, keep client identities separate from cloud accounts, require per-operation local passphrase confirmation, commit same-principal use devices to a box-owned roster, and return signed acknowledgements. Existing data-plane SSO is not replaced by this work. The v1 evidence contract remains unchanged.

## Plan, dependencies and acceptance

1. Freeze these wire contracts before parallel implementation. Main owns integration and end-to-end tests. Python authority/provisioning, runtime/routes, client vault, JS protocol/transport, and isolated UI have disjoint owners.
2. Provisioning must refuse legacy owner/data/history and identity-only reset. A missing database is not first-claim eligibility. Only a verified factory-clean or completed full-erase state may create a new private provisioning bundle. Existing state is never overwritten. Missing independent legacy owner evidence returns `LOCAL_TRUST_MIGRATION_PROOF_REQUIRED` and preserves data.
3. Implement one authoritative SQLite transaction for challenges, requests, cancellation, approval, events, bindings and stored ACKs. Do not double-write the previous pending-only journal.
4. Implement an independent client vault and dedicated trusted confirmation window, then connect real HTTPS operations and package the new files. No cloud login or renderer-provided `verified` flag unlocks the identity.
5. Verify real first-root → second device request → manager confirmation → atomic roster commit → signed receipt, along with concurrency, cancellation, expiry, restarts, clock rollback, wrong TLS/box pins, altered requests, IPC sender isolation and lock-during-confirmation cases. No real accounts, production provisioning, reset or deployment are performed during development.

## Protection and transport

The first supported client policy is `software-passphrase-v1`: independent local passphrase, separate access/approval keys, per-operation approval-key decryption. It does not claim hardware non-exportability or remotely attested user presence. No reusable `verified=true` authorization token exists. The management UI must display the same immutable request that main signs; locked, closed, replaced or expired intents cannot later produce a submission.

Management runs as a separate HTTPS application at `/local-trust/v1`, without a reverse proxy or cloud/Octop dependency. TLS SPKI pin and the independent P-256 box signing JWK are supplied by the protected delivery packet or an already trusted local manager. The desktop validates the TLS pin before sending a request body, rejects HTTP, redirects, credentials/query/fragment in the base URL, and verifies signed box responses. The old bridge rejects this path prefix rather than forwarding it to Octop.

All JWS use the strict ASCII/safe-integer/canonical JSON and unpadded base64url rules of the evidence contract. ES256 is the only asymmetric algorithm. Every type is fixed by the operation, never chosen from incoming metadata. Box-signed envelopes use type `centuarai-local-management-response+jws` and payload `{schemaVersion:1,purpose:"centuarai.local-management.response",boxId,boxKeyThumbprint,kind,issuedAt,body}`. `body` is exact-schema per operation; consumers validate it, binding it to the expected request/challenge/checkpoint rather than trusting an arbitrary signed blob.

All server times come from the execution-time trusted clock. A service-start generation invalidates unfinished challenges/requests; an exclusive runtime lock prevents independently generated generations racing. The durable wall-clock high-water mark cannot be reset by restarting the service. SQLite work uses a bounded worker pool, never the event loop. Body limits, source budgets and independent public/management concurrency limits protect the listener. Responses are `Cache-Control: no-store`; errors/logs never contain request proofs, local passphrases or claim secrets.

## Provisioning and first root

Protected delivery packet (maximum 8 KiB):

```
{schemaVersion:1,type:"centuarai-local-trust-delivery",boxId,baseUrl,
 boxKey:<P-256 public JWK>,tlsSpkiSha256:<32-byte base64url digest>,
 provisioningId:<32-byte random value>,ownershipEpoch:<positive integer>,
 claimSecret:<32-byte base64url random secret>}
```

The box keeps separate local-authority and TLS private keys in its private directory, outside ordinary business-data backups/reset roots. A private provisioning file contains the SHA-256 digest of the claim secret as the HS256 verification key; the client computes the same value. This value is itself sensitive and must never be returned by an API. It is consumed/removed from the ledger when the first root commits; persisted consumed state prevents old packet reuse. Offline full-disk rollback protection is outside this software guarantee.

`POST /first-root/challenge` takes `{}` and returns signed kind `first-root-challenge`, body `{provisioningId,ownershipEpoch,challenge,issuedAt,expiresAt,grants}`. The challenge is random 32 bytes, lives at most 300 seconds, and is single-use. No principal or roster is disclosed. Already-owned/unknown provisioning state cannot restart first claim.

First-root canonical payload has exactly:

```
{schemaVersion:1,purpose:"centuarai.local-management.first-root",
 boxId,boxKeyThumbprint,provisioningId,ownershipEpoch,challenge,requestId,
 issuedAt,expiresAt,principalId,clientId,accessKey,approvalKey,grants,
 grantExpiresAt:null,keyProtection:"software-passphrase-v1"}
```

Keys are distinct valid P-256 public JWKs. Root grant resources/actions must exactly match the independently provisioned initial grants. Principal/client IDs are independent random local IDs, not cloud account IDs. Three proofs cover the identical canonical payload: ES256 `centuarai-first-root-access+jws`, ES256 `centuarai-first-root-approval+jws`, and HS256 `centuarai-first-root-secret+jws` keyed by `SHA-256(claimSecret)`. The raw secret never travels to the server. `POST /first-root/commit` takes exactly `{accessProof,approvalProof,secretProof}`.

Commit rechecks provisioning/epoch/challenge/time/keys in `BEGIN IMMEDIATE`, consumes the credential, writes the first manager and principal, event/version/checkpoint and the signed ACK once, then commits before replying. Different concurrent roots cannot both succeed. Exact completed retries verify both client key proofs and return the stored ACK; a different payload with the same request ID conflicts. No transaction failure creates partial ownership. New-root state records `recoveryConfigured:false`; this feature cannot claim recovery protection.

## Fresh authenticated management reads

`POST /auth/challenge` takes `{}` and returns signed kind `auth-challenge`, body `{nonce,issuedAt,expiresAt,ownershipEpoch}` (maximum 60 seconds). The nonce is single-use for either authenticated read below.

Access-key proof type `centuarai-local-management-read+jws`, exact payload:

```
{schemaVersion:1,purpose:"centuarai.local-management.read",
 boxId,boxKeyThumbprint,ownershipEpoch,nonce,issuedAt,expiresAt,
 clientId,operation:<"state"|"request">,requestId:<null|32-byte ID>}
```

`POST /state` takes `{proof}`. Only a currently active manager's access key authorizes its principal's state. Return signed kind `state` with `{context,bindings,recoveryConfigured}`: context is the six fields in evidence v1; bindings use that existing schema and include key history needed for validation. Current implementation admits one local principal, no cross-member access.

`POST /requests/read` takes `{proof}`. The applicant may read only its own request and receipt using the saved target access key; an active manager may read a request targeting the same principal. Return signed kind `request` body `{requestId,requestDigest,state,requestJws,ack}`; `ack` is null until committed. Unknown requests and unauthorized reads have the same external denial. Every read proof is verified before returning metadata; old Bearer tokens and replayed proposal proofs do not authorize reads.

## Ordinary use-device enrollment

`POST /requests/challenge` takes `{}` and returns signed kind `binding-challenge`, body `{context,challenge,issuedAt,expiresAt}`. The six context fields are loaded from the local authoritative roster. No private member/device list is exposed.

`POST /requests` takes `{requestProof}` using the unchanged evidence-v1 applicant JWS. The challenge/context must match and remain live. Persist the exact immutable payload, digest and original signed submission receipt in one transaction. Reject conflicts, repeated challenges, known client/key identities and invalid lifetimes. Return signed kind `request-receipt`, body `{requestId,requestDigest,state,expiresAt}`. Exact proposal retries return that original receipt byte-for-byte, never the latest state; dynamic state and ACK require a fresh authenticated read. This prevents a captured expired proposal proof from tracking later approval or cancellation.

`POST /requests/approve` takes `{requestId,approvalProof}`. In the same write transaction, load the saved applicant proof and **current** roster, validate the evidence-v1 approval, recheck pending status/version/time, append one binding/event, increment roster version/digest, and persist a signed ACK. Caller-supplied roster or confirmation booleans are rejected. The new binding is only `use`, has no approval key/capability and cannot delegate. Cancellation uses unchanged signed cancellation: `POST /requests/cancel` takes `{cancelProof}`. Approve/cancel compete in one transaction; terminal requests never revive. Exact approved retries return the stored ACK only after validating the original approving key signature and matching request digest; they do not create another binding.

ACK kind `binding-ack` body has exactly `{requestId,requestDigest,bindingId,principalId,clientId,role,accessKeyThumbprint,ownershipEpoch,rosterVersion,rosterDigest,policyVersion,committedAt,recoveryConfigured}`. A client verifies the box signature, request/key/principal/role match and monotonic pinned checkpoint before displaying success and recording the association. Receipt loss does not cause re-claim or new identity creation.

The authoritative runtime reserves 128 challenge records per kind. Approved records/ACKs remain durable; cancelled/expired use requests are retained until one hour after their original expiration and may then be pruned. An expired proof cannot create a new request after pruning. Missing expired records are not success evidence. First-root result recovery uses exact dual-PoP commit retries; the ordinary use-request read endpoint does not expose first-root proofs. These rules apply to the integrated authority store, not the earlier offline pending-only journal.

## Desktop flow and interfaces

A main-owned coordinator controls the flow. Renderer methods are fixed business actions, never arbitrary signing, network requests or trusted-state input:

- `snapshot`, `createProfile`, `unlock`, `lock`.
- `prepareFirstRoot({deliveryPacket})` → immutable review; `confirmFirstRoot({reviewHandle,passphrase})`.
- `exportJoinInfo({boxId})` → public descriptor + explicit principal/resource limits (no claim secret).
- `prepareJoin({joinInfo})` → immutable request review; `submitJoin({reviewHandle})` → signed receipt and invitation text.
- `prepareApproval({invitation})` → authenticated fetch + immutable review; `confirmApproval({reviewHandle,passphrase})`.
- `refreshRequest({boxId,requestId})`, `cancelRequest({boxId,requestId})`, `refreshDevices({boxId})`.

The coordinator stores descriptors, pinned checkpoints and receipts in the profile's authenticated encrypted state. Imports are parsed/size-limited in main; a manager cannot replace a stored box pin from an invitation. The protected first packet and confirmation passphrase are not persisted in ordinary UI state, logs, cloud sync or clipboard history automatically. A dedicated window/preload provides the above actions only; trusted main-frame + webContents + exact URL validation applies to every call. Closing/crashing/navigating/locking/suspending invalidates all review handles. Main re-reads current state before signing and submission, and fences late asynchronous results by identity/window generation.

The first release UI describes software protection accurately and records local binding separately from existing data-login status. Recovery and replacing cloud data-plane authorization remain later work; no `local_trust_enforced` claim is made by this management flow.

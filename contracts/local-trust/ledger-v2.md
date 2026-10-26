# Local authority ledger v2 — implementation contract

Status: implementation contract following coordinating review, 2026-10-26. This document authorizes no production migration and does not describe already deployed behavior. Wire changes require explicit cross-owner review and matching vectors before implementation changes. Existing [use-device evidence v1](v1/README.md) and [management v1](management-v1.md) remain separate, supported wire contracts.

## Scope, ownership and acceptance

One local authority instance owns the database and all management/data authorization changes. Add an explicit atomic v1 migration, typed security events, independent principals, effective resource grants, explicit manager enrollment, revocation, independently verified recovery configuration and ownership-transfer preparation. The same runtime consumes a read-only authorization view; it must not instantiate another writer or import cloud grants as authority.

This work does not establish hardware non-exportability, physical anti-rollback, cloud-account migration authority, backup decryption from a signing key, or safe erasure merely from an empty database. The supported client policy remains `software-passphrase-v1`. A renderer flag, device certificate, DeviceKey, cloud token, existing network membership or local application admin credential cannot satisfy any user proof below.

Implementation dependencies:

1. Freeze wire/schema, migration fixtures and cross-language rejection vectors.
2. Implement transactional migration and replay validation; preserve v1 enrollment proofs/commits and stored responses, while explicitly upgrading incompatible state readers.
3. Implement mutation review/commit, scoped fresh reads and the single-runtime authorization view.
4. Implement explicit manager/member enrollment, revocation and last-manager arbitration.
5. Integrate the separate recovery/backup contract and OS verified-erase adapter.
6. Test two independent SQLite connections, competing mutations, power-loss boundaries, old credentials, state corruption and scoped disclosure before enabling routes.

Ordinary runtime startup never migrates implicitly. Missing, partial or unknown schema is an error, never permission to create a new authority. The offline migration command holds the exclusive runtime lock; the management/data listeners are stopped. No cloud or legacy ownership row is imported.

## Encoding and cryptographic domains

Reuse evidence-v1's restricted canonical JSON, ASCII token syntax, positive safe integers, exact public P-256 JWKs, canonical base64url and fixed ES256 rules. Unknown/duplicate fields, noncanonical encodings, floats, negative zero, algorithm selection and header key metadata fail closed. Optional fields below are mandatory and explicitly `null` when unused.

Each compact JWS is at most 16,384 ASCII bytes. The mutation commit HTTP body is at most 96 KiB. Neither limit is an authorization mechanism. Any response/projection that cannot fit its negotiated bound is rejected before committing a change that would make required management reads unusable. Large history reads use explicit bounded pagination, not larger unsigned responses.

Unless specified otherwise, lifetimes satisfy `issuedAt <= now < expiresAt <= issuedAt + 300`; a prepare and its resulting mutation keep the same interval. `now` comes from the execution-time trusted clock and is a positive safe integer. `expectedRecoveryVersion` and other fields explicitly defined as counters may be zero; this is not permission for zero-valued epochs or key versions.

Fixed protected headers have exactly `alg="ES256"` and the listed `typ`:

| Purpose | `typ` | Verification key |
| --- | --- | --- |
| Prepare a private mutation review | `centuarai-local-ledger-prepare+jws` | Current actor access key; current offline recovery key for a recovery actor |
| Commit a mutation | `centuarai-local-ledger-mutation+jws` | Current actor approval key; current offline recovery key for a recovery actor |
| Target access-key possession | `centuarai-local-ledger-target-access+jws` | Exact target access key in the mutation |
| Target approval-key possession | `centuarai-local-ledger-target-approval+jws` | Exact target approval key in the mutation |
| Reimported next recovery material | `centuarai-local-ledger-recovery-material+jws` | Exact next recovery signing key in the mutation |
| Source recovery proof for a backup import | `centuarai-local-ledger-source-recovery+jws` | Source key bound by the independently verified backup manifest; never a target-box authority key |
| Fresh v2 read | `centuarai-local-ledger-read+jws` | The registered key selected under the scoped read rules |
| Box response | `centuarai-local-ledger-response+jws` | Independently pinned local box signing key |

Every target/material proof signs the complete, identical canonical mutation payload. Signing only a request ID, a human summary or an untyped digest is insufficient. `mutationDigest = base64url(SHA256(canonical(mutation)))`. Different signatures over the same canonical payload are equivalent for exact retries; different payloads with one request ID conflict.

## Persistent identities and authority

### Box ownership and principals

`BoxOwnership` has exactly:

```
{boxId,boxKeyThumbprint,ownershipEpoch,
 state:"unclaimed_ready"|"owned"|"transfer_frozen"|"erase_pending",
 ownerPrincipalId:null|token,originalOwnerBindingId:null|token,
 extendedOwnerPolicyActivated:boolean,provisioningId:null|digest,
 pendingTransferId:null|digest}
```

The bootstrap bundle is an immutable origin anchor: original box identity, initial provisioning identity, original credentials and provisioning evidence digest. Its original epoch is historical. After v2, runtime compares its immutable identity/origin to the migration anchor; it does **not** require mutable current ownership epoch, current owner, recovery state or current provisioning credential to equal the original bundle. Mutable values come only from the verified ledger.

`LocalPrincipal` has exactly:

```
{principalId,ownershipEpoch,status:"active"|"suspended"|"revoked",
 principalSecurityVersion,createdSequence,recoveryVersion}
```

Principal IDs are independently generated local tokens, globally unique across retained history and epochs. Never look them up or alias them using cloud account ID, phone, display name or app user integer. Revoked principals cannot be recreated under the same ID. Ownership of the organization is separate from a member's private identity. An organization owner may invite or revoke membership under explicit authority, but cannot add a device to an existing other principal, sign as that principal or acquire its private resource grants.

### Bindings, capabilities and grant records

Keep evidence-v1's exact binding projection for v1 consumers. Internally extend each binding with `bindingRevision` (positive integer), `ownershipEpoch`, `capabilities`, `createdByBindingId:null|token`, `createdByRecoveryId:null|digest`, `sourceRequestId` and `sourceEventSequence`. Initial root is anchored to its signed root request. A use binding has no approval key and an empty capability list.

The supported capability tokens, sorted and unique, are:

```
backup.create
backup.restore
device.approve_manage
device.approve_use
device.review_descendants
device.revoke
member.invite
member.revoke
ownership.transfer
recovery.configure
```

`role="manage"` alone grants none of them. `canApproveUseDevices` in the v1 projection is true only when the currently effective binding includes `device.approve_use`. Being an owner principal does not make every device an owner-management device.

Resource grants are separate records, not inferred from capabilities or `delegableGrants`:

```
{grantId,ownershipEpoch,principalId,bindingId:null|token,
 resourceId,resourceScope:"principal-private"|"shared",resourceNamespaceId,
 actions,delegableActions,
 expiresAt:null|positiveInt,delegationExpiresAt:null|positiveInt,
 status:"active"|"suspended"|"revoked",
 sourceGrantIds:[token...],sourceBindingId:null|token,
 createdSequence,revision}
```

`actions` and `delegableActions` are sorted unique subsets of `execute/read/write`; `actions` is nonempty, `delegableActions` may be empty and is a subset of `actions`. Source grant IDs are sorted and unique. A source must predate the child, be independently valid at creation, and bound the child's resource/actions, delegation and lifetime. Ordinary device enrollment requires the same principal on every source edge. The only cross-principal source edge in this contract is an explicitly approved `principal.invite` delegation of an explicitly shared resource. Source edges form a DAG, never a cycle. A finite source limit cannot grant unlimited or longer authority. The initial root resource grant set is exactly the independently provisioned set.

The initial executable catalog accepts exactly `wanx`, `space`, `space:personal`, `clipboard` and `semantica`, all as principal-private templates. `space` is an explicit alias of `space:personal`. `wanx` refers to that principals own Octop domains and does not include system administration; `clipboard` is the private clipboard subdomain; `semantica` is the principals independent workspace collection. No shared resource is configured in this first implementation; shared invitations and unknown tokens are rejected.

The resource catalog defines each public resource token as either a principal-private namespace template or an explicitly shared resource. A generic token such as `space` or `space:personal` never addresses the inviter's private storage globally: it resolves under the **target principal** to a fresh server-created namespace. A private template grants only capabilities over that new empty namespace; it carries no source edge into another principal's data and cannot reuse the inviter's namespaceId, app-user integer, directory or decryption envelope. Such template creation requires the explicit approved invitation and a catalog policy allowing new empty private namespaces; it is not delegation of the inviter's existing private ResourceGrant.

For that explicit new-principal invitation, createdByBindingId records inviter provenance only. It does not make the member's independent private authority continuously depend on the inviter device. Recovery/revocation of the inviter's devices affects their same-principal device descendants, not this independently established member. Revoking the member requires principal.revoke. Any separately configured shared-resource source edge still obeys its own current revocation/expiry and is not revived by member independence or recovery.

Shared grants use a stable catalog entry explicitly marked shared and bind the exact shared resourceNamespaceId. Only then may a member.invite source edge cross principals, within the inviter's actual delegable shared-resource scope. Unknown/ambiguous resource kinds are rejected; private resources cannot be relabeled shared by a caller. Migration and data adapters require the reviewed catalog mapping and cannot infer it from a resource's display name. The data resolver keys private storage by target principal plus its ledger namespace; ownership/member administration never aliases another member's private namespace.

A binding's data authority is the intersection of its explicit grant records, the principal's active grants, current epoch, status, policy, lifetime and valid source/approval chain. The v1 `delegableGrants` field is a projection of actual delegable authority; a use device's empty value does **not** mean it has no data grants. V1 use requests retain their explicit `grants` and `grantExpiresAt` as the source of actual binding grants.

All historical client IDs and access/approval/recovery signing-key thumbprints remain unique across their respective registered purposes and epochs. A revoked key cannot reappear by changing client ID, principal ID or key purpose. Recovery backup-encryption keys have a separate typed registry and cannot be accepted as signing keys.

### Versions and checkpoints

`rosterVersion` is a global monotonic security-event sequence; any authority-changing event increments it exactly once. `authorizationVersion` is a global positive counter incremented on every committed v2 security event, including enrollment, recovery, freeze and revocation. `bindingRevision` changes when that binding's effective state, explicit grants or capabilities change. `principalSecurityVersion` changes on principal-wide invalidation/recovery. Neither clock time nor a cloud version replaces these counters.

The six v1 context fields remain `{boxId,boxKeyThumbprint,ownershipEpoch,rosterVersion,rosterDigest,policyVersion}`. In v2, `rosterDigest` is the SHA-256 digest of the canonical full public-security snapshot described below, not a claim that a scoped response discloses the entire snapshot. Current v1 management clients verify `rosterDigest == SHA256(canonical(bindings))`; therefore a v2 scoped state **cannot** be returned as a v1 state response. A change in another principal can cause a conservative global-version conflict; it does not authorize disclosing that principal's records.

After migration, `/local-trust/v1/state` returns `LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED` and never fabricates the old digest relationship. Evidence-v1 use request/challenge/submit/approve/cancel payloads and saved v1 root/binding ACKs remain supported, but only an upgraded coordinator obtains the required current state through the v2 scoped snapshot. Its verifier checks the box signature, `projectionDigest`, current global checkpoint and scope; it then constructs the evidence verifier's trusted input from the six global context fields plus the exact v1 projection of the authorized principal's bindings. The authority still checks global key/client history and current grants in the commit transaction. Old clients must upgrade rather than silently ignore unknown fields or accept a different digest interpretation.

The canonical security snapshot has exactly:

```
{schemaVersion:2,ownership,policyVersion,authorizationVersion,dataPlanePolicy:"local-trust-required",
 principals:[LocalPrincipal...],bindings:[InternalBinding...],
 grants:[ResourceGrant...],recoveryConfigurations:[PublicRecoveryConfiguration...],
 keyHistory:[{thumbprint,purpose,firstSequence,retiredAtSequence:null|positiveInt}...]}
```

Arrays are sorted by their stable ID; key history is sorted by `purpose` then thumbprint. Current `rosterVersion/rosterDigest`, clock watermarks, request caches, raw credential verification secrets and event/ACK signatures are excluded to avoid recursion and secret disclosure. Public recovery fields are defined in [the recovery contract](recovery-backup-transfer-v1.md). `InternalBinding` means the v1 fields plus the explicitly listed v2 extension fields above; no implementation-specific column is hashed accidentally.

## Common mutation and review protocol

The actor object has exactly:

```
{kind:"binding"|"recovery",principalId,
 bindingId:null|token,keyVersion:positiveInt}
```

For a binding actor, `bindingId` is required and `keyVersion` is the current approval-key version. Preparation uses that binding's registered access key; commit uses its separate approval key. For a recovery actor, `bindingId=null` and `keyVersion` is the current principal recovery version; both proofs use the corresponding independently established recovery signing key. A recovery actor may perform only the explicitly specified recovery action, never ordinary administration.

A preparation payload has exactly:

```
{schemaVersion:2,purpose:"centuarai.local-ledger.prepare",
 boxId,boxKeyThumbprint,ownershipEpoch,rosterVersion,rosterDigest,policyVersion,
 requestId,challenge,issuedAt,expiresAt,actor,action,args}
```

The resulting mutation has the same fields, changes purpose to `centuarai.local-ledger.mutation`, and adds exactly `effectsDigest`. `args` is the exact action-specific schema below; generic arbitrary JSON actions are forbidden.

`effectsDigest` hashes the complete canonical signed review effects object. Its exact fields are:

```
{targetPrincipalId:null|token,targetBindingIds:[token...],targetSummaries:[TargetSummary...],
 revokedBindings:{count,digest},suspendedBindings:{count,digest},
 invalidatedRequests:{count,digest},
 principalSecurityVersionBefore:null|positiveInt,
 principalSecurityVersionAfter:null|positiveInt,
 recoveryVersionBefore:null|nonnegativeInt,recoveryVersionAfter:null|nonnegativeInt,
 recoveryBefore:null|RecoveryReviewConfiguration,recoveryAfter:null|RecoveryReviewConfiguration,
 remainingIndependentManagers:nonnegativeInt,verifiedRecoveryAvailable:boolean,
 grantsBefore:null|GrantList,grantsAfter:null|GrantList,
 capabilitiesBefore:null|CapabilityList,capabilitiesAfter:null|CapabilityList,
 resultingAuthority:null|{grants,delegableGrants,expiresAt,delegationExpiresAt,capabilities},
 redacted:boolean,ownershipStateAfter,requiresVerifiedErase:boolean}
```

`GrantList` is the exact v1 sorted `{resourceId,actions}` list, allowing empty lists only for review projections. `TargetSummary` is exactly `{bindingId,principalId,clientId,role,accessKeyThumbprint,approvalKeyThumbprint:null|digest,bindingRevision,status,capabilities,expiresAt,delegationExpiresAt}` and comes from the same checkpoint as the prepared mutation. New target keys are displayed from args; existing revoke/review targets use these signed summaries, never a stale cached device name. `resultingAuthority` is populated for manager/member creation and recovery and includes the exact restored delegation and both expiry limits; otherwise it is null. Its grants/delegableGrants use GrantList and lifetimes use explicit null or positive integers. `RecoveryReviewConfiguration` is the full public recovery configuration below except establishedAt/establishedSequence/retiredAtSequence, which the commit assigns; both recoveryBefore/recoveryAfter are null outside recovery operations. Thus recovery consent binds its keys, granted authority and expiry, not merely a version number.

Count/digest pairs commit to the sorted affected stable IDs, with digest of `[]` for zero. `targetBindingIds` and targetSummaries contain only explicit targets the actor may see; cross-member membership revocation reveals counts/commitments, not the other member's full private device/grant list. In that case targetSummaries is empty, detailed grant/capability fields are `null` and `redacted=true`. The server retains the full computed affected-ID sets to revalidate the same impact at commit. Redaction never means authorization is skipped. Oversized reviews are rejected, never silently truncated; descendant review may be split into separately revalidated bounded operations.

The signed review includes the complete mutation and effects. The client recomputes effectsDigest and mutationDigest, displays the immutable target keys, capability/grant/lifetime changes and cascade/last-manager result, then signs that exact mutation. UI handles cannot substitute fields, authority input or a `verified` boolean. The prepare proof only reads a review; it does not authorize the mutation.

### Endpoints and response envelopes

All paths below are under the independent pinned HTTPS `/local-trust/v2` listener. No redirect or old proxy fallback is permitted.

| Endpoint | Exact request body | Signed response kind/body |
| --- | --- | --- |
| `POST /mutations/challenge` | `{actor,action}` | `mutation-challenge`: `{context,actor,action,challenge,issuedAt,expiresAt}` |
| `POST /mutations/prepare` | `{prepareProof}` | `mutation-review`: `{mutation,effects}` |
| `POST /mutations/commit` | `{mutationProof,targetAccessProof,targetApprovalProof,recoveryMaterialProof,sourceRecoveryProof}` | `mutation-ack`, schema below |
| `POST /auth/challenge` | `{}` | `read-challenge`: `{context,nonce,issuedAt,expiresAt}` with lifetime at most 60 seconds |
| `POST /read` | `{proof}` | The exact scoped read kind below |

Unused commit proof fields are explicit `null`. No generic extra-proof array or caller-supplied trusted roster is accepted. `sourceRecoveryProof` is reserved for the exact backup import action defined by the recovery/backup contract and is null for every action in this document.

The mutation challenge echoes syntactically valid actor/action inputs without confirming a principal, key or recovery configuration exists. It returns only the public box checkpoint. Current recovery version/key identity and principal state require a valid recovery prepare proof; wrong keys and unknown recovery principals have the same external denial. The independently retained recovery packet supplies its expected principal and recovery identity.

The new box response payload is exactly:

```
{schemaVersion:2,purpose:"centuarai.local-ledger.response",
 boxId,boxKeyThumbprint,kind,issuedAt,body}
```

Preparation stores the exact draft, resulting mutation, effects and signed original review in the authoritative transaction. Its challenge advances `issued -> prepared -> committed`, bound to one request/digest. Exact preparation retries return only the original review, not current status. Expired/cancelled preparations never revive. Service restart invalidates unfinished challenges/preparations while retaining terminal receipts and the durable clock fence.

Commit runs inside `BEGIN IMMEDIATE`: verify all required proofs, current actor/chain/status, expected checkpoint, time, action limits, last-manager rule and recomputed effects; then write typed event, projections, versions, consumed proofs and the stored signed ACK. Commit precedes response delivery. Any conflict requires a new review; neither frontend nor server silently updates the expected version or effectsDigest.

For target co-signing, the approver transfers exactly `{schemaVersion:2,type:"centuarai-local-ledger-review-handoff",baseUrl,tlsSpkiSha256,boxKey,reviewJws}` through the already selected trusted box association/invitation channel. This descriptor cannot overwrite an existing box pin. The target verifies the signed review and effectsDigest, its own two public keys, principal, grants/capabilities/lifetimes, freshness and expected box before a separate local passphrase confirmation signs both target proofs. The reply is exactly `{schemaVersion:2,type:"centuarai-local-ledger-target-proofs",requestId,mutationDigest,targetAccessProof,targetApprovalProof}`. The approver verifies that both proofs cover its original complete mutation. An earlier applicant proof cannot substitute for these final-review proofs, and a target receives no generic arbitrary signing API.

The `mutation-ack` body is exactly:

```
{requestId,mutationDigest,action,effectsDigest,eventId,eventDigest,
 ownershipEpoch,rosterVersion,rosterDigest,policyVersion,authorizationVersion,
 committedAt,ownershipState,result}
```

`result` is exactly `{principalId:null|token,bindingId:null|token,
 principalSecurityVersion:null|positiveInt,recoveryVersion:null|nonnegativeInt,
 transferId:null|digest,operationId:null|digest}`. Unused values are null; each action has the populated fields listed below. Backup actions set operationId=requestId to identify the separately tracked authorized job. Every result is a historical commit fact. It does not assert that the actor/target is still active or a background data job has completed at read time.

## Action-specific schemas and checks

### `owner-policy.activate-v2`

Exact args: `{capabilities:CapabilityList}`; all target/material proof fields are null. Binding actor must be the **currently active original owner-root binding**, proven by the independently signed first-root event, with its original separate approval key. Current ownership is owned, the original owner principal is active, and `extendedOwnerPolicyActivated=false`.

Migration initially preserves only `device.approve_use`. This one-time, explicit operation can activate a user-selected subset of the supported capabilities for that original root binding; `device.approve_use` must remain included. It changes no resource grant, data scope or expiry, and does not add any capability to another device. The signed review exposes each capability change. The UI offers a dedicated “enable extended security management” confirmation and per-operation passphrase. A cloud owner, an ordinary manager or an imported display role cannot invoke the exception. Result identifies the owner principal and original binding. Exact retry is allowed; a second different activation is rejected. This draft supplies no later capability-expansion route: the confirmation must explicitly disclose that unselected capabilities cannot be added within the current epoch by repeating activation. A later policy-update feature requires its own reviewed authority/recovery contract; it cannot be smuggled into this exception.

### `device.add-manager`

Exact args:

```
{target:{clientId,accessKey,approvalKey,keyProtection:"software-passphrase-v1",
 capabilities:CapabilityList,grants:GrantList,delegableGrants:GrantList,
 expiresAt:null|positiveInt,delegationExpiresAt:null|positiveInt}}
```

Actor needs effective `device.approve_manage`; the target is **the actor's existing principal**. Both target proofs are mandatory; recovery/source proofs are null. Target keys are distinct, unused and purpose-separated, and client ID has no retained history. Requested capabilities are a subset of the actor's effective capabilities; grants/delegable grants and both lifetimes are bounded by the actual principal/source grants and actor delegation authority. Delegable grants may be empty. Finite authority cannot approve unlimited authority. `device.approve_manage` itself is never inherited unless explicitly included and authorized. The committed binding records its approving parent and source grants; result identifies principal/new binding.

This action cannot create a principal, migrate another person's identity, rotate/reuse historical keys or repair a revoked binding. Existing use enrollment remains evidence-v1 and cannot request an approval key or capabilities.

### `principal.invite`

Exact args:

```
{principalId:<new local token>,
 target:{clientId,accessKey,approvalKey,keyProtection:"software-passphrase-v1",
 capabilities:CapabilityList,grants:GrantList,delegableGrants:GrantList,
 expiresAt:null|positiveInt,delegationExpiresAt:null|positiveInt}}
```

Actor belongs to the current owner principal and has effective `member.invite`. Both target-key proofs cover the same complete mutation and establish the recipient's independent key possession. Principal ID, client ID and keys must be entirely new, including revoked history. The invitation creates exactly one new principal and its first manager atomically. It cannot select an existing principal, alias an app user/cloud ID or assign the inviter's private identity to the recipient.

Shared-resource delegation comes only from explicit delegable shared grants held by the actor; ownership alone does not supply data grants. Private-template entries create a fresh empty target namespace under the catalog rules above and never export the owner's private data. The invitation's review distinguishes these two cases and signs the actual catalog/namespace resolution through effectsDigest. Recipient capabilities are limited to `device.approve_use`, `device.approve_manage`, `device.revoke`, `device.review_descendants`, `recovery.configure`, `backup.create`, `backup.restore`, explicitly selected and bounded by the actor's effective policy. `member.invite`, `member.revoke` and `ownership.transfer` are never delegated through a member invitation. Capability possession alone does not permit reading private resources. Result identifies the new principal and its first binding.

### `device.revoke`

Exact args: `{bindingId,mode:"normal"|"emergency-lock"}`; no target/material proof. Actor needs `device.revoke`, target belongs to the same principal, and target is not already terminal unless this is an exact completed retry.

The target becomes permanently revoked. Its still-dependent descendant bindings/grants become suspended, including descendants approved before the revocation arrived. Pending requests and prepared privileged mutations depending on that chain are invalidated. Keep all key/client tombstones. Two descendants cannot approve/review each other to remove their dependence on a revoked ancestor.

Normal mode requires at least one independent active manager with sufficient relevant capabilities after the **entire cascade**, or an already verified independent recovery configuration. Counting managers before the transaction or before the cascade is invalid. `emergency-lock` explicitly permits zero remaining managers: it invalidates affected authority and leaves the principal in `suspended` recovery-required state. It never promotes a use device or cloud account. Emergency mode is a separately displayed destructive confirmation, still requiring the actor's current approval proof. Result identifies the target principal/binding and resulting principal security version.

### `device.review-descendants`

Exact args: `{bindingIds:[token...]}`; 1..16 sorted unique IDs; no target/material proof. Actor needs `device.review_descendants` and an effective source chain independent of every revoked/suspended ancestor being replaced. Every target belongs to the actor principal, is suspended (never revoked), and retains its original keys and scope. The new valid parent/source grant edges must predate this operation and remain within the actor's effective authority. Revalidation cannot increase capabilities, grants or lifetime. All targets/edges are bound by the review/effects digest and committed atomically. If no independent chain or verified recovery exists, deny rather than forming a cycle.

### `principal.revoke`

Exact args: `{principalId}`; no target/material proof. Actor must belong to the current owner principal with `member.revoke`. Target is a different active/suspended principal; revoking the owner principal uses the ownership-transfer/reset path, not this action.

Atomically revoke target membership, all its bindings, recovery capability, resource grants, prepared operations and active session generation. Preserve business data and audit records; no automatic export, reassignment or deletion is authorized. The owner sees only the explicit member target and bounded affected counts/commitments. It cannot use this operation to become that member or read the member's private keys/content. Result identifies the revoked principal and new principal security version.

### Recovery actions

These action names and args are shared with [recovery/backup/transfer v1](recovery-backup-transfer-v1.md); that contract specifies the offline packet, backup encryption format and reimport procedure.

- `recovery.setup`: `{expectedRecoveryVersion:0,newRecovery}`.
- `recovery.rotate`: `{expectedRecoveryVersion:<positiveInt>,newRecovery}`.
- `recovery.recover`: `{expectedRecoveryVersion:<positiveInt>,expectedPrincipalSecurityVersion,
  newRecovery,target:{clientId,accessKey,approvalKey,keyProtection:"software-passphrase-v1"}}`.

`newRecovery` is exactly `{recoveryId:<new digest>,version:<expected+1>,signingKey:<P-256 public JWK>,backupKey:<RSA-3072 public JWK>}`. RSA public-key validation is a distinct exact schema and algorithm profile; it must never pass through the P-256 signing validator. Private recovery/backup keys are generated and retained offline by the client. No cloud sync, ordinary vault backup, persistent plaintext or server-side shared recovery secret is introduced.

The persistent public recovery configuration is exactly `{principalId,recoveryId,version,status:"active"|"retired",signingKey,backupKey,grants,delegableGrants,capabilities,expiresAt,delegationExpiresAt,establishedAt,establishedSequence,retiredAtSequence:null|positiveInt}`. Grant/capability lists and lifetime types use the rules above. At setup/rotation, the approved review fixes the recovery authority ceiling from the acting binding's effective authority intersected with the principal's current authority. This ceiling is persisted, not dynamically enlarged when the owner later activates capabilities or receives more grants. Its expiry cannot exceed the actor/source grant limits at establishment. The full before/after public configurations are signed by effectsDigest, and recovery requires the current configuration still to be active and unexpired.

Setup/rotate require a same-principal binding actor with `recovery.configure` and a `recoveryMaterialProof` produced only after the user reimports the independently saved **new** material. Target proofs are null. Reimport checks signing/backup key correspondence and the separate backup-key round trip. Setup is allowed only at version zero; rotate requires the exact current version. Result identifies the principal/current actor binding and next recovery version.

Recover requires a recovery actor at the exact active current recovery version, both new target-key proofs and the next material proof. Target keys/client ID are new and distinct. The target manager's restored capabilities, effective/delegable grants and lifetimes are bounded by the saved recovery configuration **and** that principal's currently valid authority; the signed review displays the exact result. The next recovery configuration cannot exceed that same intersection. Recovery cannot increase organization authority or restore revoked membership. The entire result is bound by effectsDigest and the expected principal security version.

Commit atomically revokes all old bindings, invalidates that principal's pending operations/session generation, retires the old online recovery key, installs the new recovery version and target manager, and increments principalSecurityVersion. Other principals are not revoked. Box ownershipEpoch does not change. A recovered owner principal remains the owner principal, but its old original root does not become active again. The independent recovery configuration must already state the owner's activated capabilities; recovery cannot create capabilities omitted from that configuration. Exact retries validate the frozen old recovery proof plus target/new-material proofs and return only the original stored ACK.

The newly imported backup key does not revoke decryption of old copied archives by old material. Recovery authority and usable data/backup decryption are separately tested and reported.

### `backup.create` and `backup.restore`

Exact args, matching the recovery/backup contract:

```
backup.create:
{scopeProfile,resourceIds,expectedRecoveryVersion,recipientKeyThumbprint,
 targetId,includeBusinessSecrets}

backup.restore:
{backupId,archiveSha256,sourceBoxKeyThumbprint,manifestSha256,
 targetDescriptorDigest,scopeProfile,resourceIds,ownerMapping,sourceId}
```

IDs/handles/profile names are tokens except backupId/digest fields, which are canonical digest32. resourceIds is a sorted unique list of 1..16 catalog resource tokens; scopeProfile must be an installed, reviewed profile. includeBusinessSecrets is boolean. expectedRecoveryVersion is positive. ownerMapping is the exact sorted, bounded `{sourcePrincipalId,targetPrincipalId,resourceIds}` array defined by the backup contract; the initial adapter accepts only its explicitly supported single-principal mapping. No user path/URL or arbitrary table/SQL selector is accepted.

Create requires current backup.create plus actual source read scope and a current, verified recovery recipient matching version/thumbprint. Restore requires current target backup.restore and destination write scope; sourceRecoveryProof is mandatory and checked using the source-authenticated archive header/key bound to the selected source pin. All other target/material proof fields are null for backup actions. The source offline key proves source eligibility only; target actor approval and current target ownership are independently required. In particular, it cannot recover or impersonate an existing target member.

Commit authorizes one durable operation, sets result.operationId=requestId and appends `backup.operation-authorized`. It returns mutation-ack, not a claim that encryption/restoration has finished. The root worker executes the fixed reviewed resource plan through the same authority's restricted operation interface. No SQLite transaction remains open during filesystem, container, crypto or network work. The independent worker-permit and one-archive restore-key handoff schemas are owned by the backup contract; both bind this exact committed operation digest and current scope/versions.

The `OperationStatus` record has exactly:

```
{operationId,requestId,action,mutationDigest,attempt,stateVersion,
 state:"queued"|"running"|"completed"|"failed"|"cancelled",
 phase,errorCode:null|token,recoveryRequired:boolean,
 result:null|BackupCreateResult|BackupRestoreResult,updatedAt}
```

operationId=requestId; attempt/stateVersion are positive integers. Allowed phases are `queued`, `validating`, `awaiting_key`, `quiescing`, `snapshotting`, `encrypting`, `staged`, `applying`, `data_verified`, `publishing`, `complete`, `failed_safe`, `recovery_required`, `cancelled`. The action/phase transition table in the worker contract is restrictive; unknown phases are rejected. Only state=completed has a typed result with verified actual data/digests/durable publication; completed has errorCode=null and recoveryRequired=false. A failed partially applied restore retains the gate and recoveryRequired=true, never claims old or new data is safe to serve.

Workers update the authoritative operation through exact `(operationId,mutationDigest,expectedAttempt,expectedStateVersion)` compare-and-swap. One active attempt exists per operation. Restart resumes only the same recorded plan and filesystem evidence; an expired permit is renewed only if current actor/principal/scope still permits it. No automatic restart creates another mutation or replaces target/recipient/source. Missing providers/unsupported components fail explicitly; there is no fake completed status.

An append-only operation-event stream, in the same database/writer, records worker transitions without pretending each byte-progress update changes global authorization. Its exact event is `{schemaVersion:2,operationId,operationSequence,eventType,previousOperationEventDigest,authorizationEventDigest,attempt,stateVersion,recordedAt,body}`; eventType is `operation.started|operation.phase-changed|operation.completed|operation.failed|operation.cancelled`, and body is the exact operation-status object above. Its digest is SHA256(canonical(event)); the signed status binds that event through an additional exact envelope body `{status,operationEventDigest}` for the `operation-status` response kind. The data inside status is the object above. Completed results are immutable and retries return the stored signed completion status. Authorization/proof history and worker artifact history are distinct but linked by authorizationEventDigest and mutationDigest.

### `ownership.transfer-prepare`

Exact args:

```
{transferId:<new digest>,dataDisposition:"erase-local",
 expectedOwnerPrincipalId,scopeManifestDigest:<digest>,
 retainedIndependentBackups:true}
```

Actor belongs to the current owner principal and has `ownership.transfer`; no target/material proofs. Scope refers to an independently collected, versioned OS erasure manifest shown in the review, not arbitrary client filesystem paths. This action grants no future recipient access. It freezes the current ownership, invalidates current data sessions and unfinished admissions, and records an immutable pending transfer. No retain-data transfer or implicit export is available through this action. Independent backups are not deleted by default.

Once committed, all new data authorization and privileged enrollment/recovery on this box is denied while ownership is frozen/erase-pending. The original actor may use fresh proof to read its transfer result; exact retry returns the original freeze ACK. There is no automatic timeout/thaw or cloud-account override. A failed/missing erasure or delivery step leaves the box frozen with a resumable diagnostic state.

Only the OS verified-erasure adapter can complete the next transition, as described below. Merely restarting the runtime, clearing an application DB, seeing no bindings or receiving a signed manufacturer qualification does not increment epoch or reopen root claim.

## Fresh scoped reads and historical results

Registered clients use `POST /local-trust/v2/authenticated-challenge` with exact
body `{proof}`. The proof JWS type is exactly
`centuarai-local-ledger.auth-challenge+jws` (the dot is intentional), ES256, with
payload `{schemaVersion:2,purpose:"centuarai.local-ledger.auth-challenge",boxId,boxKeyThumbprint,ownershipEpoch,actor,clientNonce,issuedAt,expiresAt}`.
clientNonce is a fresh digest32; expiry is at most 60 seconds after issuance.
Binding actors sign with their registered access key and bind their **registered
binding epoch**, including historical bindings. Recovery actors sign with the
registered recovery signing key; ownershipEpoch may be null only for recovery
because the independent offline packet need not contain an epoch, or it must
match that principal's recorded epoch. The box first verifies the exact known
actor/key, pinned box and lifetime before allocating anything. Unknown actors,
wrong keys and invalid proofs share CHALLENGE_DENIED. This proves possession,
not current access; all later read/data/backup authorization remains unchanged.

The response is the existing signed `read-challenge` with the **current** global
context and a random server nonce. Each verified actor has an independent bound
of eight unconsumed current-boot nonces and 1,024 issuance/replay records per
60-second maximum window. Anonymous challenges occupy a separate bounded pool
and cannot consume these slots. The actor key is derived from registered
identity, never an unverified caller-chosen bucket. Identical clientNonce and
proof payload may retrieve the same unconsumed challenge body; a consumed nonce,
changed payload, or old boot is denied. Authenticated issuance tombstones persist
until their proof expires, including across restart; restarting never restores
an old nonce. Ordinary consumed anonymous nonce rows may be pruned because
absence still denies replay. The existing challenges table retains these records
under an actor-specific kind and typed context wrapper, with no parallel writer
or implicit database schema migration.

Mutation preparation uses the analogous fixed
`POST /local-trust/v2/mutations/authenticated-challenge` body `{proof}`. Its JWS
type is `centuarai-local-ledger.auth-mutation-challenge+jws`, purpose is
`centuarai.local-ledger.auth-mutation-challenge`, and its exact payload is the
authenticated read-challenge payload plus the allowlisted `action`. The client
signs this ≤60-second PoP with the registered access/recovery key. The response
is the existing `mutation-challenge` with a 300-second review window, including
the exact actor and action. The issued nonce is bound to that action as well as
the actor and checkpoint; it cannot prepare a different action. Mutation nonce
reservations and replay records are separate from read nonces: eight pending
and 1,024 retained records per registered actor, bounded by the 300-second
challenge lifetime. Anonymous compatibility requests use only their original
separate pool; filling that pool cannot block a registered actor's revocation,
recovery or explicit approval. Prepare and commit still perform their complete
current authorization, immutable payload, scope and user-proof checks.

Challenge lookups use indexes on kind, expiry and (kind, clientNonceDigest).
Expiry cleanup and consumed anonymous cleanup are separate indexed statements;
authenticated tombstones are never removed merely to free a pending slot.
The bound is 2,048 records per registered historical actor/key (1,024 for each
purpose), with at most 300 seconds retention. It is linear in retained registered
identities, not a fixed global capacity claim: the current implementation retains
historical binding and recovery identities without a lifetime numeric cap.
Anonymous callers cannot create those identities or use their reserved slots.
Long-lived fleet capacity and authenticated abuse still require deployment sizing.

For the preserved v1 request-read wire, a current same-principal manager may use
its authenticated read nonce. The server first verifies the v1 proof using that
manager's stored access key, then derives the actor from the stored binding to
consume exactly its reserved nonce. The wire contains no caller-selected actor.
Unapproved applicants retain the bounded anonymous bootstrap read path; this
compatibility rule does not create a quota or authority for an unknown device.

V2 read proof payload is exactly:

```
{schemaVersion:2,purpose:"centuarai.local-ledger.read",
 boxId,boxKeyThumbprint,ownershipEpoch,nonce,issuedAt,expiresAt,
 actor:{kind:"binding"|"recovery",principalId,bindingId:null|token,keyVersion},
 operation:"self-binding"|"principal-state"|"membership-directory"|"mutation-status"|"operation-status"|"transfer-status"|"data-effect"|"recovery-state",
 requestId:null|digest,bindingId:null|token}
```

Lifetime is at most 60 seconds; nonce is single-use. For `self-binding`, bindingId equals the actor's binding and requestId is null. For principal/recovery state and membership directory both IDs are null. For mutation/operation/transfer status and data-effect, requestId is required and bindingId is null. The server-issued read challenge supplies the current public ownership epoch even when the key was registered in an older epoch. Actor identity/key lookup uses retained history; this does not restore authority.

- **Self binding:** a known historical access key, including revoked/suspended/old-epoch devices, may prove possession and receive only its own current state. Signed body: `{bindingId,principalId,clientId,bindingOwnershipEpoch,currentContext,status,principalStatus,ownershipState,bindingRevision,principalSecurityVersion,authorizationVersion}`. No other binding or grant is disclosed. `currentContext` is the six-field current checkpoint. `status` is a current availability projection: a stored active record whose epoch, expiry or authorization chain is no longer valid projects suspended without rewriting historical records. It cannot display a time-expired binding as currently active. Unknown key and wrong signature have one denial.
- **Principal state:** only a currently active same-principal manager may read its scoped current records. Signed body: `{context,projection,projectionDigest}` where context is the six-field **global** checkpoint and projection is exactly `{principal,ownershipView,bindings,grants,recoverySummary,qualifiedOriginalOwnerRoot}`. `projectionDigest=SHA256(canonical(projection))` in base64url; it is distinct from global rosterDigest. `ownershipView` is exactly `{ownershipEpoch,state,isOwnerPrincipal,allowedOwnerActions}`; allowedOwnerActions is the sorted subset of capabilities available to this actor for owner administration. recoverySummary is exactly null or the current active PublicRecoveryConfiguration for this principal. The v2 binding/capability schema is explicit; unknown versions/capabilities block privileged UI rather than being ignored. The projection never exposes another principal's private identity list. Full event history has a separately bounded cursor contract before an endpoint is enabled.
- **Mutation status:** the authenticated original actor or a currently authorized same-principal manager may read its operation. A historical actor key can only read an operation whose stored proof matches that actor; it cannot enumerate unrelated request IDs. Signed body: `{requestId,mutationDigest,action,state:"prepared"|"committed"|"cancelled"|"expired",ack:null|compactJws}`. Unknown and unauthorized requests share one denial. Only committed has an ACK. Exact commit retries verify all frozen original proofs and return the stored ACK even if the mutation itself retired those keys; they grant no new right.
- **Membership directory:** only an active owner-principal manager with member.invite or member.revoke may read `{context,members:[{principalId,status,createdSequence,createdEventDigest}...]}`. No member device keys, private resource grants, recovery records, email or cloud identifier appears. Members are sorted by principalId and the bounded response is signed. Capacity exceeding the fixed response bound rejects new invitations until an explicit paginated-directory protocol is supported; it never emits an incomplete directory disguised as complete.
- **Recovery state:** current recovery proof or current same-principal manager with recovery.configure may read `{principalId,principalSecurityVersion,configuration:null|PublicRecoveryConfiguration}`; null means no configured recovery and is visible only to an authorized manager. No private material is returned. A retired recovery key may recover only its own previously committed operation's immutable result, not current recovery configuration.
- **Data effect:** route the original mutation requestId to the same runtime's bounded connection/task-closure effect tracker, using the exact signed effect body in [data v1](data-v1.md). operationId is that requestId. Only a **currently authorized manager** with corresponding scope may read it; historical/revoked keys cannot read dynamic closure status. An absent effect provider reports unknown rather than success. This returns bounded effect counts/status, not another device's session identities or content. A ledger ACK is not proof that every connection has closed. This read is the explicit response-type exception: it returns data-v1 signed envelope kind `effect`, with its fixed data-response JWS type and millisecond fields. The client selects that verifier from operation=data-effect; it never guesses an algorithm or verifier from incoming metadata.
- **Operation status:** current original-actor authority or a current same-principal manager with the corresponding backup capability may read the exact backup job status defined below. Historical actor keys retrieve only the immutable mutation ACK, not current backup artifacts or job data. No parallel bearer authentication or job writer is introduced.
- **Transfer status:** only the exact original freeze actor, using its retained access key and a fresh nonce, may read its own committed ownership.transfer-prepare request. This narrow audit read remains available after freeze, revocation and redelivery; it never grants current authority or exposes a new owner or claim secret. Signed kind/body is `transfer-status` / `{requestId,transferId,state:"frozen"|"erase_pending"|"redelivery_ready",sourceOwnershipEpoch,checkpoint:{context,eventDigest,authorizationVersion},updatedAt,resetEvidenceDigest:null|digest,preparedDeliveryDigest:null|digest}`. The checkpoint and updatedAt come from the archived signed freeze/erase-started/redelivery-ready event, never a later owner's current snapshot. The first two states have context.ownershipEpoch=sourceOwnershipEpoch; ready has sourceOwnershipEpoch+1. resetEvidenceDigest is null only for frozen; preparedDeliveryDigest is non-null only for ready. The response envelope issuedAt is the current fresh-read time. A missing trusted OS completion or diagnosis leaves the last proven state; no fabricated success or failure is inferred from timeout. Another manager/principal/request or an old nonce cannot use this exception.

`outcome_unknown` is a client-side transport state, never a fabricated server terminal state. Timeout does not erase the prepared transaction, generate another recovery packet or imply failure. Clients retain the original complete proof set encrypted and query or precisely retry it.

Preserved v1 use-request retries return the original signed pending receipt. Only fresh authenticated reads expose a later pending/approved/cancelled/expired state. Historical root/binding ACKs are labeled historical. The UI must perform fresh self-binding/current authorization checks before displaying a restored device as active; an old root exact-retry ACK cannot undo revocation.

## Single-runtime data authorization view

V2 admission requires the box-side persistent `local-trust-required` policy described by [data v1](data-v1.md). It is a forward-only security floor, not a desktop association flag or ordinary configurable fallback. Compatible deployment/runtime guards must remember this floor outside restorable business data as well as in the ledger. If the ledger is missing, corrupt or unavailable, the protected box remains data-denied; it does not infer that old SSO is allowed. A locked/restarted client with no remembered association, cloud re-login, account recovery or an old ACK cannot lower it. Migration is enabled only with compatible native/gateway gates; migrating storage alone does not establish that all data entry points are protected. Runtime/deployment capability checks fail closed before exposing either old or new listeners.

The existing authority instance exposes synchronous `get_authorization(binding_id, now)` to the in-process bounded executor/data service. It runs a consistent current-state read under the authority's transaction/connection discipline. It accepts no user-supplied roster, caller capabilities, principal mapping or cloud grant and never issues a management mutation.

Success returns a detached read-only value with exactly:

```
{boxId,boxKeyThumbprint,ownershipEpoch,rosterVersion,rosterDigest,policyVersion,
 authorizationVersion,bindingId,bindingRevision,principalId,principalSecurityVersion,
 clientId,accessKey,status,principalStatus,ownershipState,grants,expiresAt}
```

Success requires ownershipState=owned, current epoch, active principal and binding, valid independent source chain and nonempty effective data grants. Invalid/revoked/suspended/frozen authority produces a fixed denial, never a permissive `allow` fallback. `grants` is the current actual v1 resource/action projection, not delegableGrants. `expiresAt` is the earliest finite boundary among the binding, active contributing principal/resource grants and source-chain lifetimes, or null when all are unlimited. At that boundary the data service obtains a fresh view; it may lose expired scope, never continue with an old superset.

Data sessions capture epoch, authorizationVersion, principalSecurityVersion and bindingRevision. They recheck through this same authority at the data contract's bounded interval and on mutations; a mutation ACK is not an access token. Resource/app mapping must use this immutable local principal ID. Failure, unsupported view version or clock rollback denies access without restarting old SSO as a fallback.

## Typed append-only events and transaction rules

Every v2 security event has exactly:

```
{schemaVersion:2,eventId,sequence,eventType,previousEventDigest,
 ownershipEpoch,requestId:null|digest,mutationDigest:null|digest,
 actor:null|Actor,effectsDigest:null|digest,
 authorizationVersion,policyVersion,committedAt,rosterDigest,body}
```

`eventType` is an explicit allowlist: `schema.migrated`, `root.established`, `binding.use-added`, `owner-policy.activated`, `binding.manager-added`, `principal.invited`, `binding.revoked`, `binding.descendants-reviewed`, `principal.revoked`, `recovery.configured`, `recovery.rotated`, `principal.recovered`, `backup.operation-authorized`, `ownership.transfer-frozen`, `ownership.erase-started`, `ownership.redelivery-ready`. Unknown types cannot be ignored during replay.

The exact body schemas are:

| Event type | Exact body |
| --- | --- |
| `schema.migrated` | The migration-anchor object defined below |
| `root.established` | `{rootPayload,accessProof,approvalProof,secretProof,provisioningRecordDigest,delta}` |
| `binding.use-added` | `{requestProof,approvalProof,delta}` using complete compact v1 proofs |
| Owner-policy/manager/member/revoke/review/recovery/backup-authorization/transfer-freeze mutation events | `{mutation,proofs,delta}`; proofs is the exact five-field commit body and mutation is the matching canonical decoded payload |
| `ownership.erase-started` | `{transferId,resetEvidenceDigest,scopeManifestDigest,delta}` |
| `ownership.redelivery-ready` | `{transferId,resetEvidenceDigest,scopeManifestDigest,preparedDeliveryDigest,newProvisioning,delta}` |

`delta` is exactly `{principals:[LocalPrincipal...],bindings:[InternalBinding...],grants:[ResourceGrant...],recoveryConfigurations:[PublicRecoveryConfiguration...],ownership:null|BoxOwnership,retiredSigningKeyThumbprints:[digest...],invalidatedRequestIds:[digest...]}`. Record arrays contain the complete post-event values for changed stable IDs, sorted by ID; absent records mean unchanged, never delete. Retired principal/binding/key records remain in the reconstructed state. Event-type handlers specify the permitted status/version/scope transitions above and replay the operation against the predecessor state: the handler's computed delta must exactly equal the stored delta. An otherwise well-formed arbitrary projection replacement is rejected. Network callers never submit delta as a write command.

Event type must match mutation action exactly: `owner-policy.activate-v2 -> owner-policy.activated`, `device.add-manager -> binding.manager-added`, `principal.invite -> principal.invited`, `device.revoke -> binding.revoked`, `device.review-descendants -> binding.descendants-reviewed`, `principal.revoke -> principal.revoked`, `recovery.setup -> recovery.configured`, `recovery.rotate -> recovery.rotated`, `recovery.recover -> principal.recovered`, `backup.create|backup.restore -> backup.operation-authorized`, `ownership.transfer-prepare -> ownership.transfer-frozen`. No unknown mapping, generic patch or role-derived fallback is permitted.

`newProvisioning` is exactly `{provisioningId,ownershipEpoch,boxKeyThumbprint,tlsSpkiSha256,credentialCommitment}`. The commitment is `SHA256(canonical({purpose:"centuarai.local-ledger.claim-verifier-commitment",provisioningId,ownershipEpoch,verifierDigest}))` in base64url, where verifierDigest is SHA-256 of the sensitive HS256 verification key. The key itself is kept only in protected current-credential storage, excluded from public snapshots/events. It is retired on root commit and never regenerated from the old bundle. Root proof retention does not claim the consumed HS key remains available for future re-verification; its accepted one-time credential check is anchored by the original box commit, while both retained client PoPs remain independently verifiable.

`eventDigest=SHA256(canonical(event))` in base64url. Full proof material is private audit evidence, not included in public roster reads or ordinary business backups. Per-principal proof access follows the same scoped read rules.

Events, projections, source edges, version advances, challenge consumption, original receipts and ACK are committed once in one SQLite transaction. The final signed ACK binds the eventDigest and resulting checkpoint; the event excludes the ACK signature to avoid recursion. ACK bytes are stored and never regenerated on retries. Startup replays/validates event types, sequence, previous digest, signed checkpoint/ACK and reconstructed projection equality. Index rows, key history and grant/source edges must match replayed state; a correct top-level hash alone does not excuse inconsistent indexes.

The preserved v1 binding-ACK format has no eventDigest field. For v2 root/use commits only, keep that exact public ACK and additionally persist a v2 signed `checkpoint` response with exact body `{context,eventDigest,authorizationVersion}` in the same transaction. Startup requires both signatures and their identical resulting context. The additional checkpoint is private replay evidence; it does not silently change the existing v1 ACK schema.

One runtime generation is shared by every connection/worker. Exclusive runtime locking prevents competing supervisors; retired generations remain fenced. Restart expires unfinished work but never lowers the persisted clock high-water mark. Expected proof/authorization failures retain clock/expiry maintenance without retaining partial authority changes. Disk/transaction failures cannot return success. History and approved ACKs are permanent; bounded expired/cancelled request retention cannot delete key revocation or committed recovery/ownership evidence.

## Atomic v1 to v2 migration

Migration accepts only the exact reviewed v1 schema, including the immutable `receipt` column. Older/partial draft schemas require explicit separate handling; never guess their meaning. Validate private path/inode permissions, the initialized seal, immutable bundle digest and box-key match before opening the source. Run SQLite integrity checks and acquire the sole writer transaction before inspecting or creating v2 state.

Before any migration write, validate all of the following:

1. **Source identity/state:** metadata matches immutable v1 box identity, initial epoch/provisioning/grants and seal; durable clock is a valid safe integer; recoveryConfigured=false. Missing DB/seal or a cloud/application DB is rejected.
2. **Complete event chain:** contiguous sequence from 1, exact canonical v1 event payloads, exact previous digests and event digests, valid stored box binding-ACK signatures. Each ACK matches its event's request ID/digest, binding/principal/client/role/key, epoch, policy, version, roster digest and commit time.
3. **Incremental roster reconstruction:** replay each v1 binding-commit in order. Check the canonical sorted binding-array digest at **every** event against the signed ACK, not only the final hash. No client/key/binding/principal conflicts or unexplained deletion/replacement. The final replayed bindings and key-purpose index equal the stored tables and metadata exactly.
4. **Root proof:** the first event is the sole root, its saved access proof has the strict first-root schema and valid access PoP, its approval key is distinct and fixed by that same signed payload, and its request digest matches the ACK/event. The root payload/grants match the independently provisioned source. V1 stores only the root access proof, so migration does not falsely claim to reconstruct the discarded first-root approval/secret proofs; the original box-signed committed checkpoint is required evidence that v1 completed them. No such evidence means deny, not infer ownership from a row.
5. **Use admission evidence:** every non-root binding comes from its exact saved evidence-v1 applicant JWS, decoded approval payload/public key and matching approved row/ACK. Verify the retained applicant signature. V1 did **not** retain the manager's approval compact JWS: migration cannot reverify that discarded user signature. Require the v1 history to have exactly one manager, the independently anchored first-root manager; every decoded approval must name that root binding/key/version and match its request digest. Validate root establishment, predecessor checkpoint, original approval/commit times, scope and lifetime against the reconstructed predecessor roster. The signed box ACK and uniquely reconstructible root lineage are the historical trust anchor that v1 accepted the missing approval signature, not a newly invented proof. Any additional manager, inconsistent approver/key or ambiguous lineage rejects migration. Do not evaluate approved historical evidence against today's wall clock. Reconstruct actual grants from the signed applicant request and the unique root source; never infer data grants from empty use delegableGrants. V2 stores the complete mutation/target/material proof set and its digests so future migrations can reverify signatures that v1 discarded.
6. **Pending/terminal evidence:** validate saved applicant proof/value/digest identity and the original immutable pending receipt. Its signed receipt describes initial submission only, not current terminal state. Existing cancelled/expired state stays terminal. Pending requests/challenges/prepared work expire at migration; they do not authorize v2 operations. Approved responses remain byte-for-byte available for historical exact retries.
7. **Unclaimed source:** zero events, bindings and principals, initial empty roster digest and unconsumed matching provisioning verification key are required. This case is allowed only for an already sealed OS-provisioned v1 authority, not a newly created empty SQLite file. Preserve credential provenance; do not manufacture a factory-clean claim.

Migration creates v2 tables/projections, a single `schema.migrated` event/checkpoint and schema-version marker inside the same `BEGIN IMMEDIATE` transaction. `PRAGMA user_version=2` and all projection/event writes commit atomically. An exception or process termination before commit leaves the entire v1 schema usable; a completed v2 migration is never written again. No two-database swap or post-commit best-effort event append is allowed.

The migration event body binds `{fromSchema:1,toSchema:2,bootstrapBundleDigest,
 sourceSchemaDigest,sourceCheckpoint:{ownershipEpoch,rosterVersion,rosterDigest,eventDigest},
 sourceEvidenceDigest,sourceClockHighWater}`. `sourceEvidenceDigest` commits to sorted immutable v1 rows and signed evidence retained for verification, excluding secret values (use a domain-separated commitment to the source credential identity). Retain legacy evidence read-only under an explicit archive schema; v2 replay starts from the verified migration anchor. The migration sequence is old rosterVersion+1, so pinned v1 clients see a forward checkpoint. All actual grants/lifetimes remain unchanged.

For a claimed source, the unique independently signed root establishes ownerPrincipalId/originalOwnerBindingId. Principal security version and binding revisions begin at 1. Effective capabilities migrate to `device.approve_use` only where v1 explicitly had canApproveUseDevices; other capabilities are empty. Recovery version is zero. The one-time owner-policy activation, not migration, authorizes new administrative powers.

Migration updates no business principal mapping automatically, enables no data-plane bypass and restores no consumed credential. Business backup restore may not overwrite this schema marker, events, tombstones or current checkpoint. A file-system/disk snapshot rollback outside the process remains outside the software-only guarantee; clients compare retained checkpoints and fail closed on regression/conflict.

## OS erasure and new-epoch handoff

Ownership freeze is a committed local user mutation, not an OS erase receipt. The privileged OS adapter authenticates the existing pending transfer and independently verifies the signed, complete full-erase journal, scope manifest, stop-writer isolation, preserved security history and current empty data roots. Identity-only reset, legacy retained data, incomplete erase and unrecognized layouts are rejected.

The OS adapter calls the **same running authority's** private operation path; it does not edit SQLite or use a second store writer. Its input is an opaque verified evidence handle/path loaded under protected local IPC/root-peer checks and reparsed by the trusted adapter, not an HTTP boolean or arbitrary caller assertion. The public mutation route cannot invoke this path. A deployment operator's ability to change system software remains a separate threat boundary.

Private operations are:

- `mark_erase_started(transferId, verifiedResetPlan, now)`: match the frozen epoch/scope and append `ownership.erase-started`; remain data-denied.
- `complete_verified_redelivery(transferId, verifiedEraseEvidence, preparedDelivery, now)`: revalidate the full erase chain and freshly persisted protected delivery candidate; consume the pending transfer exactly once, retire prior owner/principal/binding/recovery authority, invalidate all sessions/pending operations, increment ownershipEpoch by one and append `ownership.redelivery-ready` with a new provisioningId/credential generation. Existing event/key history is retained. New owner and root remain unset until the separate first-root protocol completes.

`preparedDelivery` is generated only after erase verification and contains fresh 32-byte random claim material, independent protected delivery and a verifier for the new epoch. Its proof/packet/evidence digests and generation are bound to the redelivery event; secret bytes never appear in events, ACKs or public endpoints. If material generation, protected delivery persistence or the authority transaction fails, no unclaimed_ready state is published and old packet verification material is not reactivated. Exact interrupted retries refer to the same candidate/transfer; they cannot replace recipient keys or revive an old label.

The original immutable bundle stays an origin anchor. New credential generations have their own immutable protected provisioning record, validated against the signed redelivery event and current ledger. Runtime never recreates a missing ledger from either bundle. Installing a fresh application image or restoring a business backup does not reset ownership.

## Required rejection and concurrency tests

- V1 corruption at any event/ACK/request/index/root grant, unknown schema, missing seal, partial migration, concurrent migration/start and interrupted migration all fail without partial v2 authority.
- Basic v1 root migration gains no new capability; owner-policy activation requires the original currently active root approval key, exact explicit capability review and one-time CAS.
- Same-principal manager dual-PoP; access/approval key substitution, historical reuse, cross-principal targeting, finite-to-unlimited authority and unselected capabilities fail.
- Owner invitation creates a fresh principal only; existing member IDs/cloud aliases and another principal's private resources fail. Scoped reads never expose a different member's device/backup/recovery records.
- Revoke versus approve, two mutual revocations, last-manager cascade, independent descendant review and cyclic review are arbitrated by separate SQLite connections in one transaction.
- Recovery setup without reimport, old/rotated recovery material, changed target keys, wrong principal security version and interrupted rotation fail without consuming the currently valid path. Successful recovery revokes only the intended principal and returns the identical ACK after receipt loss.
- Historical root/approval/mutation ACKs never become current authorization; revoked devices can read only their own current status using fresh proof. Replayed proposals cannot query dynamic state.
- Data authorization reads use the one authority instance and current actual grants; principal revocation, recovery, freeze, expiry, restart and clock rollback deny stale sessions without old SSO fallback.
- Transfer prepare without complete verified erase never opens first root. Identity-only reset, old factory labels, missing delivery material, changed transfer scope and old checkpoint restore cannot admit a new owner over retained data.

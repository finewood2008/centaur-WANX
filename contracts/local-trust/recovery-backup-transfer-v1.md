# Recovery, encrypted backup and erasing transfer v1

Status: implementation contract, 2026-10-26. This defines the implementation and acceptance requirements; it is not a claim that recovery, encrypted backup, transfer or local data-plane enforcement has shipped.

This extends [management-v1](management-v1.md). The shared mutation, capability, preview and transaction schemas belong to [ledger-v2](ledger-v2.md); the two documents must be reconciled before implementation is connected to runtime. Evidence-v1 signatures remain unchanged.

## 1. Scope, owners and dependencies

The delivered paths must be operable: recover management of an existing box; create an encrypted backup of real business data and restore it to an independently initialized replacement box; transfer a box after verified erasure of previous private data.

- Ledger: recovery configuration/version, principal security version, operation admission, events and exact receipts. It does not execute filesystem commands.
- Client: independent material generation, protected export/re-import, immutable reviews and per-operation approval-key unlocking. Renderer flags, paths or arbitrary signing payloads do not establish authority.
- OS worker: fixed resource profiles, writer isolation, snapshots, strict container parsing, staging, durable restore/erase journals and restricted filesystem operations.
- Existing cloud reset permits remain a separate prerequisite where the reset executor requires them. They cannot replace local owner authorization. No default remotely initiated destructive operation is added.
- Existing-user migration remains separate. Missing databases, old factory markers, empty folders, identity-only reset and cloud login cannot create a local owner or recovery key.
- Recovery/revocation against business HTTP, WebSocket, downloads, tasks and application sessions depends on local data-plane admission. Until old cloud/SSO and stale security versions are rejected there, report management recovery separately; do not claim all old data sessions were revoked.

Acceptance uses real temporary files, SQLite databases, encrypted archives, independent identities, signed HTTPS requests, crash injection and restart checks. JSON round trips alone do not establish data recovery. Development does not provision, erase, transfer or restore production boxes.

## 2. Encoding and current authority

Use existing exact schemas, strict ASCII canonical JSON, safe integers, unpadded base64url and ES256 JWS. A digest is base64url SHA-256 of the specified bytes; a random ID is 32 independently random bytes. Times are integer Unix seconds from the execution-time trusted clock.

`BoxDescriptor` is exactly `{boxId,baseUrl,boxKey,tlsSpkiSha256}`, using management-v1's HTTPS-origin and P-256 rules. Source pins come from protected recovery material or an already trusted association, never from an archive alone.

- `ownershipEpoch` changes only across verified whole-box ownership handover.
- `principalSecurityVersion` invalidates one principal's old devices/sessions on recovery. It does not silently impersonate or invalidate another member.
- `recoveryVersion` starts at zero, advances exactly once on setup/rotation/recovery, and is not restored from business backup.
- Roster/event checkpoints advance on committed security changes and bind approval previews.

An immutable provisioning bundle attests bootstrap origin, not current mutable state. Startup must validate the sealed ledger/event chain without resetting versions to the bundle or rejecting a legitimate new epoch solely because the bootstrap bundle was older.

Capabilities `recovery.configure`, `backup.create`, `backup.restore`, and `ownership.transfer` require explicit resource scope. `manage` alone grants none of them. V1 migration preserves only existing `device.approve_use`; the original owner root explicitly approves `owner-policy.activate-v2` to activate additional capabilities without enlarging resources. Ledger-v2 defines eligibility and the exact activation proof.

## 3. Independent offline recovery material

Generate two unrelated key pairs using the cryptographic library:

1. P-256, exclusively for recovery authorization signatures.
2. RSA 3072-bit, exponent 65537, exclusively for decrypting wrapped backup data keys. Public JWK is exactly `{kty:"RSA",n,e}`: `n` is a minimal unsigned 384-byte integer with top bit set; `e` is `AQAB`. Do not reuse the evidence-v1 P-256 validator for this key.

RSA wrapping is OAEP with SHA-256 for both OAEP and MGF1. Each archive gets a fresh random 32-byte AES-256-GCM data key. Recovery signing, backup decryption, device access/approval, claim secrets, TLS and box signing keys are distinct. Use library primitives and explicit parameters, not handwritten RSA/padding. [Python RSA documentation](https://cryptography.io/en/latest/hazmat/primitives/asymmetric/rsa/), [Node crypto documentation](https://nodejs.org/api/crypto.html)

`NewRecovery` is exactly:

```text
{recoveryId,version,signingKey:<P-256 public JWK>,backupKey:<RSA public JWK>}
```

The ledger's `PublicRecoveryConfiguration` is exactly:

```text
{principalId,recoveryId,version,status:"active"|"retired",
 signingKey,backupKey,grants,delegableGrants,capabilities,
 expiresAt:null|positiveInt,delegationExpiresAt:null|positiveInt,
 establishedAt,establishedSequence,retiredAtSequence:null|positiveInt}
```

Grant lists use evidence-v1's sorted resource/action schema; capabilities use ledger-v2's fixed list. Setup/rotation explicitly establish a recovery authority ceiling no broader or longer-lived than the approving binding's effective authority and the principal's independent ceiling. `delegableGrants` is a subset of grants; finite source/binding/delegation limits cannot become unlimited. The signed effects include `recoveryBefore` and `recoveryAfter`, using this exact public shape minus commit-derived `establishedAt`/`establishedSequence`/`retiredAtSequence`. Unused values are null. Commit derives those fields from actual trusted time/event sequence. Old configuration records are retained as retired history.

Recovery is limited to the intersection of the stored recovery ceiling and the principal's current valid ceiling, including capabilities, data grants, delegation and expiry. An old offline key does not silently acquire capabilities activated after it was configured. The recovered target and next recovery configuration cannot exceed this intersection. A later active manager may explicitly approve a larger rotated recovery ceiling only within that manager's own current authority.

Protected material file, maximum 16 KiB:

```text
{schemaVersion:1,type:"centuarai-recovery-material",
 materialId,recoveryVersion,principalId,source:<BoxDescriptor>,createdAt,
 recoverySigningPrivateKey:<base64url PKCS8 DER>,
 backupDecryptPrivateKey:<base64url PKCS8 DER>}
```

`materialId` equals `NewRecovery.recoveryId`. Both private keys must parse as the specified algorithms; derived public keys must reproduce `NewRecovery`. No account password, phone, short code, DeviceKey or user identifier derives either key. This file contains full recovery/decryption power and requires explicit user export; it is not a routine settings backup.

Every setup, rotation and recovery uses a fresh material ID and two newly generated key pairs. Reject previously registered signing or backup-encryption key thumbprints, including retired versions. Keeping the old RSA recipient while changing only the signing key does not satisfy rotation: old decrypting material would still unlock new archives.

The authority stores public keys, identifiers/versions and protocol metadata, never either private key or a symmetric equivalent that can sign as the user or decrypt backups. A backup target receives only ciphertext and public metadata.

### Export and actual re-import

Client states: `draft_generated → exported → reimport_verified → commit_unknown → committed`. Cancellation is possible before submission. Export alone does not set `recoveryConfigured=true`.

1. Main uses a native save dialog or equivalent controlled file handle, exclusive creation and restrictive permissions. Renderer passes only material/review handles, not arbitrary filesystem paths or URLs. A failed export may retry the same material until success. After a successful save, another copy requires actual re-import of that saved material; keeping a permanent plaintext cache is not an export-retry mechanism.
2. After export, release generation-time private-key references. Normal snapshots, logs, telemetry, crash text, clipboard history, cloud sync and persistent profile state contain no material secrets. A dedicated transient presentation may display material only for that operation.
3. A separate native open dialog reads the saved file. Validate size/schema, expected source pins/principal/ID/next version, both private-to-public correspondences, and an RSA-OAEP encrypt/decrypt round trip with fresh bytes. An incomplete/wrong file or renderer `saved:true` fails.
4. Only keys obtained from this successful re-import produce the new material proof. It signs the complete immutable mutation. The existing approval key is separately unlocked for the configuration operation.
5. Lock, close, navigation, suspend or crash invalidates precommit handles. Uncommitted exported files remain user-controlled but have no active online recovery qualification. Failed/cancelled drafts preserve the prior configuration. Memory cleanup is best effort, not a claim of physical RAM erasure.
6. If commit may have succeeded, resolve the same request using exact proof retry and authenticated status. Do not rotate, regenerate or discard material because a reply was lost.

UI distinguishes exported, verified, committed configuration, recovered management identity, and actually restored business data.

## 4. Recovery API and atomic effects

Use `/local-trust/v2` and ledger-v2's common mutation payload: current checkpoint, request ID, challenge, actor, action, exact args, time bounds and `effectsDigest`.

- `POST /mutations/challenge` takes `{actor,action}` and returns a signed fresh challenge/checkpoint.
- `POST /mutations/prepare` takes `{prepareProof}`. Preparation uses the same common fields with the prepare purpose and without `effectsDigest`; a binding uses its access key and a recovery actor its current offline signing key. Return signed `{mutation,effects}`.
- `POST /mutations/commit` takes exactly `{mutationProof,targetAccessProof,targetApprovalProof,recoveryMaterialProof,sourceRecoveryProof}`; unused slots are `null`.
- Fresh authenticated read provides operation status and stored results. Submission replay cannot reveal later state.

Ledger-v2 owns these exact shared schemas and proof type strings. Binding mutation proof uses the independent approval key; recovery mutation proof uses the current recovery key. Target access/approval proofs and new recovery-material proof each sign the same complete mutation. The source recovery proof used by backup restore has fixed type `centuarai-local-ledger-source-recovery+jws` and also signs that complete mutation.

Recovery preparation proves current offline-key possession before returning principal-specific configuration/effects. Unknown principals/material IDs, wrong versions and invalid keys have the same external denial; anonymous endpoints do not enumerate configurations.

| Action | Exact args | Required qualification |
| --- | --- | --- |
| `recovery.setup` | `{expectedRecoveryVersion:0,newRecovery}` | Binding with `recovery.configure`, new material proof; next version 1 |
| `recovery.rotate` | `{expectedRecoveryVersion,newRecovery}` | Binding with `recovery.configure`, new material proof; next version current + 1 |
| `recovery.recover` | `{expectedRecoveryVersion,expectedPrincipalSecurityVersion,newRecovery,target}` | Current recovery actor, target access/approval proofs and next material proof |

`target` is exactly `{clientId,accessKey,approvalKey,keyProtection:"software-passphrase-v1"}`. Keys are distinct and unused in historical key registry. Principal is the current recovery actor's principal, never a substituted cloud account or another member.

Recovered grants/capabilities come from the stored recovery ceiling intersected with that principal's currently effective explicit authority. Do not restore old grants from a backup or derive power from `manage`. Effects display exact resulting grants/capabilities/lifetimes, both public recovery configurations, invalidated old bindings and next security/recovery versions; the canonical effects digest is signed by all required proofs.

One `BEGIN IMMEDIATE` rechecks qualification, current policy/checkpoint, challenge/time, versions, key uniqueness and proofs. Setup/rotation replace public configuration and append the event/receipt. Recovery additionally invalidates that principal's old bindings, pending authorizations and session generation; creates the approved target binding; advances principal security version; installs the next recovery configuration; and stores the exact ACK. Used keys remain historical. Other principals are not reassigned.

Failure before commit neither consumes active recovery qualification nor partially installs a target. Two competing recoveries cannot both succeed. Completed retry binds the original operation/target proofs and returns the stored ACK without reactivation. Nonterminal challenges expire across service generations; committed retry and durable wall-clock high-water survive restart.

Rotation immediately invalidates old online recovery qualification. It cannot prevent holders of old backup keys from decrypting already copied old archives. New archives use current recipient and fresh data keys. An in-flight export whose recipient was superseded cannot publish as a newly completed current backup; fail or restart encryption with current qualification. Old material needed for historical archives remains explicitly user-retained, never silently deleted.

## 5. Encrypted backup format

V1 is an uncompressed streamable container, not tar/zip extraction. Existing plaintext `.tar.gz` remains a legacy format requiring explicit controlled conversion and verified replacement; enabling encryption cannot silently delete the only recoverable copy.

A `.cxb` file has exact framing:

```text
8 ASCII bytes "CXBKP1\r\n"
uint32be headerLength; canonical ASCII JSON Header
chunkCount records: uint32be ciphertextLength; ciphertext plus 16-byte GCM tag
uint32be sourceProofLength; ASCII source-proof JWS
8 ASCII bytes "CXBEND1\n"
EOF
```

No trailing bytes, duplicates, unknown fields, indefinite lengths, compression or concatenated containers. Header ≤16 KiB; source proof ≤8 KiB; chunk size exactly 1,048,576; plaintext ≤1 TiB. An implementation may advertise a smaller admission limit. Count/lengths must exactly match authenticated total size.

`Header`:

```text
{schemaVersion:1,format:"centuarai-business-backup-v1",
 backupId,sourceBoxId,sourceBoxKeyThumbprint,sourceOwnershipEpoch,
 principalId,principalSecurityVersion,recoveryId,recoveryVersion,sourceRecoverySigningKey,
 recipientKeyThumbprint,createdAt,scopeProfile,scopeDigest,
 wrapAlgorithm:"RSA-OAEP-256",wrappedDataKey,
 cipher:"A256GCM",noncePrefix,chunkSize:1048576,chunkCount,
 plaintextBytes,manifestBytes,manifestSha256}
```

RSA recipient thumbprint is RFC 7638 SHA-256 of exact public JWK. Wrapped key is 384 bytes; nonce prefix is four random bytes. OAEP label is ASCII `centuarai.backup.key.v1\n<backupId>\n<recipientKeyThumbprint>`.

Chunk `i` uses nonce `noncePrefix || uint64be(i)`. AAD is ASCII `centuarai.backup.chunk.v1\n`, raw SHA-256 of canonical Header, `uint64be(i)`, and `uint32be(plaintext chunk length)`. All but the final chunk contain exactly chunkSize plaintext bytes. Each archive, including restarted failed exports, uses a new random data key and prefix. Never reuse an old key/counter with different plaintext. Tags are 16 bytes; unauthenticated plaintext is never published. [Python AEAD documentation](https://cryptography.io/en/latest/hazmat/primitives/aead/)

Plaintext is `canonical Manifest || file bytes in manifest order`; `manifestBytes` gives the exact prefix size. Manifest ≤16 MiB and ≤100,000 files. Public header discloses identifiers/versions/profile/approximate sizes, not filenames or secrets.

Source proof is ES256 type `centuarai-business-backup+jws` with exact payload:

```text
{schemaVersion:1,purpose:"centuarai.business-backup",
 boxId,boxKeyThumbprint,backupId,headerSha256,ciphertextSha256,
 ciphertextBytes,manifestSha256,scopeDigest,createdAt}
```

Ciphertext digest/count covers concatenated chunk length prefixes and encrypted records, excluding footer. Verify against the source key already pinned in material/association. Recipient public-key possession cannot forge a source-authorized archive. Only the exact admitted completed snapshot can obtain this signature; no generic signing route exists.

Before restore, stream-verify all bounds, complete ciphertext digest and source signature, then decrypt into private stage and verify every tag/digest. Late authentication failure never leaves an active restored file.

### Manifest

```text
{schemaVersion:1,type:"centuarai-business-manifest",
 backupId,source:<BoxDescriptor>,principalId,
 sourceCheckpoint:{ownershipEpoch,principalSecurityVersion,rosterVersion,rosterDigest,policyVersion},
 recovery:<NewRecovery>,scopeProfile,resourceIds,scopeDigest,createdAt,
 databaseSets:[{component,driver,schemaVersion,snapshotGroup,files:[fileId]}],
 files:[{fileId,resourceId,pathUtf8,size,sha256,kind}],
 secretPolicy:"business-encrypted-host-security-excluded-v1",
 excludedSecurityState:true,quiescenceReceiptDigest}
```

Manifest recovery public configuration matches Header's recovery ID/version/recipient/signing key and is authenticated by source proof through manifest digest. The source-box-signed Header binds `sourceRecoverySigningKey` for pre-admission verification of `sourceRecoveryProof`. Full manifest/ciphertext consistency is rechecked before any restore application. This is historical source/decryption qualification, not current online recovery authority.

Arrays are deterministic and duplicate-free; resource IDs sorted; files ordered by resource ID then decoded path bytes. IDs are unique tokens. `pathUtf8` is base64url of strictly valid UTF-8 relative path, preserving actual user filenames while signed JSON remains ASCII. Reject absolute paths, NUL, backslash, empty/`.`/`..` components, duplicate paths, destination case/alias collisions, symlinks, hardlinks, devices, FIFOs and sockets. `kind` is `file|sqlite|config|business-secret|quarantined-package`; destinations are regular private files, never archive-controlled executables.

File sizes are nonnegative safe integers; their sum plus manifestBytes must equal plaintextBytes exactly. Zero-length regular files are permitted. Every database-set file ID must resolve exactly once to a declared SQLite/component file; no unreferenced database or duplicate component consistency group is silently accepted.

Database sets are complete consistency groups. SQLite must pass integrity/foreign-key/schema checks; required history marker without verified history DB fails. Files from distinct snapshot groups cannot be mixed. PostgreSQL needs an implemented consistent adapter; cross-engine/unsupported restoration is rejected before changes.

## 6. Resource and secret policy

A code-owned, versioned, tested profile maps resource IDs to fixed paths, schema adapters, allowed config keys, owner mapping and writer isolation. Neither renderer nor archive supplies absolute paths.

| Component | Current business source | Required adapter |
| --- | --- | --- |
| WANX | `/var/lib/centuarai/wanx/.octop/octop.db`, history_v2 SQLite/marker, registered workspaces, user/agent files and knowledge | Known SQLite schema plus history group; configured workspaces constrained to approved roots |
| WANX configuration/packages | Selected business config, skill/plugin/application contents under WANX business root | Key allowlist; executable packages and outbound automation restored inactive/quarantined |
| Zhijun | `/var/lib/centuarai/zhijun` | Named component DB/config/consistency adapter; opaque directory copy is insufficient |
| Semantica | `/var/lib/centauros/semantica/data` | Named component consistency adapter; omitted model caches explicitly reported as rebuildable |

Whole-box backup requires passing adapters for every installed business component. Unsupported components block whole-box admission; explicit partial-resource backup may proceed with its narrower manifest. Unknown legacy/home/custom layouts are not silently omitted.

WANX executable policy must enumerate exact schema revision and table/column allowlists. Unknown tables, triggers, virtual tables, columns or versions that could carry authority fail closed until reviewed. Policy separates:

- Business content: agents, channels, cron configuration, conversation sessions/threads/messages, published experts, knowledge, selected application content, preferences and required foreign keys. Conversation `sessions` is content, not permission to resume an authenticated session.
- Business secrets: selected provider/connector credentials and necessary decryption-key rows may be inside the authenticated encrypted archive only under explicit export approval. Restored connectors and scheduled execution remain disabled pending current policy.
- Identity: old passwords/hashes, JWT signing secret, invites, SSO state/identity mapping, browser cookies, refresh tokens, bridge leases/tokens, consumed claims and current resource authorization never return as live authority. User rows may retain inert foreign-key metadata; owner mapping is explicit, never “give everything to the first admin”.
- Security configuration: exclude installation SSO trust, host credentials and app grants. Parse config/env with allowed-key policy; copying full config/env, the full secrets table or unchanged SQLite DB is prohibited.

Sanitize an isolated snapshot, never the live source. Preserve business foreign keys without restoring old login identity. Target service credentials and application identity mapping come from current trusted bootstrap, not historical JWTs, `preserve_users=False` or archive-nominated administrator accounts.

Always exclude these paths and logical contents from business restoration:

```text
/var/lib/centauros/local-trust
/var/lib/centauros/local-trust-delivery
/var/lib/centauros/.local-trust-provisioning
/var/lib/centauros/device
/var/lib/centauros/provisioning
/var/lib/centuaros/consumer-authorization
/var/lib/centuaros/deployment
cloud-agent/remote-agent device credentials and authorization mirrors
WANX bridge auth.sqlite3, resource grants, access/session/approval keys
TLS private keys, installation credentials, recovery private material
reset/transfer/recovery consumption journals and security version floors
```

This is target allowlisting plus logical DB/content policy, not only a filename blacklist. Links, mounts, configuration paths or DB values cannot redirect restoration into security state. Local transfer does not implicitly delete a user's external backup.

The secret-filter guarantee covers application/host-managed locations, fields and recognized recovery-material formats. It does not claim to discover every secret a user manually typed into an arbitrary document. `includeBusinessSecrets=false` omits managed provider/connector secrets; it is not automatic redaction of document contents. Recognized recovery-material files and managed private keys are excluded even when business-secret export was approved, and no restored document can be consumed as authority.

## 7. Backup/restore admission and restricted worker

Use the shared ledger-v2 prepare/commit/read API. Admission creates a durable operation but still returns the common stored `mutation-ack`, with `result.operationId=requestId`; it does not claim completion. Exact submission retry returns that original ACK. Fresh `operation-status` reads report `queued|running|completed|failed|cancelled` and the typed result below. Worker completion is a separate typed job event and signed status, not a second mutation ACK.

| Action | Exact args |
| --- | --- |
| `backup.create` | `{scopeProfile,resourceIds,expectedRecoveryVersion,recipientKeyThumbprint,targetId,includeBusinessSecrets}` |
| `backup.restore` | `{backupId,archiveSha256,sourceBoxKeyThumbprint,manifestSha256,targetDescriptorDigest,scopeProfile,resourceIds,ownerMapping,sourceId}` |

`sourceId`/`targetId` are opaque handles from configured user-owned storage or controlled picker. They are not renderer paths/URLs. Resolution checks intended filesystem/device, safe ancestors, ownership, mount identity, capacity and separation from source/security/staging roots. A storage handle cannot authorize an operation.

`ownerMapping` is a sorted array of exact `{sourcePrincipalId,targetPrincipalId,resourceIds}` records, bounded by selected backup and target grants. Display it in the target review. The initial single-principal adapter refuses unsupported multi-member mappings.

Restore requires current target `backup.restore` and destination write scope, plus `sourceRecoveryProof` verified against the source-authenticated historical recovery public configuration. That historical proof alone never establishes target ownership or current online recovery qualification. The private backup key is needed separately to decrypt the archive. The review binds source fingerprint, new target pins, resource selection, secrets, owner mapping, replacement/data-loss behavior and inactive integrations.

Source registration pins a single immutable file identity under `sourceId`. A bounded inspection verifies source-proof signature and Header digest against the explicitly selected source pin before preparing the mutation. Untrusted header fields do not set current authority. The worker verifies complete archive hash, ciphertext and encrypted manifest before any application; changed or swapped source fails rather than inheriting the approved handle.

Completed `backup.create` result (`BackupCreateResult`) is exactly:

```text
{type:"backup-created",operationId,backupId,archiveSha256,manifestSha256,
 scopeProfile,resourceIds,recoveryId,recoveryVersion,recipientKeyThumbprint,
 targetId,bytes,completedAt,targetDurable:true}
```

Completed `backup.restore` result (`BackupRestoreResult`) is exactly:

```text
{type:"data-restore-completed",operationId,backupId,archiveSha256,manifestSha256,
 targetBoxId,targetDescriptorDigest,scopeProfile,resourceIds,ownerMapping,
 verifiedFiles,verifiedBytes,completedAt,securityStateUnchanged:true,
 integrationsActivated:false}
```

For noncompleted status, result is null. Failure has a fixed `errorCode`, phase, and `recoveryRequired` flag; it cannot fabricate either completion type. Ledger-v2 defines the exact common operation-status envelope and fixed job-event schemas. Event bodies bind operation/attempt/state version and the immutable approved operation digest.

After commit the authority emits type `centuarai-local-worker-operation+jws`:

```text
{schemaVersion:1,purpose:"centuarai.local-worker.operation",
 boxId,boxKeyThumbprint,operationId,action,operationDigest,
 principalId,ownershipEpoch,principalSecurityVersion,policyVersion,
 scopeDigest,issuedAt,expiresAt}
```

Action is `backup.create|backup.restore|ownership.transfer.erase`. A root-only worker uses a fixed local channel, loads the committed operation, verifies installed box key and every field. No arbitrary shell command/path list is accepted.

Before irreversible phases recheck current noncancelled operation, versions, policy, scope and live permit. Reissue an expired permit only for the same still-authorized durable operation. Lock order is fleet/operation lock then short ledger checks; no SQLite write transaction spans shutdown, copying, network or encryption. Journals bind immutable operation digest and attempt/state version; stale workers cannot complete a newer attempt.

### Bounded native backup I/O

These fixed operations are under `POST /local-trust/v2/backup-io/<operation>`.
The exact request wrapper is `{body,proof}`. The access proof type is
`centuarai-local-backup-io+jws`, signing exactly
`{schemaVersion:1,purpose:"centuarai.local-backup.io",boxId,boxKeyThumbprint,ownershipEpoch,principalSecurityVersion,nonce,issuedAt,expiresAt,actor,operation,bodySha256}`.
Use a fresh auth-v2 nonce, at most 60 seconds, and SHA256 of canonical request body.
Every call rechecks the current binding, versions, capability and scope. A handle
is never authorization; source handles also remain bound to their admitting actor.

| Operation | Exact body |
| --- | --- |
| `targets.list` | `{}` |
| `source.begin` | `{archiveBytes,archiveSha256,source:<independently pinned BoxDescriptor>}` |
| `source.append` | `{uploadId,offset,chunkBase64}` |
| `source.finalize` | `{uploadId}` |
| `source.read` | `{sourceId}` |
| `archive.read` | `{operationId,offset,length}` |
| `transfer.plan` | `{}` |

Upload/source IDs are tokens of at most 128 characters. `chunkBase64` is canonical
standard Base64, decoded chunk at most 1,048,576 bytes; archive maximum is
209,715,200 bytes. Exact append retries compare the offset, length and chunk hash,
never append twice. Conflicting/reordered offsets fail. Registries cap concurrent
handles, total reserved disk, expiry and cleanup; finalized sources remain immutable
and are fully hashed and verified against the independently pinned source proof.
The native main process owns file dialogs and streamed file reads/writes. Renderer
paths, URLs, chunks, pins invented from the archive and asserted verified digests
are not accepted.

Only `source.append` admits a 1,420,000-byte HTTP body. Other requests remain at
32 KiB; these limits do not increase ordinary management or ledger proof limits.
The exact response is `{receipt,contentBase64}`. `receipt` has type
`centuarai-local-backup-io-response+jws`, maximum 16 KiB, and exact payload
`{schemaVersion:1,purpose:"centuarai.local-backup.io-response",boxId,boxKeyThumbprint,operation,nonce,requestBodySha256,issuedAt,body}`.
`contentBase64` is null except for archive ranges, whose canonical standard Base64
bytes are bound by the receipt hash and length. The client verifies the small
receipt before exposing bytes. Archive response maximum is 1,420,000 bytes;
nonrange responses are at most 32 KiB.

Response `body` is exactly:

| Operation | Body |
| --- | --- |
| `targets.list` | `{type:"backup-targets",targets:[{targetId:"local-managed",kind:"local-managed",durability:"same-box",scopeProfiles:<sorted authorized known profiles>,resourceIds:<sorted union of those profiles>,maxArchiveBytes:209715200}]}` |
| `source.begin` | `{type:"backup-source-upload",uploadId,offset:0,chunkMaxBytes:1048576,archiveMaxBytes:209715200,expiresAt}` |
| `source.append` | `{type:"backup-source-upload-progress",uploadId,offset,expiresAt}` |
| `source.finalize`, `source.read` | `{type:"backup-source",sourceId,archiveBytes,archiveSha256,source:<BoxDescriptor>,header:<Header>,sourceProof,expiresAt}` |
| `archive.read` | `{type:"backup-archive-range",operationId,backupId,archiveSha256,offset,length,totalBytes,contentSha256,eof}` |
| `transfer.plan` | `{type:"ownership-transfer-plan",scopeManifestDigest,resetPlanDigest,dataDisposition:"erase-local",retainedIndependentBackups:true,scope}` |

Unavailable/ungranted targets yield an empty target list. Archive ranges require
a completed create operation belonging to the current principal plus current read
scope over the actual job resource; knowing an operation ID does not permit download.
Native download completes only after the saved file's total length/hash match.
`targetDurable:true` for `local-managed` means fsynced **same-box** storage, not an
off-box copy. Native export success is a separate verified UI state.

`transfer.plan` requires current transfer capability and is derived from trusted
OS inventory, including root-private plaintext staging, source uploads and local
encrypted backup caches. The signed scope digest is passed unchanged to the
transfer mutation; prepare/commit revalidate the exact plan. The renderer cannot
construct the erase scope.

`scope` is exactly `{resourceRoots,cacheRoots,preservedSecurityRoots,affectedPrincipals,affectedBindings,retainedExternalBackups:true}`.
The three nonempty path arrays are individually ASCII-sorted and unique, at most
64 paths in total; each path is absolute ASCII, at most 256 characters, with no
empty/dot/dot-dot component or trailing slash. Counts include retained records
from the current ownership generation, because revoked members' data may remain.
The digest is SHA256 of canonical
`{purpose:"centuarai.local-ledger.transfer-scope",resetPlanDigest,scope}`.
The OS reset plan digest includes its actual inventory, fixed erase intent and
the authority boot at review. Cache roots include the gateway's
`/var/lib/centauros/local-trust/data-staging` as well as worker staging, uploads
and encrypted archives. A preserved authority directory means its security
metadata only, explicitly excluding these listed cache descendants. The stable
`operation-worker.lock` inode is preserved nonsecret exclusion metadata.
Changing scope or affected counts requires a new signed review.

The implemented fixed profile mapping is:

| Profile | Exact resource IDs | Included data |
| --- | --- | --- |
| `semantica-private-v1` | `["semantica"]` | Schema 11 known business rows and referenced originals/derived files for the current private workspace; runtime jobs normalized; security, confirmation and integration receipts excluded |
| `wanx-personal-v1` | `["clipboard","space:personal"]` | The current principal's independent personal-space index/known objects and clipboard business database; main schema-31 identity mapping is read only and never archived; authorization, sync, upload and request receipts excluded |

Advertise only configured profiles whose entire resource set is currently
authorized; the client selects one fixed mapping, not arbitrary resource unions.
Both require `includeBusinessSecrets:false`. Unknown schema, external object
locations or unreviewed layouts fail. Restore accepts only an empty current
principal workspace/namespace, preserves other principals and keeps authority,
main identity tables and installation configuration intact. The two WANX
business databases use one ATTACH transaction under the publication guard.
These profiles do not implement whole-box restore. Prepare binds the capacity policy:
maximum plaintext is 198 MiB, including manifest; framing/header/footer/tag overhead
is reserved, and the writer still requires final archive at most 200 MiB.

Before any `source.begin`, the native client authenticates the complete local
archive: exact magic/canonical header, all frame sizes, terminal framing,
independently pinned source proof, ciphertext digest and complete file digest.
It matches the reimported offline material and unwraps the archive key locally.
Selecting a recovery JSON/PEM or corrupt ciphertext must produce zero upload
calls. A file extension, stat result or caller-supplied digest is insufficient.

### Single-archive key handoff

`POST /operations/restore-key` takes exactly `{operationId,archiveSha256,dataKey,proof}` over the pinned management HTTPS connection. `dataKey` is base64url 32 bytes; no private recovery key is accepted. Use a fresh `/auth/challenge` nonce. The access-key proof type is `centuarai-local-restore-key+jws` and exact payload:

```text
{schemaVersion:1,purpose:"centuarai.local-restore.key",
 boxId,boxKeyThumbprint,ownershipEpoch,principalSecurityVersion,
 operationId,archiveSha256,dataKeySha256,nonce,issuedAt,expiresAt,actor}
```

Actor is the original still-active binding authorized for that restore, not an arbitrary manager; lifetime is at most 60 seconds. Verify the current admitted operation, actor/capability/scope/versions, one-use nonce and hash of supplied key before passing it to the fixed worker channel. Response is a signed `restore-key-received` body `{operationId,archiveSha256,receivedAt}`; this is not a restore completion or durable-key-retention promise. Body logging is disabled.

The worker retains only this archive key in transient memory. It does not persist it in the authority, journal, event, configuration or general vault. After a crash before a fully verified stage exists, status reports `awaiting_key` as the running phase and the same operation requires a fresh authenticated key handoff. A completed verified stage may resume from its durable file/manifest evidence without retaining the key. Wrong keys fail staging and do not change active data.

### Snapshot

1. Acquire operation/resource gates; stop and drain participating tasks, processes, DB writers and containers. Inspect open files/mappings and known legacy writers. A backup mutex or SQLite online copy alone is not cross-file consistency.
2. Within quiescence, snapshot history child archives before parent registry using SQLite backup APIs, then files; sanitize independent DB/config copies. Live WAL files are not copied as ordinary files.
3. Build and verify manifest/checkpoint. Undeclared omissions, changing files, unsupported external workspaces, low space or returning writers fail the snapshot.
4. Encrypt with fresh archive key into private temporary target file. Sign actual final digests; recheck current recipient/version and admitted authority before publication.
5. Fsync file, publish atomically without replacement, fsync directory, then store signed `backup-created` with exact digests and target confirmation. Only now report the backup recoverable there.

No raw archive remains beside ciphertext. Temporary plaintext has private permissions and bounded lifecycle. A failed unpublished stage is cleaned or retained gated for explicit recovery. Never delete the only older backup before an independent restore drill verifies its replacement.

### Restore and interruption

States: `accepted → validating → staged → applying → data_verified → complete`; `failed_safe` before changes, `recovery_required` after interrupted application. Gate/journal lives outside restored business roots.

1. Validate target authorization, protected source pins, complete framing/signature/bounds/digests before interpreting paths or schemas.
2. A short-lived trusted client import unwraps only this archive's key. Send that one-use key to the pinned target worker through the authenticated encrypted operation channel, bound to operation ID/archive digest; never send either recovery private key. Key receipt is not a general data session.
3. Decrypt/authenticate/sanitize to a new private stage. Verify files, history relations, DB schema/foreign keys, owner mapping and exclusions; active business data remains unchanged.
4. Freeze all destination writers and durably persist full replacement journal/gate before modifying paths. Stage on each destination filesystem or reject the atomic-replacement profile. Keep previous business paths under private operation-owned names until verified.
5. Switch each fixed resource via durable rename and directory fsync with per-resource intent/result. Multiple renames are not one atomic transaction. Readers/writers stay gated until reconciliation; crash resumes only the exact operation/manifest.
6. Read back actual installed data and verify fresh application identity mapping and rejection of old sessions/SSO. Persist signed `data-restore-completed` before releasing gates. Network integrations/packages require current-policy activation.
7. Incomplete restart stays isolated. Resume/rollback follows phase/inode/digest evidence; never infer fresh ownership from empty folders, restore authority from business backup, or start historical containers automatically.

Business restore cannot decrease or replace authority, physical identity, recovery versions, used keys, claim consumption, revocations, policy/security floors. Assert invariants before/after all success/failure paths. Historical data restoration does not roll back authorization.

### Replacement box

Verify its own protected delivery packet, independent first root, new pins, principal/device and verified new recovery configuration first. Old material/archive cannot replace bootstrap or target authority.

Then approve import with old-source pin and explicit source-to-new-target principal/resource mapping. Do not import active old rosters, access/approval keys, cloud owner records, recovery private keys or server credentials. Actual data access uses the new box's current bindings.

An offline old box cannot be globally revoked by restoring another box. Original online recovery rejects old versions according to its current ledger, while old backup keys may still decrypt old copied ciphertext on an independently initialized target. UI/receipts must preserve this distinction.

## 8. Transfer: private data erased by default

V1 has no retained-private-data ownership transfer. Existing cloud `retainData:true` flow stays disabled. Any selected-resource handover is a separate explicitly approved export/import.

Ledger action `ownership.transfer-prepare` has exact args:

```text
{transferId:<new digest>,dataDisposition:"erase-local",
 expectedOwnerPrincipalId,scopeManifestDigest:<digest>,
 retainedIndependentBackups:true}
```

Current actor needs `ownership.transfer` and current approval policy. No recipient is authorized by this mutation and target/material proof slots are null. Future first-root eligibility is established only after verified erasure and protected new-packet delivery; a cloud phone/account is not a target grant. Preview lists all local business roots, container layers/logs, local snapshots/backups, wrappers, model/connector secrets and affected members; retained external backups are separate.

Two distinct authorization domains must meet:

1. Local committed approval binds old local owner, transfer ID, full scope and current versions.
2. Existing OS `NEXUSAOS-DEVICE-RESET-PERMIT-V1` cloud permit remains required where executor policy requires it, for full erase of the same physical device/scope. Identity-only and cloud-owner-change-only are rejected.
3. Root journal binds both authorization digests and exact mapping of cloud reset ID/target epoch to local operation ID/next local epoch. Cloud/local epochs need not be numerically equal and cannot be conflated.
4. Before consumption, expired admission requires a fresh same-operation local
   permit and valid cloud permit. There is no replacement by an unapproved transfer.

One-way root-only journal outside business roots:

```text
reviewed → old_authority_frozen → erasing → erase_verified
         → new_material_staged → redelivery_committed
         → new_delivery_ready → new_root_claimed
```

Before freeze commit, a review may be abandoned without changes. After freeze, there is no automatic timeout/thaw or account override. Failures remain frozen/`recovery_required`; old sessions/material/claim secrets never reactivate. Freeze/gate is durable before deleting data.

Fresh dual-domain admission is consumed exactly once by the signed durable
`ownership.erase-started` event. Erasure is then irreversible: the same transfer,
epoch, scope and evidence may only finish wiping and delivering. Its continuation
does not expire with the 60-second worker admission lease; a 210-second stop or
restart cannot reactivate the old owner. Before deletion and every fixed root,
the executor authenticates the stored mutation ACK and erase-started checkpoint,
recomputes actual scope/evidence/cloud-envelope digests, and requires the same
`erase_pending` state. An expired, never-consumed permit cannot start erasure.

Before first consumption, normal progression requires independently observed
physical closure of gateway sessions/staging, native operations and durable
workers. The provider drains its file/SQL/IO threads and releases the stable
worker lock; the executor must acquire that same inode before any erase.
Historical effect evidence lost on restart remains `unknown`. Same-boot pending
or unknown cannot bypass the barrier. A reviewed boot that is demonstrably
retired may use fixed `transfer.isolate`: with fresh exact frozen authorization,
the privileged executor stops the fixed authority service, verifies its actual
PID exit, obtains both stable runtime and worker locks, persistently stops the
approved native containers/units including clipboard, and checks file descriptors
and mappings over the entire scope. It fsyncs an independent private isolation
receipt before releasing locks and restarting only the fixed authority unit.
The new boot rechecks receipt, lock inodes, persistent isolation and fresh local/
cloud admission; this does not label the old historical effect `effective`.
If restart fails after the receipt, the exact durable inbox request permits the
root executor to revalidate the stopped process and locks and retry service
startup only. It cannot consume an expired permit or erase via this retry.

After erase-started has been consumed, a real authority/provider restart follows
that exact signed event rather than requiring vanished historical effect caches.
Newly recreated known empty worker directories may be removed; unexpected files
or business data recreated after material staging keep the box isolated. The
candidate delivery packet is never regenerated by retry. Dynamic legacy roots
that the fixed executor cannot actually write are rejected during preview.

Reuse existing full-erase inventory, known legacy roots, isolation/removal of containers, writer checks, permit verification, actual emptiness, receipts and fsync. Changing owner records, deleting SQLite rows, identity-only reset or deleting authority directory is not erasure proof.

Ordinary provisioning continues to reject existing authority/delivery/staging. The transfer worker does not delete or replace the authoritative database and does not call ordinary initialization. It uses the same running authority's private `mark_erase_started` and `complete_verified_redelivery` operations, with root-peer checks and independently reparsed local evidence, as defined by ledger-v2. The OS journal and ledger event bind each other by transfer/evidence digest; neither can be fabricated by a public HTTP boolean.

Retirement in the same ledger invalidates old principals/bindings, online recovery/session versions and claims, while retaining event/key/epoch history and consumed generations. No retired projection can become active by restoring an old business file. The immutable initial bundle remains an origin anchor; current credentials/epochs come from the verified event chain.

After verified erasure, stage the next local epoch, new provisioning ID and fresh random claim secret in a new immutable protected provisioning record and delivery packet. Keep this physical box's independent signing/TLS identity and pins; changing those is a different explicit operation, not needed to change the owner. No old active roster or recovery configuration is copied into the new generation.

One authority transaction validates durable new-material evidence, retires old qualification, consumes the transfer, advances ownershipEpoch once and records the new credential generation plus `ownership.redelivery-ready`. It leaves owner/root unset. Only then can the protected packet be delivered and the normal new first-root protocol complete. Staged material is unavailable through public APIs before readiness. Missing/corrupt delivery candidate keeps the box frozen; interrupted retry resumes the exact candidate instead of regenerating or resurrecting old material.

The new owner pins the descriptor through protected delivery, creates fresh access/approval keys and principal, and configures new recovery material. Old claimant keys remain historical and cannot be recycled as a new owner. Completion distinguishes local erasure from retained external copies. Ordinary file removal is not forensic media sanitization or cryptographic erasure; those require separate verified full-disk/key-destruction profiles.

## 9. Factory-clean extension

Old manufacturing markers attest a device-bound delivery window, not current absence of ownership/history or this local provisioning transaction. Empty-folder checks alone do not close the cloud-claim/local-ACK gap.

A future distinct-domain factory attestation needs independently installed manufacturing trust, exact physical identity, fresh provisioning nonce, declared clean-image/data scope, manufacturing eligibility epoch and durable one-time consumption. Combine with actual inventory/isolation, and reject prior authority, consumption, customer data or incompatible lifecycle history.

This extension is not enabled here and is not a legacy migration bypass. Legacy without independent owner evidence returns `LOCAL_TRUST_MIGRATION_PROOF_REQUIRED` and preserves data.

## 10. Typed results and real-data acceptance

Errors are fixed codes. No proof, material, unwrapped key, private key, environment secret, plaintext entry or arbitrary exception text appears in public logs/responses.

Typed completion states distinguish `recovery-configured`, `management-recovered`, `backup-created`, `data-restore-completed`, `transfer-erased`, `transfer-delivery-ready` and `transfer-completed`. Configuration does not prove backup exists; backup creation does not prove restoration; erasure does not prove packet delivery or all external copies destroyed.

| Group | Required temporary-fixture observations |
| --- | --- |
| Material | Real native-dialog-adapter file save/re-import and real crypto; wrong/truncated/key/pin files fail; lock/close cancels; no renderer saved flag or secret in snapshots/logs/clipboard |
| Setup/rotate | No activation before re-import; wrong capability denied; concurrent rotations one winner; failure preserves old config; exact stored retry |
| Recovery | Target dual proofs and next material proof; changed target rejected; competing recoveries one winner; old key/device/session denied online; unrelated principal unchanged |
| Restart/time | Every commit boundary, retired boot, rollback clock, missing/partial ledger; committed retries survive without initializer fallback |
| Real backup | UTF-8/binary files, business secret, SQLite rows and history bodies recover byte-for-byte; host keys/JWT authority/material absent from sanitized content |
| Container | Wrong OAEP label/key/pin, header/footer/tag tamper, reordered/missing/duplicate chunks, truncation/appended bytes/oversized bounds/path/link/device/collision all fail before publication |
| Consistency | Active writers/changing files fail; child/parent history group verified; unsupported schema/component/engine explicit; no silent partial whole-box success |
| Restore | Faults before/after each rename/fsync; no mixed-state access; exact resume; no security-path/foreign-owner selection; authority/revocation/recovery floors unchanged |
| New box | Own valid first root/pins/recovery required; old data explicitly mapped; old rosters/SSO not restored; actual new user reads data; no global offline-old-box revocation claim |
| Transfer | Either authorization alone, wrong scope and identity-only denied; real temp data erased; generations never simultaneously active; interrupted delivery never reinitializes |
| Data plane | HTTP/WS/download/task/app sessions, stale JWT/SSO and restored old DB cannot bypass current local versions; use/backup roles cannot recover or export unrelated resources |

Completion requires actual UI → HTTPS → ledger → worker → real data → signed receipt flows, explicit supported-component coverage and operational instructions for controlled erase/restore windows. No operator should be asked to bypass a gate to complete the advertised path.

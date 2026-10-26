# Remaining local security work

Updated 2026-10-26. The user has requested completion of the remaining development after items 1–4, with deep verification. This extends the management-loop work; it does not authorize production reset, deployment, real-account changes or publication.

## Acceptance and dependencies

1. Finish and record the management v1 checks: real TLS/vault/SQLite enrollment, exclusive startup, independent connection races, durable clock, immutable receipts, lock lifecycle, packaged entry and isolated Electron UI. Legacy migration remains blocked without independently established owner evidence; missing state must never become a new root.
2. Freeze the next wire contracts after codebase exploration. Cover local data access and revocation, role/member operations, independent recovery/rotation, encrypted backup restoration and ownership transfer. Every high-risk operation must bind the exact target, keys, grants, prior checkpoint, purpose, challenge and deadline to per-operation approval. No cloud login, old grant or caller-supplied `verified` value becomes authority.
3. Connect local authorization to the actual data path: independently bound access proof, local principal/resource mapping, HTTP/WS/SSE/Range enforcement, bounded leases and app subauthorization. LAN use must work without cloud authentication. Protected boxes must reject old cloud tickets/native tokens and direct/backend aliases. Lock/revocation must close affected active streams within the specified five-second budget; task persistence requires its own explicit grant.
4. Implement ledger changes with one authoritative transaction and signed stored results: explicit manager qualification, device/member revocation, last-manager rules and descendants, distinct member identities and scoped invitations. Never map another person into an existing private principal based on cloud identity, names or phone numbers.
5. Implement user-held recovery configuration, rotation and new-device recovery, including interrupted/idempotent recovery and rejection of old online recovery material. Use actual temporary data for encrypted backup/restore tests. Business restore must preserve current revocations/checkpoints; cross-box restoration must establish verified new security state, not silently replay an old ledger. Historical ciphertext decryptability is distinct from online authorization revocation.
6. Implement safe ownership transfer under independently verified current and recipient keys. Default transfer does not transfer private data. Any retained-data handoff must enumerate exactly what the current owner approves; reset/transfer must invalidate old identities, sessions and pending approvals atomically without trusting cloud ownership edits.
7. Complete integration, fault injection, concurrency and performance tests before marking a path complete. Record software versus hardware guarantees and real hardware/OS release validation separately. Physical/TPM guarantees cannot be established by mocked tests.

## Workstreams and affected areas

- Main: freeze contracts, shared integration, coordinator and existing shell wiring, cross-language/end-to-end/failure tests, final documentation and verification.
- Bridge authorization/data transport: independent modules plus existing `wanx-bridge/wanx_bridge/{server,auth,upstream,...}` only after the concrete seam and owner are agreed.
- Ledger: extend local authority/protocol and their tests, retaining compatibility/fail-closed migration rules for already initialized state.
- Desktop data client: `client.mjs`, `octop/`, `app-host/`, resource clients and local identity signing, with disjoint ownership agreed before edits.
- OS recovery/deployment: existing reset/backup/deployment boundaries plus new recovery tools, with temporary fixtures and no actual reset.
- Dedicated UI: fixed IPC methods, immutable per-operation review, recovery material handling, visible receipt and delivery state; real isolated Electron tests.

Exploration may run alongside completion of v1 verification. New protocol-dependent edits wait for the frozen contract. Parallel writers own disjoint files; main integrates shared files and waits for all delegated work before reporting completion.

## Verification matrix

- Positive: independent first root; second use and explicit management device; disconnected-cloud LAN reads/writes; permitted member resources; recovery to new client; encrypted data restore; authorized transfer and new ownership.
- Authorization negatives: password/SMS/token-only access, wrong box/member/key/scope, stale or altered checkpoint, revoked descendants, caller-supplied authority, old SSO/native and backend routes, app confused-deputy paths.
- Transport: stolen headers/cookies/URLs, replayed proofs, changed method/path/body/range, redirect and TLS pin substitution, new WS channel/SSE/reconnect, denied cross-origin and iframe IPC.
- State/concurrency: first-root and recovery races; approve/cancel/revoke races; last-manager conflict; transaction failure and process kill; lost receipt and exact retries; DB/backup rollback; clock rollback; restart generation; bounded retention and source budgets.
- Lifecycle: lock/suspend/user switch/window crash/navigation during KDF, signing, transport and persistence; no delayed unlock or submission; active stream stop within five seconds.
- Load: bounded queues/memory, database lock behavior, long streams versus management capacity, request/nonce floods, repeated reconnect/restart. Publish measured limits and test configuration, not unsupported throughput claims.

## Status: software implementation and local acceptance complete

All seven software work packages above have been integrated. Existing cloud-login restrictions remain in force. Delivery includes the independent local identity/vault and management UI; proof-gated native data paths and application lifecycles; scoped managers/members; recovery and rotation; two explicitly scoped encrypted business backup profiles; and independently verified erase/redelivery with restart recovery. No production deployment, account change, reset, migration, commit or publication was performed.

The backup profiles are `semantica-private-v1` and `wanx-personal-v1` (personal space plus clipboard). They are not whole-box backups. Restore requires an independently authorized empty target namespace, preserves other principals and current security state, and never restores old device grants or private authority keys. Existing grants are not silently expanded to advertise a new profile.

Final verification evidence:

- Native WANX `make all PYTEST_JOBS=4`: lint, formatting and typing passed; 4950 tests passed / 17 conditional skips. The final runtime assembly fixture uses the required signed initial session intent.
- Bridge: 1503 passed / 1 source-path skip; that Clipboard integration was separately enabled and passed. The final narrow backup quota HTTP mapping passed 71 related tests, including real TLS, nonce rollback/retry and error non-disclosure.
- Desktop: 2042 passed / 21 conditional skips. Ten skipped environment cases were separately enabled and passed (14 tests in their files). Four real Electron security journeys passed; the remaining packaging/GUI/Windows conditions are not counted as executed.
- OS: 2799 passed / 4 Linux-only skips / 2168 subtests. The latest complete local-trust module set passed 151 tests / 73 subtests after quota, plan retention and actual UID/GID installation fixes.
- Semantica: 494 passed / 2 conditional skips / 191 subtests in an isolated Python 3.11 environment; both conditions were separately enabled and passed, for 496 actually executed tests. Model calls use the existing test doubles and synthetic configuration; external services and model downloads were blocked.
- Clipboard: 50 passed. The shared native gate also built and installed as a non-editable Python 3.11 wheel and passed 67 protocol/ASGI tests. Both WANX lockfiles validate offline without upgrades.

Deep cases include 196 MiB real two-box backup/restore, archive validation before any upload, anonymous challenge exhaustion with legal operations continuing, per-principal upload-byte reservation, same-request replay races, 60 authenticated session renewals from four devices, active stream revocation, actual SQL rollback and filesystem compensation, held lock-inode exclusion, partial erase/restart, exact scope/permit binding, and fresh-root delivery after the old devices become inactive. Physical effect evidence remains unknown when actual closure cannot be established. Restart isolation is a distinct OS proof; it does not manufacture historical effect success.

Production readiness is separate. Linux peer credentials, actual systemd/Docker lifecycle and mount isolation, hardware disk latency, Windows packaging/ACL behavior, hardware key protection and forensic storage erasure still require their respective environments. Required mode continues to deny unisolated host terminal/desktop/mobile and Agent Shell/files/custom MCP/plugins. Admin's known ten baseline failures and isolated MySQL validation remain recorded separately. These limits do not justify restoring cloud-account data authorization.

The full current report, commands, local logs, scope limits and historical P0 evidence are maintained in `../centuarai-os/docs/account-device-security-implementation-plan.md` (relative to the WANX repository root). Transport timings and exact fixture limits are in `wanx-bridge/docs/local-data-verification.md`.

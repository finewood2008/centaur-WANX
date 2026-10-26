# Local data security and concurrency verification

Recorded 2026-10-26; latest runs include authenticated initial session intents. These are local synthetic-fixture results, not a production throughput or capacity claim. No production account, secret, data directory, cloud service or external network was used.

## Environment and commands

- macOS 26.5.2, arm64; CPython 3.14.9.
- pytest 9.1.1, cryptography 49.0.0, httpx 0.28.1, uvicorn 0.49.0, websockets 15.0.1.
- Node 23.11.0.
- Real loopback TLS with generated test certificates, real HTTP/WS sockets, the actual ASGI gateway/native gate, actual Unix-domain broker sockets, and anonymous files in private temporary directories.
- macOS does not provide the production Linux `SO_PEERCRED` adapter. The network fixture replaces **only** that credential lookup with the current test UID. A separate test proves the production non-Linux branch denies. Linux kernel credential checks, production root/GID deployment permissions, multiple containers and hardware disk latency require Linux deployment acceptance; this run does not claim they passed.
- Business handlers in generic stream tests are controlled fixtures. The ledger-to-effect test additionally provisions and migrates a real temporary SQLite authority, commits a signed revocation, observes its post-commit callback and performs a fresh authenticated signed effect read.

From the repository root:

```sh
rtk proxy env PYTHONPATH=src:wanx-bridge:packages/local-data-gate .venv/bin/python -m pytest -q -s \
  wanx-bridge/tests/test_local_data_protocol.py \
  wanx-bridge/tests/test_local_data_sessions.py \
  wanx-bridge/tests/test_local_data_effects.py \
  wanx-bridge/tests/test_local_data_broker.py \
  wanx-bridge/tests/test_local_data_routes.py \
  wanx-bridge/tests/test_local_data_gateway.py

rtk proxy node --test \
  wanx-client/tests/device-data-contract.test.mjs \
  wanx-client/tests/device-trust-data-session.test.mjs \
  wanx-client/tests/device-trust-vault.test.mjs
```

The latest full owned Python run passed **176 tests** in 16.49 seconds; the Node protocol/session/vault run passed **65 tests** in 12.20 seconds. Deprecation warnings concern uvicorn's legacy WebSocket adapter and pytest cleanup of unrelated concurrent temporary-test directories; no assertion was weakened to suppress them. Root integration owns broader Bridge, native, OS and Electron acceptance.

## Measured closure and bounded admission

The following values are one recorded run, not percentiles. The generic revocation tests change the synthetic authoritative view and deliberately omit invalidation notification, exercising the independent authorization-poll fallback. All time differences use the same machine's monotonic clock; ledger Unix-second timestamps are never subtracted from client wall clocks.

| Scenario | Actual load and assertion | Recorded observation |
| --- | --- | --- |
| Same request replay | 12 concurrent real HTTPS requests with one identical signed proof | Exactly 1 accepted, 11 denied, 1 native handler |
| Range download revoke | 1 MiB declared body, 4 KiB chunks every 40 ms | Closed 0.620664 s after view change; last byte 0.578212 s; 61,440 bytes received; incomplete content raises a truncation error |
| SSE revoke | One event every 40 ms, idle between events | Closed 0.602935 s; last byte 0.580629 s |
| Chat WS revoke | Real upgrade proof and a fresh independent native-hop WebSocket key; frames every 40 ms | Closed 0.603554 s; last frame 0.579889 s |
| Upload revoke | Declared 6,000 bytes; client holds after the first 16 bytes | Gateway transport/file cleanup 1.995263 s; **0** native handlers and **0** business writes |
| Operation cap | Tightened limit of 1 with one live SSE stream | Second request returns `LOCAL_DATA_CAPACITY` before an upstream call |
| Anonymous handshakes | 48 concurrent requests from one real TLS peer | 16 capacity rejections after the configured burst, zero challenges allocated; valid heartbeat and fresh initial Access PoP both return 200 |
| Authenticated renewal under anonymous flood | 4 existing devices at the same peer, each with a host and 14 child launches; 60 concurrent fresh renewals while anonymous requests continue | All 60 renewed, distinct new session IDs, unchanged grant ceilings; anonymous requests remain denied; 0.232181 s total in this fixture |

The real SQLite revocation test records the post-SQL-commit observer, independently records the client transport closure, and requires the actual protocol `connection_lost` evidence. In the recorded run:

- commit observer to Range TCP closure: **0.000906 s**;
- conservative interval from before submitting the signed mutation to closure: **0.003362 s**;
- no later data byte was observed after the commit marker;
- fresh manager `/v2/read` verifies a box-signed `effectState=effective`, with gateway **1/1** and native **1/1** physically closed;
- staged files are gone, the download is observably truncated, and no timeout or logical-cancel flag substitutes for physical evidence.

These timings are small local samples. Five-second assertions are regression limits, not a statement about unmeasured production latency, QPS, NAT populations or disk performance.

## Security and persistence assertions

- Python verifies real Node and Python ES256 vectors, including session intent and renewal. Strict schemas, purposes, canonical JSON, wrong keys, altered bodies/selectors, replay and noncanonical targets reject.
- The actual native handler is unreachable through copied legacy Bearer tokens, cloud exchange, unknown routes, shared-space selectors, host terminal/desktop/mobile or shared-host browser-control paths.
- A real clipboard-to-Octop child hop keeps the same local principal and receives a derived private `clipboardScope`. A child request outside the fixed callback allowlist is denied.
- Native resource preparation batches bind the admitted parent proof, native generation, exact resource/action set and request digest. Twelve concurrent uses of one nonce have one winner. Removing any required resource closes continued operation checks.
- Logical revoke and expired proof records **do not** free storage capacity. Gateway and native physical file cleanup must both complete. Cancelled disk-thread work retains its reservation until the actual thread drains.
- Broker tests use real UDS framing and cover wrong peer UID, unsupported platforms, duplicate JSON/headers, query credentials, oversized requests, no pipelining, occupied socket paths and a full connection cap without an unbounded wait queue.
- Initial challenges require current registered Access-key PoP before allocating a candidate. Twenty concurrent copies of one intent have one winner; per-binding candidate limits preserve another binding's headroom. Eight blocked unverified identity lookups keep their actual reservations after caller cancellation, leave the active-session query pool available for a valid heartbeat, and release only after actual work drains. Random commit locators cause no authority lookup.
- Authenticated renewal uses separate bounded admission, a fresh old-channel signature plus fresh Access proof, and exact proposal binding. Closing the parent, swapping keys/request IDs, replaying old proposals, using anonymous challenges on the renewal path, or exceeding a binding's budget denies. A new signed retry replaces only its own unused candidate; late responses cannot restore the replaced proposal.

## Physical effect coverage

Data effects require the complete configured native participant inventory, real native cleanup ACKs and gateway transport/file evidence. The tracker covers missing/stale inventory, generation changes hiding old operations, unknown IDs, incomplete/evicted history, concurrent replay, thread-safe immutable reads and restarted runtimes with no historical evidence. Zero counts alone do not imply effectiveness.

Durable backup/restore jobs are separate required participants. The tracker consumes exact job/attempt/binding/principal/epoch/authorization-version descriptors, explicit completeness, a known worker boot and current physical receipts. It includes jobs in the effect's native-operation counts. It remains unknown for absent/unready/stale workers, wrong attempts or identities, regressing state versions, unresolved publication, a changed boot or truncated job history. Database terminal states and permit expiry are not physical-stop evidence. A known unready worker can later supply actual drain evidence in the same boot; it need not remain permanently unknown once every proof is present.

The OS worker owner's separate acceptance was independently rerun from the sibling `centuarai-os` directory with `rtk proxy ../centuarai-wanx/.venv/bin/python -m pytest -q tests/test_local_trust_operations.py`: **6 passed in 2.98 seconds**. Its real two-box restore fixture commits a signed emergency lock immediately before the target SQL commit, obtains the real ledger `affectedJobs` descriptors, and observes an active worker at that boundary. It verifies SQL rollback, removal of copied files and private staging, preservation of another principal's data, and a final physical `closed` receipt only after cleanup drains. Feeding those real before/final worker observations into this tracker changes the result from pending/unknown to effective, with every targeted worker operation closed. Native inventory readiness is an explicit fixture in that particular test; it does not replace the separate real HTTP/WS/native tests above.

Worker lock/restart and complete OS transfer acceptance remain part of the OS owner's broader test suite. The generic TLS fixtures explicitly configure no durable worker when none exists.

## Independent transfer fault review

The final independent OS subset was run from `centuarai-os`:

```sh
rtk proxy ../centuarai-wanx/.venv/bin/python -m pytest -q \
  tests/test_local_trust_transfer.py \
  tests/test_local_trust_transfer_faults.py \
  tests/test_local_trust_isolation.py \
  tests/test_local_trust_operations.py
```

**31 passed in 10.28 seconds.** The separately owned fault file contributes 18 cases. The subset uses real temporary-file deletion, SQLite authority transactions, independent local/cloud signatures, immutable packet bytes, real child-process termination and actual POSIX exclusive locks. Docker, systemd and host writer enumeration are controlled adapters; this is not Linux service deployment acceptance.

The review found and verified fixes for omitted cache scope despite a retained digest, substituted cloud-permit bytes, erasing a live worker's lock inode, incomplete primary-reset recovery, and a new Provider's empty working directories blocking an already staged transfer. It also verified these boundaries:

- Wrong device/scope, identity-only cloud authorization and a historical completed reset cannot authorize the current transfer.
- The consumed ledger event authenticates the actual scope, cloud permit, review boot and execution evidence. An unconsumed expired permit cannot begin erasure. An already consumed exact irreversible operation may continue across the short admission TTL; this does not authorize a new operation.
- Primary-data and cache deletion faults resume under the same approved scope. External backups remain intact, and new business data after staging keeps the box isolated.
- Missing staged material is never regenerated. Delivery occurs only after the signed redelivery commit; a crash after durable delivery but before its completion journal retries the identical packet without advancing the epoch again.
- Actual authority/Provider restarts retain the same candidate and require the same consumed authorization. Lost historical effects are never relabeled effective.
- An unconsumed transfer whose effect history was lost requires an actual later boot and independent fixed isolation. A child process that remains alive despite a claimed service stop is rejected. Successful isolation requires both stable lock inodes, actual process exit and native writer checks before recording its private receipt.

No unresolved bypass was found in the reviewed final transfer branches. Production Linux mount namespaces, service stop behavior and root/GID packaging still need their separate deployment acceptance.

# Local data authorization v1 — review draft

Status: **Core schemas, limits and injection interfaces frozen for implementation**. This document extends the independent local authority in [management-v1.md](management-v1.md); it does not change the evidence-v1 binding schemas. It describes a custom protocol. Its possession and request-component binding ideas are informed by [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449) and [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421); it does **not** claim conformance to either RFC.

## Acceptance, ownership and dependencies

The completed feature admits data operations only through a live locally authorized binding and current possession proof. It works on LAN without a cloud account or cloud availability. Cloud credentials, old bridge sessions, native JWTs, renderer assertions and loopback location never substitute for local authority. Lock/revocation must stop ongoing data channels within five seconds under the supported, measured load envelope, including otherwise idle channels.

Implementation owners and interfaces:

| Owner | Files / boundary | Required dependency |
|---|---|---|
| Protocol/session owner | `wanx_bridge/local_data_protocol.py`, `local_data_sessions.py`, `device-trust/data-contract.mjs`, corresponding tests | Frozen schemas below; injected authoritative query, monotonic clock, box response signer and bounded executor |
| Authority owner | Existing `local_authority_store.py` instance and ledger mutations | `get_authorization(binding_id, now)` and committed security-change notifications; no second writer |
| Runtime/native-gate owner | Independent TLS runtime, bridge forwarding, native ASGI gate, native principal mapping and private UDS | The same `LocalDataSessions` instance, gateway signing key, strict application/route policy registry |
| Desktop owner | `data-session.mjs`, finite vault signers, gateway/platform/client paths | Protocol helpers; main-owned channel keys, app launch identity, abort/generation fences |
| Integration/UI owner | Application host, trusted UI, end-to-end fixtures | No alternate signing/network API; signed effect DTO; observed transport shutdown evidence |

The schemas and resource names are frozen; route coverage and actual deployment remain integration acceptance work. Before marking `local_trust_required` ready: run real gateway/native HTTP, WS, SSE, upload and Range tests, direct-native bypass tests, and lock/revocation timing tests. A management ACK or successful session creation alone is not completion evidence.

## 1. Runtime and trust boundaries

1. The independent pinned HTTPS runtime owns the existing single `LocalTrustAuthority` writer and boot generation. It also hosts the new data gateway. It injects its authority query into `LocalDataSessions`; it never instantiates another authority or changes generation to serve a data request.
2. The gateway reuses bounded HTTP/stream/WS transport code, **not** `PlatformAuthService` as an authorization source. There is no extra hop through the old cloud bridge.
3. The gateway forwards directly to explicitly registered private upstreams. Each hop has a distinct signed purpose and pinned gateway public key. The independent gateway signing key is different from the box response key, TLS key, client access/approval keys and temporary channel keys. Provision it create-only; native key trust is explicit configuration, never first-connection trust.
4. The native Octop ASGI gate executes before all HTTP/WS routers and JWT-exempt logic, including internal and non-`/api` dynamic routes. In required mode it accepts only a valid gateway proof plus private runtime admission. It supplies a trusted scoped user; ordinary native JWTs are not an alternative path.
5. Required mode closes old cloud/platform/native login, registration, OIDC, application exchange, cookie/query-token and first-frame-token paths on public and direct native listeners. No proof-error, absent file, cloud failure, unsupported app or restart may fall back to the old mode. Deliberate operator maintenance uses a separate OS-protected interface, not a loopback exception.
6. The public data origin is the descriptor's exact HTTPS origin. Keep the existing SPKI-before-body guarantee. Redirects cannot move a proof/body to another origin. Management paths remain local to their own handlers; they are not forwarded to Octop.
7. Desktop main retains channel keys and network authority. All six existing paths must use the same session implementation: browser HTTP, manifest/assets, ordinary WS, desktop/mobile WS, main HTTP and main WS. Application children receive neither keys nor a reusable raw signing API.

A LAN address or P2P dial route may change without changing box identity. Main selects only an authenticated discovery/approved route for the saved descriptor; changing a route never replaces the saved box signing key or TLS SPKI pin. A P2P TLS connector validates the same SPKI on `secureConnect` before exposing a socket or sending business bytes. It must not use a legacy CA-only connection as a fallback. Pools are partitioned by box pin, profile, application launch and session generation; closing a generation disposes its sockets. Required mode is persisted by the box, so a restarted/locked desktop with no in-memory box association still cannot enter through old cloud paths.

The threat model protects against copied cloud/native tokens, copied individual request proofs, hostile renderers/children, other LAN clients and stale sessions. The existing software-passphrase policy does not attest hardware key custody or resist arbitrary code running as the trusted main/box service OS user.

## 2. Encoding, primitive types and clocks

All structures shown below are **exact schemas**: every field is required, explicit `null` remains explicit, and unknown/duplicate fields are rejected. Objects are ordinary records; getters/prototypes do not enter signers. JWS payload/header bytes use evidence-v1 canonical JSON: ASCII strings, safe integers without negative zero, sorted object keys, unpadded canonical base64url. Only ES256 / 64-byte IEEE-P1363 signatures are supported. Protected headers are exactly `{alg:"ES256",typ:<fixed operation type>}`; no incoming algorithm/key URL/kid selects a verifier.

- `Id32` / `Digest32`: exactly 32 decoded bytes, canonical base64url.
- `Token`: evidence-v1 ASCII token, 1–128 characters; no terminal newline.
- `PublicKey`: exact public P-256 JWK `{crv,kty,x,y}`, on-curve, no private/extra fields.
- `Version`: positive safe integer.
- `TimeMs`: positive safe integer **Unix milliseconds**. These fields are named `issuedAtMs`/`expiresAtMs`; management-v1's second-based fields are not interchangeable.
- `Grants`: unchanged sorted evidence-v1 resource/action list; actions are `execute`, `read`, `write`.
- `ApplicationId`: exact entry in the deployed application policy registry, not any syntactically valid string.
- Every compact request/control JWS is at most 16 KiB; signed control responses at most 64 KiB.

Runtime trusted wall-clock fencing remains authoritative. Deadlines, cache age, presence and watchdog intervals use a monotonic clock. Clients estimate server time conservatively from a verified response and monotonic elapsed time; they do not make their own wall clock an authorization authority. Reject future-issued proofs; do not add an expiry grace that extends the presence budget. Clock rollback or unavailable authority fails closed.

## 3. Authoritative authorization view

The existing authority exposes this synchronous internal method, executed through the runtime's bounded executor:

```
get_authorization(binding_id: Token, now: trusted_time) -> {
  boxId, boxKeyThumbprint, ownershipEpoch,
  rosterVersion, rosterDigest, policyVersion, authorizationVersion,
  principalSecurityVersion, principalStatus, ownershipState,
  bindingId, bindingRevision, principalId, clientId, accessKey,
  status, grants, expiresAt
}
```

`expiresAt` retains the ledger's explicit `null` or Unix-seconds representation internally; the session adapter converts it once to a `TimeMs` deadline. It MUST NOT mistake seconds for milliseconds. All public session DTO expiry fields use milliseconds.

The method returns only for `ownershipState="owned"`, active current principal/binding, current epoch, valid lineage and live effective scope. Otherwise it raises a stable denial; no caller-supplied `allow` flag is accepted. `grants` are actual effective data rights derived from the authoritative commit/source, **not** `delegableGrants`. An expired/revoked lineage cannot be kept alive by a cached grant. The minimum relevant binding/principal/resource/lineage expiry bounds the result.

`authorizationVersion` is the global security-event version; `bindingRevision` is the individual binding revision; `principalSecurityVersion` fences recovery/revocation of that principal. A newer unrelated global version triggers reevaluation; it does not change the session's identity. A changed epoch, binding revision or principal security version closes the captured session. Scope expansion requires a new session; a refresh never silently expands its initially accepted grants.

Positive authorization cache age is at most 1000 ms from query start and bounded by effective expiry. Never reset cache age on a cache hit, heartbeat, network failure or a failed refresh. Deduplicate concurrent refreshes per binding, bound queue length and execution time, and close instead of serving stale authority. Querying must not bypass ledger transaction/clock guards. No data-plane nonce, session or request proof is written to a second ownership ledger.

## 4. Session establishment and application isolation

There are no bearer data tokens. `sessionId` is only a locator; possessing it is insufficient. Each session binds one active local binding, one main-generated temporary P-256 channel key, one `applicationId`, one random `launchId`, one gateway generation and a fixed principal. It cannot switch identity or application during renewal.

The main/vault access-key signer is finite: it accepts only the validated session-intent and create-session payloads below, checks its own client/binding identity and trusted descriptor, and verifies that the current main/launch generation is still unlocked. Main generates the temporary key; its private half is never persisted or sent to a renderer/child. It is distinct from the long-term access/approval keys and is discarded on lock, close, crash, suspend or launch invalidation.

### 4.1 Challenge

`POST /local-trust/v1/data/session-challenge` takes:

```
{proof}
```

`proof` is signed by the registered Access key with type `centuarai-local-data-session-intent+jws` and exact payload:

```
{schemaVersion:1,purpose:"centuarai.local-data.session-intent",
 boxId,boxKeyThumbprint,bindingId,applicationId,launchId,requestId,channelKey,
 jti,issuedAtMs,expiresAtMs}
```

Its lifetime is at most 3000 ms. Verify the current active binding, pinned Access key and registered application before allocating any challenge or replay entry; no unsigned compatibility path remains. The temporary channel differs from the Access key. Unverified locators use at most eight separate physical authority lookups and never populate the live-session authorization cache; cancellation does not release those lookup reservations until actual executor work drains. Random session-commit locators are rejected before any authority query, and a real challenge's saved Access pin verifies its proof before the fresh authorization lookup.

There are at most 256 initial candidates globally and 32 per binding. A fresh signed intent may replace only the same binding/application/launch's unused candidate; the old challenge can no longer commit. Retain every consumed `(bindingId,jti)` until its admission interval expires, at most 64 per binding and 4096 total, and reject rather than evict a live replay record. Concurrent reuse has one winner. The signed response kind `session-challenge` body is:

```
{challenge,gatewayGeneration,issuedAtMs,expiresAtMs}
```

`challenge` and `gatewayGeneration` are `Id32`; lifetime is at most 30,000 ms. Restart drops outstanding challenges and sessions. Exhaustion denies new allocations. The following Access proof must preserve the intent's request ID, channel key, application and launch exactly, and current binding/security revisions must still match.

### 4.2 Access-key proof and session response

`POST /local-trust/v1/data/sessions` takes exactly `{accessProof}`. The fixed JWS type is `centuarai-local-data-session+jws`, payload:

```
{schemaVersion:1,purpose:"centuarai.local-data.session",
 boxId,boxKeyThumbprint,ownershipEpoch,principalId,bindingId,clientId,
 gatewayGeneration,challenge,requestId,issuedAtMs,expiresAtMs,
 applicationId,launchId,channelKey}
```

`requestId`/`launchId` are `Id32`. Lifetime is at most 30,000 ms and within the saved challenge. The verifier looks up the current access key using the authoritative binding, never a supplied key. It compares every identity field, consumes the challenge atomically with session allocation, intersects effective grants with the registered app's maximum rights and validates the temporary key. Native preparation can be asynchronous, but authorization and main/server generations must be rechecked after it, before a session becomes visible.

Signed response kind `session` body:

```
{sessionId,gatewayGeneration,applicationId,launchId,channelKeyThumbprint,
 issuedAtMs,expiresAtMs,presenceExpiresAtMs,heartbeatIntervalMs:1000,
 authorization:{boxId,boxKeyThumbprint,ownershipEpoch,
   authorizationVersion,principalSecurityVersion,bindingId,bindingRevision,
   principalId,clientId,grants,grantExpiresAtMs}}
```

`grantExpiresAtMs` is `null` or `TimeMs`. A session's hard lifetime is at most 300,000 ms and within effective grant expiry. Initial presence is at most 3000 ms from server issue time. No response includes native UID, upstream credential or channel private key. A session ID is never returned as `access_token` or stored in legacy token slots.

At hard expiry a still-unlocked main may establish a fresh session/key and reconnect; existing connections do not mutate to the new identity. Creation failure remains failure, never a cloud login attempt.

Before hard expiry, authenticated renewal has an independent finite admission path. `POST /local-trust/v1/data/renewal-challenge` takes exactly `{proof}`. Type `centuarai-local-data-renewal+jws`, purpose `centuarai.local-data.renewal`, and exact payload is the channel-common fields below plus `{requestId,channelKey}`. Its lifetime is at most 3000 ms and the **old channel key** signs the proposed new request ID and new P-256 channel public key. The old session/application/launch remain exact; the new key differs from both old channel and Access keys. The response is the existing signed `session-challenge` kind.

`POST /local-trust/v1/data/renewals` then takes exactly `{accessProof}` using the normal Access-signed session schema. The proposal's request ID, new channel key, application and launch must match exactly. Both admission steps recheck the old session's current authority and live fence; commit cannot expand the saved resource/actions or grant-expiry ceiling. A new session gets its own hard deadline; no old session or connection gains time. An anonymous challenge cannot enter this commit path, and a renewal challenge cannot enter ordinary `/sessions`. Main never falls back to anonymous or cloud authentication when renewal fails.

Existing-session control has 64 concurrent slots, independent of the 32 initial-handshake slots. There are 128 authenticated renewal challenges, independent of the 256 Access-PoP initial challenges; one unused proposal per old session, and at most 32 accepted renewal proposals per binding per 60 seconds. A fresh signed retry may replace its own unused proposal while consuming the same finite budget; late Access proofs for the replaced challenge are denied. Authenticated renewals use no source-IP bucket, so devices behind the same LAN/NAT/P2P endpoint do not consume one another's anonymous allotment. Existing global session, replay, authority-query and operation caps still apply.

Applications do not derive a generic bearer from a shell session. `deriveApplication({applicationId,launchId})` is a **main-only** operation which establishes a separately scoped session through this protocol, after validating the registered app/child identity. Product ID `super-advisory` is not interchangeable with a manifest application ID. `wanx-host` is a named first-party policy, not a wildcard. Unknown applications and missing resource mappings are rejected.

The shared desktop transport seam is:

```
DataSession.request({path,method,headers,body,signal,stream=false,
                     idleTimeoutMs,freshConnection})
  -> Promise<{status,headers,body}>  // bounded Buffer or live guarded IncomingMessage
DataSession.openWebSocket({path,headers,protocols,signal})
  -> Promise<ws>                   // OPEN, briefly paused until the consumer attaches
```

`body` can be bounded bytes/string/JSON or a Readable; main snapshots/serializes it once and stages Readables before signing. `path` is validated against the local application policy and is never an arbitrary origin. Caller timeout options can only tighten configured limits. No return value contains proofs, keys or a legacy token. The implementation fences both pre-return work and continued stream/frame delivery. It must not drop early WS frames while transitioning to the registered consumer. Desktop/mobile start messages contain no legacy token; trusted native scope supplies identity. WebSocket proof is required at HTTP upgrade, not deferred until an application frame.

## 5. Heartbeat, close and presence

Main sends a channel-key heartbeat every 1000 ms only while its captured profile/window/application generation remains unlocked and active. There is no renderer-provided presence boolean.

`POST /local-trust/v1/data/heartbeat` takes `{proof}`. Fixed type `centuarai-local-data-heartbeat+jws`:

```
{schemaVersion:1,purpose:"centuarai.local-data.heartbeat",
 boxId,sessionId,gatewayGeneration,applicationId,launchId,
 jti,sequence,issuedAtMs,expiresAtMs}
```

`sequence` is a positive safe integer strictly greater than the last accepted heartbeat sequence; limited gaps are allowed for lost requests, so a lost response does not permanently desynchronize the session. `jti` is fresh `Id32`. Lifetime is at most 3000 ms. Signature, current presence/hard deadline, generation, app/launch, latest authority and replay state are checked before advancing it.

Crucially, the new deadline is no later than **both** `issuedAtMs + 3000` and `expiresAtMs`, as well as server-now + 3000 and all session/grant deadlines. Receiving a delayed heartbeat does not buy three new seconds. An expired or closed session can never be revived, even by a correctly signed heartbeat.

Signed response kind `heartbeat` body:

```
{sessionId,sequence,issuedAtMs,presenceExpiresAtMs,authorizationVersion,bindingRevision}
```

`POST /local-trust/v1/data/close` takes `{proof}`. Fixed type `centuarai-local-data-close+jws`, with heartbeat's fields except `sequence`, plus `reason` exactly one of `lock`, `user-close`, `app-exit`, `superseded`. Purpose is `centuarai.local-data.close`; lifetime is at most 3000 ms. It only closes its own session. Signed response kind `closed` body is `{sessionId,closedAtMs}`. Repeated close can return the saved closed result only after validating the same channel identity; it cannot reopen anything.

Lock synchronously increments desktop generation, rejects new work, aborts pending/signing/handshake operations, clears rendered sensitive state, destroys channel keys and stops heartbeats. A best-effort close may use a proof prepared before destruction; it is not necessary for the three-second server deadline. Late promises/results cannot restore session state. Cloud logout may close local UI state but is not described as revoking the box binding.

## 6. Every data request: exact target and body binding

Every admitted HTTP request carries exactly one `X-Centuarai-Data-Proof` header. No `Authorization`, cookie, `token`/`access_token` query parameter, duplicate proof or first-frame token is accepted as an alternative. External callers cannot supply gateway/native identity headers. `sessionId` is found only inside the proof.

Fixed type `centuarai-local-data-request+jws`, signed by the captured channel key:

```
{schemaVersion:1,purpose:"centuarai.local-data.request",
 boxId,sessionId,gatewayGeneration,applicationId,launchId,jti,
 issuedAtMs,expiresAtMs,transport,method,rawTarget,headers,bodySha256,bodyBytes}
```

- Lifetime is at most 10,000 ms; this limits **admission**, not the duration of an already admitted operation.
- `transport` is exactly `http` or `websocket`. HTTP methods are an explicit uppercase registry set. WebSocket uses `method:"GET"` with `transport:"websocket"`.
- `rawTarget` is the exact ASCII origin-form raw path plus optional `?` and raw query, at most 8192 bytes. Compare ASGI `raw_path` and `query_string`, not a decoded/reencoded URL. Reject credentials, fragments, control characters, backslashes, traversal, slash aliases, ambiguous/double-encoded path forms and prohibited credential query fields before routing. Canonicalization must not turn an initially permitted path into another resource.
- `bodySha256` is `Digest32` of the exact HTTP entity bytes; `bodyBytes` is a nonnegative safe integer. Empty HTTP/WS bodies use SHA-256 of empty bytes and length zero.
- `headers` is exactly this object; each value is the single exact transmitted ASCII string or explicit `null`:

```
{contentType,range,ifRange,ifMatch,lastEventId,agentId,dataContext,
 idempotencyKey,webSocketKey,webSocketProtocol,spaceLink,contentSha256}
```

The mappings are `Content-Type`, `Range`, `If-Range`, `If-Match`, `Last-Event-ID`, `X-Octop-Agent-Id`, `X-Wanx-Data-Context`, `Idempotency-Key`, `Sec-WebSocket-Key`, `Sec-WebSocket-Protocol`, `X-Space-Link`, `X-Content-Sha256`. Duplicate selector headers are rejected. WebSocket fields are null for HTTP and reflect the actual upgrade for WS. Header values/aggregate length are bounded by the registry and transport header cap. `spaceLink` directly commits the exact capability header; it is not rewritten into `dataContext`. When present, `contentSha256` is recomputed as lowercase hex from the same entity bytes as `bodySha256`; no caller-supplied content digest is trusted instead of hashing bytes. Accept/encoding and other explicitly allowed transport-only headers cannot select another authority/resource; unknown security-relevant headers are denied, not forwarded implicitly.

The gateway verifies the signature against the saved channel key; checks session/presence/current authority/application; resolves resource and action from the fixed route registry; atomically reserves the `jti` and operation capacity; then reads any body. A failed/cancelled attempt burns that proof. Retry uses a new `jti`/proof; a business idempotency key stays unchanged only when the application supports that idempotency contract. The gateway never retries an uncertain mutation automatically.

`Range`/`If-Range` and SSE `Last-Event-ID` are signed on every new request. A WS reconnect always has a new proof, request ID and upgrade key. Successful WS admission does not authorize another connection.

## 7. Resource/application registry and native principal mapping

The route registry is mandatory and deny-by-default. Each entry defines exact method/path pattern, transport, application IDs, selector semantics, authority resource resolution, required action, request/response/frame limits and allowed upstream. A wildcard proxy rule or mapping every GET to `read` is insufficient: endpoints can execute work or expose credentials regardless of verb.

The initial resource catalog is fixed:

| Resource | Permitted principal scope |
| --- | --- |
| `wanx` | Current principal's Octop private surfaces, including personal space and clipboard; never system administration |
| `space`, `space:personal` | Explicit aliases for this principal's personal space only |
| `clipboard` | This principal's own notes only |
| `semantica` | This principal's own workspace collection only |

Shared or unknown resources are denied in this version. A catalog entry does not bypass the application and exact route registries.

The first registry must inventory personal spaces/files/chunks/links, agents/workspaces/chat, browser/desktop/mobile/terminal, application assets and Semantica desktop operations. It must distinguish readonly resources, mutations, execution, ownership/management actions and system-wide administration. All referenced IDs, paths, query/body resource selectors and existing native owners must resolve to the authenticated principal before forwarding.

Application policies are explicit entries; known examples include `wanx-host`, `centaurai.wanx.ai-browser`, `centaurai.wanx.centaurloop`, `centaurai.wanx.superadvisors`, `centaurai.wanx.dialogue`, `centaurai.wanx.zhijun`, `centaurai.wanx.semantica`, `centaurai.wanx.new-media-toolkit`, `centaurai.wanx.huohua-publisher`, and `ai.wanx.studio`. Listing an ID here grants nothing. Implementation must verify the actual registered manifest ID before adding its policy.

Native identity is a durable one-to-one mapping of `(boxKeyThumbprint,ownershipEpoch,principalId)` to a dedicated native user. The namespace is separate from cloud OIDC subjects and operator accounts. Only the trusted native mapper creates/resolves it; external requests never select native UID, username, role or another user's resource root. Include a stable native identity marker so a restored database reusing a numeric UID cannot inherit a different principal's data.

The gate puts its validated user/context in ASGI scope and `request.state.octop_user`. HTTP authentication and **all** browser/desktop/mobile/terminal/chat/notification WS helpers consume that scope in required mode. They must not independently accept query/start-message JWTs or skip the gate through a JWT exemption. No private-JWT compatibility fallback is part of this profile.

Local `manage` grants device-management authority; it does not automatically become native `admin`. Personal-space storage continues to use the correctly mapped UID. Semantica desktop uses an explicit principal warehouse scope. Semantica native is an instance-wide administrative API and requires a separately provisioned system resource capability or remains denied. Cloud licensing/billing may separately restrict a licensed feature, but cannot grant local data access or change the principal. There is no automatic adoption of old cloud-linked data; migration requires its own independently reviewed proof.

## 8. Large bodies and disk/memory backpressure

The desktop stages nonempty request bodies to a private temporary file with incremental SHA-256, verifies length/route cap, closes the file, then signs and sends fixed `Content-Length`. The gateway and native gate independently stage and verify the exact signed body **before** invoking a mutating upstream/handler. Never forward unverified bytes while waiting to compare a final hash. No pass-through of a renderer's asserted `X-Content-Sha256` is allowed.

Initial supported caps, subject to validation against the route inventory:

| Budget | Required initial bound |
|---|---|
| Ordinary upload route maximum | Preserve current registered maximum up to 100 MiB |
| Workspace archive maximum | Preserve current 200 MiB limit |
| Personal-space chunk | Existing 4 MiB chunk protocol remains preferred |
| Desktop staged bytes | 1 GiB total; 400 MiB per launch; at most two staging bodies per launch |
| Gateway + native host staged reservation | 1 GiB combined, reserve `2 * bodyBytes` before accepting a body; at most eight staging operations and two per binding |
| Staging deadline | 300 seconds absolute and 15 seconds without progress; continuous presence/authority checks still apply |
| In-memory body chunks | Bounded incremental buffers; no whole-body materialization |

These are enforcement caps, not measured throughput/capacity claims. Smaller route-specific limits take precedence. Unknown routes do not obtain the largest cap. Reserve declared bytes before disk allocation; check actual bytes continuously. Logical revocation does not release reservations: gateway `finish_operation` follows physical socket/file cleanup, and native `closed` follows its actual file cleanup. Cancelled thread I/O must drain before closing its file and freeing its slot. A closed record with either owner still unconfirmed retains capacity even after proof expiry; an unreachable native owner cannot create fictitious free disk. If real existing route requirements differ, revise the registry explicitly rather than silently truncating or falling back.

Staging directories/files are private, exclusive, no-follow and service-owned, with reviewed ACL handling on supported desktop platforms. Fixed names, symlinks, hardlinks and user-selected output paths are rejected. Open file handles bind the checked inode through verification/forwarding. Clean up on mismatch, disk-full, timeout, cancellation, lock, downstream failure and startup orphan recovery. A consumed/staged operation cannot be reused for another path/body. Recheck scope and presence after staging and immediately before each downstream side effect.

## 9. Gateway-to-native proof and private admission/lease API

Every upstream hop strips caller-supplied gateway/native identity headers and adds exactly one `X-Centuarai-Gateway-Proof`. Fixed type `centuarai-local-data-gateway-request+jws`, signed with the separate pinned gateway key:

```
{schemaVersion:1,purpose:"centuarai.local-data.gateway-request",audience,
 gatewayId,gatewayGeneration,sessionId,operationId,parentOperationId,jti,issuedAtMs,expiresAtMs,
 boxId,boxKeyThumbprint,ownershipEpoch,authorizationVersion,
 principalSecurityVersion,bindingId,bindingRevision,principalId,clientId,
 applicationId,launchId,transport,method,rawTarget,headers,bodySha256,bodyBytes,
 resourceId,action,serviceContext}
```

`audience` is a configured exact upstream identifier, initially `octop`, `semantica`, `semantica-mcp` or `clipboard`, never a caller-provided URL. `gatewayId` is a provisioned token; `operationId`/`jti` are `Id32`. `parentOperationId` is null for a direct gateway operation or the parent `Id32` for the restricted child hop below. The initial proof expires at most 2000 ms after issue and is minted only after the gateway validates its own staged body and current authority. The **native** raw target/headers/hash are signed after any permitted gateway rewrite; they are not silently copied from the external target. A rewrite must not expand the resolved resource/action. Native verifies every identity/scope field against the runtime's admitted operation.

`serviceContext` has an exact audience-specific schema, constructed by the trusted route adapter:

| Audience | Exact context |
|---|---|
| `octop` | `{kind:"principal",principalNamespace,clipboardScope}` |
| `semantica`, `semantica-mcp` | `{kind:"warehouse",principalNamespace,workspaceId,warehouseId,operation}` |
| `clipboard` | `{kind:"clipboard",principalNamespace,applicationId}` |

`principalNamespace` is SHA-256/base64url of canonical `{schemaVersion:1,purpose:"centuarai.local-data.principal",boxKeyThumbprint,ownershipEpoch,principalId}`. `workspaceId` is the trusted mapped token, `warehouseId` is a validated UUID or null, and `operation` is an exact registered Semantica operation. These values come from the accepted principal/resource mapping; body/query/legacy HMAC cannot override them. Required-mode Semantica constructs its integration scope from this verified context; its ordinary Bearer/HMAC and the MCP port are not alternate authorities. Clipboard must also run the gate, including its callbacks to Octop.

Direct Octop operations have `clipboardScope:null`. A clipboard child has exactly `{application:"wanx.clipboard",exportId,parent}`: ordinary private app-directory callbacks use both IDs `null`; a permitted export uses its fixed lowercase 32-hex `exportId` and fixed `parent` (32-hex or empty string for that principal's root). The gateway derives export constraints only from the fully staged, hash-verified parent export body; the broker never accepts a child-supplied replacement. Native storage checks the private app directory or exact export target inside the same transaction as its operation. `parentOperationId` is nonnull exactly when this Octop clipboard scope is nonnull.

Native operation replay protection cannot rely only on a native-process cache: Octop can restart while a two-second proof is still live. The unique gateway runtime atomically consumes the hop proof and binds it to the native process generation through a dedicated private UDS API.

The initial Linux adapter uses `/run/centuarai-local-trust/native-gate.sock`, outside the authority's 0700 directory. Its parent is operator-managed, its socket permissions are limited to the configured native identity, and `SO_PEERCRED` checks the expected UID. Containers receive only the required socket directory. Unsupported peer-credential/ACL adapters fail closed. This endpoint is not reachable through either public gateway or legacy proxy.

All UDS bodies are bounded exact JSON and use these fixed operations:

- `POST /v1/admit`: `{gatewayProof,nativeGateGeneration,gateNonce}`. Native has verified the proof's signature, target/header consistency and freshness. Runtime verifies the proof again against the pending operation and consumes its `jti` once. State becomes `staging` for that exact native generation. An already consumed proof is rejected, including after native restart.
- `POST /v1/activate`: `{operationId,nativeGateGeneration,gateNonce,bodySha256,bodyBytes}`. Only the previously admitted operation can activate, after native independently completes body verification and live checks. It cannot change identity, resource, action or request bytes.
- `POST /v1/check`: `{operationId,nativeGateGeneration,gateNonce}`. Only checks an already admitted/active operation; unknown IDs cannot create authority. Native calls at intervals no longer than 1000 ms and watches local expiry at intervals no longer than 250 ms.
- `POST /v1/closed`: `{operationId,nativeGateGeneration,gateNonce,outcome}` where outcome is `completed`, `cancelled`, `denied` or `outcome-unknown`. It terminates the operation and records closure evidence. It cannot reauthorize it.

- `POST /v1/child`: `{parentOperationId,nativeGateGeneration,gateNonce,audience,transport,method,rawTarget,headers,bodySha256,bodyBytes}`. Only the configured service UID currently executing the admitted active parent can call it. The runtime resolves a fixed child-route rule and creates a new operation/proof with the same identity, application, binding, principal namespace and deadlines, narrowed resource/action and a server-constructed `serviceContext`. It returns a raw gateway-request JWS. Initially allow only `clipboard -> octop` registered personal-space callbacks and `semantica-mcp -> semantica` registered native callbacks. Children cannot issue grandchildren. They cannot outlive the parent, continue after its revocation or widen its resource/action; unknown call graphs are denied. Callers never receive the gateway signing key and cannot reuse the parent's proof for a different target. The child receiver verifies the actual body/selector-to-resource relationship before running a handler, not merely the claimed body digest. Every child still performs one-time `/v1/admit` and guarded activation.

Every successful UDS reply is a raw compact JWS with type `centuarai-local-data-gateway-lease+jws` and exact payload:

```
{schemaVersion:1,purpose:"centuarai.local-data.gateway-lease",audience,
 gatewayId,gatewayGeneration,nativeGateGeneration,gateNonce,
 sessionId,operationId,parentOperationId,gatewayProofDigest,state,
 ownershipEpoch,authorizationVersion,principalSecurityVersion,
 bindingId,bindingRevision,principalId,clientId,applicationId,launchId,
 resourceId,action,issuedAtMs,expiresAtMs}
```

`state` is `staging`, `active` or `closed`; the caller must expect the correct state for its phase. `gatewayProofDigest` hashes the exact initial compact gateway proof. `gateNonce` is fresh `Id32` chosen for this UDS call. Lease expiry is at most 1000 ms and never exceeds presence/session/grant expiry or cached authority freshness. Denial returns no lease. A closed response acknowledges termination, not live permission.

Initial proof expiry applies at `admit`; a large upload may continue under its existing operation leases after those two seconds. `activate` rechecks everything before a handler runs. The native gate's ASGI wrapper covers both receive and send, closes idle or blocked operations when checks fail, and cancels/disposes downstream tasks. No business handler runs on a `staging` lease. Gateway restart changes generation and invalidates every session/proof/operation; native restart cannot revive a consumed operation.

### Native application resource preparation

Only an already admitted and activated `wanx-host` Octop operation for `POST /api/platform/applications/readiness`, `/prepare`, or `/candidates/prepare` may call private `POST /v1/authorize-resources`. Its exact body is `{operationId,nativeGateGeneration,gateNonce,grants}`. `grants` is a nonempty sorted evidence-v1 grant list derived by the native adapter from its verified artifact manifest, never trusted from a renderer. Initial preparation admission may select an existing read/write resource; it authorizes bounded validation only. No preparation side effect occurs before this complete batch is authorized against both the original application session ceiling and current authority.

The response is a separate JWS type `centuarai-local-data-gateway-resources+jws`, with purpose `centuarai.local-data.gateway-resources`. Its exact payload is the gateway-lease schema plus `grants` and `requestDigest`; `requestDigest` is SHA-256/base64url of the canonical entire request body. `state` is `active`, audience is `octop`, application is `wanx-host`, `parentOperationId` is null, and expiry is at most 1000 ms bounded by the same presence/authority freshness rules. The existing `gatewayProofDigest` commits the original admitted request, including its body and route. The native process must verify all lease context fields, its fresh nonce, the request digest and exact grant set. The first authorization freezes that operation's complete batch; later calls must name the same set. Every subsequent live check rechecks the entire batch. This endpoint cannot create a session, change principal, select another operation, or authorize an unrelated route.

## 10. Response envelopes, errors and revocation effects

Control responses use the independent box key pinned by the descriptor. Type `centuarai-local-data-response+jws`, exact envelope:

```
{schemaVersion:1,purpose:"centuarai.local-data.response",boxId,boxKeyThumbprint,
 kind,issuedAtMs,body}
```

Kinds and exact bodies are defined above plus `effect` below. Consumers choose the expected kind from the requested operation, verify box identity/signature and bind response fields to the saved challenge/session/request. Standard data response bodies remain the registered application's native format over the pinned connection; native/gateway control credentials are stripped from all responses and redirects. All control and sensitive data responses are `Cache-Control:no-store`; log redaction includes proof headers/query aliases, claim secrets, passphrases, UDS leases and body staging paths.

Errors have exact bounded JSON `{code}`. Initial data codes are `LOCAL_DATA_INVALID`, `LOCAL_DATA_REQUIRED`, `LOCAL_DATA_FORBIDDEN`, `LOCAL_DATA_SESSION_CLOSED`, `LOCAL_DATA_SESSION_EXPIRED`, `LOCAL_DATA_REPLAY`, `LOCAL_DATA_CONTEXT_CHANGED`, `LOCAL_DATA_BODY_MISMATCH`, `LOCAL_DATA_BODY_TOO_LARGE`, `LOCAL_DATA_STAGING_UNAVAILABLE`, `LOCAL_DATA_CAPACITY`, `LOCAL_DATA_AUTHORITY_UNAVAILABLE` `LOCAL_DATA_CLOCK_ROLLBACK`, `LOCAL_DATA_ROUTE_DENIED`, `LOCAL_DATA_SCOPE_DENIED`, `LOCAL_DATA_UNAVAILABLE` and `LOCAL_DATA_CAPABILITY_REQUIRED`. No arbitrary exception/message is returned. Authentication/unknown identity errors do not enumerate bindings. Client allowlists enumerate reviewed codes, not a wildcard prefix.

Ledger changes commit before notification. The runtime invalidates matching caches/sessions immediately when notified; polling remains the independent fallback. Lock closes one session; binding/principal/ownership changes close exactly the affected sessions and operations. A changed global version must never cause privilege growth.

The effect `operationId` is exactly the original ledger mutation `requestId`. Effect observation is exposed only through ledger-v2 `/v2/read` operation `data-effect`, with fresh currently authorized manager proof and matching scope, never an unauthenticated polling route or a revoked historical actor. This operation returns this profile's signed `effect` envelope directly; consumers choose the fixed data verifier by operation and do not guess its type. Missing effect providers yield `unknown`. Exact `effect` body for the UI:

```
{operationId,targetScope:{kind,id},authorizationVersion,committedAtMs,deadlineMs,
 effectState,gateway:{generation,targetSessions,closedSessions,pendingSessions},
 native:{targetOperations,closedOperations,pendingOperations,unknownOperations},
 observedAtMs,evidenceDigest}
```

`targetScope.kind` is `session`, `binding`, `principal` or `ownership`; its ID is the corresponding scoped identifier. Counts are nonnegative safe integers. `effectState` is `pending`, `effective`, `failed` or `unknown`. `deadlineMs=committedAtMs+5000`. `evidenceDigest` is `Digest32` over the canonical, credential-free audit evidence correlated to this operation. `effective` requires positive evidence that all affected channels/operations closed and the complete configured gate participant set is ready; zero target counts alone cannot establish effectiveness when a gate is missing or unreachable. Unknown outcomes remain `unknown`/`failed`, even after the timer. A management commit ACK does not claim that connections have already closed. Desktop lock is an immediate local fact; it does not unlock keys to poll a remote effect. Remote effect remains unknown unless a valid pre-lock close response or a later independently authorized read supplies evidence.

Native handler cancellation cannot undo a committed mutation or prove that an external job had no side effect. Report uncertain side effects as such and never retry them blindly. The five-second transport guarantee is measured from authoritative revoke commit, or desktop lock invocation, to the last delivered byte/frame and channel closure. Use a correlated same-host monotonic fixture observation or the conservative interval from before mutation submission until observed closure; subtracting different machines' wall-clock timestamps is not a valid measurement. The UI never infers effectiveness from a local countdown. This guarantee does not claim to erase previously downloaded data.

The physical tracker receives only first successful SQL commits through the same authority's private commit observer; historical retries do not create new evidence. `get_effect_commit(requestId)` returns exactly `{operationId,targetScope,authorizationVersion,committedAtMs,deadlineMs,affectedBindingIds,affectedJobs,affectedJobsComplete}` from the committed signed event/ACK. `affectedBindingIds` includes invalidated lineage descendants, not only the directly named binding. The runtime calls `sessions.observe_commit(value)` and then invalidates authority; disconnection of the management requester does not cancel this work. `sessions.effect_snapshot(requestId,expected)` is a synchronous read of an immutable, bounded publication and never calls SQLite or the event loop from the authority thread. Initial bounds are 128 effect histories and 512 credential-free session/operation history records; missing or evicted required history produces `unknown`.

Complete participant evidence uses private UDS `POST /v1/observe` with exact body `{nativeGateGeneration,gateNonce,activeOperationIds}`. The sorted unique `Id32` array contains at most 128 operations still awaiting native handler/file cleanup. Kernel peer UID selects the audience, as for all broker calls. Its separate type is `centuarai-local-data-gateway-observation+jws`, purpose `centuarai.local-data.gateway-observation`; exact payload `{schemaVersion:1,purpose,audience,gatewayId,gatewayGeneration,nativeGateGeneration,gateNonce,requestDigest,accepted,issuedAtMs,expiresAtMs}`. `accepted` is a boolean indicating an exact inventory match; this response grants no session, request, resource or lease authority. `requestDigest` commits to the complete request body, and validity is at most 1000 ms. Unknown IDs, generation changes hiding outstanding work, replayed nonces, a missing configured audience or stale reports prevent positive effect evidence. Native gates report at startup, at most every 500 ms and after actual cleanup; reporting never renews operation leases.

The gateway invokes the trusted runtime ASGI extension `scope.extensions["centuarai.local_data.transport"].close_and_wait()` only after worker, upstream and staged-file cleanup. The extension returns true only after the real protocol `connection_lost` callback. A response body terminator, cancellation flag, logical close or elapsed timeout is insufficient. Each data HTTP response explicitly advertises `Connection: close`, so a client cannot reuse a connection being closed for evidence; native HTTP hops also explicitly close. Native `closed` acknowledgements follow actual handler and staging cleanup. A final `effective` record is a historical fact, retained within the bounded effect history; missing transport support or unconfirmed native cleanup remains `unknown`.

Privileged durable backup/restore workers are additional required participants, independent of DataSession admission. Internal `affectedJobs` contains sorted `{operationId,attempt,stateVersion,bindingId,principalId,ownershipEpoch,authorizationVersion}` descriptors, including historical attempts and terminal jobs whose physical cleanup is not yet proven. It is capped at 128; `affectedJobsComplete=false` explicitly prevents positive effect evidence after truncation. Original job-authorization ACKs supply the authorization version. Database state `failed`, `completed`, lease expiry, or absence from the runnable queue does not prove that copy threads or SQL publication stopped.

The fixed same-process provider seam is `install_effect_observer(callback)`. It publishes exactly `{workerBootId,sequence,ready,jobs}` at registration, at most every 500 ms and after cleanup; `jobs` is the complete bounded sorted descriptor list above plus `{phase,publicationPending}`. `phase` is `active`, `closed` or `unknown`; `closed` requires `publicationPending=false` and all actual execution/file/SQL threads drained. Runtime forwards through a coalesced, bounded callback to `sessions.observe_worker`. Positive effects require fresh ready worker inventory, the captured boot, exact attempt/identity/epoch/authorization version and nondecreasing state version. Provider presence without readiness, stale observations, missing jobs, unresolved publication or a changed boot remain unknown. A fixed exclusive worker lock held until all threads drain is required before a replacement worker can reconcile prior attempts; successful restart never reconstructs lost effect histories. The public effect's `native` operation counts include these durable jobs, while `evidenceDigest` commits to their separate worker provenance.

## 11. Bounded state and injection contract

`LocalDataSessions` owns only ephemeral session/challenge/replay/operation state under one internal lock. It is constructed once per runtime with:

```
LocalDataSessions(
  authority,             // existing instance: get_authorization; never constructs a writer
  execute_authority,     // bounded executor admission + trusted execution-time clock
  box_id, box_key_thumbprint, gateway_id,
  box_response_signer,   // (kind,body,now_ms) -> box response JWS
  gateway_signer,        // (payload) -> gateway request JWS
  gateway_verifier,      // (proof,now_ms) -> gateway request payload
  gateway_lease_signer,  // (payload) -> gateway lease JWS
  gateway_resources_signer, // (payload) -> fixed native resource-batch JWS
  gateway_observation_signer, // (payload) -> inventory evidence JWS, never a lease
  required_audiences,     // exact configured native participant set
  worker_required,       // true when the runtime installs its durable-operation provider
  wall_clock_ms, monotonic_clock,
  application_policy, route_policy, child_policy,
  on_operation_closed   // (operation_snapshot,reason), optionally async
)                       // Python keyword arguments
```

Its transport-facing operations are `challenge`, `renewal_challenge`, `create_session`, `heartbeat`, `close_session`, `admit_request`, `activate_request`, `gateway_request`, `assert_live`, `finish_operation`, `native_admit`, `native_activate`, `native_check`, `native_closed`, `native_authorize_resources`, `native_observe`, `child_hop`, `bind_clipboard_export`, `bind_mcp_operation`, `invalidate_authority`, `sweep` and `close`. Private runtime evidence operations are `observe_commit`, `observe_worker` and the synchronous `effect_snapshot`; none grants authority. The runtime calls `sweep()` every at most 250 ms even without incoming traffic. Methods accept validated typed inputs/immutable request observations, not ASGI requests or caller-marked trust. No slow crypto, filesystem, authority executor or upstream I/O runs while holding the ephemeral-state lock. Reserve state first; after every await recheck generation/closed state before publishing any result.

`application_policy(applicationId,launchId,view)` returns the attenuated `Grants`. `route_policy(context,observation)` and `child_policy(parentSnapshot,childBody)` return exactly `{audience,resourceId,action,serviceContext,bodyLimit,upstreamPath}`; `upstreamPath` is the final exact raw origin-form target. Request observations contain exactly `{transport,method,rawTarget,headers,bodySha256,bodyBytes}`. Detached operation snapshots contain `{operationId,sessionId,parentOperationId,context,route,bodySha256,bodyBytes,state,constraints}`. Context is the authorization response DTO plus `applicationId`, `launchId` and `principalNamespace`, without a key or a bearer. A fixed child route may narrow parent `write`/`execute` to `read` only when the session separately holds that read right. Read parents never create write/execute children; write never becomes execute. Policy callbacks are trusted static route resolution and must not perform I/O.

The paired protocol modules expose finite helpers, with matching schemas and test vectors:

```
// JavaScript device-trust/data-contract.mjs
signSession(payload, accessPrivateKey) -> compactJws
signSessionIntent(payload, accessPrivateKey) -> compactJws
signHeartbeat(payload, channelPrivateKey) -> compactJws
signRenewal(payload, oldChannelPrivateKey) -> compactJws
signClose(payload, channelPrivateKey) -> compactJws
signRequest(payload, channelPrivateKey) -> compactJws
verifyDataResponse(jws, {descriptor,kind,nowMs,expected}) -> frozenEnvelope
validateSessionPayload(payload) -> frozenClone
validateSessionIntentPayload(payload) -> frozenClone
validateRequestPayload(payload) -> frozenClone

# Python wanx_bridge/local_data_protocol.py
decode_session_locator(jws) -> unverified locator
decode_session_intent_locator(jws) -> unverified locator
decode_channel_locator(jws, *, kind) -> unverified locator
verify_session_proof(jws, access_key, *, now_ms) -> validated payload
verify_session_intent(jws, access_key, *, now_ms) -> validated payload
verify_channel_proof(jws, channel_key, *, kind, now_ms) -> validated payload
sign_data_response(box_key, *, box_id, kind, body, now_ms) -> compact_jws
```

`kind` for channel proof verification is the caller-fixed enum `heartbeat`, `close`, `request` or `renewal`; incoming JWS metadata does not choose it. A locator is used only to find a pinned key, never to authorize or disclose metadata. The sessions layer performs current authority, expected identity, challenge, replay and live-state checks after cryptographic verification. `expected` binds required response body fields by canonical exact comparison. Main's vault exposes only `signDataSession` backed by the finite session helper; channel signers remain private to main's `DataSession`. Native hop signing/verification is owned by the runtime/gate module and is not a desktop export.

Initial bounds: 256 live sessions total / 32 per binding; 256 outstanding initial session challenges / 32 per binding; 1024 unexpired replay entries per session / 16,384 total; 128 active operations total / 16 per session. Rejected anonymous initial attempts use kernel-peer source buckets (32 burst, 4 tokens/second, 128 source entries, 30-second idle expiry), plus at most 32 concurrent initial control operations. A valid Access PoP is not charged to an exhausted anonymous bucket; forwarding headers cannot select a bucket. Existing-session heartbeat/close/renewal have separate bounded control admission. Never evict a live replay tombstone to make room. Entries can be pruned only after their signed admission interval is irreversibly expired or their entire session/generation is dead. Capacity returns a fixed error before allocating or forwarding. These admission guarantees do not claim protection from saturation of the underlying TLS CPU or network link.

All streams have bounded queued bytes and frame sizes specified by their registered route. `max_size=None`, unbounded send queues and unbounded waiting for a slow client are prohibited. Admission, staging, upstream start and native checks have bounded waits. If overload prevents fresh authority, fail closed rather than promising the five-second bound while serving stale data.

## 12. Required verification matrix

1. **Cross-language protocol:** fixed canonical vectors, signatures, tampering, wrong type/algorithm/curve/pin, unknown/duplicate fields, negative/unsafe values, milliseconds/seconds confusion, altered key/session/application/launch.
2. **Session/replay:** wrong access key, stale/reused challenge, concurrent consumes, delayed heartbeat, replayed/out-of-order heartbeat, no resurrection, session hard expiry, runtime/native restart and hop-proof replay after native cache loss.
3. **Every transport entry:** main/browser HTTP, manifest, ordinary/desktop/mobile/chat WS, SSE reconnect, HEAD, Range/If-Range, download, multipart/chunk/archive upload and application child requests. New connection requires new proof.
4. **No fallback:** cloud ticket/bearer, native JWT, login/OIDC/app exchange, cookies/query/start tokens, spoofed gateway headers, direct native loopback, internal MCP and unknown/non-API paths all fail in required mode.
5. **Scope isolation:** same-principal authorized devices can access their permitted resources; another principal, wrong app/launch, different agent/space/warehouse, system admin route and changed selector cannot borrow that identity. Restored numeric UID collision fails.
6. **Bodies/limits:** actual bytes differ from signed hash/length, headers change, duplicate headers, slow/oversize upload, disk quota/full, symlink/hardlink/inode replacement, cancellation/lock during all staging phases, uncertain upstream commit and business-idempotent retry.
7. **Live invalidation:** real active and idle HTTP/WS/SSE/Range/upload channels; lock, binding/principal/ownership revocation, authority outage, restart and clock rollback. Observe last bytes/frames and actual closure, not only counters. Verify less than five seconds under the documented test load and runtime configuration.
8. **Effects/UI:** pending ACK versus effective closure; unreachable native gate remains unknown; stale async result cannot repopulate locked UI or recreate a session; cloud logout is not mislabeled as box revocation.

Use synthetic identities and private temporary storage only. Record tested environment, concurrent load, body/frame sizes and observed maximum closure delay. Do not infer production capacity from the configured limits or a small fixture.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAccount } from "../account/index.mjs";
import { createRemoteSupport, readSupportRequest } from "../account/support.mjs";

const NOW = Date.parse("2026-10-17T08:00:00Z");
const DEVICE = "centauros-0123456789abcdef01234567";
const OTHER = "centauros-abcdef0123456789abcdef01";
const owner = (extra = {}) => ({ deviceId: DEVICE, role: "owner", status: "active", ownershipEpoch: 7, online: false, ...extra });
const immutableKeys = ["requestId", "deviceId", "identityDeviceId", "operatorId", "operatorName", "ownerBindingId", "ownershipEpoch", "reason", "scope", "durationMinutes", "createdAt", "requestExpiresAt"];
function request(extra = {}) {
  const value = {
    requestId: "request-1", deviceId: "inventory-102", identityDeviceId: DEVICE,
    registryDeviceId: DEVICE, operatorId: "operator-1", operatorName: "运维人员",
    ownerBindingId: "binding-1", ownershipEpoch: 7, reason: "检查桌面连接", scope: "support.vnc",
    durationMinutes: 10, createdAt: "2026-10-17T07:59:00Z", requestExpiresAt: "2026-10-17T08:05:00Z",
    decision: "pending", authorization: "none", supportSessionId: null,
    supportRevision: 3, observation: null, audit: [], ...extra,
  };
  const immutable = Object.fromEntries([...immutableKeys].sort().map(key => [key, value[key]]));
  return { ...value, requestDigest: createHash("sha256").update(JSON.stringify(immutable)).digest("hex") };
}
const approved = (extra = {}) => request({ decision: "approved", authorization: "active", supportSessionId: "session-1",
  approvedAt: "2026-10-17T08:00:00Z", expiresAt: "2026-10-17T08:10:00Z", supportRevision: 4, ...extra });
const decisionInput = (extra = {}) => ({ deviceId: DEVICE, ownershipEpoch: 7, requestId: "request-1", requestDigest: request().requestDigest,
  decision: "approved", confirmed: true, ...extra });
const revokeInput = (extra = {}) => {
  const { decision, ...input } = decisionInput();
  return { ...input, supportSessionId: "session-1", ...extra };
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}) {
  let phase = "authenticated", identity = { accountId: "owner-1", clientId: "client-1" };
  let rows = [owner()], current = options.current ?? request();
  const listeners = new Set(), calls = [];
  const account = {
    // No P2P client, platform or current-box dependencies are supplied.
    snapshot: () => ({ phase, devices: [owner()] }), getIdentity: () => identity,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async listDevices() { calls.push(["devices"]); return options.listDevices ? options.listDevices() : rows; },
    async request(input) {
      calls.push(["request", structuredClone(input)]);
      if (options.request) return options.request(input);
      if (!input.method) return current;
      return input.method === "POST" ? input.body.decision === "approved" ? approved() : request({ decision: "rejected" })
        : approved({ authorization: "revoked", supportRevision: 5 });
    },
  };
  const service = createRemoteSupport({ account, now: () => NOW, wait: options.wait || (async () => {}) });
  t.after(() => service.close());
  return { service, calls, listeners,
    devices(next) { rows = next; }, current(next) { current = next; },
    publish(nextPhase, nextIdentity = identity) {
      phase = nextPhase; identity = nextIdentity;
      for (const listener of listeners) listener({ phase });
    },
  };
}

test("cloud current reads the explicitly selected offline Owner box without a business connection", async t => {
  const h = harness(t);
  assert.deepEqual(await h.service.current({ deviceId: DEVICE }), { deviceId: DEVICE, ownershipEpoch: 7, request: readSupportRequest(request(), owner(), NOW) });
  assert.deepEqual(h.calls, [["devices"], ["request", { path: `/app-api/devices/${DEVICE}/support-requests/current` }]]);
  h.current(null);
  assert.deepEqual(await h.service.current({ deviceId: DEVICE }), { deviceId: DEVICE, ownershipEpoch: 7, request: null });
});

for (const [name, status, body] of [
  ["busy envelope", 409, { code: 409, msg: { errorCode: "SUPPORT_AUTHORIZATION_BUSY", message: "SUPPORT_AUTHORIZATION_BUSY" } }],
  ["HTTP 200 with business 500 deadlock envelope", 200, { code: 500, msg: "服务器内部错误" }],
  ["HTTP 500 envelope", 500, { code: 500, msg: "服务器内部错误" }],
]) test(`production ${name} crosses the account transport and retries only current before one decision`, async t => {
  let saved = null, reads = 0, decisions = 0;
  const waits = [];
  const reply = data => new Response(JSON.stringify({ code: 200, data }));
  const account = createAccount({
    store: { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); }, clear: async () => { saved = null; } },
    fetch: async (url, options) => {
      if (url.endsWith("/login")) return reply({ accountId: "owner-1", clientId: JSON.parse(options.body).clientId,
        accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 3600 });
      if (url.endsWith("/devices")) return reply([owner()]);
      if (url.endsWith("/support-requests/current")) {
        reads++;
        if (reads <= 2) return new Response(JSON.stringify(body), { status });
        return reply(request());
      }
      assert.equal(url.endsWith("/support-requests/request-1/decision"), true);
      assert.equal(options.method, "POST");
      decisions++;
      return reply(approved());
    },
  });
  t.after(() => account.close());
  await account.loginSMS({ phone: "13800138000", code: "123456" });
  const service = createRemoteSupport({ account, now: () => NOW, wait: async ms => { waits.push(ms); } });
  t.after(() => service.close());
  assert.equal((await service.decide(decisionInput())).request.authorization, "active");
  assert.equal(reads, 3);
  assert.equal(decisions, 1);
  assert.deepEqual(waits, [250, 500]);
});

const busy = () => Object.assign(new Error("SUPPORT_AUTHORIZATION_BUSY"), { code: "SUPPORT_AUTHORIZATION_BUSY", status: 409 });
const serverFailure = () => Object.assign(new Error("ACCOUNT_REQUEST_FAILED"), { code: "ACCOUNT_REQUEST_FAILED", status: 500 });

for (const error of [busy(), serverFailure()]) test(`${error.code} current retries are bounded and never send a decision when exhausted`, async t => {
  const waits = [];
  const h = harness(t, { request: () => { throw error; }, wait: async ms => { waits.push(ms); } });
  await assert.rejects(h.service.decide(decisionInput()), { code: error.code, status: error.status });
  assert.equal(h.calls.filter(call => call[0] === "request").length, 4);
  assert.equal(h.calls.some(call => call[1]?.method), false);
  assert.deepEqual(waits, [250, 500, 1000]);
});

test("only current lock contention or a recognized 500 is retryable, never a decision or revoke", async t => {
  for (const error of [Object.assign(new Error("REQUEST_EXPIRED"), { code: "REQUEST_EXPIRED", status: 409 }),
    Object.assign(new Error("ACCOUNT_NETWORK_ERROR"), { code: "ACCOUNT_NETWORK_ERROR" }),
    Object.assign(busy(), { status: 403 }),
    ...[401, 403, 404, 409, 422, 502, "500", undefined].map(status => Object.assign(serverFailure(), { status })),
    Object.assign(new Error("ACCOUNT_INVALID_RESPONSE"), { code: "ACCOUNT_INVALID_RESPONSE", status: 500 })]) {
    const h = harness(t, { request: () => { throw error; }, wait: () => assert.fail("must not retry") });
    await assert.rejects(h.service.current({ deviceId: DEVICE }), { code: error.code });
    assert.equal(h.calls.filter(call => call[0] === "request").length, 1);
  }
  for (const kind of ["decide", "revoke"]) for (const error of [busy(), serverFailure()]) {
    const h = harness(t, { request: input => {
      if (input.method) throw error;
      return kind === "decide" ? request() : approved();
    }, wait: () => assert.fail("must not retry a mutation") });
    await assert.rejects(h.service[kind](kind === "decide" ? decisionInput() : revokeInput()), { code: error.code });
    assert.equal(h.calls.filter(call => call[1]?.method).length, 1);
  }
});

for (const error of [busy(), serverFailure()]) test(`account changes during ${error.code} read backoff cancel before another read or decision`, async t => {
  const delay = deferred();
  const h = harness(t, { request: () => { throw error; }, wait: () => delay.promise });
  const operation = h.service.decide(decisionInput());
  const rejected = assert.rejects(operation, { code: "SUPPORT_SESSION_CHANGED" });
  await flush();
  h.publish("authenticated", { accountId: "owner-2", clientId: "client-1" });
  delay.resolve();
  await rejected;
  assert.equal(h.calls.filter(call => call[0] === "request").length, 1);
});

test("server-valid multiline Unicode reason preserves the exact canonical digest bytes", () => {
  const value = request({ reason: "检查连接\n确认桌面\t状态\r\n" + "🔧".repeat(120) });
  assert.equal(readSupportRequest(value, owner(), NOW).reason, value.reason);
});

test("fresh cloud ownership overrides cached Owner state before every call", async t => {
  const h = harness(t);
  await h.service.current({ deviceId: DEVICE });
  for (const rows of [[], [owner({ deviceId: OTHER })], [owner({ role: "member" })], [owner({ status: "disabled" })],
    [owner({ ownershipEpoch: 0 })], [owner({ ownershipEpoch: "7" })]]) {
    h.devices(rows);
    const before = h.calls.filter(call => call[0] === "request").length;
    await assert.rejects(h.service.current({ deviceId: DEVICE }), { code: "OWNER_REQUIRED" });
    assert.equal(h.calls.filter(call => call[0] === "request").length, before);
  }
});

test("invalid, unsigned and injected mutation inputs cannot reach the account API", async t => {
  const h = harness(t);
  for (const input of [decisionInput({ confirmed: false }), decisionInput({ ownershipEpoch: "7" }), decisionInput({ decision: "approve" }),
    decisionInput({ deviceId: "../other" }), decisionInput({ requestDigest: "not-a-digest" }), decisionInput({ role: "owner" }), decisionInput({ url: "https://evil.invalid" })])
    await assert.rejects(h.service.decide(input), { code: "SUPPORT_INVALID_INPUT" });
  assert.deepEqual(h.calls, []);
  h.publish("signed_out", null);
  await assert.rejects(h.service.current({ deviceId: DEVICE }), { code: "ACCOUNT_LOGIN_REQUIRED" });
  assert.deepEqual(h.calls, []);
});

test("an ownership epoch change stops a decision before reading or mutating support", async t => {
  const h = harness(t);
  h.devices([owner({ ownershipEpoch: 8 })]);
  await assert.rejects(h.service.decide(decisionInput()), { code: "OWNER_CHANGED" });
  assert.deepEqual(h.calls, [["devices"]]);
});

for (const decision of ["approved", "rejected"]) test(`${decision} requires fresh matching request facts and sends only the frozen decision contract`, async t => {
  const h = harness(t);
  const result = await h.service.decide(decisionInput({ decision }));
  assert.equal(result.request.decision, decision);
  assert.equal(result.ownershipEpoch, 7);
  assert.deepEqual(h.calls.at(-1), ["request", { method: "POST", path: `/app-api/devices/${DEVICE}/support-requests/request-1/decision`,
    body: { decision, requestDigest: request().requestDigest } }]);
});

test("stale request identity, digest, expiry and completed decision never send a mutation", async t => {
  const h = harness(t);
  for (const current of [null, request({ requestId: "request-2" }), request({ reason: "changed reason" }),
    request({ requestExpiresAt: "2026-10-17T08:00:00Z" }), request({ decision: "rejected" }), approved()]) {
    h.current(current);
    await assert.rejects(h.service.decide(decisionInput()), { code: "SUPPORT_REQUEST_CHANGED" });
  }
  assert.equal(h.calls.some(call => call[1]?.method), false);
});

test("wrong-device, corrupted digest and invalid success receipts fail closed", async t => {
  let reply = approved();
  const h = harness(t, { request: input => input.method ? reply : request() });
  for (const bad of [null, {}, approved({ registryDeviceId: OTHER }), approved({ ownershipEpoch: 8 }),
    { ...approved(), reason: "tampered without new digest" }, approved({ authorization: "none" }),
    request({ decision: "rejected" }), approved({ supportRevision: 2 }), approved({ supportSessionId: "" })]) {
    reply = bad;
    await assert.rejects(h.service.decide(decisionInput()), error => ["SUPPORT_INVALID_RESPONSE", "SUPPORT_REQUEST_CHANGED"].includes(error.code));
  }
  reply = approved({ requestId: "another-request" });
  await assert.rejects(h.service.decide(decisionInput()), { code: "SUPPORT_REQUEST_CHANGED" });
});

test("revoke binds the current active session and accepts revocation without inventing device cleanup", async t => {
  const h = harness(t, { current: approved() });
  const result = await h.service.revoke(revokeInput());
  assert.equal(result.request.authorization, "revoked");
  assert.equal(result.request.observation, null);
  assert.deepEqual(h.calls.at(-1), ["request", { method: "DELETE", path: `/app-api/devices/${DEVICE}/support-sessions/session-1` }]);
  for (const current of [approved({ supportSessionId: "session-other" }), approved({ authorization: "revoked" }), approved({ authorization: "expired" })]) {
    h.current(current);
    const before = h.calls.filter(call => call[1]?.method).length;
    await assert.rejects(h.service.revoke(revokeInput()), { code: "SUPPORT_REQUEST_CHANGED" });
    assert.equal(h.calls.filter(call => call[1]?.method).length, before);
  }
});

test("revoke rejects active, foreign-session and regressed receipts", async t => {
  let reply;
  const h = harness(t, { request: input => input.method ? reply : approved() });
  for (const bad of [approved(), approved({ authorization: "revoked", supportSessionId: "different-session" }),
    approved({ authorization: "revoked", supportRevision: 3 })]) {
    reply = bad;
    await assert.rejects(h.service.revoke(revokeInput()), { code: "SUPPORT_INVALID_RESPONSE" });
  }
  reply = approved({ authorization: "expired", supportRevision: 5 });
  assert.equal((await h.service.revoke(revokeInput())).request.authorization, "expired");
});

for (const stage of ["ownership", "current", "decision"]) {
  for (const change of ["different-account", "same-account-relogin"]) test(`${change} invalidates an in-flight ${stage} result`, async t => {
    const pending = deferred();
    const h = harness(t, {
      ...(stage === "ownership" ? { listDevices: () => pending.promise } : {}),
      request: input => (stage === "current" && !input.method) || (stage === "decision" && input.method) ? pending.promise : request(),
    });
    const operation = h.service.decide(decisionInput());
    const rejected = assert.rejects(operation, { code: "SUPPORT_SESSION_CHANGED" });
    await flush();
    if (change === "same-account-relogin") {
      h.publish("signed_out", null);
      h.publish("authenticated", { accountId: "owner-1", clientId: "client-1" });
    } else h.publish("authenticated", { accountId: "owner-2", clientId: "client-1" });
    pending.resolve(stage === "ownership" ? [owner()] : stage === "decision" ? approved() : request());
    await rejected;
    assert.equal(h.calls.filter(call => call[1]?.method).length, stage === "decision" ? 1 : 0);
  });
}

test("an ordinary authenticated refresh preserves a pending operation", async t => {
  const pending = deferred();
  const h = harness(t, { listDevices: () => pending.promise });
  const operation = h.service.current({ deviceId: DEVICE });
  h.publish("authenticated");
  pending.resolve([owner()]);
  assert.equal((await operation).request.requestId, "request-1");
});

test("double clicks share no mutation and failures release the per-device lock for retry", async t => {
  const pending = deferred();
  let wait = true;
  const h = harness(t, { request: input => input.method ? wait ? pending.promise : approved() : request() });
  const first = h.service.decide(decisionInput());
  const failure = assert.rejects(first, { code: "ACCOUNT_NETWORK_ERROR" });
  await flush();
  await assert.rejects(h.service.decide(decisionInput()), { code: "SUPPORT_BUSY" });
  await assert.rejects(h.service.current({ deviceId: DEVICE }), { code: "SUPPORT_BUSY" });
  assert.equal(h.calls.filter(call => call[1]?.method).length, 1);
  pending.reject(Object.assign(new Error("ACCOUNT_NETWORK_ERROR"), { code: "ACCOUNT_NETWORK_ERROR" }));
  await failure;
  wait = false;
  assert.equal((await h.service.decide(decisionInput())).request.authorization, "active");
});

test("closing unsubscribes, invalidates pending reads and rejects new work", async t => {
  const pending = deferred();
  const h = harness(t, { listDevices: () => pending.promise });
  const reading = h.service.current({ deviceId: DEVICE });
  const rejected = assert.rejects(reading, { code: "SUPPORT_SESSION_CHANGED" });
  h.service.close();
  assert.equal(h.listeners.size, 0);
  pending.resolve([owner()]);
  await rejected;
  await assert.rejects(h.service.current({ deviceId: DEVICE }), { code: "SUPPORT_SESSION_CHANGED" });
  assert.deepEqual(h.calls, [["devices"]]);
});

test("only fresh observations matching the current revision and support identity can confirm cleanup", () => {
  const observation = { supportRevision: 5, requestId: "request-1", supportSessionId: "session-1", observedAt: "2026-10-17T07:59:59Z",
    connection: "disconnected", desktop: "closed", streamToken: "private" };
  const read = extra => readSupportRequest(approved({ authorization: "revoked", supportRevision: 5, observation: { ...observation, ...extra } }), owner(), NOW);
  assert.deepEqual(read().observation, { supportRevision: 5, requestId: "request-1", supportSessionId: "session-1", observedAt: observation.observedAt,
    connection: "disconnected", desktop: "closed" });
  for (const bad of [{ supportRevision: 4 }, { requestId: "other" }, { supportSessionId: "other" },
    { observedAt: "2026-10-17T07:59:29Z" }, { observedAt: "2026-10-17T08:00:06Z" }, { observedAt: "invalid" },
    { connection: "closed" }, { desktop: "deleted" }]) assert.equal(read(bad).observation, null);
  assert.equal(read({ requestId: null, supportSessionId: null }).observation.desktop, "closed", "device-wide idle cleanup is valid at the matching revision");
  assert.equal(read({ desktop: "cleanup_failed" }).observation.desktop, "cleanup_failed");
});

test("support projection excludes credentials, arbitrary endpoints and audit details", () => {
  const value = request({ accessToken: "private", operatorURL: "https://evil.invalid", connection: "disconnected", desktop: "closed",
    audit: [{ event: "request.created", actorId: "operator-1", at: "2026-10-17T07:59:00Z", details: { password: "private" } },
      { event: "bad", actorId: "invalid actor", at: "2026-10-17T07:59:00Z" }] });
  const result = readSupportRequest(value, owner(), NOW);
  assert.equal(result.observation, null, "top-level derived status cannot stand in for a device observation");
  assert.deepEqual(result.audit, [{ event: "request.created", actorId: "operator-1", at: "2026-10-17T07:59:00Z" }]);
  assert.doesNotMatch(JSON.stringify(result), /private|evil\.invalid|details|"desktop"|"connection"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApplicationSession } from "../app-host/session.mjs";
import { fromEnvironment } from "../host-sdk/index.cjs";

const context = { boxId: "box-1", connection: "ready", user: { id: 4 } };
const installPath = path.join(os.tmpdir(), "wanx-session", "test.application");
const createSession = options => createApplicationSession({
  hostApplicationId: "wanx-host", applicationId: "test.application", installPath,
  createConnection: () => ({ context: () => context }), ...options,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function readContext(environment, token = environment.WANX_HOST_TOKEN) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${environment.WANX_HOST_BASE_URL}/__wanx/context`, {
      agent: false, headers: { authorization: `Bearer ${token}` },
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
  });
}

test("each launch has its own HTTP credential and SDK close leaves the Host session usable", async t => {
  const first = await createSession();
  t.after(() => first.close());
  const second = await createSession();
  t.after(() => second.close());
  assert.notEqual(first.launchId, second.launchId);
  assert.notEqual(first.environment.WANX_HOST_TOKEN, second.environment.WANX_HOST_TOKEN);
  assert.equal(first.environment.WANX_HOST_LAUNCH_ID, first.launchId);
  assert.equal(first.environment.WANX_HOST_APPLICATION_ID, "wanx-host");
  assert.equal(first.environment.WANX_HOST_CLIENT_APPLICATION_ID, "test.application");
  assert.equal(first.environment.WANX_HOST_INSTALL_ROOT, installPath);
  assert.equal(first.environment.WANX_HOST_PROTOCOL_VERSION, "1");
  assert.equal(first.environment.WANX_HOST_SOCKET, undefined);
  assert.deepEqual(await readContext(second.environment, first.environment.WANX_HOST_TOKEN), {
    status: 401, body: { code: "HOST_UNAUTHORIZED" },
  });
  const client = fromEnvironment(second.environment);
  t.after(() => client.close());
  assert.deepEqual(await client.context(), context);
  client.close();
  assert.deepEqual(await readContext(second.environment), { status: 200, body: context });
  await first.close();
  assert.deepEqual(second.assertLive(), context);
});

test("close revokes synchronously, closes the listener once, and only releases the borrowed subscription", async t => {
  let unsubscribed = 0, connectionClosed = 0;
  const session = await createSession({ createConnection: () => ({
    context: () => context,
    subscribe: () => () => { unsubscribed++; },
    close: () => { connectionClosed++; },
  }) });
  t.after(() => session.close());
  const client = fromEnvironment(session.environment);
  t.after(() => client.close());
  await client.context();
  const invalidated = new Promise(resolve => client.onSessionInvalidated(resolve));
  const closing = session.close();
  assert.throws(() => session.assertLive(), { code: "HOST_SESSION_EXPIRED" });
  assert.equal(unsubscribed, 1);
  assert.equal(session.close(), closing);
  await closing;
  assert.equal((await invalidated).code, "HOST_SESSION_EXPIRED");
  await assert.rejects(readContext(session.environment), { code: "ECONNREFUSED" });
  assert.equal(connectionClosed, 0);
  assert.equal(unsubscribed, 1);
});

test("a creation signal does not revoke a published session", async t => {
  const controller = new AbortController();
  const session = await createSession({ signal: controller.signal });
  t.after(() => session.close());
  controller.abort();
  assert.deepEqual(session.assertLive(), context);
  assert.deepEqual(await readContext(session.environment), { status: 200, body: context });
});

test("creation canceled before connection acquisition does not acquire a connection", async () => {
  const controller = new AbortController();
  const reason = new Error("launch canceled");
  controller.abort(reason);
  let acquired = false;
  await assert.rejects(createSession({ signal: controller.signal,
    createConnection: () => { acquired = true; },
  }), error => error === reason);
  assert.equal(acquired, false);
});

test("a connection arriving after creation cancellation is never published or subscribed", async () => {
  const controller = new AbortController(), pending = deferred();
  const reason = new Error("launch canceled");
  let subscribed = false, connectionClosed = false;
  const creating = createSession({ signal: controller.signal, createConnection: () => pending.promise });
  const rejected = assert.rejects(creating, error => error === reason);
  controller.abort(reason);
  pending.resolve({ context: () => context,
    subscribe: () => { subscribed = true; }, close: () => { connectionClosed = true; },
  });
  await rejected;
  assert.equal(subscribed, false);
  assert.equal(connectionClosed, false);
});

test("connection acquisition failure preserves the original error", async () => {
  const error = Object.assign(new Error("not ready"), { code: "NETWORK_NOT_READY" });
  await assert.rejects(createSession({ createConnection: async () => { throw error; } }), value => value === error);
});

test("creation canceled after listening releases the subscription before rejecting", async () => {
  const controller = new AbortController(), reason = new Error("launch canceled");
  let unsubscribed = 0;
  await assert.rejects(createSession({ signal: controller.signal, createConnection: () => ({
    context: () => context,
    subscribe() { controller.abort(reason); return () => { unsubscribed++; }; },
  }) }), error => error === reason);
  assert.equal(unsubscribed, 1);
});

test("synchronous invalidation during subscription cleans up the late unsubscribe and rejects creation", async () => {
  let live = true, unsubscribed = 0;
  await assert.rejects(createSession({ createConnection: () => ({
    context() { if (!live) throw Error("NETWORK_CHANGED"); return context; },
    subscribe(changed) {
      live = false; changed();
      return () => { unsubscribed++; };
    },
  }) }), { code: "HOST_SESSION_EXPIRED" });
  assert.equal(unsubscribed, 1);
});

test("subscription setup failure closes creation resources and preserves the error", async () => {
  const error = new Error("subscription failed");
  await assert.rejects(createSession({ createConnection: () => ({
    context: () => context, subscribe() { throw error; },
  }) }), value => value === error);
});

for (const code of ["NETWORK_CHANGED", "SESSION_CLOSED", "GATEWAY_CLOSED", "PLATFORM_SESSION_EXPIRED", "HOST_SESSION_EXPIRED"]) {
  test(`${code} from the box permanently revokes the launch while retaining its HTTP error endpoint`, async t => {
    let calls = 0;
    const session = await createSession({ createConnection: () => ({
      context: () => context,
      request() { calls++; throw Object.assign(new Error(code), { code }); },
    }) });
    t.after(() => session.close());
    const client = fromEnvironment(session.environment);
    t.after(() => client.close());
    await client.context();
    await assert.rejects(client.request("/api/test"), { code: "HOST_SESSION_EXPIRED" });
    assert.throws(() => session.assertLive(), { code: "HOST_SESSION_EXPIRED" });
    assert.deepEqual(await readContext(session.environment), {
      status: 401, body: { code: "HOST_SESSION_EXPIRED" },
    });
    await assert.rejects(client.request("/api/test"), { code: "HOST_SESSION_EXPIRED" });
    assert.equal(calls, 1);
  });
}

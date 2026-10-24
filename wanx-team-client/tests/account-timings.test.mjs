import test from "node:test";
import assert from "node:assert/strict";
import { createAccount } from "../account/index.mjs";

const grantPath = "/app-api/devices/box-one/wanx/sso-grants";
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const reply = (data, status = 200, headers = {}) => new Response(
  JSON.stringify({ code: status, data }), { status, headers },
);

async function fixture({ grant, save = async () => {} } = {}) {
  let clock = 100000, clientId, saved, refreshes = 0;
  const events = [], responses = [];
  const account = createAccount({
    now: () => clock,
    store: { load: async () => saved, save: async value => { await save(value); saved = value; } },
    measure: async (step, operation) => {
      events.push(`${step}:start`);
      try { return await operation(); }
      finally { events.push(`${step}:end`); }
    },
    onGrantTiming: value => responses.push(value),
    fetch: async (url, options) => {
      if (url.endsWith("/login")) clientId = JSON.parse(options.body).clientId;
      if (url.endsWith("/login") || url.endsWith("/refresh")) {
        if (url.endsWith("/refresh")) refreshes++;
        return reply({ accountId: "account-one", clientId, accessToken: "SECRET-access",
          refreshToken: "SECRET-refresh", expiresIn: 3600 });
      }
      return url.endsWith("/sso-grants") ? grant(options) : reply({});
    },
  });
  await account.loginPassword({ phone: "13800138000", password: "SECRET-password" });
  events.length = 0;
  return { account, events, responses, expireSoon: () => { clock += 3590000; },
    refreshes: () => refreshes,
    request: () => account.request({ method: "POST", path: grantPath, body: { challengeReceipt: "SECRET-receipt" } }) };
}

test("grant timing distinguishes response headers from a delayed body and records only safe metadata", async () => {
  const headers = deferred(), body = deferred();
  const id = "c7e65752-bde8-48cf-82cb-c4c1d04ac3a9";
  const f = await fixture({ grant: async () => {
    await headers.promise;
    return new Response(new ReadableStream({ async start(controller) {
      await body.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 200, data: { grant: "SECRET-grant" } })));
      controller.close();
    } }), { headers: { "X-Wanx-Timing-Id": id, "Server-Timing": "wanx_grant;dur=123.4", "X-Secret": "SECRET-header" } });
  } });
  const pending = f.request();
  try {
    await tick();
    assert.deepEqual(f.events, ["account.grant.headers:start"]);
    headers.resolve();
    await tick();
    assert.deepEqual(f.events, ["account.grant.headers:start", "account.grant.headers:end", "account.grant.body:start"]);
    assert.deepEqual(f.responses, [{ requestId: id, serverDurationMs: 123.4, httpStatus: 200 }]);
  } finally { headers.resolve(); body.resolve(); }
  assert.equal((await pending).grant, "SECRET-grant");
  assert.equal(f.events.at(-1), "account.grant.body:end");
  assert.doesNotMatch(JSON.stringify({ events: f.events, responses: f.responses }), /SECRET/);
  await f.account.close();
});

test("concurrent grants expose shared refresh and persistence waits without duplicate refreshes", async () => {
  const gate = deferred();
  let block = false, grants = 0;
  const f = await fixture({ save: async () => { if (block) await gate.promise; },
    grant: async () => { grants++; return reply({ grant: "SECRET-grant" }); } });
  block = true;
  f.expireSoon();
  const first = f.request(), second = f.request();
  try {
    await tick();
    assert.equal(f.refreshes(), 1);
    assert.equal(grants, 0);
    assert.equal(f.events.filter(x => x === "account.grant.refresh:start").length, 2);
    assert.ok(f.events.includes("account.refresh.http:end"));
    assert.ok(f.events.includes("account.refresh.persist:start"));
    assert.ok(!f.events.includes("account.refresh.persist:end"));
  } finally { gate.resolve(); }
  await Promise.all([first, second]);
  assert.equal(grants, 2);
  assert.equal(f.events.filter(x => x === "account.refresh.persist:end").length, 1);
  await f.account.close();
});

test("grant 401 retry is visible and invalid server timing metadata is discarded", async () => {
  let requests = 0;
  const f = await fixture({ grant: async () => ++requests === 1
    ? reply({}, 401, { "X-Wanx-Timing-Id": "SECRET-id", "Server-Timing": "wanx_grant;dur=Infinity" })
    : reply({ grant: "SECRET-grant" }, 200, { "Server-Timing": "wanx_grant;dur=-1" }) });
  await f.request();
  assert.equal(f.refreshes(), 1);
  assert.equal(requests, 2);
  assert.ok(f.events.includes("account.grant.retry:start"));
  assert.ok(f.events.includes("account.grant.retry:end"));
  assert.deepEqual(f.responses, [{ httpStatus: 401 }, { httpStatus: 200 }]);
  await f.account.request({ path: "/app-api/devices" });
  assert.equal(f.responses.length, 2);
  assert.doesNotMatch(JSON.stringify(f.responses), /SECRET|Infinity/);
  await f.account.close();
});

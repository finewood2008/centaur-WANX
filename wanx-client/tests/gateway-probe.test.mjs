import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { probeEndpoint } from "../octop/probe.mjs";

const health = {
  ok: true,
  started_at: 123,
  db: true,
  users_loaded: 1,
  agents_running: 0,
};

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("probe verifies public WANX health without login credentials", async (t) => {
  const url = await fixture(t, (request, response) => {
    assert.equal(request.url, "/api/health");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    response.end(JSON.stringify(health));
  });
  assert.deepEqual(await probeEndpoint(url), health);
});

test("probe permits an uninitialized WANX so the normal setup page can load", async (t) => {
  const pending = { ...health, db: false, users_loaded: 0 };
  const url = await fixture(t, (_request, response) =>
    response.end(JSON.stringify(pending)),
  );
  assert.deepEqual(await probeEndpoint(url), pending);
});

test("probe rejects unrelated services, malformed JSON and oversized responses", async (t) => {
  for (const body of [
    '{"ok":true}',
    "<html>ok</html>",
    JSON.stringify({ ...health, ok: false }),
    " ".repeat(17 * 1024),
  ]) {
    const url = await fixture(t, (_request, response) => response.end(body));
    await assert.rejects(probeEndpoint(url), { code: "health_invalid" });
  }
});

test("probe does not follow redirects", async (t) => {
  let calls = 0;
  const url = await fixture(t, (_request, response) => {
    calls++;
    response.writeHead(302, { location: "/api/health?again=1" });
    response.end();
  });
  await assert.rejects(probeEndpoint(url), { code: "health_invalid" });
  assert.equal(calls, 1);
});

test(
  "probe cancellation destroys an in-flight health request",
  { timeout: 3_000 },
  async (t) => {
    let started;
    const received = new Promise((resolve) => {
      started = resolve;
    });
    const url = await fixture(t, (_request, response) => {
      started();
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
    });
    const controller = new AbortController();
    const pending = probeEndpoint(url, { signal: controller.signal });
    await received;
    const rejected = assert.rejects(pending, { name: "AbortError" });
    controller.abort();
    await rejected;
  },
);

test("probe bounds unavailable endpoint errors", async (t) => {
  const url = await fixture(t, (request) => request.socket.destroy());
  await assert.rejects(probeEndpoint(url), { code: "health_unavailable" });
});

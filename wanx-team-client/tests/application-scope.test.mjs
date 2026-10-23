import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createDashboardGateway } from "../octop/gateway.mjs";

async function setup(t, { denied = false, exchangeGate } = {}) {
  let parent = "parent-one", exchanges = 0;
  const seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push([req.url, req.headers.authorization]);
    if (req.url === "/api/auth/platform/application") {
      exchanges++;
      let body = "";
      for await (const part of req) body += part;
      assert.deepEqual(JSON.parse(body), { application_id: "super-advisory" });
      assert.equal(req.headers.authorization, `Bearer ${parent}`);
      res.setHeader("content-type", "application/json");
      if (denied) { res.writeHead(403); return res.end(JSON.stringify({code:"BOX_APPLICATION_ACCESS_DENIED"})); }
      if (exchangeGate) await exchangeGate;
      return res.end(JSON.stringify({ access_token: `scoped-${parent}`, token_type: "Bearer", expires_in: 120,
        user: { id: 7, application_id: "super-advisory" } }));
    }
    res.end(JSON.stringify({ authorization: req.headers.authorization }));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    seen.push([req.url, req.headers.authorization]);
    ws.handleUpgrade(req, socket, head, client => client.send("ready"));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const gateway = await createDashboardGateway({ targetURL: `http://127.0.0.1:${server.address().port}`,
    session: { getToken: () => parent, close() {}, onExpired: () => () => {} } });
  t.after(async () => { await gateway.close(); for (const client of ws.clients) client.terminate();
    await new Promise(resolve => ws.close(resolve)); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { gateway, seen, renew: () => { parent = "parent-two"; }, exchanges: () => exchanges };
}

test("application HTTP and WebSocket use opaque scoped marker and renew with parent lease", async t => {
  const f = await setup(t);
  const request = () => f.gateway.request({ path: "/api/brainstorm/profile", applicationScope: "super-advisory" });
  const [a, b] = await Promise.all([request(), request()]);
  assert.equal(JSON.parse(a.body).authorization, "Bearer scoped-parent-one");
  assert.equal(JSON.parse(b.body).authorization, "Bearer scoped-parent-one");
  assert.equal(f.exchanges(), 1);
  const stream = await f.gateway.openWebSocket({ path: "/api/agents/team/chat/ws", applicationScope: "super-advisory" });
  assert.equal((await once(stream, "message"))[0].toString(), "ready"); stream.terminate();
  assert.deepEqual(f.seen.at(-1), ["/api/agents/team/chat/ws?token=scoped-parent-one", "Bearer scoped-parent-one"]);
  f.renew(); await request(); assert.equal(f.exchanges(), 2);
  const plain = await f.gateway.request({ path: "/api/auth/me" });
  assert.equal(JSON.parse(plain.body).authorization, "Bearer parent-two");
});

test("scope exchange is not a public gateway route and no fallback occurs after denied exchange", async t => {
  const f = await setup(t, { denied: true });
  await assert.rejects(f.gateway.request({ path: "/api/brainstorm/profile", applicationScope: "super-advisory" }),
    { code: "BOX_APPLICATION_ACCESS_DENIED" });
  await assert.rejects(f.gateway.request({ path: "/api/auth/platform/application", method: "POST" }), /PLATFORM_SESSION_EXPIRED/);
  await assert.rejects(f.gateway.request({ path: "/api/auth/me", applicationScope: "admin" }), {code:"BOX_APPLICATION_SCOPE_FORBIDDEN"});
  assert.equal(f.seen.some(([url]) => url === "/api/brainstorm/profile"), false);
});


test("parent renewal during an exchange rejects stale credentials before sending a business request", async t => {
  let finish;
  const exchangeGate = new Promise(resolve => { finish = resolve; });
  const f = await setup(t, { exchangeGate });
  const pending = f.gateway.request({ path: "/api/brainstorm/profile", applicationScope: "super-advisory" });
  while (!f.exchanges()) await new Promise(resolve => setTimeout(resolve, 1));
  f.renew(); finish();
  await assert.rejects(pending, { code: "NETWORK_NOT_READY" });
  assert.equal(f.seen.some(([url]) => url === "/api/brainstorm/profile"), false);
});

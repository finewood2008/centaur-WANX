import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { createApplicationSession } from "../app-host/session.mjs";
import { fromEnvironment } from "../host-sdk/index.cjs";
async function fixture(t, applicationId = "centaurai.wanx.huohua-publisher") {
  let request,
    revoked,
    live = true;
  const box = http.createServer((req, res) => res.end("{}")),
    wss = new WebSocketServer({ server: box });
  wss.on("connection", (ws, req) => {
    request = req;
    ws.on("message", (data) => ws.send(data));
  });
  box.listen(0, "127.0.0.1");
  await once(box, "listening");
  const gateway = await createDashboardGateway({
    targetURL: `http://127.0.0.1:${box.address().port}`,
    session: { getToken: () => "fixture-secret", close() {} },
  });
  const session = await createApplicationSession({
    hostApplicationId: "wanx",
    applicationId,
    installPath: "/fixture",
    createConnection: async () => ({
      context: () => {
        if (!live) throw Error("SESSION_CLOSED");
        return { boxId: "fixture", user: { id: 2 }, connection: "ready" };
      },
      request: (i) => gateway.request(i),
      openStream: (i) => gateway.openWebSocket(i),
      subscribe: (f) => ((revoked = f), () => {}),
    }),
  });
  const client = fromEnvironment(session.environment);
  t.after(async () => {
    client.close();
    await session.close();
    await gateway.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    box.closeAllConnections();
    await new Promise((r) => box.close(r));
  });
  return {
    client,
    request: () => request,
    revoke: () => {
      live = false;
      revoked();
    },
  };
}
test(
  "Fire terminal uses existing native gateway credentials and closes on Host invalidation",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    const context = await f.client.context();
    assert.equal(context.hostFeatures.ephemeralTerminal, true);
    assert.equal(JSON.stringify(context).includes("fixture-secret"), false);
    const ws = await f.client.openStream(
      "/api/agents/owned/terminal/ws?cols=120&rows=24",
    );
    await once(ws, "open");
    const reply = once(ws, "message");
    ws.send(JSON.stringify({ type: "input", data: "fixed worker command\n" }));
    assert.equal(JSON.parse((await reply)[0]).type, "input");
    const url = new URL(f.request().url, "http://box");
    assert.equal(url.pathname, "/api/agents/owned/terminal/ws");
    assert.equal(url.searchParams.get("token"), "fixture-secret");
    const closed = once(ws, "close");
    f.revoke();
    await closed;
    await assert.rejects(f.client.context());
  },
);
test(
  "other applications cannot open terminal streams",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, "another.app");
    assert.equal(
      (await f.client.context()).hostFeatures?.ephemeralTerminal,
      undefined,
    );
    const ws = await f.client.openStream("/api/agents/owned/terminal/ws");
    await assert.rejects(once(ws, "open"));
    assert.equal(f.request(), undefined);
  },
);
test(
  "Fire cannot attach another persistent terminal or supply credentials",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    for (const path of [
      "/api/agents/owned/terminal/ws?session_id=other",
      "/api/agents/owned/terminal/ws?token=foreign",
      "/api/agents/owned/terminal/ws?cols=bad",
      "/api/agents/owned/terminal/ws?cols=1000",
      "/api/agents/owned/terminal/ws?rows=-1",
      "/api/agents/owned/terminal/ws?access_token=foreign",
      "/api/agents/owned/terminal/not-ws",
    ]) {
      const ws = await f.client.openStream(path);
      await assert.rejects(once(ws, "open"));
    }
    assert.equal(f.request(), undefined);
  },
);

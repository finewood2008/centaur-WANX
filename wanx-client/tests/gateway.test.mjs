import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createDashboardGateway } from "../octop/gateway.mjs";

async function fixture(t, handler) {
  const upstream = http.createServer(handler);
  const sockets = new Set();
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const targetURL = `http://127.0.0.1:${upstream.address().port}`;
  const gateway = await createDashboardGateway({ targetURL });
  t.after(async () => {
    await gateway.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { gateway, upstream, targetURL };
}

function request(url, { headers = {}, method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

test("proxies Dashboard assets and API credentials without injecting identities", async (t) => {
  const { gateway, targetURL } = await fixture(t, (incoming, response) => {
    if (incoming.url === "/assets/app.js")
      return response.end("export default 42;");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ path: incoming.url, headers: incoming.headers }),
    );
  });
  assert.equal(
    (await request(gateway.url + "/assets/app.js")).body.toString(),
    "export default 42;",
  );
  const result = await request(gateway.url + "/api/auth/me?flag=1", {
    headers: {
      authorization: "Bearer box-user-token",
      origin: gateway.url,
      cookie: "session=box-cookie",
      "x-forwarded-user": "forged",
      forwarded: "host=bad.example",
    },
  });
  const payload = JSON.parse(result.body);
  assert.equal(payload.path, "/api/auth/me?flag=1");
  assert.equal(payload.headers.authorization, "Bearer box-user-token");
  assert.equal(payload.headers.cookie, "session=box-cookie");
  assert.equal(payload.headers.origin, targetURL);
  assert.equal(payload.headers.host, new URL(targetURL).host);
  assert.equal(payload.headers["x-forwarded-user"], undefined);
  assert.equal(payload.headers.forwarded, undefined);
});

test("rejects rebinding, cross-origin writes and absolute proxy targets before upstream", async (t) => {
  let calls = 0;
  const { gateway } = await fixture(t, (_request, response) => {
    calls++;
    response.end("ok");
  });
  for (const options of [
    { headers: { host: "attacker.example" } },
    { headers: { origin: "https://attacker.example" } },
    { method: "POST" },
    { headers: { "sec-fetch-site": "cross-site" } },
  ])
    assert.equal((await request(gateway.url, options)).status, 403);
  assert.equal(
    (await request(gateway.url + "//attacker.example/api")).status,
    403,
  );
  assert.equal(calls, 0);
  assert.equal(
    (
      await request(gateway.url, {
        method: "POST",
        headers: { origin: gateway.url },
      })
    ).status,
    200,
  );
});

test("streams uploads beyond the old 2 MiB limit and preserves downloads", async (t) => {
  const { gateway } = await fixture(t, (incoming, response) =>
    incoming.pipe(response),
  );
  const body = Buffer.alloc(5 * 1024 * 1024, 0x73);
  const result = await request(gateway.url + "/api/upload", {
    method: "POST",
    headers: {
      origin: gateway.url,
      "content-type": "application/octet-stream",
    },
    body,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, body);
});

test("SSE first event arrives while upstream remains open and close cancels the stream", async (t) => {
  const { gateway } = await fixture(t, (_incoming, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: first\n\n");
  });
  const outgoing = http.get(gateway.url + "/api/events");
  const [incoming] = await once(outgoing, "response");
  const [chunk] = await once(incoming, "data");
  assert.equal(chunk.toString(), "data: first\n\n");
  assert.equal(incoming.complete, false);
  incoming.on("error", () => {});
  const closed = new Promise((resolve) => incoming.once("close", resolve));
  await gateway.close();
  await closed;
  await assert.rejects(request(gateway.url));
});

test("rewrites same-target redirects and cookies, blocks external redirects", async (t) => {
  let targetURL;
  const setup = await fixture(t, (incoming, response) => {
    response.writeHead(302, {
      location:
        incoming.url === "/external"
          ? "https://outside.example/login"
          : `${targetURL}/login?a=1`,
      "set-cookie": "session=abc; Domain=box.example; Path=/; HttpOnly",
    });
    response.end();
  });
  targetURL = setup.targetURL;
  const result = await request(setup.gateway.url);
  assert.equal(result.status, 302);
  assert.equal(result.headers.location, setup.gateway.url + "/login?a=1");
  assert.deepEqual(result.headers["set-cookie"], [
    "session=abc; Path=/; HttpOnly",
  ]);
  const external = await request(setup.gateway.url + "/external");
  assert.equal(external.status, 502);
  assert.equal(external.headers.location, undefined);
});

test("WebSocket forwards binary, text and negotiated subprotocol; disable closes it", async (t) => {
  const { gateway, upstream, targetURL } = await fixture(
    t,
    (_request, response) => response.end(),
  );
  const wss = new WebSocketServer({
    server: upstream,
    handleProtocols: () => "terminal",
  });
  t.after(() => wss.close());
  wss.on("connection", (socket, incoming) => {
    assert.equal(incoming.headers.origin, targetURL);
    assert.equal(incoming.headers.authorization, "Bearer websocket-user");
    socket.on("message", (data, binary) => socket.send(data, { binary }));
  });
  const client = new WebSocket(
    gateway.url.replace("http:", "ws:") + "/api/terminal/ws?token=abc",
    ["terminal", "other"],
    {
      origin: gateway.url,
      headers: { authorization: "Bearer websocket-user" },
    },
  );
  t.after(() => client.terminate());
  await once(client, "open");
  assert.equal(client.protocol, "terminal");
  let reply = once(client, "message");
  client.send("hello");
  let [data, binary] = await reply;
  assert.equal(data.toString(), "hello");
  assert.equal(binary, false);
  reply = once(client, "message");
  const input = Buffer.from([0, 255, 13, 10]);
  client.send(input);
  [data, binary] = await reply;
  assert.deepEqual(data, input);
  assert.equal(binary, true);
  const ended = once(client, "close");
  await gateway.close();
  await ended;
});

test("upstream errors return fixed, bounded messages without target details", async (t) => {
  const { gateway, upstream } = await fixture(t, (_request, response) =>
    response.end(),
  );
  await new Promise((resolve) => upstream.close(resolve));
  const result = await request(gateway.url);
  assert.equal(result.status, 502);
  assert.equal(result.body.toString(), "Box connection unavailable");
});

test("relative redirects resolve against the requested path", async (t) => {
  const { gateway } = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: "next?state=1" });
    response.end();
  });
  const result = await request(gateway.url + "/api/auth/start");
  assert.equal(result.headers.location, gateway.url + "/api/auth/next?state=1");
});

test("rejects target credentials, paths and non-HTTP protocols", async () => {
  for (const targetURL of [
    "http://user:pass@localhost",
    "http://localhost/api",
    "http://localhost/?token=secret",
    "file:///tmp/box",
  ]) {
    await assert.rejects(
      createDashboardGateway({ targetURL }),
      /INVALID_TARGET_URL/,
    );
  }
});

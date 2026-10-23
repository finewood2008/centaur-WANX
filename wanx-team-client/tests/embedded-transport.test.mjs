import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createTunnelAgent } from "../network/tunnel.mjs";
import { probeEndpoint } from "../octop/probe.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";

const health = {
  ok: true,
  db: true,
  started_at: 1,
  users_loaded: 1,
  agents_running: 0,
};

test(
  "health, streaming HTTP, uploads and WebSocket use the embedded tunnel",
  { timeout: 10000 },
  async (t) => {
    const host = "198.51.100.9:8088";
    const targetURL = `http://${host}`;
    const received = [];
    const connections = new Set();
    const track = (socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
    };
    const upstream = http.createServer((request, response) => {
      received.push({
        host: request.headers.host,
        auth: request.headers.authorization,
        proxyAuth: request.headers["proxy-authorization"],
      });
      if (request.url === "/api/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(health));
      } else if (request.url === "/api/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
      } else request.pipe(response);
    });
    upstream.on("connection", track);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const wsServer = new WebSocketServer({ server: upstream });
    wsServer.on("connection", (ws, request) => {
      assert.equal(request.headers.origin, targetURL);
      assert.equal(request.headers.host, host);
      assert.equal(request.headers["proxy-authorization"], undefined);
      ws.on("message", (bytes, binary) => ws.send(bytes, { binary }));
    });
    const proxy = http.createServer();
    const tunnelTargets = [];
    proxy.on("connection", track);
    proxy.on("connect", (request, socket, head) => {
      assert.equal(request.headers.authorization, "Bearer test-private-token");
      tunnelTargets.push(request.url);
      const destination = net.connect(upstream.address().port, "127.0.0.1");
      track(destination);
      destination.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) destination.write(head);
        socket.pipe(destination).pipe(socket);
      });
      socket.on("error", () => destination.destroy());
      destination.on("error", () => socket.destroy());
      socket.on("close", () => destination.destroy());
      destination.on("close", () => socket.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const agent = createTunnelAgent({
      url: targetURL,
      proxy: { port: proxy.address().port, token: "test-private-token" },
    });
    let gateway;
    t.after(async () => {
      await gateway?.close();
      agent.destroy();
      for (const client of wsServer.clients) client.terminate();
      wsServer.close();
      for (const socket of connections) socket.destroy();
      await Promise.all([
        new Promise((r) => upstream.close(r)),
        new Promise((r) => proxy.close(r)),
      ]);
    });
    assert.deepEqual(await probeEndpoint(targetURL, { agent }), health);
    gateway = await createDashboardGateway({ targetURL, agent });
    const body = Buffer.alloc(3 * 1024 * 1024, 17);
    const response = await fetch(`${gateway.url}/api/upload`, {
      method: "POST",
      headers: { origin: gateway.url, authorization: "Bearer box-session" },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    const stream = await fetch(`${gateway.url}/api/events`);
    const reader = stream.body.getReader();
    assert.equal(
      new TextDecoder().decode((await reader.read()).value),
      "data: first\n\n",
    );
    await reader.cancel();
    const ws = new WebSocket(
      `${gateway.url.replace("http:", "ws:")}/api/ws?token=box-session`,
      { origin: gateway.url },
    );
    await once(ws, "open");
    const echoed = once(ws, "message");
    ws.send(Buffer.from([0, 1, 255]));
    assert.deepEqual((await echoed)[0], Buffer.from([0, 1, 255]));
    const closed = once(ws, "close");
    await gateway.close();
    await closed;
    // Keep-alive may reuse a tunnel; all requests still target an unroutable
    // TEST-NET address and can succeed only through this explicit proxy.
    assert.ok(tunnelTargets.length >= 1);
    assert.ok(tunnelTargets.every((target) => target === host));
    assert.ok(
      received.every(
        (request) => request.host === host && request.proxyAuth === undefined,
      ),
    );
    assert.equal(
      received.find((request) => request.auth)?.auth,
      "Bearer box-session",
    );
  },
);

test(
  "a rejected tunnel fails health and gateway requests without direct fallback",
  { timeout: 5000 },
  async (t) => {
    let directCalls = 0;
    const upstream = http.createServer((_request, response) => {
      directCalls += 1;
      response.end(JSON.stringify(health));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const targetURL = `http://127.0.0.1:${upstream.address().port}`;
    const proxy = http.createServer();
    proxy.on("connect", (_request, socket) =>
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"),
    );
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const agent = createTunnelAgent({
      url: targetURL,
      proxy: { port: proxy.address().port, token: "rejected" },
    });
    const gateway = await createDashboardGateway({ targetURL, agent });
    t.after(async () => {
      await gateway.close();
      agent.destroy();
      await Promise.all([
        new Promise((r) => proxy.close(r)),
        new Promise((r) => upstream.close(r)),
      ]);
    });
    await assert.rejects(
      probeEndpoint(targetURL, { agent }),
      /health_unavailable/,
    );
    assert.equal((await fetch(`${gateway.url}/api/health`)).status, 502);
    assert.equal(directCalls, 0);
  },
);

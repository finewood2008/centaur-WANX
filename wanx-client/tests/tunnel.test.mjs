import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createTunnelAgent } from "../network/tunnel.mjs";

const token = "test-proxy-token-with-no-production-value";
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const request = (url, options) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ response, body }));
      response.on("error", reject);
    });
    req.on("error", reject);
  });
async function fixture(t) {
  const cert = await readFile(
    new URL("./fixtures/tls/server-cert.pem", import.meta.url),
  );
  const key = await readFile(
    new URL("./fixtures/tls/server-key.pem", import.meta.url),
  );
  const seen = [];
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const upstream = https.createServer({ cert, key }, (req, res) => {
    seen.push({
      host: req.headers.host,
      authorization: req.headers.authorization,
      servername: req.socket.servername,
    });
    res.end("secure response");
  });
  const upstreamPort = await listen(upstream);
  upstream.on("connection", track);
  const proxy = http.createServer();
  proxy.on("connection", track);
  proxy.on("connect", (req, downstream, head) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const target = track(
      net.connect(upstreamPort, "127.0.0.1", () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) target.write(head);
        target.pipe(downstream);
        downstream.pipe(target);
      }),
    );
    target.on("error", () => downstream.destroy());
    downstream.on("error", () => target.destroy());
  });
  const port = await listen(proxy);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => proxy.close(resolve)),
      new Promise((resolve) => upstream.close(resolve)),
    ]);
  });
  return { cert, seen, proxy: { port, token } };
}

test("HTTPS tunnel validates certificates even if a caller tries to disable verification", async (t) => {
  const { proxy } = await fixture(t);
  const url = "https://box.wanx.test:8088";
  const agent = createTunnelAgent({ url, proxy });
  t.after(() => agent.destroy());
  await assert.rejects(
    request(url, { agent, rejectUnauthorized: false }),
    (error) => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT",
  );
});

test("HTTPS tunnel preserves target Host and SNI and rejects a trusted wrong-host certificate", async (t) => {
  const { proxy, cert, seen } = await fixture(t);
  const url = "https://box.wanx.test:8088";
  const agent = createTunnelAgent({ url, proxy });
  t.after(() => agent.destroy());
  const { body } = await request(url, { agent, ca: cert });
  assert.equal(body, "secure response");
  assert.deepEqual(seen, [
    {
      host: "box.wanx.test:8088",
      authorization: undefined,
      servername: "box.wanx.test",
    },
  ]);
  const otherURL = "https://wrong.wanx.test:8088";
  const other = createTunnelAgent({ url: otherURL, proxy });
  t.after(() => other.destroy());
  await assert.rejects(
    request(otherURL, { agent: other, ca: cert }),
    (error) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
  );
});

test("destroy during pending CONNECT rejects the waiting request promptly", async (t) => {
  let accepted;
  const connected = new Promise((resolve) => {
    accepted = resolve;
  });
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  proxy.on("connect", () => accepted()); // Deliberately withhold the response.
  const port = await listen(proxy);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => proxy.close(resolve));
  });
  const agent = createTunnelAgent({
    url: "http://192.0.2.1:8088",
    proxy: { port, token },
  });
  const pending = new Promise((resolve, reject) => {
    http.get("http://192.0.2.1:8088", { agent }, resolve).on("error", reject);
  });
  const rejected = assert.rejects(
    pending,
    (error) => error.code === "network_disabled",
  );
  await connected;
  agent.destroy();
  await rejected;
});

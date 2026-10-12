import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { createApplicationHost } from "../app-host/server.mjs";

test("application host requires the launch token and restricts paths", async () => {
  const host = await createApplicationHost({
    applicationId: "wanx-host",
    socketPath: process.platform === "win32" ? `\\\\.\\pipe\\wanx-app-seam-${process.pid}` : path.join(os.tmpdir(), `wanx-app-seam-${process.pid}.sock`),
    token: "token",
    context: () => ({ boxId: "box-1", connection: "ready" }),
    isApplicationAllowed: (applicationId, launchId) => applicationId === "centaurai.wanx.zhijun" && launchId === "launch-1",
    request: ({ path }) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ path })) }),
  });
  const call = (value) => new Promise((resolve, reject) => {
    const socket = net.createConnection(host.endpoint);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buffer += chunk; const index = buffer.indexOf("\n"); if (index >= 0) { socket.destroy(); resolve(JSON.parse(buffer.slice(0, index))); } });
    socket.on("error", reject);
    socket.on("connect", () => socket.end(JSON.stringify(value) + "\n"));
  });
  assert.deepEqual((await call({ id: "1", token: "token", applicationId: "centaurai.wanx.zhijun", launchId: "launch-1", method: "context.get" })).value, { boxId: "box-1", connection: "ready" });
  assert.equal((await call({ id: "2", token: "bad", applicationId: "centaurai.wanx.zhijun", launchId: "launch-1", method: "context.get" })).error, "APPLICATION_IPC_UNAUTHORIZED");
  assert.equal((await call({ id: "3", token: "token", applicationId: "centaurai.wanx.zhijun", launchId: "other-launch", method: "context.get" })).error, "APPLICATION_IPC_UNAUTHORIZED");
  assert.equal((await call({ id: "4", token: "token", applicationId: "centaurai.wanx.zhijun", launchId: "launch-1", method: "http.request", params: { path: "/private" } })).error, "APPLICATION_PATH_NOT_ALLOWED");
  assert.deepEqual((await call({ id: "5", token: "token", applicationId: "centaurai.wanx.zhijun", launchId: "launch-1", method: "identity.get" })).value, { boxId: "box-1", connection: "ready", identityOnly: true });
  const response = await call({ id: "6", token: "token", applicationId: "centaurai.wanx.zhijun", launchId: "launch-1", method: "http.request", params: { path: "/api/agents" } });
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(Buffer.from(response.value.body, "base64").toString()), { path: "/api/agents" });
  assert.equal((await call({ id: "7", token: "token", applicationId: "centaurai.wanx.zhijun", launchId: "launch-1", method: "http.stream", params: { path: "/api/events" } })).value.status, 200);
  await host.close();
});

test("application host relays a chat stream over the fixed IPC socket", async () => {
  const fake = new EventEmitter();
  let sent;
  fake.send = (data, options) => { sent = { data: Buffer.from(data).toString(), options }; };
  fake.close = () => {};
  const host = await createApplicationHost({
    applicationId: "wanx-host",
    socketPath: process.platform === "win32" ? `\\\\.\\pipe\\wanx-app-stream-${process.pid}` : path.join(os.tmpdir(), `wanx-app-stream-${process.pid}.sock`),
    token: "token",
    context: () => ({ boxId: "box-1", connection: "ready" }),
    isApplicationAllowed: (applicationId, launchId) => applicationId === "centaurai.wanx.zhijun" && launchId === "launch-1",
    openStream: () => fake,
  });
  const socket = net.createConnection(host.endpoint);
  socket.setEncoding("utf8");
  let buffer = "";
  const queue = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const value = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      (waiters.shift() || ((item) => queue.push(item)))(value);
    }
  });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve));
  const send = (message) => socket.write(JSON.stringify({ token: "token", applicationId: "centaurai.wanx.zhijun", launchId: "launch-1", ...message }) + "\n");
  await new Promise(resolve => socket.once("connect", resolve));
  send({ id: "open", method: "stream.open", params: { path: "/api/agents/a/chat/ws" } });
  const opened = await next();
  assert.equal(opened.ok, true);
  const streamId = opened.value.streamId;
  fake.emit("message", Buffer.from('{"type":"token","content":"你好"}'), false);
  const frame = await next();
  assert.equal(frame.type, "stream.message");
  assert.equal(Buffer.from(frame.data, "base64").toString(), '{"type":"token","content":"你好"}');
  send({ id: "send", method: "stream.send", params: { streamId, data: Buffer.from("ping").toString("base64") } });
  await next();
  assert.equal(sent.data, "ping");
  send({ id: "close", method: "stream.close", params: { streamId } });
  assert.equal((await next()).ok, true);
  socket.destroy();
  await host.close();
});

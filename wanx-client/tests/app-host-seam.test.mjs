import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
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
    capabilitiesFor: (_applicationId, launchId) => launchId === "launch-1" ? ["http.request"] : [],
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
  await host.close();
});

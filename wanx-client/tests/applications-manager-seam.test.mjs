import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplicationManager } from "../applications/manager.mjs";

test("manager installs and launches an application with a one-time host environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-manager-"));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "shell"), { recursive: true });
  await writeFile(path.join(source, "shell", "main.cjs"), "module.exports = {};\n");
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({
    applicationId: "centaurai.wanx.zhijun", name: "知君", version: "0.4.2", protocolVersion: 1,
    runtime: "electron", entrypoint: "shell/main.cjs", capabilities: ["identity.read"],
  }));
  let launchOptions;
  const manager = await createApplicationManager({
    applicationRoot: path.join(root, "installed"), applicationId: "wanx-host",
    context: () => ({ boxId: "box-1", connection: "ready" }),
    spawn: (_file, _args, options) => {
      launchOptions = options;
      const child = { exitCode: null, once(_event, callback) { child.exit = callback; }, kill() { child.exitCode = 0; child.exit?.(); } };
      return child;
    },
  });
  await manager.install({ sourceDir: source });
  const launched = await manager.launch("centaurai.wanx.zhijun");
  assert.equal(launched.state, "running");
  assert.equal(launchOptions.env.WANX_HOST_CLIENT_APPLICATION_ID, "centaurai.wanx.zhijun");
  assert.equal(launchOptions.env.WANX_HOST_PROTOCOL_VERSION, "1");
  await manager.close();
});

test("reopening after a box switch creates a new launch instead of reusing the old connection", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { rm } = await import("node:fs/promises");
  const net = await import("node:net");
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "main.cjs"), "module.exports = {};\n");
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({
    applicationId: "centaurai.wanx.zhijun", name: "知君", version: "0.4.3", protocolVersion: 1,
    runtime: "electron", entrypoint: "main.cjs", capabilities: ["identity.read"],
  }));
  let box = "box-102";
  const children = [], environments = [];
  const manager = await createApplicationManager({
    applicationRoot: path.join(root, "installed"), applicationId: "wanx-host",
    createConnection: async () => {
      if (!box) throw Object.assign(new Error("NETWORK_NOT_READY"), { code: "NETWORK_NOT_READY" });
      const selected = box;
      return { context: () => {
        if (box !== selected) throw Object.assign(new Error("NETWORK_CHANGED"), { code: "NETWORK_CHANGED" });
        return { boxId: selected, connection: "ready" };
      } };
    },
    spawn: (_file, _args, options) => {
      environments.push(options.env);
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
      children.push(child);
      return child;
    },
  });
  t.after(() => manager.close());
  const context = (env) => new Promise((resolve, reject) => {
    const socket = net.createConnection(env.WANX_HOST_SOCKET);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.end(JSON.stringify({
      id: "context", applicationId: env.WANX_HOST_CLIENT_APPLICATION_ID,
      launchId: env.WANX_HOST_LAUNCH_ID, token: env.WANX_HOST_TOKEN, method: "context.get",
    }) + "\n"));
    socket.on("data", (data) => {
      buffer += data;
      if (buffer.includes("\n")) { socket.destroy(); resolve(JSON.parse(buffer.split("\n")[0])); }
    });
  });
  await manager.install({ sourceDir: source });
  const first = await manager.launch("centaurai.wanx.zhijun", "0.4.3");
  assert.equal((await context(environments[0])).value.boxId, "box-102");
  assert.equal((await manager.launch("centaurai.wanx.zhijun", "0.4.3")).launchId, first.launchId);
  assert.equal(children.length, 1);
  box = "box-103";
  const second = await manager.launch("centaurai.wanx.zhijun", "0.4.3");
  assert.notEqual(second.launchId, first.launchId);
  assert.equal(children[0].exitCode, 0);
  assert.equal((await context(environments[1])).value.boxId, "box-103");
  assert.equal((await context(environments[0])).error, "APPLICATION_IPC_UNAUTHORIZED");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(source, "application.manifest.json"), "utf8"));
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({ ...manifest, version: "0.4.4" }));
  await manager.install({ sourceDir: source });
  const updated = await manager.launch("centaurai.wanx.zhijun", "0.4.4");
  assert.notEqual(updated.launchId, second.launchId);
  assert.equal(children[1].exitCode, 0);
  assert.equal((await context(environments[2])).value.boxId, "box-103");
  box = null;
  await assert.rejects(manager.launch("centaurai.wanx.zhijun", "0.4.3"), { code: "NETWORK_NOT_READY" });
  assert.equal(children.length, 3);
});

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

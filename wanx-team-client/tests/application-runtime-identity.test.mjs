import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchInstalledApplication } from "../applications/runtime.mjs";

test("desktop window identity preserves private application data and revoked-window cleanup", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx-runtime-identity-")));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousData = process.env.WANX_HOST_APPLICATION_DATA;
  t.after(async () => {
    Object.defineProperty(process, "platform", platform);
    if (previousData === undefined) delete process.env.WANX_HOST_APPLICATION_DATA;
    else process.env.WANX_HOST_APPLICATION_DATA = previousData;
    await rm(root, { recursive: true, force: true });
  });
  Object.defineProperty(process, "platform", { value: "win32" });
  const applicationRoot = path.join(root, "applications"), applicationId = "test.desktop";
  const installPath = path.join(applicationRoot, applicationId, "1.0.0");
  const profile = "b".repeat(64), userData = path.join(applicationRoot, ".runtime", "local", profile, applicationId);
  const icon = path.join(installPath, "icon.png");
  await mkdir(installPath, { recursive: true });
  await writeFile(icon, "fixture");
  await writeFile(path.join(installPath, "entry.cjs"), "");
  await writeFile(path.join(installPath, ".wanx-install.json"), JSON.stringify({
    applicationId, name: "Desktop fixture", version: "1.0.0", protocolVersion: 1,
    runtime: "electron", entrypoint: "entry.cjs", capabilities: [], installPath,
  }));
  const effects = [], app = new EventEmitter();
  app.setName = value => effects.push(["name", value]);
  app.setPath = (key, value) => effects.push([key, value]);
  app.setAppUserModelId = value => effects.push(["appId", value]);
  app.exit = value => effects.push(["exit", value]);
  let receive;
  await launchInstalledApplication({
    applicationRoot, installPath, app,
    environment: { WANX_HOST_LAUNCH_ID: "private-launch", WANX_HOST_TOKEN: "fixture",
      WANX_HOST_CLIENT_APPLICATION_ID: applicationId, WANX_HOST_DATA_PROFILE: profile,
      WANX_HOST_USER_DATA_DIR: userData },
    receive: listener => { receive = listener; }, load: async () => {},
  });
  assert.ok(effects.some(([key, value]) => key === "appId" && value === applicationId));
  assert.ok(effects.some(([key, value]) => key === "userData" && value === userData));
  assert.equal(process.env.WANX_HOST_APPLICATION_DATA, userData);
  const window = () => {
    const result = Object.assign(new EventEmitter(), { webContents: new EventEmitter(),
      setIcon: value => effects.push(["icon", value]), setMenu() {}, setMenuBarVisibility() {},
      isDestroyed: () => false, hide: () => effects.push(["hide"]),
      destroy: () => effects.push(["destroy"]),
    });
    app.emit("browser-window-created", {}, result);
  };
  window();
  assert.deepEqual(effects.at(-1), ["icon", icon]);
  receive({ type: "wanx:application-invalidate", launchId: "private-launch" });
  assert.deepEqual(effects.slice(-3), [["hide"], ["destroy"], ["exit", 0]]);
  const before = effects.length;
  window();
  assert.deepEqual(effects.slice(before), [["hide"], ["destroy"]]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("desktop registers setup IPC before loading the control renderer", async () => {
  const source = await readFile(new URL("../shell/main.mjs", import.meta.url), "utf8");
  const setup = source.indexOf("setupRuntime = await createSetupRuntime(");
  const load = source.indexOf("control.loadURL(controlURL)");
  assert.notEqual(setup, -1);
  assert.notEqual(load, -1);
  assert.ok(setup < load, "the renderer may request Bluetooth state as soon as it loads");
});

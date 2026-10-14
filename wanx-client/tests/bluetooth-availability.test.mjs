import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createBluetoothAvailability } from "../local-ui/renderer/bluetooth-availability.mjs";
import { macBluetoothState, windowsBluetoothState, readBluetoothState } from "../shell/bluetooth-state.mjs";
import { installBluetoothSettings } from "../shell/bluetooth-settings.mjs";

test("Bluetooth preflight distinguishes unavailable radio from unsupported API and permission errors", async () => {
  const unsupported = createBluetoothAvailability(undefined);
  assert.equal(unsupported.snapshot().status, "unsupported");
  assert.equal((await unsupported.refresh()).status, "unsupported");
  const radio = createBluetoothAvailability({ getAvailability: async () => false });
  assert.equal(radio.snapshot().status, "checking");
  assert.equal((await radio.refresh()).status, "unavailable");
  radio.reportError({ name: "NotFoundError" });
  assert.equal(radio.snapshot().status, "unavailable", "empty scan is not permission denial");
  radio.reportError({ name: "NotAllowedError" });
  assert.equal(radio.snapshot().status, "permission-denied");
  const blocked = createBluetoothAvailability({ getAvailability: async () => { throw { name: "SecurityError" }; } });
  assert.equal((await blocked.refresh()).status, "permission-denied");
  const failed = createBluetoothAvailability({ getAvailability: async () => { throw new Error("adapter read failed"); } });
  assert.equal((await failed.refresh()).status, "error");
});

test("Bluetooth availability changes invalidate older reads and notify subscribers", async () => {
  let changed, finish, removed;
  const radio = createBluetoothAvailability({
    getAvailability: () => new Promise(resolve => { finish = resolve; }),
    addEventListener(name, listener) { assert.equal(name, "availabilitychanged"); changed = listener; },
    removeEventListener(name, listener) { removed = [name, listener]; },
  });
  const statuses = [];
  const unsubscribe = radio.subscribe(state => statuses.push(state.status));
  const pending = radio.refresh();
  changed({ value: true });
  assert.equal(radio.snapshot().status, "available", "click handlers can synchronously inspect readiness");
  finish(false);
  await pending;
  assert.equal(radio.snapshot().status, "available");
  changed({ value: false });
  assert.deepEqual(statuses, ["checking", "available", "unavailable"]);
  unsubscribe();
  radio.dispose();
  assert.deepEqual(removed, ["availabilitychanged", changed]);
});

test("latest Bluetooth preflight result wins when returning from system settings", async () => {
  const pending = [];
  const radio = createBluetoothAvailability({ getAvailability: () => new Promise(resolve => pending.push(resolve)) });
  const first = radio.refresh(), second = radio.refresh();
  pending[1](true); await second;
  pending[0](false); await first;
  assert.equal(radio.snapshot().status, "available");
});

for (const [platform, section, url] of [
  ["darwin", "bluetooth", "x-apple.systempreferences:com.apple.Bluetooth"],
  ["darwin", "privacy", "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth"],
  ["win32", "bluetooth", "ms-settings:bluetooth"],
  ["win32", "privacy", "ms-settings:bluetooth"],
]) test(`Bluetooth settings ${platform}/${section} uses a fixed destination and rejects foreign frames`, async () => {
  const handlers = new Map(), opened = [];
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const webContents = { mainFrame: { url: "file:///client/index.html" } };
  const dispose = installBluetoothSettings({ webContents, ipcMain, documentUrl: webContents.mainFrame.url, platform,
    openExternal: async target => { opened.push(target); } });
  const handler = handlers.get("wanx:discovery:open-bluetooth-settings");
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  assert.equal((await handler({ ...event, senderFrame: { ...webContents.mainFrame } }, section)).code, "IPC_ACCESS_DENIED");
  assert.equal((await handler(event, "https://attacker.example")).code, "INVALID_REQUEST");
  assert.deepEqual(opened, []);
  assert.deepEqual(await handler(event, section), { ok: true });
  assert.deepEqual(opened, [url]);
  dispose(); assert.equal(handlers.size, 0);
});

test("unsupported OS and failure opening settings produce a bounded UI error", async () => {
  for (const platform of ["linux", "darwin"]) {
    let handler;
    const webContents = { mainFrame: { url: "file:///client/index.html" } };
    installBluetoothSettings({ webContents, documentUrl: webContents.mainFrame.url, platform,
      ipcMain: { handle: (_name, value) => { handler = value; } },
      openExternal: async () => { throw new Error("cannot open"); } });
    assert.equal((await handler({ sender: webContents, senderFrame: webContents.mainFrame }, "bluetooth")).code, "BLUETOOTH_SETTINGS_UNAVAILABLE");
  }
});


test("bundled scanning preserves the click stack and turns browser permission failures into guidance", async () => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL("../local-ui/renderer/device-setup-entry.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  for (const name of ["NotAllowedError", "SecurityError", "NotFoundError"]) {
    let requested = false;
    const error = Object.assign(new Error("chooser error"), { name });
    const window = {
      wanxSetupTransport: { subscribe() { return () => {}; }, reply() {}, status() {} },
    };
    vm.runInNewContext(built.outputFiles[0].text, {
      window, navigator: { bluetooth: {
        getAvailability: async () => true,
        requestDevice() { requested = true; return Promise.reject(error); },
      } },
      crypto: globalThis.crypto, performance, setTimeout, clearTimeout, AbortController,
    });
    await window.wanxBluetooth.refresh();
    const selected = window.wanxDeviceSetupTransport.requestDeviceFromUserGesture();
    assert.equal(requested, true, "requestDevice must run synchronously in the click stack");
    await assert.rejects(selected, caught => caught === error);
    assert.equal(window.wanxBluetooth.snapshot().status,
      name === "NotFoundError" ? "available" : "permission-denied");
    await window.wanxDeviceSetupTransport.dispose();
  }
});


test("adapter presence cannot override a powered-off or unreadable native radio", async () => {
  for (const status of ["unavailable", "permission-denied", "error", "unsupported", "available"]) {
    const radio = createBluetoothAvailability({ getAvailability: async () => true }, async () => ({ status }));
    assert.equal((await radio.refresh()).status, status);
  }
  const absent = createBluetoothAvailability({ getAvailability: async () => false }, async () => ({ status: "available" }));
  assert.equal((await absent.refresh()).status, "unavailable");
});

test("adapter arrival rechecks power before allowing discovery", async () => {
  let changed;
  const radio = createBluetoothAvailability({
    getAvailability: async () => true,
    addEventListener: (_event, listener) => { changed = listener; },
  }, async () => ({ status: "unavailable" }));
  changed({ value: true });
  assert.equal(radio.snapshot().status, "checking");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(radio.snapshot().status, "unavailable");
});

test("macOS and Windows radio power parsing never treats off as available", () => {
  const mac = state => ({ SPBluetoothDataType: [{ controller_properties: { controller_state: state } }] });
  assert.deepEqual(macBluetoothState(mac("attrib_on")), { status: "available" });
  assert.deepEqual(macBluetoothState(mac("attrib_off")), { status: "unavailable", reason: "powered-off" });
  assert.equal(macBluetoothState({ SPBluetoothDataType: [] }).status, "unavailable");
  assert.equal(macBluetoothState({}).status, "error");
  assert.equal(windowsBluetoothState({ states: ["On"] }).status, "available");
  for (const state of ["Off", "Disabled"]) assert.deepEqual(windowsBluetoothState({ states: [state] }), { status: "unavailable", reason: "powered-off" });
  assert.equal(windowsBluetoothState({ states: ["Unknown"] }).status, "error");
  assert.equal(windowsBluetoothState({ states: [] }).status, "unavailable");
  assert.equal(windowsBluetoothState({ permissionDenied: true }).status, "permission-denied");
});

test("platform power probes are bounded, read-only and return errors when unavailable", async () => {
  for (const platform of ["darwin", "win32"]) {
    let invocation;
    const state = await readBluetoothState({ platform, env: { SystemRoot: "C:\\Windows" },
      exec: async (...args) => {
        invocation = args;
        return { stdout: JSON.stringify(platform === "darwin"
          ? { SPBluetoothDataType: [{ controller_properties: { controller_state: "attrib_off" } }] }
          : { states: ["Off"] }) };
      },
    });
    assert.equal(state.status, "unavailable");
    assert.equal(invocation[2].timeout, 5000);
    assert.equal(invocation[2].windowsHide, true);
    if (platform === "darwin") assert.deepEqual(invocation.slice(0, 2), ["/usr/sbin/system_profiler", ["SPBluetoothDataType", "-json"]]);
    else {
      assert.equal(invocation[0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      const script = Buffer.from(invocation[1].at(-1), "base64").toString("utf16le");
      assert.match(script, /GetRadiosAsync/);
      assert.doesNotMatch(script, /SetStateAsync|RequestAccessAsync/);
    }
    assert.equal((await readBluetoothState({ platform, exec: async () => { throw new Error("timeout"); } })).status, "error");
  }
});

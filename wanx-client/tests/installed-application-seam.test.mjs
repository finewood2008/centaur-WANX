import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchInstalledApplication, runManagedApplication } from "../applications/runtime.mjs";

const managedPlatform = ["darwin", "win32"].includes(process.platform) && ["x64", "arm64"].includes(process.arch);
const managedOnly = { skip: !managedPlatform && "Market applications require macOS or Windows x64/arm64" };

async function fixture(t, { signed = true } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wanx-bootstrap-")));
  const previousData = process.env.WANX_HOST_APPLICATION_DATA;
  t.after(async () => {
    if (previousData === undefined) delete process.env.WANX_HOST_APPLICATION_DATA;
    else process.env.WANX_HOST_APPLICATION_DATA = previousData;
    await rm(root, { recursive: true, force: true });
  });
  const applicationRoot = path.join(root, "applications"), applicationId = "test.bootstrap";
  const artifactId = randomUUID(), installPath = path.join(applicationRoot, applicationId, artifactId);
  await mkdir(installPath, { recursive: true });
  const manifest = { applicationId, name: "Bootstrap fixture", version: "1.0.0", protocolVersion: 1,
    runtime: "electron", entrypoint: "entry.cjs", capabilities: [] };
  await writeFile(path.join(installPath, "entry.cjs"), "");
  await writeFile(path.join(installPath, "wanx-app.json"), JSON.stringify(manifest));
  const keys = generateKeyPairSync("ed25519");
  const descriptor = { schemaVersion: 1, applicationId, artifactId, version: "1.0.0", os: process.platform === "win32" ? "windows" : "macos",
    arch: ["x64", "arm64"].includes(process.arch) ? process.arch : "x64", packageType: "wanxapp", hostProtocol: 1,
    minWanxVersion: "0.1.0", fileName: "fixture.wanxapp", sha256: "0".repeat(64), size: 1, manifest };
  const record = { ...manifest, installPath };
  const recordPath = path.join(installPath, ".wanx-install.json");
  const save = () => writeFile(recordPath, JSON.stringify(record));
  async function resign() {
    const bytes = Buffer.from(JSON.stringify(descriptor));
    record.envelope = { keyId: "fixture", descriptorBase64: bytes.toString("base64"),
      signatureBase64: sign(null, bytes, keys.privateKey).toString("base64") };
    await save();
  }
  if (signed) await resign(); else await save();
  const effects = [], messages = [], app = new EventEmitter();
  app.setName = name => effects.push(["name", name]);
  app.setPath = (key, value) => effects.push([key, value]);
  app.focus = () => effects.push(["focus"]);
  const environment = { WANX_HOST_LAUNCH_ID: "launch", WANX_HOST_TOKEN: "test-token",
    WANX_HOST_CLIENT_APPLICATION_ID: applicationId, WANX_HOST_TRANSPORT: "http-v1",
    WANX_HOST_BASE_URL: "http://127.0.0.1:12345", WANX_HOST_INSTALL_ROOT: installPath };
  const options = { applicationRoot, installPath, app, environment,
    trustedKeys: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }) },
    send: message => messages.push(message), receive: listener => { effects.push(["receive"]); app.on("host-message", listener); },
    load: async entry => effects.push(["load", entry]),
  };
  return { root, record, recordPath, manifest, descriptor, options, effects, messages, save, resign, previousData };
}

async function rejectsBeforeLoading(h, launch, code) {
  await assert.rejects(launch(h.options), { code });
  assert.deepEqual(h.effects, []);
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.options.app.eventNames(), []);
  assert.equal(process.env.WANX_HOST_APPLICATION_DATA, h.previousData);
}

for (const platform of ["win32", "darwin"]) {
  for (const [label, launch, signed] of [["market", runManagedApplication, true], ["local", launchInstalledApplication, false]]) {
    test(`${label} bootstrap hides every Windows application window menu and preserves macOS menus (${platform})`, async t => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: platform });
      t.after(() => Object.defineProperty(process, "platform", originalPlatform));
      const h = await fixture(t, { signed });
      const menuCalls = [];
      h.options.load = async () => {
        for (let index = 0; index < 2; index++) {
          const webContents = new EventEmitter();
          const window = Object.assign(new EventEmitter(), { webContents,
            setMenu: value => menuCalls.push([index, "menu", value]),
            setMenuBarVisibility: value => menuCalls.push([index, "visible", value]),
          });
          h.options.app.emit("browser-window-created", {}, window);
          assert.deepEqual(menuCalls, platform === "win32"
            ? Array.from({ length: index + 1 }, (_, n) => [[n, "menu", null], [n, "visible", false]]).flat()
            : []);
          webContents.emit("did-finish-load");
          window.emit("closed");
        }
      };
      await launch(h.options);
      h.options.app.emit("host-message", { type: "wanx:application-activate", launchId: "launch" });
      h.options.app.emit("before-quit");
      assert.deepEqual(h.messages, [{ type: "wanx:application-ready", launchId: "launch" }]);
    });
  }
}

for (const [label, launch, signed] of [["market", runManagedApplication, true], ["local", launchInstalledApplication, false]]) {
  test(`${label} bootstrap accepts HTTP-only launch environment, configures the profile and reports readiness once`, label === "market" ? managedOnly : {}, async t => {
    const h = await fixture(t, { signed });
    await launch(h.options);
    const profile = path.join(h.options.applicationRoot, ".runtime", h.record.applicationId);
    assert.deepEqual(h.effects, [["name", h.record.name], ["userData", profile], ["sessionData", profile], ["receive"], ["load", path.join(h.options.installPath, "entry.cjs")]]);
    assert.deepEqual(h.messages, []);
    const contents = new EventEmitter();
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
      setMenu() {}, setMenuBarVisibility() {},
      isMinimized: () => true, restore: () => h.effects.push(["restore"]), show: () => h.effects.push(["show"]), focus: () => {} });
    h.options.app.emit("browser-window-created", {}, window);
    contents.emit("did-fail-load", {}, -105, "subframe", "", false);
    contents.emit("did-fail-load", {}, -3, "aborted", "", true);
    assert.deepEqual(h.messages, []);
    contents.emit("did-finish-load");
    h.options.app.emit("before-quit");
    assert.deepEqual(h.messages, [{ type: "wanx:application-ready", launchId: "launch" }]);
    const before = h.effects.length;
    h.options.app.emit("host-message", { type: "wanx:application-activate", launchId: "other" });
    assert.equal(h.effects.length, before);
    h.options.app.emit("host-message", { type: "wanx:application-activate", launchId: "launch" });
    assert.deepEqual(h.effects.slice(before), [["restore"], ["show"], ["focus"]]);
  });
}

for (const field of ["WANX_HOST_CLIENT_APPLICATION_ID", "WANX_HOST_TOKEN", "WANX_HOST_LAUNCH_ID"]) {
  test(`market bootstrap checks ${field} before touching an invalid installation`, async t => {
    const h = await fixture(t);
    delete h.options.environment[field];
    h.options.applicationRoot = path.join(h.root, "missing");
    await rejectsBeforeLoading(h, runManagedApplication, "MARKET_APPLICATION_SESSION_REQUIRED");
  });
}

for (const [label, modify, code] of [
  ["missing envelope", h => { delete h.record.envelope; }, "MARKET_UNTRUSTED_KEY"],
  ["untrusted key", h => { h.options.trustedKeys = {}; }, "MARKET_UNTRUSTED_KEY"],
  ["invalid signature", h => { h.record.envelope.signatureBase64 = Buffer.alloc(64).toString("base64"); }, "MARKET_INVALID_SIGNATURE"],
]) {
  test(`market bootstrap rejects ${label} before malformed local record fields`, async t => {
    const h = await fixture(t);
    modify(h);
    h.record.name = "";
    await h.save();
    await rejectsBeforeLoading(h, runManagedApplication, code);
  });
}

test("market bootstrap checks the application directory before reading a record", async t => {
  const h = await fixture(t);
  h.options.environment.WANX_HOST_INSTALL_ROOT = h.root;
  await rejectsBeforeLoading(h, runManagedApplication, "MARKET_INSTALL_STATE_INVALID");
});

test("market bootstrap rejects the wrong platform before reading a missing disk manifest", async t => {
  const h = await fixture(t);
  h.descriptor.os = process.platform === "darwin" ? "windows" : "macos";
  await h.resign();
  await rm(path.join(h.options.installPath, "wanx-app.json"));
  await rejectsBeforeLoading(h, runManagedApplication, "MARKET_INCOMPATIBLE");
});

for (const field of ["arch", "artifactId"]) {
  test(`market bootstrap rejects a mismatched ${field}`, managedOnly, async t => {
    const h = await fixture(t);
    h.descriptor[field] = field === "arch" ? (process.arch === "arm64" ? "x64" : "arm64") : randomUUID();
    await h.resign();
    await rejectsBeforeLoading(h, runManagedApplication, "MARKET_INCOMPATIBLE");
  });
}

test("market bootstrap checks disk manifest parity before later record validation", managedOnly, async t => {
  const h = await fixture(t);
  await writeFile(path.join(h.options.installPath, "wanx-app.json"), JSON.stringify({ ...h.manifest, name: "changed" }));
  h.record.name = "";
  await h.save();
  await rejectsBeforeLoading(h, runManagedApplication, "MARKET_PACKAGE_INVALID");
});

test("market bootstrap rejects a directory entry before loading", managedOnly, async t => {
  const h = await fixture(t);
  const entry = path.join(h.options.installPath, "entry.cjs");
  await rm(entry); await mkdir(entry);
  await rejectsBeforeLoading(h, runManagedApplication, "MARKET_PACKAGE_INVALID");
});

test("market bootstrap observes a record changed before its second validation", managedOnly, async t => {
  const h = await fixture(t);
  let checks = 0;
  Object.defineProperty(h.options.environment, "WANX_HOST_LAUNCH_ID", { get() {
    // Change the real file as the second phase checks its launch identity.
    if (++checks === 2) writeFileSync(h.recordPath, JSON.stringify({ ...h.record, name: "changed after initial checks" }));
    return "launch";
  } });
  await rejectsBeforeLoading(h, runManagedApplication, "APPLICATION_RECORD_INVALID");
});

test("local bootstrap accepts legacy versions without a socket or disk manifest", async t => {
  const h = await fixture(t, { signed: false });
  h.record.version = "development";
  await h.save();
  await rm(path.join(h.options.installPath, "wanx-app.json"));
  await launchInstalledApplication(h.options);
  assert.ok(h.effects.some(([event]) => event === "load"));
});

test("local bootstrap verifies an envelope when present, without adopting market-only rules", async t => {
  const h = await fixture(t);
  h.descriptor.os = process.platform === "darwin" ? "windows" : "macos";
  await h.resign();
  await rm(path.join(h.options.installPath, "wanx-app.json"));
  await launchInstalledApplication(h.options);
  assert.ok(h.effects.some(([event]) => event === "load"));
});

test("local bootstrap checks identity before signature and still rejects invalid signatures", async t => {
  const h = await fixture(t);
  h.record.envelope.signatureBase64 = Buffer.alloc(64).toString("base64");
  await h.save();
  const id = h.options.environment.WANX_HOST_CLIENT_APPLICATION_ID;
  h.options.environment.WANX_HOST_CLIENT_APPLICATION_ID = "another.app";
  await rejectsBeforeLoading(h, launchInstalledApplication, "APPLICATION_RECORD_INVALID");
  h.options.environment.WANX_HOST_CLIENT_APPLICATION_ID = id;
  await rejectsBeforeLoading(h, launchInstalledApplication, "MARKET_INVALID_SIGNATURE");
});

test("local bootstrap checks launch identity before an invalid installation path", async t => {
  const h = await fixture(t, { signed: false });
  delete h.options.environment.WANX_HOST_LAUNCH_ID;
  h.options.installPath = path.join(h.root, "missing");
  await rejectsBeforeLoading(h, launchInstalledApplication, "APPLICATION_RECORD_INVALID");
});

test("local bootstrap rejects a record pointing at another installation", async t => {
  const h = await fixture(t, { signed: false });
  h.record.installPath = h.root;
  await h.save();
  await rejectsBeforeLoading(h, launchInstalledApplication, "APPLICATION_RECORD_INVALID");
});

for (const [label, launch, signed, code] of [["local", launchInstalledApplication, false, "APPLICATION_RECORD_INVALID"], ["market", runManagedApplication, true, "MARKET_PACKAGE_INVALID"]]) {
  test(`${label} bootstrap rejects an entry resolving outside the installation`, {
    skip: process.platform === "win32" ? "Symlink creation requires Windows privileges" : label === "market" ? managedOnly.skip : false,
  }, async t => {
    const h = await fixture(t, { signed });
    const outside = path.join(h.root, "outside.cjs"), entry = path.join(h.options.installPath, "entry.cjs");
    await writeFile(outside, ""); await rm(entry); await symlink(outside, entry);
    await rejectsBeforeLoading(h, launch, code);
  });
}

for (const existingRuntime of [false, true]) {
  test(`bootstrap ${existingRuntime ? "prefers the current profile" : "reuses the legacy profile"}`, async t => {
    const h = await fixture(t, { signed: false });
    const legacy = path.join(h.root, "application-data", h.record.applicationId);
    const current = path.join(h.options.applicationRoot, ".runtime", h.record.applicationId);
    await mkdir(legacy, { recursive: true });
    if (existingRuntime) await mkdir(current, { recursive: true });
    await launchInstalledApplication(h.options);
    assert.deepEqual(h.effects.find(([event]) => event === "userData"), ["userData", existingRuntime ? current : legacy]);
  });
}

for (const [label, launch, signed] of [["market", runManagedApplication, true], ["local", launchInstalledApplication, false]]) {
  test(`${label} bootstrap reports a main-frame failure only once`, label === "market" ? managedOnly : {}, async t => {
    const h = await fixture(t, { signed });
    await launch(h.options);
    const webContents = new EventEmitter();
    h.options.app.emit("browser-window-created", {}, Object.assign(new EventEmitter(), { webContents, setMenu() {}, setMenuBarVisibility() {} }));
    webContents.emit("did-fail-load", {}, -105, "private diagnostic", "private URL", true);
    webContents.emit("did-finish-load");
    h.options.app.emit("before-quit");
    assert.deepEqual(h.messages, [{ type: "wanx:application-failed", launchId: "launch" }]);
  });
}

test("local bootstrap rejects a directory outside installed applications", async t => {
  const h = await fixture(t, { signed: false });
  h.options.installPath = h.root;
  await rejectsBeforeLoading(h, launchInstalledApplication, "APPLICATION_RECORD_INVALID");
});

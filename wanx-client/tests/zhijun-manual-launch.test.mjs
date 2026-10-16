import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { removeZhijunAutoStart, migrateClient } from "../tools/disable-zhijun-autostart.mjs";

const fixture = name => readFile(new URL(`./fixtures/manual-launch/${name}`, import.meta.url), "utf8");
const load = text => import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  let listener, launches = 0, closes = 0, unsubscribed = false;
  let snapshot = { phase: "ready", account: { phase: "authenticated" }, connection: { deviceId: "local-test" } };
  const manager = {
    listInstalled: async () => [{ applicationId: "centaurai.wanx.zhijun" }],
    launch: async () => { launches++; },
    close: async () => { closes++; },
  };
  const client = {
    snapshot: () => snapshot,
    subscribe(fn) { listener = fn; return () => { unsubscribed = true; }; },
  };
  return { client, manager, get launches() { return launches; }, get closes() { return closes; },
    get unsubscribed() { return unsubscribed; },
    notify(next) { snapshot = next; listener(); },
  };
}

async function directory(t, { adapter = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-manual-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "shell"));
  const main = await fixture("legacy-main.mjs"), source = await fixture("legacy-adapter.mjs");
  await writeFile(path.join(root, "shell/main.mjs"), main);
  if (adapter) await writeFile(path.join(root, "zhijun-source-dev.mjs"), source);
  return { root, main, source };
}

test("legacy adapter reproduces launch on ready and the second-instance hook", async () => {
  const h = harness();
  const old = await load(await fixture("legacy-adapter.mjs"));
  const source = await old.createRealSourceDevelopment(h.client, h.manager);
  await settle();
  assert.equal(h.launches, 1);
  const app = new EventEmitter();
  (await load(await fixture("legacy-main.mjs"))).attach(app, source);
  app.emit("second-instance");
  await settle();
  assert.equal(h.launches, 2);
  await source.close();
});

test("patched startup, connection changes and repeat launch never launch Zhijun", async () => {
  const next = removeZhijunAutoStart({ main: await fixture("legacy-main.mjs"), adapter: await fixture("legacy-adapter.mjs") });
  const h = harness();
  const source = await (await load(next.adapter)).createRealSourceDevelopment(h.client, h.manager);
  await settle();
  assert.equal(h.launches, 0);
  for (const phase of ["disconnected", "connecting", "ready", "ready"]) {
    h.notify({ phase, account: { phase: "authenticated" }, connection: phase === "ready" ? { deviceId: "local-test" } : null });
  }
  const app = new EventEmitter();
  (await load(next.main)).attach(app, source);
  app.emit("second-instance");
  await settle();
  assert.equal(h.launches, 0);
  await source.manager.launch(source.applicationId);
  assert.equal(h.launches, 1, "explicit Open through the application manager is preserved");
  await source.close();
  assert.equal(h.closes, 1);
  assert.equal(h.unsubscribed, true);
});

test("CLI defaults to check, backs up before applying and is idempotent", async t => {
  const f = await directory(t);
  const tool = fileURLToPath(new URL("../tools/disable-zhijun-autostart.mjs", import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [tool, "--client-dir", f.root, ...args], { encoding: "utf8" }));
  assert.deepEqual(run(), { changed: true, applied: false });
  assert.equal(await readFile(path.join(f.root, "shell/main.mjs"), "utf8"), f.main);
  const result = run("--apply");
  assert.equal(result.applied, true);
  assert.equal(await readFile(path.join(result.backupDirectory, "shell/main.mjs"), "utf8"), f.main);
  assert.equal(await readFile(path.join(result.backupDirectory, "zhijun-source-dev.mjs"), "utf8"), f.source);
  const next = removeZhijunAutoStart({ main: f.main, adapter: f.source });
  assert.equal(await readFile(path.join(f.root, "shell/main.mjs"), "utf8"), next.main);
  assert.equal(await readFile(path.join(f.root, "zhijun-source-dev.mjs"), "utf8"), next.adapter);
  assert.deepEqual(run("--apply"), { changed: false, applied: false });
  assert.equal((await readdir(f.root)).filter(n => n.startsWith(".manual-launch-backup-")).length, 1);
});

test("unfamiliar adapters are rejected before changing files", async t => {
  const f = await directory(t);
  await writeFile(path.join(f.root, "zhijun-source-dev.mjs"), "export const unknown = true;\n");
  await assert.rejects(migrateClient(f.root, { apply: true }), /UNSUPPORTED_SOURCE_DEVELOPMENT_ADAPTER/);
  assert.equal(await readFile(path.join(f.root, "shell/main.mjs"), "utf8"), f.main);
  assert.equal((await readdir(f.root)).some(n => n.startsWith(".manual-launch-backup-")), false);
  assert.throws(() => removeZhijunAutoStart({ main: "sourceDevelopment.open(unknown)", adapter: f.source }), /UNSUPPORTED_SECOND_INSTANCE_HOOK/);
});

test("ordinary clients without the retired adapter need no migration", async t => {
  const f = await directory(t, { adapter: false });
  const normal = "export const client = true;\n";
  await writeFile(path.join(f.root, "shell/main.mjs"), normal);
  assert.deepEqual(await migrateClient(f.root, { apply: true }), { changed: false, applied: false, reason: "NO_DEVELOPMENT_ADAPTER" });
  assert.equal(await readFile(path.join(f.root, "shell/main.mjs"), "utf8"), normal);
});

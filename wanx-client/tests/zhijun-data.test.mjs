import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectZhijunData } from "../applications/zhijun-data.mjs";

const manifest = {
  applicationId: "centaurai.wanx.zhijun", protocolVersion: 3,
  runtime: "electron", launchMode: "shared", entrypoint: "market/main.mjs",
  compatibility: { localDataSchema: { writeVersion: "9.0.0" } },
};
const scope = "a".repeat(64);
const data = { version: 1, users: { "4": [{ id: "work", agentId: "owned-agent", ready: true, name: "工作", extra: { preserved: true } }] } };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zhijun-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = [path.join(root, "current"), path.join(root, "legacy")];
  const inspect = input => inspectZhijunData({ manifest, profileDirectories: profiles, ...input });
  async function roles(value = data, profile = profiles[0], name = scope) {
    const directory = path.join(profile, "host-scopes", name);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "roles.json");
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  }
  return { root, profiles, inspect, roles };
}

test("absent profiles and the observed Chromium-only legacy profile contain no business data", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.inspect(), { localDataPresent: false });
  for (const name of ["Cache", "Code Cache", "Local Storage", "Shared Dictionary", "blob_storage"])
    await mkdir(path.join(f.profiles[1], name), { recursive: true });
  for (const name of ["Network Persistent State", "Preferences", "SharedStorage", "Trust Tokens", "Trust Tokens-journal"])
    await writeFile(path.join(f.profiles[1], name), "opaque Chromium metadata");
  for (let i = 0; i < 7; i++) await mkdir(path.join(f.profiles[1], "host-scopes", String(i).repeat(64)), { recursive: true });
  // Chromium metadata is opaque and not recursively interpreted as application data.
  await writeFile(path.join(f.profiles[1], "Local Storage", "opaque"), "not JSON");
  assert.deepEqual(await f.inspect(), { localDataPresent: false });
});

test("recognizes actual roles version 1 without changing bytes or trusting manifest writeVersion", async t => {
  const f = await fixture(t);
  const bytes = JSON.stringify(data, null, 2) + "\n";
  const file = await f.roles(bytes);
  assert.deepEqual(await f.inspect(), { localDataPresent: true, localDataSchemaVersion: "1.0.0" });
  assert.equal(await readFile(file, "utf8"), bytes);
  await f.roles({ version: 1, users: {} }, f.profiles[1]);
  assert.deepEqual(await f.inspect(), { localDataPresent: true, localDataSchemaVersion: "1.0.0" });
});

test("both profiles must be understood even if the current profile is readable", async t => {
  const f = await fixture(t);
  await f.roles();
  await f.roles({ version: 2, users: {} }, f.profiles[1]);
  assert.deepEqual(await f.inspect(), { status: "unknown" });
  await f.roles(data, f.profiles[1]);
  await writeFile(path.join(f.profiles[1], "unknown-database.sqlite"), "retained");
  assert.deepEqual(await f.inspect(), { status: "unknown" });
});

test("unknown paths and malformed scopes are not treated as empty data", async t => {
  for (const name of ["custom.db", "host-scopes/not-a-scope/roles.json", `host-scopes/${scope}/unknown.json`, `host-scopes/${scope}/roles.json.123.abcdef123456.tmp`]) {
    await t.test(name, async t => {
      const f = await fixture(t);
      const file = path.join(f.profiles[0], name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{}");
      assert.deepEqual(await f.inspect(), { status: "unknown" });
    });
  }
});

test("corrupt, future and unusable role registries stay unknown", async t => {
  const values = ["{broken", null, [], { version: 2, users: {} }, { version: 1, users: [] },
    { version: 1, users: { "4": {} } }, { version: 1, users: { "4": [null] } },
    { version: 1, users: { "4": [{}] } }, { version: 1, users: { "4": [{ id: "work", ready: "true" }] } }];
  for (let index = 0; index < values.length; index++) await t.test(String(index), async t => {
    const f = await fixture(t);
    await f.roles(typeof values[index] === "string" ? values[index] : JSON.stringify(values[index]));
    assert.deepEqual(await f.inspect(), { status: "unknown" });
  });
});

test("oversized files and non-directory profiles fail closed", async t => {
  const f = await fixture(t);
  await f.roles(" ".repeat(1024 * 1024 + 1));
  assert.deepEqual(await f.inspect(), { status: "unknown" });
  await rm(f.profiles[0], { recursive: true });
  await writeFile(f.profiles[0], "not a directory");
  assert.deepEqual(await f.inspect(), { status: "unknown" });
});

test("hard-linked role files and metadata do not establish schema evidence", async t => {
  const f = await fixture(t);
  const file = await f.roles();
  await link(file, path.join(f.root, "outside"));
  assert.deepEqual(await f.inspect(), { status: "unknown" });
  await rm(file);
  await link(path.join(f.root, "outside"), path.join(f.profiles[0], "Preferences"));
  assert.deepEqual(await f.inspect(), { status: "unknown" });
});

test("unreadable profiles are unknown, not empty", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async t => {
  const f = await fixture(t);
  await f.roles();
  await chmod(f.profiles[0], 0);
  try { assert.deepEqual(await f.inspect(), { status: "unknown" }); }
  finally { await chmod(f.profiles[0], 0o700); }
});

test("links at profile, scope and metadata boundaries are rejected", { skip: process.platform === "win32" }, async t => {
  for (const name of ["", "host-scopes", `host-scopes/${scope}`, `host-scopes/${scope}/roles.json`, "Cache", "Preferences"]) {
    await t.test(name || "profile", async t => {
      const f = await fixture(t);
      const target = path.join(f.root, "target");
      if (name.endsWith("roles.json") || name === "Preferences") await writeFile(target, JSON.stringify(data));
      else await mkdir(target);
      const destination = path.join(f.profiles[0], name);
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(target, destination);
      assert.deepEqual(await f.inspect(), { status: "unknown" });
    });
  }
});

test("linked profile parents cannot redirect or hide the retained profile", { skip: process.platform === "win32" }, async t => {
  for (const dangling of [false, true]) await t.test(dangling ? "dangling parent" : "existing parent", async t => {
    const f = await fixture(t);
    const parent = path.join(f.root, "application-data"), target = path.join(f.root, "elsewhere");
    if (!dangling) await f.roles(data, path.join(target, "zhijun"));
    await symlink(target, parent);
    assert.deepEqual(await f.inspect({ profileDirectories: [f.profiles[0], path.join(parent, "zhijun")] }), { status: "unknown" });
  });
});

test("the reader is limited to the audited shared Zhijun runtime", async t => {
  const f = await fixture(t);
  await f.roles();
  for (const override of [{ applicationId: "other.app" }, { protocolVersion: 1 }, { runtime: "web" },
    { launchMode: "isolated" }, { entrypoint: "desktop/main.mjs" }])
    assert.equal(await f.inspect({ manifest: { ...manifest, ...override } }), null);
  assert.deepEqual(await f.inspect({ profileDirectories: [] }), { status: "unknown" });
});

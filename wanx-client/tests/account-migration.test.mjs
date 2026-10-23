import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "../account/index.mjs";
import { createSecureAccountStore } from "../account/store.mjs";
import { createLocalEncryption, isLocalCiphertext } from "../account/local-encryption.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "wanx-account-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "account.enc");
  // Opaque legacy ciphertext; the fake OS adapter owns its plaintext mapping.
  const encrypted = Buffer.from("v10-legacy-fixture");
  let plaintext;
  let reads = 0;
  const legacyStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { plaintext = value; return encrypted; },
    decryptString(bytes) {
      reads++;
      assert.deepEqual(bytes, encrypted);
      return plaintext;
    },
  };
  const oldStore = createSecureAccountStore({ filePath, safeStorage: legacyStorage });
  const local = createLocalEncryption({ directory, legacyStorage });
  const store = createSecureAccountStore({ filePath, safeStorage: local });
  return { directory, filePath, encrypted, legacyStorage, oldStore, store, local, reads: () => reads };
}

test("legacy remembered login migrates atomically and keeps the login client identity", async t => {
  const f = await fixture(t);
  const input = { phone: "13800138000", password: "fixture-password", remember: true };
  const clients = [];
  const fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    clients.push(body.clientId);
    return new Response(JSON.stringify({ code: 200, data: {
      accountId: "fixture-account", clientId: body.clientId,
      accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 3600,
    } }));
  };
  const original = createAccount({ store: f.oldStore, fetch });
  await original.loginPassword(input);
  const saved = await f.oldStore.load();
  saved.active = null;
  await f.oldStore.save(saved);
  await original.close();
  const beforeReads = f.reads();
  const upgraded = createAccount({ store: f.store, fetch });
  t.after(() => upgraded.close());
  assert.deepEqual(await upgraded.getRememberedLogin(), input);
  assert.equal(f.reads(), beforeReads + 1);
  assert.ok(isLocalCiphertext(await readFile(f.filePath)));
  await upgraded.loginPassword(input);
  assert.equal(upgraded.snapshot().phase, "authenticated");
  assert.equal(clients[1], clients[0]);
  assert.deepEqual((await f.store.load()).accounts, saved.accounts);
  assert.equal(f.reads(), beforeReads + 1);
  const restarted = createSecureAccountStore({ filePath: f.filePath,
    safeStorage: createLocalEncryption({ directory: f.directory }) });
  assert.deepEqual((await restarted.load()).rememberedLogin, input);
});

test("new and migrated stores never access the legacy provider again", async t => {
  const f = await fixture(t);
  f.legacyStorage.isEncryptionAvailable = () => { throw new Error("unexpected OS access"); };
  assert.equal(await f.store.load(), null);
  await f.store.save({ value: "fixture" });
  assert.deepEqual(await f.store.load(), { value: "fixture" });
  assert.equal(f.reads(), 0);
});

for (const failure of ["locked", "decrypt", "json", "write"]) {
  test(`legacy migration ${failure} failure preserves the original ciphertext`, async t => {
    const f = await fixture(t);
    await f.oldStore.save({ value: "fixture" });
    if (failure === "locked") f.legacyStorage.isEncryptionAvailable = () => false;
    if (failure === "decrypt") f.legacyStorage.decryptString = () => { throw new Error("private OS error"); };
    if (failure === "json") f.legacyStorage.decryptString = () => "not json";
    if (failure === "write") await writeFile(join(f.directory, "local-credentials"), "blocked");
    await assert.rejects(f.store.load(), new RegExp(failure === "write" ? "SECURE_STORAGE_WRITE_FAILED" : "SECURE_STORAGE_READ_FAILED"));
    assert.deepEqual(await readFile(f.filePath), f.encrypted);
  });
}

for (const failure of ["tampered", "missing-key", "unknown-format"]) {
  test(`${failure} is never retried with OS encryption or treated as an empty account`, async t => {
    const f = await fixture(t);
    await f.store.save({ value: "fixture" });
    if (failure === "missing-key") await rm(join(f.directory, "local-credentials", "master.key"));
    const bytes = await readFile(f.filePath);
    if (failure === "tampered") bytes[bytes.length - 1] ^= 1;
    if (failure === "unknown-format") bytes.fill(0);
    await writeFile(f.filePath, bytes);
    const store = createSecureAccountStore({ filePath: f.filePath,
      safeStorage: createLocalEncryption({ directory: f.directory, legacyStorage: f.legacyStorage }) });
    await assert.rejects(store.load(), /SECURE_STORAGE_READ_FAILED/);
    assert.deepEqual(await readFile(f.filePath), bytes);
    assert.equal(f.reads(), 0);
  });
}

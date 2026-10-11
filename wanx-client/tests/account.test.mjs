import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAccount, consumerSignature } from "../account/index.mjs";
import { createSecureAccountStore } from "../account/store.mjs";

function memoryStore() {
  let value = null;
  return {
    load: async () => structuredClone(value),
    save: async (next) => {
      value = structuredClone(next);
    },
    clear: async () => {
      value = null;
    },
  };
}
const reply = (data, status = 200) =>
  new Response(JSON.stringify({ code: status, data }), { status });
function fixture(extra = {}) {
  const calls = [];
  const store = extra.store || memoryStore();
  let currentClient,
    refreshCount = 0;
  const account = createAccount({
    store,
    ...extra,
    fetch: async (url, options) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, options, body });
      if (url.endsWith("/login")) {
        currentClient = body.clientId;
        return reply({
          accountId: "account-one",
          clientId: currentClient,
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresIn: 3600,
        });
      }
      if (url.endsWith("/refresh")) {
        refreshCount++;
        const saved = await store.load();
        return reply({
          accountId: "account-one",
          clientId: currentClient || saved.active.session.clientId,
          accessToken: `access-rotated-${refreshCount}`,
          refreshToken: `refresh-rotated-${refreshCount}`,
          expiresIn: 3600,
        });
      }
      if (url.endsWith("/devices"))
        return reply([
          {
            deviceId: "box-one",
            deviceName: "我的盒子",
            online: true,
            privateToken: "must-not-expose",
          },
        ]);
      if (url.endsWith("/send"))
        return reply({ expiresIn: 300, debugCode: "do-not-expose" });
      return reply({});
    },
  });
  return { account, calls, store, refreshCount: () => refreshCount };
}

test("Consumer DER signature matches Python canonical request, excluding deployment prefix", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const identity = { clientId: "client-one", privateKey };
  const body = '{"requestId":"req-one"}';
  const headers = consumerSignature({
    identity,
    accountId: "account-one",
    method: "POST",
    path: "/app-api/network/enrollments",
    body,
    now: 1000000,
    nonce: "known-nonce-12345",
  });
  const canonical = [
    "NEXUSAOS-CONSUMER-V1",
    "account-one",
    "client-one",
    "POST",
    "/app-api/network/enrollments",
    "1000",
    "known-nonce-12345",
    createHash("sha256").update(body).digest("hex"),
  ].join("\n");
  assert.equal(
    verify(
      "sha256",
      Buffer.from(canonical),
      publicKey,
      Buffer.from(headers["X-Nexus-Signature"], "base64"),
    ),
    true,
  );
});

test("versioned signatures canonicalize duplicate query keys and RFC3986 escaping", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const headers = consumerSignature({
    identity: { clientId: "c", privateKey },
    accountId: "a",
    method: "GET",
    path: "/app-api/v1/sync?z=x&x=b&x=a%20!'",
    now: 1000,
    nonce: "test-nonce",
  });
  const canonical = [
    "NEXUSAOS-CONSUMER-APP-V1",
    "a",
    "c",
    "GET",
    "/app-api/v1/sync",
    "x=a%20%21%27&x=b&z=x",
    "1",
    "test-nonce",
    createHash("sha256").update("").digest("hex"),
  ].join("\n");
  assert.equal(
    verify(
      "sha256",
      Buffer.from(canonical),
      publicKey,
      Buffer.from(headers["X-Nexus-Signature"], "base64"),
    ),
    true,
  );
});

test("password login, signed directory, and snapshots never return credentials", async () => {
  const { account, calls, store } = fixture();
  const states = [];
  account.subscribe((state) => states.push(state));
  await account.loginPassword({
    phone: "13800138000",
    password: "password-test",
  });
  assert.equal(account.snapshot().phase, "authenticated");
  assert.equal(
    calls[0].body.platform,
    process.platform === "darwin"
      ? "macos"
      : process.platform === "win32"
      ? "windows"
      : process.platform,
  );
  assert.match(calls[0].body.clientPublicKey, /BEGIN PUBLIC KEY/);
  await account.listDevices();
  assert.equal(account.snapshot().devices[0].deviceName, "我的盒子");
  assert.equal(calls[1].options.headers.Authorization, "Bearer access-secret");
  assert.equal(calls[1].options.redirect, "error");
  assert.match(calls[1].url, /prod-api\/app-api\/devices$/);
  assert.doesNotMatch(
    JSON.stringify(states),
    /secret|PRIVATE KEY|must-not-expose|password-test/,
  );
  assert.deepEqual(Object.keys(account.getIdentity()).sort(), [
    "accountId",
    "clientId",
  ]);
  assert.equal(
    (await store.load()).active.session.accessToken,
    "access-secret",
  );
  await account.close();
  assert.ok(
    await store.load(),
    "closing preserves encrypted session for restore",
  );
});

test("SMS result strips debugCode, login uses SMS route", async () => {
  const { account, calls } = fixture();
  assert.deepEqual(await account.sendSMS("13800138000"), { expiresIn: 300 });
  await account.loginSMS({ phone: "13800138000", code: "123456" });
  assert.match(calls[1].url, /auth\/sms\/login$/);
});

test("refresh is single flight and persisted; restore refreshes silently with same identity", async () => {
  const { account, store, refreshCount } = fixture();
  await account.loginPassword({
    phone: "13800138000",
    password: "password-test",
  });
  const identity = account.getIdentity();
  await Promise.all([account.refresh(), account.refresh(), account.refresh()]);
  assert.equal(refreshCount(), 1);
  await account.close();
  const restored = fixture({ store });
  await restored.account.restore();
  assert.deepEqual(restored.account.getIdentity(), identity);
  assert.equal(restored.calls.length, 1);
  assert.match(restored.calls[0].url, /auth\/refresh$/);
});

test("HTTPS and path confinement reject caller-controlled origins and traversal", async () => {
  for (const baseURL of [
    "http://localhost",
    "https://user:pass@example.com",
    "https://example.com/?token=a",
  ])
    assert.throws(() => createAccount({ baseURL }), /ACCOUNT_INVALID_URL/);
  const { account } = fixture();
  await account.loginPassword({
    phone: "13800138000",
    password: "password-test",
  });
  for (const path of [
    "https://evil.test/app-api/devices",
    "//evil.test/app-api/devices",
    "/app-api/../admin",
    "/app-api/%2e%2e/admin",
    "/admin",
    "/app-api/devices#fragment",
  ])
    await assert.rejects(account.request({ path }), /ACCOUNT_INVALID_PATH/);
});

test("logout cancels late login response so it cannot resurrect a session", async () => {
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const store = memoryStore();
  const account = createAccount({
    store,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      await new Promise((resolve) => {
        release = resolve;
        started();
      });
      return reply({
        accountId: "account-one",
        clientId: body.clientId,
        accessToken: "secret",
        refreshToken: "secret",
        expiresIn: 3600,
      });
    },
  });
  const loggingIn = account.loginPassword({
    phone: "13800138000",
    password: "password-test",
  });
  await ready;
  await account.logout();
  release();
  await assert.rejects(loggingIn, /ACCOUNT_CANCELLED/);
  assert.equal(account.snapshot().phase, "signed_out");
  assert.equal((await store.load()).active, null);
});

test("logout is signed, clears stored credentials and directory", async () => {
  const { account, calls, store } = fixture();
  await account.loginSMS({ phone: "13800138000", code: "123456" });
  await account.listDevices();
  await account.logout();
  const last = calls.at(-1);
  assert.match(last.url, /auth\/logout$/);
  assert.equal(last.body.refreshToken, "refresh-secret");
  assert.ok(last.options.headers["X-Nexus-Signature"]);
  assert.equal((await store.load()).active, null);
  assert.deepEqual(account.snapshot().devices, []);
});

test("network contract errors retain codes while arbitrary server text is stripped", async () => {
  const store = memoryStore();
  const setup = fixture({ store });
  await setup.account.loginSMS({ phone: "13800138000", code: "123456" });
  let mode = "refresh";
  const account = createAccount({
    store,
    fetch: async () => {
      if (mode === "refresh") {
        const saved = await store.load();
        return reply({ ...saved.active.session, expiresIn: 3600 });
      }
      return new Response(
        JSON.stringify({
          code: "NETWORK_ENROLLMENT_REQUIRED",
          msg: "server secret",
        }),
        { status: 404 },
      );
    },
  });
  await account.restore();
  mode = "error";
  await assert.rejects(
    account.request({
      method: "POST",
      path: "/app-api/network/restore",
      body: {},
    }),
    (error) =>
      error.code === "NETWORK_ENROLLMENT_REQUIRED" &&
      error.status === 404 &&
      !error.message.includes("secret"),
  );
});

test("encrypted store persists only ciphertext, rejects plaintext backend, clears atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wanx-account-test-"));
  try {
    const filePath = join(directory, "session.enc");
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 173),
      decryptString: (value) =>
        value.map((byte) => byte ^ 173).toString("utf8"),
    };
    const store = createSecureAccountStore({ filePath, safeStorage });
    assert.equal(await store.load(), null);
    await store.save({
      privateKey: "private-key-secret",
      refreshToken: "refresh-secret",
    });
    assert.doesNotMatch(
      (await readFile(filePath)).toString(),
      /private-key-secret|refresh-secret/,
    );
    assert.equal((await store.load()).refreshToken, "refresh-secret");
    await store.clear();
    assert.equal(await store.load(), null);
    const insecure = createSecureAccountStore({
      filePath,
      safeStorage: {
        ...safeStorage,
        getSelectedStorageBackend: () => "basic_text",
      },
    });
    await assert.rejects(
      insecure.save({ token: "secret" }),
      /SECURE_STORAGE_UNAVAILABLE/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logout preserves per-account identity across restart without retaining sessions", async () => {
  const store = memoryStore();
  const first = fixture({ store });
  await first.account.loginSMS({ phone: "13800138000", code: "123456" });
  const original = first.account.getIdentity();
  await first.account.logout();
  assert.equal(first.account.getIdentity(), null);
  await first.account.close();
  const second = fixture({ store });
  await second.account.restore();
  assert.equal(second.account.snapshot().phase, "signed_out");
  assert.equal(second.calls.length, 0);
  await second.account.loginSMS({ phone: "13900139000", code: "123456" });
  assert.notEqual(second.account.getIdentity().clientId, original.clientId);
  await second.account.logout();
  await second.account.loginSMS({ phone: "13800138000", code: "123456" });
  assert.equal(second.account.getIdentity().clientId, original.clientId);
});

test("redirects and oversized JSON responses are rejected without exposing contents", async () => {
  const store = memoryStore();
  const setup = fixture({ store });
  await setup.account.loginSMS({ phone: "13800138000", code: "123456" });
  let mode = "refresh";
  const account = createAccount({
    store,
    fetch: async () => {
      if (mode === "refresh") {
        const saved = await store.load();
        return reply({ ...saved.active.session, expiresIn: 3600 });
      }
      if (mode === "redirect")
        return { redirected: true, url: "https://evil.test/", status: 200 };
      return reply({ text: "secret".repeat(400000) });
    },
  });
  await account.restore();
  mode = "redirect";
  await assert.rejects(
    account.request({ path: "/app-api/devices" }),
    /ACCOUNT_REDIRECT_REJECTED/,
  );
  mode = "large";
  await assert.rejects(
    account.request({ path: "/app-api/devices" }),
    /ACCOUNT_INVALID_RESPONSE/,
  );
});

test("401 refresh rotates token once and retries request with a new signature", async () => {
  const store = memoryStore();
  const setup = fixture({ store });
  await setup.account.loginSMS({ phone: "13800138000", code: "123456" });
  let requests = 0,
    refreshes = 0;
  const signatures = [];
  const account = createAccount({
    store,
    fetch: async (url, options) => {
      if (url.endsWith("/refresh")) {
        refreshes++;
        const saved = await store.load();
        return reply({
          ...saved.active.session,
          accessToken: `fresh-${refreshes}`,
          expiresIn: 3600,
        });
      }
      requests++;
      signatures.push(options.headers["X-Nexus-Signature"]);
      assert.ok(
        options.headers.Authorization,
        "request cannot disable authentication",
      );
      return requests === 1 ? reply({}, 401) : reply({ ready: true });
    },
  });
  await account.restore();
  assert.deepEqual(
    await account.request({
      path: "/app-api/network/restore",
      authenticated: false,
    }),
    { ready: true },
  );
  assert.equal(refreshes, 2);
  assert.notEqual(signatures[0], signatures[1]);
});

test("revoked refresh publishes signed_out, clears tokens, and retains the client identity", async () => {
  const store = memoryStore();
  const setup = fixture({ store });
  await setup.account.loginSMS({ phone: "13800138000", code: "123456" });
  const identity = setup.account.getIdentity();
  let revoked = false;
  const account = createAccount({
    store,
    fetch: async () => {
      if (revoked) return reply({}, 401);
      const saved = await store.load();
      return reply({ ...saved.active.session, expiresIn: 3600 });
    },
  });
  await account.restore();
  revoked = true;
  await assert.rejects(account.refresh(), /ACCOUNT_SESSION_EXPIRED/);
  assert.equal(account.snapshot().phase, "signed_out");
  assert.equal(account.getIdentity(), null);
  const saved = await store.load();
  assert.equal(saved.active, null);
  assert.equal(
    saved.accounts["13800138000"].identity.clientId,
    identity.clientId,
  );
});

test("network 404 distinguishes an undeployed API from a missing enrollment", async () => {
  const store = memoryStore();
  const setup = fixture({ store });
  await setup.account.loginSMS({ phone: "13800138000", code: "123456" });
  let responseBody = { detail: "Not Found" },
    status = 404;
  const account = createAccount({
    store,
    fetch: async (url) => {
      if (url.endsWith("/auth/refresh")) {
        const saved = await store.load();
        return reply({ ...saved.active.session, expiresIn: 3600 });
      }
      return new Response(
        typeof responseBody === "string"
          ? responseBody
          : JSON.stringify(responseBody),
        { status },
      );
    },
  });
  await account.restore();
  for (const path of ["/app-api/network/restore", "/app-api/network/devices"]) {
    await assert.rejects(
      account.request({ path }),
      (error) =>
        error.code === "NETWORK_SERVICE_NOT_DEPLOYED" && error.status === 404,
    );
  }
  for (const body of [
    { code: "NETWORK_ENROLLMENT_REQUIRED" },
    { errorCode: "NETWORK_ENROLLMENT_REQUIRED" },
    { code: 404, data: { errorCode: "NETWORK_ENROLLMENT_REQUIRED" } },
  ]) {
    responseBody = body;
    await assert.rejects(
      account.request({ path: "/app-api/network/restore" }),
      (error) =>
        error.code === "NETWORK_ENROLLMENT_REQUIRED" && error.status === 404,
    );
  }
  responseBody = { detail: "Not Found" };
  await assert.rejects(
    account.request({ path: "/app-api/devices" }),
    (error) => error.code === "ACCOUNT_REQUEST_FAILED" && error.status === 404,
  );
  responseBody = "<html>Not Found</html>";
  await assert.rejects(
    account.request({ path: "/app-api/network/restore" }),
    (error) =>
      error.code === "NETWORK_SERVICE_NOT_DEPLOYED" && error.status === 404,
  );
  status = 503;
  responseBody = { detail: "Service unavailable" };
  await assert.rejects(
    account.request({ path: "/app-api/network/restore" }),
    (error) => error.code === "ACCOUNT_REQUEST_FAILED" && error.status === 503,
  );
  status = 200;
  responseBody = null;
  await assert.rejects(
    account.request({ path: "/app-api/network/restore" }),
    /ACCOUNT_INVALID_RESPONSE/,
  );
});

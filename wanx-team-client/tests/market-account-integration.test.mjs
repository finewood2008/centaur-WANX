import test from "node:test";
import assert from "node:assert/strict";
import { createHash, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAccount } from "../account/index.mjs";
import { createApplicationMarket } from "../applications/market.mjs";
import { createApplicationInstaller } from "../applications/installer.mjs";
import { createMarketSessionGuard } from "../shell/market-session.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/market-contract-v1.json", import.meta.url), "utf8"));
const descriptor = JSON.parse(Buffer.from(fixture.envelope.descriptorBase64, "base64"));
const success = (data) => Response.json({ code: 200, success: true, data });

async function setup(t, marketResponse) {
  let saved = null, identity, refreshed = false;
  const requests = [], nonces = new Set();
  const account = createAccount({
    store: {
      load: async () => saved,
      save: async (value) => { saved = structuredClone(value); },
      clear: async () => { saved = null; },
    },
    fetch: async (url, options) => {
      assert.equal(new URL(url).origin, "https://boss.nexusaos.qitus.cn");
      assert.ok(new URL(url).pathname.startsWith("/prod-api/app-api/"));
      const route = new URL(url).pathname.slice("/prod-api".length);
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      if (route === "/app-api/auth/password/login") {
        identity = { clientId: body.clientId, publicKey: body.clientPublicKey };
        return success({ accountId: "market-test", clientId: identity.clientId,
          accessToken: "test-access", refreshToken: "test-refresh", expiresIn: 3600 });
      }
      if (route === "/app-api/auth/refresh") {
        assert.equal(body.refreshToken, "test-refresh");
        refreshed = true;
        return success({ accountId: "market-test", clientId: identity.clientId,
          accessToken: "test-access-refreshed", refreshToken: "test-refresh-rotated", expiresIn: 3600 });
      }
      assert.ok(route.startsWith("/app-api/market/"));
      assert.equal(options.headers.Authorization, `Bearer ${refreshed ? "test-access-refreshed" : "test-access"}`);
      assert.equal(options.headers["X-Nexus-Signature-Version"], undefined);
      const headers = options.headers;
      const digest = createHash("sha256").update(options.body || "").digest("hex");
      assert.equal(headers["X-Nexus-Body-SHA256"], digest);
      assert.ok(!nonces.has(headers["X-Nexus-Nonce"]));
      nonces.add(headers["X-Nexus-Nonce"]);
      const canonical = ["NEXUSAOS-CONSUMER-V1", "market-test", identity.clientId,
        options.method, route, headers["X-Nexus-Timestamp"], headers["X-Nexus-Nonce"], digest].join("\n");
      assert.ok(verify("sha256", Buffer.from(canonical), identity.publicKey,
        Buffer.from(headers["X-Nexus-Signature"], "base64")));
      requests.push({ route, body, refreshed });
      return marketResponse({ route, body, refreshed });
    },
  });
  await account.loginPassword({ phone: "13800000000", password: "test-password" });
  const guard = createMarketSessionGuard(account);
  t.after(() => guard.close());
  const root = await mkdtemp(path.join(tmpdir(), "wanx-market-account-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installer = createApplicationInstaller({ rootDir: path.join(root, "applications"), trustedKeys: fixture.trustedKeys });
  let downloads = 0;
  const market = createApplicationMarket({
    request: (input) => account.request(input),
    applications: { ...installer, listInstalled: installer.list },
    wanxVersion: "0.1.0", platform: "darwin", arch: "arm64", trustedKeys: fixture.trustedKeys,
    temporaryRoot: root, captureSession: () => guard.captureSession(),
    fetch: async (url, options) => {
      assert.equal(url, "https://oss.example.test/app.wanxapp?signature=example");
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "error");
      downloads++;
      return new Response(Buffer.from(fixture.archiveBase64, "base64"));
    },
  });
  return { market, installer, requests, downloads: () => downloads };
}

test("Consumer login, signed market HTTP, token refresh, OSS download and verified installation work together", async (t) => {
  const { applicationId, artifactId } = descriptor;
  const h = await setup(t, ({ route, body, refreshed }) => {
    if (route === "/app-api/market/apps") {
      // Consumer's existing auth handler can return HTTP 200 with business code 401.
      if (!refreshed) return Response.json({ code: 401, success: false, msg: "expired" });
      assert.equal(body, undefined);
      return success({ items: [{ applicationId, name: "Market fixture", listed: true }] });
    }
    if (route === `/app-api/market/apps/${applicationId}/candidate`) {
      assert.deepEqual(body, { os: "macos", arch: "arm64", wanxVersion: "0.1.0", hostProtocol: 1, supportedDescriptorSchemas: [1, 2, 3], supportsReleaseAccess: true,
        ...(body.currentVersion ? { currentVersion: descriptor.version, currentArtifactId: artifactId } : {}) });
      return success({ status: body.currentVersion ? "up_to_date" : "available",
        release: { releaseId: "11111111-1111-4111-8111-111111111111", version: descriptor.version, notes: "Fixture", revision: 1 },
        artifact: { artifactId, os: descriptor.os, arch: descriptor.arch, packageType: "wanxapp",
          fileName: descriptor.fileName, size: descriptor.size, sha256: descriptor.sha256,
          status: "ready", envelope: fixture.envelope } });
    }
    assert.equal(route, `/app-api/market/artifacts/${artifactId}/download`);
    assert.deepEqual(body, {});
    return success({ artifactId, url: "https://oss.example.test/app.wanxapp?signature=example",
      expiresAt: new Date(Date.now() + 300000).toISOString() });
  });
  assert.equal((await h.market.list()).items[0].applicationId, applicationId);
  assert.equal((await h.market.candidate(applicationId)).status, "available");
  await h.market.install(applicationId);
  assert.equal((await h.installer.list())[0].artifactId, artifactId);
  assert.equal((await h.market.candidate(applicationId)).status, "up_to_date");
  assert.equal(h.downloads(), 1);
  assert.equal(h.requests.filter((request) => request.route.endsWith("/apps")).length, 2);
  assert.equal(h.requests.filter((request) => request.route.endsWith("/candidate")).length, 3);
});

test("an old Admin rejecting only supportsReleaseAccess is retried once without changing the signed artifact", async t => {
  const h = await setup(t, ({ route, body }) => {
    assert.equal(route, `/app-api/market/apps/${descriptor.applicationId}/candidate`);
    if (body.supportsReleaseAccess === true) return Response.json({ detail: [
      { type: "extra_forbidden", loc: ["body", "supportsReleaseAccess"], msg: "Extra inputs are not permitted", input: true },
    ] }, { status: 422 });
    return success({ status: "available", release: { version: descriptor.version }, artifact: { ...descriptor, status: "ready", envelope: fixture.envelope } });
  });
  assert.equal((await h.market.candidate(descriptor.applicationId)).artifact.artifactId, descriptor.artifactId);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.supportsReleaseAccess, undefined);
});

for (const detail of [
  [{ type: "extra_forbidden", loc: ["body", "wanxVersion"] }],
  [{ type: "bool_type", loc: ["body", "supportsReleaseAccess"] }],
  [{ type: "extra_forbidden", loc: ["body", "supportsReleaseAccess"] }, { type: "missing", loc: ["body", "arch"] }],
]) test("unrelated candidate validation errors never fall back to a weaker request", async t => {
  const h = await setup(t, () => Response.json({ detail }, { status: 422 }));
  await assert.rejects(h.market.candidate(descriptor.applicationId), { status: 422, code: "ACCOUNT_REQUEST_FAILED" });
  assert.equal(h.requests.length, 1);
});

for (const [name, response, code] of [
  ["HTML from an undeployed route", () => new Response("<html>Not Found</html>", { status: 404 }), "MARKET_SERVICE_NOT_DEPLOYED"],
  ["JSON from an undeployed route", () => Response.json({ detail: "Not Found" }, { status: 404 }), "MARKET_SERVICE_NOT_DEPLOYED"],
  ["revoked download", () => Response.json({ code: 404, success: false, errorCode: "MARKET_DOWNLOAD_UNAVAILABLE" }, { status: 404 }), "MARKET_DOWNLOAD_UNAVAILABLE"],
  ["retired app", () => Response.json({ code: 410, success: false, errorCode: "APPLICATION_RETIRED" }, { status: 410 }), "APPLICATION_RETIRED"],
  ["gray access denied", () => Response.json({ code: 403, success: false, errorCode: "MARKET_GRAY_ACCESS_DENIED" }, { status: 403 }), "MARKET_GRAY_ACCESS_DENIED"],
  ["storage outage", () => Response.json({ code: 503, success: false, errorCode: "MARKET_STORAGE_UNAVAILABLE" }, { status: 503 }), "MARKET_STORAGE_UNAVAILABLE"],
]) test(`market preserves actionable errors for ${name}`, async (t) => {
  const h = await setup(t, response);
  await assert.rejects(h.market.candidate(descriptor.applicationId), { code });
  assert.equal(h.downloads(), 0);
  assert.deepEqual(await h.installer.list(), []);
});

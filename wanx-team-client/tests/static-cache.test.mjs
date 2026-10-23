import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { createDashboardGateway } from "../octop/gateway.mjs";
import {
  createStaticAssetCache,
  validAssetManifest,
} from "../octop/static-cache.mjs";

const bytes = Buffer.from("export const value = 42;\n".repeat(200));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const name = "/assets/app-hash.js";
const manifest = {
  version: 1,
  release: sha("release"),
  assets: {
    [name]: {
      sha256: sha(bytes),
      size: bytes.length,
      contentType: "text/javascript",
    },
  },
};
const scope = { accountId: "account", boxId: "box" };
async function fixture(t, maxBytes) {
  const directory = await mkdtemp(path.join(tmpdir(), "wanx-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cache: createStaticAssetCache({ directory, maxBytes }) };
}
async function store(cache, value = bytes, options = {}) {
  const incoming = new PassThrough();
  incoming.statusCode = options.status || 200;
  incoming.headers = options.headers || {};
  cache.capture(scope, manifest, options.name || name, incoming);
  incoming.resume();
  const end = once(incoming, "end");
  incoming.end(value);
  await end;
  await cache.flush();
}

test("cache stores verified assets, separates trust/releases and rejects tampering", async (t) => {
  const { cache, directory } = await fixture(t);
  await store(cache, gzipSync(bytes), {
    headers: { "content-encoding": "gzip" },
  });
  assert.deepEqual((await cache.get(scope, manifest, name)).data, bytes);
  assert.equal(
    await cache.get({ ...scope, accountId: "other" }, manifest, name),
    null,
  );
  assert.equal(
    await cache.get({ ...scope, boxId: "other" }, manifest, name),
    null,
  );
  assert.equal(
    await cache.get(scope, { ...manifest, release: sha("new") }, name),
    null,
  );
  const file = (await readdir(directory)).find((v) => v.endsWith(".asset"));
  await writeFile(path.join(directory, file), Buffer.alloc(bytes.length));
  assert.equal(await cache.get(scope, manifest, name), null);
  await store(cache, Buffer.from("corrupt"));
  assert.equal(await cache.get(scope, manifest, name), null);
});

test("API, query paths, cookies, unknown encodings, invalid manifests and disk bounds", async (t) => {
  const { cache, directory } = await fixture(t, bytes.length - 1);
  for (const options of [
    { name: "/api/assets.js" },
    { name: name + "?token=x" },
    { headers: { "set-cookie": ["a=b"] } },
    { headers: { "content-encoding": "br" } },
    { status: 206 },
  ]) {
    await store(cache, bytes, options);
    assert.equal(await cache.get(scope, manifest, name), null);
  }
  assert.equal(
    validAssetManifest({
      ...manifest,
      assets: { "/assets/../secret.js": manifest.assets[name] },
    }),
    false,
  );
  assert.equal(
    validAssetManifest({
      ...manifest,
      assets: { [name]: { ...manifest.assets[name], size: 1e9 } },
    }),
    false,
  );
  await store(cache);
  assert.deepEqual(await readdir(directory), []);
});

test("new random gateway reuses verified assets but never bypasses bootstrap or lease", async (t) => {
  const { cache } = await fixture(t);
  let token = "live";
  let assetRequests = 0;
  let manifests = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === "/api/platform/assets/manifest") {
      assert.equal(req.headers.authorization, "Bearer live");
      manifests++;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(manifest));
    }
    if (req.url === name) {
      assetRequests++;
      res.setHeader("content-encoding", "gzip");
      return res.end(gzipSync(bytes));
    }
    res.end("api");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        upstream.closeAllConnections();
        upstream.close(resolve);
      }),
  );
  const create = async (bootstrap = true) => {
    const gateway = await createDashboardGateway({
      targetURL: `http://127.0.0.1:${upstream.address().port}`,
      staticCache: cache,
      cacheScope: scope,
      session: {
        getToken: () => token,
        close: async () => {},
        subscribe: () => () => {},
      },
    });
    t.after(() => gateway.close());
    if (bootstrap) await fetch(gateway.url);
    // The manifest request starts independently of the first asset request.
    for (let i = 0; i < 50 && manifests === 0; i++)
      await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 10));
    return gateway;
  };
  const first = await create();
  assert.equal(
    await (await fetch(first.origin + name)).text(),
    bytes.toString(),
  );
  await cache.flush();
  await first.close();
  const second = await create(false);
  assert.notEqual(second.origin, first.origin);
  assert.equal(
    await (await fetch(second.origin + name)).text(),
    bytes.toString(),
  );
  assert.equal(assetRequests, 2); // Unbootstrapped gateway never serves the cache.
  await fetch(second.url);
  assert.equal(
    await (await fetch(second.origin + name)).text(),
    bytes.toString(),
  );
  assert.equal(assetRequests, 2);
  const head = await fetch(second.origin + name, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(await head.text(), "");
  assert.equal(
    (
      await fetch(second.origin + name, {
        headers: { "if-none-match": '"' + sha(bytes) + '"' },
      })
    ).status,
    304,
  );
  token = null;
  assert.equal((await fetch(second.origin + name)).status, 401);
});

test("old bridge missing manifest streams without waiting for metadata", async (t) => {
  const { cache } = await fixture(t);
  const upstream = http.createServer((req, res) => {
    if (req.url.includes("manifest")) return; // metadata must not hold up assets
    res.end(bytes);
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        upstream.closeAllConnections();
        upstream.close(r);
      }),
  );
  const gateway = await createDashboardGateway({
    targetURL: `http://127.0.0.1:${upstream.address().port}`,
    staticCache: cache,
    cacheScope: scope,
    session: {
      getToken: () => "live",
      close: async () => {},
      subscribe: () => () => {},
    },
  });
  t.after(() => gateway.close());
  await fetch(gateway.url);
  const response = await fetch(gateway.origin + name, {
    signal: AbortSignal.timeout(500),
  });
  assert.equal(await response.text(), bytes.toString());
});

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ASSET_PATH = /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|otf)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function validAssetManifest(value) {
  if (
    value?.version !== 1 ||
    !SHA256.test(value.release) ||
    !value.assets ||
    typeof value.assets !== "object" ||
    Array.isArray(value.assets)
  )
    return false;
  const entries = Object.entries(value.assets);
  return (
    entries.length <= 2048 &&
    entries.every(
      ([name, entry]) =>
        ASSET_PATH.test(name) &&
        SHA256.test(entry?.sha256) &&
        Number.isInteger(entry.size) &&
        entry.size >= 0 &&
        entry.size <= MAX_ASSET_BYTES &&
        typeof entry.contentType === "string" &&
        entry.contentType.length < 100 &&
        /^(?:text\/(?:javascript|css)|application\/(?:javascript|octet-stream|font-woff)|font\/[a-z0-9-]+)$/.test(
          entry.contentType,
        ),
    )
  );
}

/** Main-process-only cache. Neither renderer state nor response headers define trust. */
export function createStaticAssetCache({
  directory,
  maxBytes = 256 * 1024 * 1024,
}) {
  let maintenance;
  let reserved = 0;
  const maxPending = 32 * 1024 * 1024;
  function key(scope, manifest, name) {
    if (
      !scope?.accountId ||
      !scope?.boxId ||
      !validAssetManifest(manifest) ||
      !ASSET_PATH.test(name) ||
      !manifest.assets[name]
    )
      return null;
    const entry = manifest.assets[name];
    return hash(
      JSON.stringify([
        scope.accountId,
        scope.boxId,
        manifest.release,
        name,
        entry.sha256,
        entry.size,
        "identity",
      ]),
    );
  }
  async function prune() {
    const names = (await readdir(directory)).filter((name) =>
      /^[a-f0-9]{64}\.asset$/.test(name),
    );
    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, ...(await stat(path.join(directory, name))) };
        } catch {
          return null;
        }
      }),
    );
    const files = entries.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = files.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of files) {
      if (total <= maxBytes) break;
      await rm(path.join(directory, entry.name), { force: true });
      total -= entry.size;
    }
  }
  maintenance = mkdir(directory, { recursive: true, mode: 0o700 })
    .then(async () => {
      // Only our temporary names are eligible; interrupted writes are never used.
      for (const name of await readdir(directory)) {
        if (/^[a-f0-9]{64}\.asset\.[a-f0-9]{16}\.tmp$/.test(name))
          await rm(path.join(directory, name), { force: true });
      }
      await prune();
    })
    .catch(() => {});
  return {
    async get(scope, manifest, name) {
      const id = key(scope, manifest, name);
      if (!id) return null;
      const file = path.join(directory, id + ".asset");
      let handle;
      try {
        handle = await open(
          file,
          constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
        );
        const info = await handle.stat();
        const entry = manifest.assets[name];
        if (!info.isFile() || info.size !== entry.size)
          throw new Error("invalid size");
        // Explicit bounded read, including if a local file changes while open.
        const data = Buffer.alloc(entry.size);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await handle.read(
            data,
            offset,
            data.length - offset,
            offset,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== data.length || hash(data) !== entry.sha256)
          throw new Error("invalid digest");
        await utimes(file, new Date(), new Date()).catch(() => {});
        return {
          data,
          contentType: entry.contentType,
          etag: `"${entry.sha256}"`,
        };
      } catch {
        await rm(file, { force: true }).catch(() => {});
        return null;
      } finally {
        await handle?.close();
      }
    },
    capture(scope, manifest, name, incoming) {
      const id = key(scope, manifest, name);
      const encoding = String(
        incoming.headers["content-encoding"] || "identity",
      ).toLowerCase();
      if (
        !id ||
        incoming.statusCode !== 200 ||
        !["identity", "gzip"].includes(encoding) ||
        incoming.headers["set-cookie"] ||
        incoming.headers["content-range"] ||
        reserved + MAX_ASSET_BYTES > maxPending
      )
        return;
      reserved += MAX_ASSET_BYTES;
      let length = 0;
      let chunks = [];
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          reserved -= MAX_ASSET_BYTES;
        }
        chunks = [];
      };
      incoming.on("data", (chunk) => {
        if (released) return;
        length += chunk.length;
        if (length > MAX_ASSET_BYTES) return release();
        chunks.push(chunk);
      });
      incoming.once("error", release);
      incoming.once("aborted", release);
      incoming.once("end", () => {
        if (released) return;
        let data;
        try {
          const raw = Buffer.concat(chunks, length);
          data =
            encoding === "gzip"
              ? gunzipSync(raw, { maxOutputLength: MAX_ASSET_BYTES })
              : raw;
          const entry = manifest.assets[name];
          if (data.length !== entry.size || hash(data) !== entry.sha256)
            return release();
        } catch {
          return release();
        }
        chunks = [];
        // Keep the reservation until the bounded queued write finishes.
        maintenance = maintenance
          .catch(() => {})
          .then(async () => {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const file = path.join(directory, id + ".asset");
            const temporary =
              file + "." + randomBytes(8).toString("hex") + ".tmp";
            try {
              const output = await open(temporary, "wx", 0o600);
              try {
                await output.writeFile(data);
              } finally {
                await output.close();
              }
              await rename(temporary, file);
              await prune();
            } finally {
              await rm(temporary, { force: true }).catch(() => {});
            }
          })
          .catch(() => {})
          .finally(release);
      });
    },
    flush: () => maintenance,
  };
}

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { marketFailure } from "./descriptor.mjs";
import { validateApplicationManifest } from "./manifest.mjs";

export async function verifyPackageHash(archivePath, descriptor, assertSession = () => {}) {
  if ((await stat(archivePath)).size !== descriptor.size) throw marketFailure("MARKET_PACKAGE_HASH_MISMATCH");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) { assertSession(); digest.update(chunk); }
  if (digest.digest("hex") !== descriptor.sha256) throw marketFailure("MARKET_PACKAGE_HASH_MISMATCH");
  assertSession();
}

function safeName(name) {
  if (typeof name !== "string" || !name || name.length > 512 || /[\\:\x00-\x1f]/.test(name) || name.startsWith("/")) return false;
  const parts = name.replace(/\/$/, "").split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !/[. ]$/.test(part) &&
    !/[<>"|?*]/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !part.startsWith(".wanx-"));
}

/** No links, duplicate/case-colliding names, encrypted entries or executable metadata. */
export async function extractApplicationArchive(archivePath, destination, descriptor, assertSession = () => {}) {
  const zip = await new Promise((resolve, reject) => yauzl.open(archivePath, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true,
  }, (error, value) => error ? reject(marketFailure("MARKET_PACKAGE_INVALID")) : resolve(value)));
  const seen = new Set();
  let count = 0, expanded = 0;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", () => reject(marketFailure("MARKET_PACKAGE_INVALID")));
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        void (async () => {
          assertSession();
          const name = entry.fileName, normalized = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (!safeName(name) || seen.has(normalized) || (entry.generalPurposeBitFlag & 1) ||
            (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) || ++count > 20000 ||
            entry.uncompressedSize > 1024 * 1024 * 1024 ||
            (expanded += entry.uncompressedSize) > 2 * 1024 * 1024 * 1024 ||
            entry.uncompressedSize > Math.max(1024 * 1024, entry.compressedSize * 1000))
            throw marketFailure("MARKET_PACKAGE_INVALID");
          seen.add(normalized);
          const output = path.join(destination, ...name.split("/"));
          if (name.endsWith("/")) {
            await mkdir(output, { recursive: true, mode: 0o700 });
          } else {
            await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
            const input = await new Promise((res, rej) => zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream)));
            const ownerExecute = (entry.externalFileAttributes >>> 16) & 0o100;
            await pipeline(input, createWriteStream(output, { flags: "wx", mode: 0o600 | ownerExecute }));
          }
          assertSession();
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    const manifestFile = path.join(destination, "wanx-app.json");
    if ((await stat(manifestFile)).size > 65536) throw marketFailure("MARKET_PACKAGE_INVALID");
    const manifest = validateApplicationManifest(JSON.parse(await readFile(manifestFile, "utf8")));
    if (JSON.stringify(manifest) !== JSON.stringify(validateApplicationManifest(descriptor.manifest)))
      throw marketFailure("MARKET_PACKAGE_INVALID");
    const entry = await stat(path.join(destination, manifest.entrypoint));
    if (!entry.isFile()) throw marketFailure("MARKET_PACKAGE_INVALID");
    assertSession();
    return manifest;
  } catch (error) {
    if (error?.code?.startsWith("ACCOUNT_") || error?.code?.startsWith("MARKET_")) throw error;
    throw marketFailure("MARKET_PACKAGE_INVALID");
  } finally { zip.close(); }
}

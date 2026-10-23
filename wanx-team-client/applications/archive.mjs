import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";

const fail = (code = "APPLICATION_ARCHIVE_INVALID") => Object.assign(new Error(code), { code });
const MAX_ARCHIVE = 2 * 1024 ** 3;
const MAX_CONTENT = 4 * 1024 ** 3;
const MAX_ENTRIES = 100_000;

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

// Extract regular files first and links last, so no archive entry can write
// through a symlink. macOS Electron frameworks need their internal links intact.
export async function extractApplicationArchive(archivePath, destination) {
  let zip;
  try {
    const archive = await stat(archivePath);
    if (!archive.isFile() || path.extname(archivePath).toLowerCase() !== ".zip") throw fail();
    if (archive.size > MAX_ARCHIVE) throw fail("APPLICATION_ARCHIVE_TOO_LARGE");
    zip = await yauzl.openPromise(archivePath, { strictFileNames: true });
    if (zip.entryCount > MAX_ENTRIES) throw fail("APPLICATION_ARCHIVE_TOO_LARGE");
    const seen = new Set(), links = [];
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName.replace(/\/$/, "");
      if (!name || /[\\:\x00-\x1f]/.test(name) || name.split("/").some(p => !p || p === "." || p === ".." || /[. ]$/.test(p))) throw fail();
      if (name === "__MACOSX" || name.startsWith("__MACOSX/") || path.posix.basename(name) === ".DS_Store") continue;
      const key = name.normalize("NFC").toLowerCase();
      if (seen.has(key)) throw fail();
      seen.add(key);
      total += entry.uncompressedSize;
      if (total > MAX_CONTENT) throw fail("APPLICATION_ARCHIVE_TOO_LARGE");
      const target = path.resolve(destination, name);
      if (!contained(destination, target) || path.posix.basename(name) === ".wanx-install.json") throw fail();
      const mode = entry.externalFileAttributes >>> 16;
      const kind = mode & 0o170000;
      if (![0, 0o100000, 0o040000, 0o120000].includes(kind)) throw fail();
      if (kind === 0o040000 || name !== entry.fileName) {
        await mkdir(target, { recursive: true });
        continue;
      }
      if (kind === 0o120000 && (process.platform === "win32" || entry.uncompressedSize > 4096)) throw fail();
      await mkdir(path.dirname(target), { recursive: true });
      const input = await zip.openReadStreamPromise(entry);
      let checksum = 0;
      async function* checked() {
        for await (const chunk of input) { checksum = crc32(chunk, checksum); yield chunk; }
        if (checksum !== entry.crc32) throw fail();
      }
      if (kind === 0o120000) {
        const chunks = [];
        for await (const chunk of checked()) chunks.push(chunk);
        const link = Buffer.concat(chunks).toString("utf8");
        if (!link || path.isAbsolute(link) || /[\\:\x00-\x1f]/.test(link) || !contained(destination, path.resolve(path.dirname(target), link))) throw fail();
        links.push({ target, link });
      } else {
        await pipeline(checked(), createWriteStream(target, { flags: "wx", mode: (mode & 0o777) || 0o644 }));
      }
    }
    for (const { target, link } of links) await symlink(link, target);
    const entries = await readdir(destination, { withFileTypes: true });
    let root = destination;
    if (!entries.some(e => e.name === "application.manifest.json")) {
      if (entries.length !== 1 || !entries[0].isDirectory()) throw fail("APPLICATION_MANIFEST_READ_FAILED");
      root = path.join(destination, entries[0].name);
    }
    if (!(await lstat(path.join(root, "application.manifest.json"))).isFile()) throw fail();
    for (const { target } of links) if (!contained(root, await realpath(target))) throw fail();
    return root;
  } catch (error) {
    if (error?.code?.startsWith("APPLICATION_")) throw error;
    throw fail();
  } finally {
    zip?.close();
  }
}

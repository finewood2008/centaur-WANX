import { chmod, lstat, readdir } from "node:fs/promises";
import path from "node:path";

// Squirrel removes quarantine attributes from every installed file. Go module
// licenses arrive as 0444; preserving that mode makes a valid signed OTA fail.
// Normalize only the staging bundle, before signing, and never follow symlinks.
export async function prepareMacUpdatePermissions(directory, { checkOnly = false } = {}) {
  let changed = 0;
  async function visit(file) {
    const entry = await lstat(file);
    if (entry.isSymbolicLink()) return;
    if (!entry.isDirectory() && !entry.isFile()) throw new Error("CLIENT_BUNDLE_FILE_TYPE_UNSUPPORTED");
    const mode = entry.mode & 0o777;
    const required = entry.isDirectory() ? 0o700 : 0o200;
    if ((mode & required) !== required) {
      if (checkOnly) throw new Error(`CLIENT_BUNDLE_NOT_UPDATABLE:${path.relative(directory, file)}`);
      await chmod(file, mode | required);
      changed++;
    }
    if (entry.isDirectory()) for (const name of await readdir(file)) await visit(path.join(file, name));
  }
  await visit(directory);
  return changed;
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  await prepareMacUpdatePermissions(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
}

import { constants } from "node:fs";
import { cp, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const signMacApp = (bundle) => execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "inherit" });

// macOS reads the Dock label from the .app bundle, not app.setName(). Keep a
// branded development copy; never mutate the shared Electron installation or
// change package.name, which owns the existing user data and encryption key.
export async function prepareDesktopRuntime({
  root = projectRoot, platform = process.platform, electronPath = require("electron"), sign = signMacApp,
} = {}) {
  if (platform !== "darwin") return electronPath;
  const config = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const source = path.resolve(electronPath, "../../..");
  const sourcePlist = path.join(source, "Contents/Info.plist");
  const icon = path.join(root, config.build.mac.icon);
  const bundle = path.join(root, "release/dev", `${config.build.productName}.app`);
  const stamp = path.join(bundle, "Contents/Resources/wanx-runtime-version");
  const digest = createHash("sha256");
  for (const file of [sourcePlist, icon, path.join(root, "package.json"), fileURLToPath(import.meta.url)]) digest.update(await readFile(file));
  const version = digest.digest("hex");
  const executable = path.join(bundle, "Contents/MacOS", path.basename(electronPath));
  try {
    if (await readFile(stamp, "utf8") === version) return executable;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(bundle, { recursive: true, force: true });
  await mkdir(path.dirname(bundle), { recursive: true });
  await cp(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const plistPath = path.join(bundle, "Contents/Info.plist");
  const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], { encoding: "utf8" }));
  Object.assign(plist, {
    CFBundleName: config.build.productName,
    CFBundleDisplayName: config.build.productName,
    CFBundleIdentifier: config.build.appId,
    CFBundleIconFile: "wanx.icns",
    ...config.build.mac.extendInfo,
  });
  await writeFile(plistPath, JSON.stringify(plist));
  execFileSync("/usr/bin/plutil", ["-convert", "xml1", plistPath]);
  await copyFile(icon, path.join(bundle, "Contents/Resources/wanx.icns"));
  // Write the cache marker before signing, so no resource changes invalidate it.
  await writeFile(stamp, version);
  try { sign(bundle); } catch (error) { await rm(stamp, { force: true }); throw error; }
  return executable;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const executable = await prepareDesktopRuntime();
  const child = spawn(executable, [projectRoot, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: false });
  child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  child.on("close", (code) => { process.exitCode = code ?? 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { if (!child.killed) child.kill(signal); });
}

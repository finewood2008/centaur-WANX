import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const repo = path.resolve(root, "..");

export function preflight() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_X64_REQUIRED");
  if (Number(process.versions.node.split(".")[0]) !== 22)
    throw new Error("NODE_22_REQUIRED");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const [name, version] of Object.entries({
    electron: "37.10.3",
    "electron-builder": "26.15.3",
    ws: "8.22.0",
  })) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version)
      throw new Error(`LOCK_VERSION_MISMATCH:${name}`);
  }
  if (pkg.version !== lock.packages?.[""]?.version)
    throw new Error("APP_VERSION_LOCK_MISMATCH");
  if (pkg.main !== "shell/entry.mjs")
    throw new Error("PACKAGED_ENTRY_MISMATCH");
  for (const dependency of Object.values(pkg.dependencies || {}))
    if (dependency.startsWith("file:") && !existsSync(path.join(root, dependency.slice(5))))
      throw new Error(`VENDORED_DEPENDENCY_MISSING:${dependency}`);
  const go = process.env.WANX_GO_EXE || "go";
  const goVersion = execFileSync(go, ["version"], { encoding: "utf8" }).trim();
  const match = /go(\d+)\.(\d+)(?:\.\d+)?\s+windows\/amd64/.exec(goVersion);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 26))
    throw new Error("GO_1_26_WINDOWS_AMD64_REQUIRED");
  for (const name of ["installer.nsh", "windows-install-acl.ps1", "windows-private-acl.ps1", "electron-builder-win-x64.json", "verify-unsigned.ps1", "entry.mjs"])
    if (!existsSync(path.join(root, "shell", name))) throw new Error(`PACKAGE_INPUT_MISSING:${name}`);
  for (const name of ["resources/icon.ico", "local-ui/renderer/index.html", "local-ui/renderer/device-setup.bundle.js", "local-ui/panel/index.html", "local-ui/panel/panel.js", "local-ui/panel-preload.cjs", "shell/provisioning-trust.json"])
    if (!existsSync(path.join(root, name))) throw new Error(`PACKAGE_INPUT_MISSING:${name}`);
  return {
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    version: pkg.version,
    node: process.version,
    go: goVersion,
    electron: lock.packages["node_modules/electron"].version,
    electronBuilder: lock.packages["node_modules/electron-builder"].version,
    goExecutable: go,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ ok: true, ...preflight() }, null, 2)); }
  catch (error) { console.error(`WANX_WINDOWS_PREFLIGHT_FAILED:${error.message}`); process.exitCode = 1; }
}

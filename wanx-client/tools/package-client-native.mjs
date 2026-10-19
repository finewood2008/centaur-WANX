import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { nativeBinaryPaths } from "../shell/native-binaries.mjs";
import { createSidecar } from "../network/sidecar.mjs";
import { prepareMacUpdatePermissions } from "./package-client-permissions.mjs";

// Signing can change Mach-O/PE bytes. Inspect the final signed files separately
// from the mandatory source comparison performed by afterPack, before signing.
export async function readPackagedNativeBinaries({ resourcesPath, platform, arch }) {
  const binaries = nativeBinaryPaths({ appPath: path.join(resourcesPath, "app.asar"), resourcesPath,
    packaged: true, platform, arch });
  const verified = {};
  for (const [kind, file] of Object.entries(binaries)) {
    const name = path.basename(file);
    let entry;
    try { entry = await lstat(file); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error(`CLIENT_NATIVE_BINARY_MISSING:${name}`);
      throw error;
    }
    if (!entry.isFile() || entry.size === 0 || (platform !== "win32" && !(entry.mode & 0o100)))
      throw new Error(`CLIENT_NATIVE_BINARY_INVALID:${name}`);
    const actual = await readFile(file);
    verified[kind] = { file: name, bytes: actual.length,
      sha256: createHash("sha256").update(actual).digest("hex") };
  }
  return verified;
}

export async function verifyPackagedNativeBinaries({ sourceDirectory, ...target }) {
  const binaries = await readPackagedNativeBinaries(target);
  for (const entry of Object.values(binaries)) {
    const source = await readFile(path.join(sourceDirectory, entry.file));
    if (createHash("sha256").update(source).digest("hex") !== entry.sha256)
      throw new Error(`CLIENT_NATIVE_BINARY_MISMATCH:${entry.file}`);
  }
  return binaries;
}

// Status does not enroll, read an account, start a tunnel or contact a box.
export async function probeNativeEngine(binaryPath) {
  const engine = createSidecar({ binaryPath });
  try {
    const status = await engine.request("status", {}, { timeoutMs: 5000 });
    if (status?.phase !== "disabled") throw new Error("CLIENT_NATIVE_ENGINE_SMOKE_FAILED");
  } finally { await engine.close(); }
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (!["darwin", "win32"].includes(platform)) return;
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  if (!arch) throw new Error("CLIENT_NATIVE_ARCH_UNSUPPORTED");
  const bundle = platform === "darwin"
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`) : context.appOutDir;
  const resourcesPath = path.join(bundle, platform === "darwin" ? "Contents/Resources" : "resources");
  const binaries = await verifyPackagedNativeBinaries({ resourcesPath, platform, arch,
    sourceDirectory: path.join(context.packager.projectDir, "native/bin") });
  const canRun = platform === process.platform && arch === process.arch;
  if (canRun)
    await probeNativeEngine(path.join(resourcesPath, "network", binaries.engine.file));
  if (platform === "darwin") await prepareMacUpdatePermissions(bundle);
  console.log(`WANX native helpers verified (${platform}-${arch}); engine status: ${canRun ? "passed" : "not run for cross-build"}`);
}

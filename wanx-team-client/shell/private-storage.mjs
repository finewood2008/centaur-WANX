import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function protectPrivateDirectory(directory, { packaged = false } = {}) {
  if (process.platform !== "win32") return;
  const target = path.resolve(directory);
  await mkdir(target, { recursive: true });
  return protect(target, packaged, "Directory");
}

export async function protectPrivateFile(file, { packaged = false, verify = false } = {}) {
  if (process.platform !== "win32") return;
  return protect(path.resolve(file), packaged, "File", verify);
}

async function protect(target, packaged, kind, verify = false) {
  const script = packaged
    ? path.join(process.resourcesPath, "security", "windows-private-acl.ps1")
    : fileURLToPath(new URL("./windows-private-acl.ps1", import.meta.url));
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  await new Promise((resolve, reject) => {
    execFile(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", target,
        "-TargetKind", kind, "-Mode", verify ? "Verify" : "Protect"],
      { windowsHide: true, timeout: 30_000 },
      (error) => error ? reject(new Error("PRIVATE_STORAGE_ACL_FAILED")) : resolve(),
    );
  });
}

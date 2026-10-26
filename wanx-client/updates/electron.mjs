import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { secureURL, updateError } from "./contracts.mjs";
import { createDifferentialDownload } from "./differential.mjs";

// electron-updater's custom-provider API consumes only this already verified
// release. It never fetches a mutable latest.yml or accepts a renderer feed URL.
export class SignedReleaseProvider {
  constructor({ release, downloadUrls = {} }) {
    this.release = release;
    this.artifact = release.artifacts[0];
    this.url = secureURL(downloadUrls[this.artifact.component] || this.artifact.url);
    if (!this.url.pathname.endsWith(release.platform.os === "darwin" ? ".zip" : ".exe")) throw updateError("UPDATE_INVALID_ARTIFACT");
    this.blockMapURL = this.artifact.blockMap
      ? secureURL(downloadUrls[`${this.artifact.component}.blockmap`] || this.artifact.blockMap.url) : null;
    if (this.blockMapURL && !this.blockMapURL.pathname.endsWith(".blockmap")) throw updateError("UPDATE_INVALID_ARTIFACT");
    this.isUseMultipleRangeRequest = false;
    this.fileExtraDownloadHeaders = null;
  }
  setRequestHeaders() {}
  async getLatestVersion() {
    return { version: this.release.version, releaseDate: this.release.createdAt,
      files: [{ url: this.artifact.url, sha512: this.artifact.sha512, size: this.artifact.sizeBytes }] };
  }
  resolveFiles(info) { return [{ url: this.url, info: info.files[0] }]; }
}

export async function verifyDownloadedFile(file, artifact) {
  if (!file || (await stat(file)).size !== artifact.sizeBytes) throw updateError("UPDATE_ARTIFACT_MISMATCH");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== artifact.sha256) throw updateError("UPDATE_ARTIFACT_MISMATCH");
}

// electron-updater's default verifier skips Authenticode when PowerShell is
// unavailable. Our signed release policy requires an independent, positive
// system verification result, including on cache reuse and just before install.
export async function verifyWindowsArtifact(file, publisherNames) {
  const script = process.resourcesPath
    ? path.join(process.resourcesPath, "security", "verify-signed.ps1")
    : fileURLToPath(new URL("../shell/verify-signed.ps1", import.meta.url));
  const powershell = path.win32.join(process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await new Promise((resolve, reject) => {
    childProcess.execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Path", file, "-PublisherNamesJson", JSON.stringify(publisherNames)],
    { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error || stderr?.trim() || stdout?.trim() !== "WINDOWS_SIGNATURE_VERIFIED")
        reject(updateError("UPDATE_SIGNATURE_VERIFICATION_FAILED"));
      else resolve();
    });
  });
}

export async function createElectronUpdateAdapter({ platform, configurationPath, windowsPublisherNames = [],
  installationDirectory, cacheDirectoryName = "wanx-client-updater",
  load = () => import("electron-updater") }) {
  if (!["darwin", "win32"].includes(platform)) throw updateError("UNSUPPORTED_PLATFORM");
  if (platform === "win32" && (!windowsPublisherNames.length || windowsPublisherNames.some(name => typeof name !== "string" || !name.trim())))
    throw updateError("UPDATE_SIGNER_NOT_CONFIGURED");
  const imported = await load();
  const module = imported.default || imported;
  const updater = platform === "darwin" ? new module.MacUpdater() : new module.NsisUpdater();
  if (platform === "win32") updater.verifyUpdateCodeSignature = async (names, file) => {
    await verifyWindowsArtifact(file, names);
    return null;
  };
  await mkdir(path.dirname(configurationPath), { recursive: true, mode: 0o700 });
  // JSON is a YAML subset. Keep signer requirements in the protected local
  // configuration, never in remotely supplied release metadata.
  if (!/^[a-z0-9-]{1,100}$/.test(cacheDirectoryName)) throw updateError("UPDATE_TEST_CONFIGURATION_INVALID");
  await writeFile(configurationPath, JSON.stringify({ updaterCacheDirName: cacheDirectoryName,
    ...(platform === "win32" ? { publisherName: windowsPublisherNames } : {}) }), { mode: 0o600 });
  updater.updateConfigPath = configurationPath;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowDowngrade = false;
  updater.disableDifferentialDownload = false;
  updater.logger = null;
  const differential = createDifferentialDownload({ configurationPath });
  // The pinned updater's Mac and NSIS downloaders share this hook. Returning
  // true requests its normal full download; cancellation must propagate.
  updater.differentialDownloadInstaller = (fileInfo, downloadUpdateOptions, installerPath) => differential.download({
    fileInfo, downloadUpdateOptions, installerPath, httpExecutor: updater.httpExecutor, logger: updater._logger,
    onProgress: progress => updater.emit("download-progress", progress),
  });
  let cancellation, downloadedFile, pendingError;
  updater.on("error", error => { pendingError = error; });
  updater.on("update-downloaded", event => { downloadedFile = event.downloadedFile; });
  const verifyArtifact = async (file, release) => {
    await verifyDownloadedFile(file, release.artifacts[0]);
    if (platform === "win32") await verifyWindowsArtifact(file, windowsPublisherNames);
  };
  return {
    async download(release, downloadUrls, { signal, onProgress }) {
      for (const directory of [path.dirname(configurationPath), installationDirectory].filter(Boolean)) {
        const space = await statfs(directory, { bigint: true });
        if (space.bavail * space.bsize < BigInt(release.artifacts[0].sizeBytes) * 3n) throw updateError("INSUFFICIENT_SPACE");
      }
      downloadedFile = null; pendingError = null;
      updater.setFeedURL({ provider: "custom", updateProvider: SignedReleaseProvider, release, downloadUrls });
      const checked = await updater.checkForUpdates();
      if (checked?.updateInfo?.version !== release.version || !checked.isUpdateAvailable) throw updateError("UPDATE_CANDIDATE_CHANGED");
      cancellation = checked.cancellationToken;
      const cancel = () => cancellation?.cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      updater.on("download-progress", onProgress);
      try {
        signal?.throwIfAborted();
        const provider = updater.updateInfoAndProvider.provider;
        await differential.prepare({ artifact: release.artifacts[0], blockMapURL: provider.blockMapURL,
          httpExecutor: updater.httpExecutor, cancellationToken: cancellation,
          requestHeaders: updater.computeRequestHeaders(provider), logger: updater._logger });
        let files;
        try { files = await updater.downloadUpdate(cancellation); }
        catch (error) { if (error.code === "ENOSPC") throw updateError("INSUFFICIENT_SPACE"); throw error; }
        signal?.throwIfAborted();
        if (pendingError) throw pendingError;
        const file = downloadedFile || files[0];
        await verifyArtifact(file, release);
        await differential.promote(file);
        signal?.throwIfAborted();
        return { file };
      } finally {
        signal?.removeEventListener("abort", cancel);
        updater.removeListener("download-progress", onProgress);
        cancellation = null;
      }
    },
    verify: verifyArtifact,
    install() {
      // On macOS native signature validation happens after this call. Keep the
      // failure path alive until the process actually exits; a method return is
      // never evidence that the new application was installed.
      return new Promise((_resolve, reject) => {
        updater.once("error", () => reject(updateError("UPDATE_INSTALL_FAILED")));
        try { updater.quitAndInstall(false, true); } catch { reject(updateError("UPDATE_INSTALL_FAILED")); }
      });
    },
    close() { cancellation?.cancel(); },
  };
}

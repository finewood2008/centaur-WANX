import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";
import { readSourceClientManifest, assertSourceClientManifestUnchanged, readPackagedClientManifest } from "./client-package-manifest.mjs";
import { clientBuildSource } from "./package-client-source.mjs";
import { clientTrustFingerprints, validateClientTrust } from "./package-client-trust.mjs";
import { readPackagedNativeBinaries } from "./package-client-native.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function validateWindowsTrust(trust, publisherName) {
  validateClientTrust(trust);
  if (!Array.isArray(trust.windowsPublisherNames) || !trust.windowsPublisherNames.includes(publisherName))
    throw new Error("生产信任文件必须包含发行公钥和本次 Authenticode 发布者。");
  return trust;
}

// Exported so the security and packaging contract can be tested on any host.
export function windowsReleaseConfiguration({ pkg, version, arch, out, trustFile, publisherName, certificateFile, certificateSha1, build, projectRoot = root }) {
  if (!out || !trustFile || semver.valid(version) !== version || !["x64", "arm64"].includes(arch) || !publisherName?.trim() ||
      Boolean(certificateFile) === Boolean(certificateSha1) || certificateSha1 && !/^[A-Fa-f0-9]{40}$/.test(certificateSha1))
    throw new Error("WINDOWS_SIGNING_CONFIGURATION_REQUIRED");
  return {
    ...pkg.build, appId: "ai.centuarai.wanx.studio.team.local", productName: pkg.build.productName,
    asar: true, npmRebuild: false, nodeGypRebuild: false, forceCodeSigning: true,
    directories: { ...pkg.build.directories, output: path.resolve(out) },
    extraMetadata: { version, wanxBuild: { ...build, distributionClass: "formal", installationScope: "per-user" } },
    extraResources: [...pkg.build.extraResources, { from: path.resolve(trustFile), to: "wanx-update-trust.json" },
      { from: path.join(projectRoot, "shell/windows-private-acl.ps1"), to: "security/windows-private-acl.ps1" },
      { from: path.join(projectRoot, "shell/verify-signed.ps1"), to: "security/verify-signed.ps1" }],
    win: { ...pkg.build.win, executableName: "WANX", requestedExecutionLevel: "asInvoker",
      target: [{ target: "nsis", arch: [arch] }], artifactName: "WANX-${version}-win-${arch}.${ext}",
      forceCodeSigning: true, verifyUpdateCodeSignature: true,
      signtoolOptions: { publisherName: [publisherName], signingHashAlgorithms: ["sha256"],
        ...(certificateFile ? { certificateFile: path.resolve(certificateFile) } : { certificateSha1 }) } },
    nsis: { ...pkg.build.nsis, include: path.join(projectRoot, "shell/installer.nsh"), oneClick: false,
      installerHeader: path.join(projectRoot, "resources/installer/header.bmp"),
      installerSidebar: path.join(projectRoot, "resources/installer/sidebar.bmp"),
      uninstallerSidebar: path.join(projectRoot, "resources/installer/sidebar.bmp"),
      perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false, createDesktopShortcut: true, createStartMenuShortcut: true,
      differentialPackage: false, installerLanguages: ["zh_CN"], runAfterFinish: true },
  };
}

export async function packageWindowsClient({ version, arch = "x64", out, trustFile, publisherName,
  certificateFile, certificateSha1, channel = "stable-studio", securityEpoch = 0 }) {
  if (process.platform !== "win32") throw new Error("正式 Windows 客户端必须在有签名证书的 Windows 构建机上生成。");
  if (!trustFile || !out || !/^[a-z][a-z0-9-]{0,31}$/.test(channel) || !Number.isSafeInteger(securityEpoch) || securityEpoch < 0)
    throw new Error("必须明确指定输出目录、生产信任文件、渠道和安全代次。");
  const source = clientBuildSource(root);
  const trust = validateWindowsTrust(JSON.parse(await readFile(trustFile, "utf8")), publisherName);
  const updateTrust = clientTrustFingerprints(trust);
  if (certificateFile) {
    await access(certificateFile);
    if (!/\.(pfx|p12)$/i.test(certificateFile) || !(process.env.WIN_CSC_KEY_PASSWORD || process.env.CSC_KEY_PASSWORD))
      throw new Error("PFX/P12 证书必须存在，并通过 WIN_CSC_KEY_PASSWORD 安全提供密码。");
  }
  try { await access(out); throw new Error("输出目录已存在，请使用新的发行目录。"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const manifest = await readSourceClientManifest(root);
  const { pkg } = manifest;
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15);
  const build = { schemaVersion: 1, buildId: `${stamp}-${randomBytes(6).toString("hex")}`,
    ...source,
    channel, securityEpoch, distributionClass: "formal", installationScope: "per-user" };
  const config = windowsReleaseConfiguration({ pkg, version, arch, out, trustFile, publisherName, certificateFile, certificateSha1, build });
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} 退出码 ${result.status}`);
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:studio"]);
  run(process.execPath, [path.join(root, "tools/build-network.mjs"), `win32-${arch}`]);
  run(process.execPath, [path.join(root, "tools/build-discovery.mjs"), "win32-x64"]);
  const { build: buildRenderer } = await import("esbuild");
  await buildRenderer({ absWorkingDir: root, entryPoints: ["local-ui/renderer/device-setup-entry.ts"], bundle: true,
    format: "iife", platform: "browser", outfile: "local-ui/renderer/device-setup.bundle.js" });
  const { build: buildElectron, Platform, Arch } = await import("electron-builder");
  try {
    await buildElectron({ projectDir: root, publish: "never", targets: Platform.WINDOWS.createTarget(["nsis"], arch === "arm64" ? Arch.arm64 : Arch.x64), config });
  } finally { await assertSourceClientManifestUnchanged(manifest); }
  const artifacts = (await readdir(out)).filter(name => name.endsWith(".exe"));
  if (artifacts.length !== 1) throw new Error("正式构建必须恰好生成一个 NSIS 安装器。");
  const installer = path.resolve(out, artifacts[0]);
  const unpacked = path.join(out, arch === "x64" ? "win-unpacked" : `win-${arch}-unpacked`);
  for (const file of [installer, path.join(unpacked, "WANX.exe")]) {
    run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "shell/verify-signed.ps1"), "-Path", file, "-PublisherName", publisherName]);
  }
  const packed = readPackagedClientManifest(path.join(unpacked, "resources/app.asar"));
  if (packed.version !== version || packed.wanxBuild?.buildId !== build.buildId || packed.wanxBuild.installationScope !== "per-user")
    throw new Error("包内版本、构建身份或安装范围验证失败。");
  const packedTrust = validateWindowsTrust(JSON.parse(await readFile(path.join(unpacked, "resources/wanx-update-trust.json"), "utf8")), publisherName);
  if (JSON.stringify(clientTrustFingerprints(packedTrust)) !== JSON.stringify(updateTrust))
    throw new Error("包内更新信任根与已验证配置不一致。");
  const nativeBinaries = await readPackagedNativeBinaries({ resourcesPath: path.join(unpacked, "resources"),
    platform: "win32", arch });
  clientBuildSource(root, { expectedCommit: source.sourceCommit });
  const sha256 = createHash("sha256"), sha512 = createHash("sha512");
  for await (const chunk of createReadStream(installer)) { sha256.update(chunk); sha512.update(chunk); }
  const digest = sha256.digest("hex");
  const report = { version, appId: pkg.build.appId, name: pkg.build.productName, platform: "windows", arch,
    signed: true, authenticodeVerified: true, publisherName, distributionClass: "formal", build, updateTrust, nativeBinaries,
    updateArtifact: { path: installer, kind: "nsis", sha256: digest, sha512: sha512.digest("base64"), sizeBytes: (await stat(installer)).size } };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "SHA256SUMS.txt"), `${digest}  ${path.basename(installer)}\n`);
  await writeFile(path.join(out, "verification-client.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: Object.fromEntries(["version", "arch", "out", "trust-file", "publisher-name", "certificate-file", "certificate-sha1", "channel", "security-epoch"].map(key => [key, { type: "string" }])) });
    console.log(JSON.stringify(await packageWindowsClient({ version: values.version, arch: values.arch || "x64", out: values.out,
      trustFile: values["trust-file"], publisherName: values["publisher-name"], certificateFile: values["certificate-file"],
      certificateSha1: values["certificate-sha1"], channel: values.channel || "stable-studio", securityEpoch: Number(values["security-epoch"] || 0) })));
  } catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
}

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { preflight, repo, root } from "./preflight-win.mjs";

const require = createRequire(import.meta.url);
const native = path.join(root, "native");
const binaryName = "wanx-netbird-win32-x64.exe";

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: "inherit", windowsHide: true });
}

async function assertUnsigned(file) {
  let lastError;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const env = {
    ...process.env,
    // The Codex pwsh runtime can inject a PowerShell 7 module ahead of the
    // Windows PowerShell module, making Authenticode fail during autoload.
    PSModulePath: [
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      path.join(path.parse(systemRoot).root, "Program Files", "WindowsPowerShell", "Modules"),
    ].join(";"),
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "shell", "verify-unsigned.ps1"), "-Path", file],
        { cwd: root, env, stdio: "pipe", windowsHide: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(3000);
    }
  }
  throw new Error(`AUTHENTICODE_CHECK_FAILED:${path.basename(file)}:${lastError.stderr?.toString().trim() || lastError.message}`);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertPE64(file) {
  const data = readFileSync(file);
  if (data.length < 1024 || data.toString("ascii", 0, 2) !== "MZ")
    throw new Error("NATIVE_PE_MISSING");
  const offset = data.readUInt32LE(0x3c);
  if (offset + 26 > data.length || data.toString("ascii", offset, offset + 4) !== "PE\0\0" || data.readUInt16LE(offset + 4) !== 0x8664)
    throw new Error("NATIVE_PE_X64_REQUIRED");
}

function sourceFingerprint() {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "release", "bin"].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push([path.relative(root, full).replaceAll("\\", "/"), sha256(full)]);
    }
  }
  visit(root);
  return createHash("sha256").update(JSON.stringify(files.sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}

async function main() {
  const input = preflight();
  const quickPackage = process.env.WANX_QUICK_PACKAGE === "1";
  const skipTests = process.env.WANX_SKIP_TESTS === "1";
  if (path.isAbsolute(input.goExecutable))
    process.env.PATH = `${path.dirname(input.goExecutable)}${path.delimiter}${process.env.PATH || ""}`;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const releaseRoot = path.resolve(process.env.WANX_RELEASE_ROOT || path.join(root, "release"));
  const stage = path.join(releaseRoot, `windows-host-${input.version}-${input.sourceCommit.slice(0, 8)}-${stamp}`);
  const output = path.join(stage, "output");
  if (existsSync(stage)) throw new Error("RELEASE_DIRECTORY_EXISTS");
  mkdirSync(output, { recursive: true });
  const testTemp = path.join(stage, "test-temp");
  mkdirSync(testTemp);
  const originalTemp = { TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMP = testTemp;
  process.env.TEMP = testTemp;
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) throw new Error("NPM_CLI_MISSING");
  run(process.execPath, [npmCli, "ci"]);
  run(process.execPath, [npmCli, "run", "build:renderer"]);
  if (!skipTests && quickPackage) run(process.execPath, ["--test",
    "tests/desktop-seam.test.mjs", "tests/desktop-runtime-seam.test.mjs",
    "tests/panel-renderer.test.mjs", "tests/panel-security.test.mjs",
    "tests/ui-state.test.mjs", "tests/ui-broadcast.test.mjs",
    "tests/startup.test.mjs", "tests/renderer-seam.test.mjs",
    "tests/discovery-names.test.mjs", "tests/setup-preload.test.mjs",
  ]);
  else if (!skipTests) run(process.execPath, [npmCli, "test"]);
  for (const name of ["TMP", "TEMP"])
    if (originalTemp[name] === undefined) delete process.env[name];
    else process.env[name] = originalTemp[name];
  if (!skipTests && !quickPackage) run(input.goExecutable, ["test", "./..."], native);
  run(process.execPath, [path.join(root, "tools", "build-network.mjs"), "win32-x64"]);
  run(process.execPath, [path.join(root, "tools", "build-discovery.mjs"), "win32-x64"]);

  const binary = path.join(native, "bin", binaryName);
  const discovery = path.join(native, "bin", "wanx-discovery-win32-x64.exe");
  assertPE64(discovery);
  assertPE64(binary);
  const engineHash = sha256(binary);
  const discoveryHash = sha256(discovery);
  const notices = ["NETBIRD-LICENSE", "go-modules.txt", "licenses"];
  for (const name of notices) if (!existsSync(path.join(native, "bin", name))) throw new Error(`LICENSE_INPUT_MISSING:${name}`);
  const licenseFiles = [];
  function collectLicenses(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) collectLicenses(source, relative);
      else if (entry.isFile()) licenseFiles.push({ file: relative, sha256: sha256(source), bytes: statSync(source).size });
    }
  }
  collectLicenses(path.join(native, "bin", "licenses"), "licenses");
  for (const name of notices.slice(0, 2)) {
    const source = path.join(native, "bin", name);
    licenseFiles.push({ file: name, sha256: sha256(source), bytes: statSync(source).size });
  }
  licenseFiles.sort((a, b) => a.file.localeCompare(b.file));

  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const { build, Platform, Arch } = require("electron-builder");
  const buildOptions = {
    projectDir: root,
    publish: "never",
    targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
    config: {
      extends: path.join(root, "shell", "electron-builder-win-x64.json"),
      appId: "ai.centuarai.wanx.client",
      productName: "万象",
      extraMetadata: { wanxBuild: { schemaVersion: 1, buildId: `${stamp}-${input.sourceCommit.slice(0, 12)}`,
        sourceCommit: input.sourceCommit, channel: "internal", securityEpoch: 0, distributionClass: "unsigned-internal-only" } },
      electronVersion: input.electron,
      asar: true,
      npmRebuild: false,
      nodeGypRebuild: false,
      directories: { output },
      files: [
        "client.mjs", "platform.mjs", "account/**", "shell/**",
        "local-ui/**", "network/**", "octop/**", "app-host/**",
        "applications/**", "updates/**", "resources/**", "package.json", "README.md",
        "node_modules/ws/**", "node_modules/semver/**", "node_modules/yauzl/**",
        "node_modules/pend/**",
        "node_modules/@nexusaos/**",
      ],
      extraResources: [
        { from: binary, to: `network/${binaryName}` },
        { from: discovery, to: "network/wanx-discovery-win32-x64.exe" },
        { from: path.join(native, "bin", "NETBIRD-LICENSE"), to: "network/NETBIRD-LICENSE" },
        { from: path.join(native, "bin", "go-modules.txt"), to: "network/go-modules.txt" },
        { from: path.join(native, "bin", "licenses"), to: "network/licenses" },
        { from: path.join(root, "shell", "windows-private-acl.ps1"), to: "security/windows-private-acl.ps1" },
      ],
      win: {
        icon: path.join(root, "resources", "icon.ico"),
        executableName: "WANX",
        requestedExecutionLevel: "asInvoker",
        extraResources: [],
        target: [{ target: "nsis", arch: ["x64"] }],
        artifactName: "WANX-UNSIGNED-${version}-win-${arch}.${ext}",
      },
      nsis: {
        include: path.join(root, "shell", "installer.nsh"),
        installerHeader: path.join(root, "resources", "installer", "header.bmp"),
        installerSidebar: path.join(root, "resources", "installer", "sidebar.bmp"),
        uninstallerSidebar: path.join(root, "resources", "installer", "sidebar.bmp"),
        oneClick: false,
        perMachine: false,
        allowElevation: false,
        allowToChangeInstallationDirectory: true,
        installerLanguages: ["zh_CN"],
        deleteAppDataOnUninstall: false,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        differentialPackage: false,
        useZip: true,
        runAfterFinish: true,
      },
      afterPack: async ({ appOutDir }) => {
        const asar = path.join(appOutDir, "resources", "app.asar");
        const { listPackage } = require("@electron/asar");
        const entries = new Set(listPackage(asar).map(value => value.replaceAll("\\", "/").replace(/^\//, "")));
        for (const relative of [
          "shell/entry.mjs", "shell/main.mjs", "applications/runtime.mjs",
          "shell/desktop.mjs", "shell/ui-state.mjs", "shell/ui-broadcast.mjs",
          "local-ui/panel/index.html", "local-ui/panel/panel.js", "local-ui/panel/panel.css",
          "local-ui/panel-preload.cjs",
          "shell/provisioning-trust.json", "local-ui/renderer/index.html",
          "local-ui/renderer/device-setup.bundle.js", "local-ui/remote-preload.cjs",
          "app-host/session.mjs", "applications/manager.mjs",
          "resources/icon.ico", "node_modules/ws/package.json",
          "node_modules/semver/package.json", "node_modules/yauzl/package.json",
          "node_modules/pend/package.json",
          "node_modules/@nexusaos/device-discovery-electron/package.json",
          "node_modules/@nexusaos/local-provisioning-electron-ble/package.json",
        ]) if (!entries.has(relative)) throw new Error(`PACKED_FILE_MISSING:${relative}`);
        const packed = path.join(appOutDir, "resources", "network", binaryName);
        assertPE64(packed);
        if (sha256(packed) !== engineHash) throw new Error("PACKED_ENGINE_HASH_MISMATCH");
        const packedDiscovery = path.join(appOutDir, "resources", "network", "wanx-discovery-win32-x64.exe");
        assertPE64(packedDiscovery);
        if (sha256(packedDiscovery) !== discoveryHash) throw new Error("PACKED_DISCOVERY_HASH_MISMATCH");
        for (const item of licenseFiles) {
          const packedLicense = path.join(appOutDir, "resources", "network", item.file);
          if (!existsSync(packedLicense) || sha256(packedLicense) !== item.sha256)
            throw new Error(`PACKED_LICENSE_HASH_MISMATCH:${item.file}`);
        }
        if (!existsSync(path.join(appOutDir, "resources", "security", "windows-private-acl.ps1")))
          throw new Error("PACKED_PRIVATE_ACL_SCRIPT_MISSING");
      },
    },
  };
  // Windows scanners may briefly hold a newly linked Go executable open.
  await delay(5000);
  let artifacts;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { artifacts = await build({ ...buildOptions, config: { ...buildOptions.config } }); break; }
    catch (error) {
      if (!String(error).includes("EBUSY") || attempt === 3) throw error;
      await delay(5000 * attempt);
    }
  }
  const filename = `WANX-UNSIGNED-${input.version}-win-x64.exe`;
  const installer = artifacts.find((candidate) => path.basename(candidate) === filename);
  if (!installer || !existsSync(installer)) throw new Error("INSTALLER_MISSING");
  for (const file of [installer, path.join(output, "win-unpacked", "WANX.exe")])
    await assertUnsigned(file);
  const packedExecutable = path.join(output, "win-unpacked", "WANX.exe");
  process.env.WANX_PACKAGED_EXECUTABLE = packedExecutable;
  process.env.TMP = testTemp;
  process.env.TEMP = testTemp;
  if (!skipTests) run(process.execPath, ["--test", "tests/packaged-application-seam.test.mjs"], root);
  for (const name of ["TMP", "TEMP"])
    if (originalTemp[name] === undefined) delete process.env[name];
    else process.env[name] = originalTemp[name];
  const skipInstallSmoke = process.env.WANX_SKIP_INSTALL_SMOKE === "1";
  const smoke = path.join(output, "smoke-windows.json");
  if (skipInstallSmoke) {
    writeFileSync(smoke, JSON.stringify({ ok: null, status: "unverified", reason: "existing-current-user-install-registration" }, null, 2));
  } else {
    run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(root, "shell", "smoke-win.ps1"), "-Installer", installer, "-Report", smoke, "-InstallRoot", process.env.WANX_SMOKE_INSTALL_ROOT || path.join(stage, "smoke-install")]);
    const smokeResult = JSON.parse(readFileSync(smoke, "utf8"));
    if (!smokeResult.ok) throw new Error("INSTALLER_SMOKE_FAILED");
  }

  const report = {
    ...input,
    sourceTreeClean: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim() === "",
    sourceFingerprintSha256: sourceFingerprint(),
    distributionClass: "unsigned-internal-only",
    signed: false,
    authenticode: "NotSigned",
    platform: "win32",
    arch: "x64",
    engine: { file: binaryName, sha256: engineHash, bytes: statSync(binary).size },
    discovery: { file: "wanx-discovery-win32-x64.exe", sha256: discoveryHash, bytes: statSync(discovery).size },
    licenses: licenseFiles,
    installer: { file: filename, sha256: sha256(installer), bytes: statSync(installer).size },
    tests: {
      node: skipTests ? "not-run-user-requested" : quickPackage ? "focused-passed" : "passed", go: skipTests ? "not-run-user-requested" : quickPackage ? "not-run-go-source-unchanged" : "passed", rendererBuild: "passed", engineBuild: "passed", packedResources: "passed", packagedApplicationSeam: skipTests ? "not-run-user-requested" : "passed", installedSmoke: skipInstallSmoke ? "unverified" : "passed",
      realAccount: "unverified", liveBoxP2P: "unverified", boxSSO: "unverified", upload: "unverified", streamingChat: "unverified",
    },
  };
  writeFileSync(path.join(output, "verification-windows.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(output, "SHA256SUMS.txt"), `${report.installer.sha256}  ${filename}\n`);
  console.log(JSON.stringify({ ok: true, output, installer, sha256: report.installer.sha256 }));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(`WANX_WINDOWS_PACKAGE_FAILED:${error.message}`); process.exit(1); });

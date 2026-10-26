import { spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import semver from "semver";
import { readSourceClientManifest, assertSourceClientManifestUnchanged, readPackagedClientManifest } from "./client-package-manifest.mjs";
import { clientBuildSource, clientTestSourceSnapshot } from "./package-client-source.mjs";
import { clientTrustFingerprints, validateClientTrust } from "./package-client-trust.mjs";
import { prepareMacUpdatePermissions } from "./package-client-permissions.mjs";
import { readPackagedNativeBinaries } from "./package-client-native.mjs";
import { createClientBlockMap } from "./client-blockmap.mjs";
import { TEST_APP_ID, TEST_PACKAGE_NAME, TEST_PRODUCT_NAME, testPackageIdentity, validTestRunId } from "../updates/test-build.mjs";
import { testFeedURL as validateTestFeedURL } from "../updates/test-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} 退出码 ${result.status}`);
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function mustExist(file) {
  await access(file);
  return file;
}

export async function packageClient({ version, arch = process.arch, out, notaryProfile, local = false, trustFile,
  channel = "stable", securityEpoch = 0, test = false, testRunId, testFeedURL, testCAFile }) {
  if (process.platform !== "darwin") throw new Error("正式 macOS 客户端包必须在 macOS 上构建。");
  if (!version || semver.valid(version) !== version) throw new Error("请用 --version 指定标准 SemVer 版本号。");
  if (!["arm64", "x64"].includes(arch)) throw new Error("--arch 仅支持 arm64 或 x64。");
  let testCA, testCAFingerprint;
  if (test) {
    if (local || !validTestRunId(testRunId) || !semver.prerelease(version) || !testCAFile || !trustFile)
      throw new Error("测试包需要独立 test-run-id、预发布版本、HTTPS 测试入口、测试 CA 和测试更新公钥，不能与 --local 混用。");
    if (channel === "stable") channel = `test-client-${testRunId}`;
    if (channel !== `test-client-${testRunId}`) throw new Error("UPDATE_TEST_CONFIGURATION_INVALID");
    validateTestFeedURL(testFeedURL);
    testCA = await readFile(testCAFile, "utf8");
    const certificate = new X509Certificate(testCA);
    if (testCA.includes("PRIVATE KEY") || certificate.checkIP("127.0.0.1") !== "127.0.0.1") throw new Error("UPDATE_TEST_CONFIGURATION_INVALID");
    testCAFingerprint = certificate.fingerprint256;
  }
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel) || !Number.isSafeInteger(securityEpoch) || securityEpoch < 0) throw new Error("更新渠道或安全代次无效。");
  let source = clientBuildSource(root, { formal: !local && !test });
  if (!local && !trustFile) throw new Error("正式包需要 --trust-file <生产更新公钥JSON>，否则安装后无法接收更新。");
  let trust;
  if (trustFile) {
    trust = validateClientTrust(JSON.parse(await readFile(path.resolve(trustFile), "utf8")));
  }
  if (!local && !test && !notaryProfile) throw new Error("正式包需要 --notary-profile <Apple 公证钥匙串配置>；本地验证可用 --local。");
  if (!local && !test) {
    const check = spawnSync("xcrun", ["notarytool", "history", "--keychain-profile", notaryProfile], { encoding: "utf8" });
    if (check.error) throw check.error;
    if (check.status !== 0) {
      const detail = (check.stderr || check.stdout).trim();
      throw new Error(`公证凭据检查失败：${detail}\n请先运行 xcrun notarytool store-credentials ${notaryProfile} --apple-id <Apple ID> --team-id <Team ID>，再重新打包。`);
    }
  }
  const manifest = await readSourceClientManifest(root);
  const { pkg } = manifest;
  const name = test ? TEST_PRODUCT_NAME : pkg.build.productName;
  const appId = test ? TEST_APP_ID : pkg.build.appId;
  const stamp = new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15);
  const build = { schemaVersion: 1, buildId: `${stamp}-${randomBytes(6).toString("hex")}`,
    ...source, channel, securityEpoch,
    distributionClass: test ? "test-only" : local ? "local-verification-only" : "formal",
    ...(test ? { applicationId: appId, testRunId, testFeedURL, testCAFingerprint } : {}) };
  const outputDir = path.resolve(out || path.join(root, "release/client", version, `macos-${arch}-${stamp}-${randomBytes(3).toString("hex")}`));
  try { await access(outputDir); throw new Error(`输出目录已存在，请另选 --out：${outputDir}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  run(process.execPath, [path.join(root, "tools/build-network.mjs"), `darwin-${arch}`]);
  run(process.execPath, [path.join(root, "tools/build-discovery.mjs"), `darwin-${arch}`]);
  run(process.execPath, [path.join(root, "tools/build-clipboard.mjs"), arch]);
  run("npm", ["run", "build:renderer"]);
  if (test) {
    source = clientBuildSource(root, { formal: false });
    Object.assign(build, source, { sourceSnapshot: clientTestSourceSnapshot(root) });
  }
  const builder = path.join(root, "node_modules/.bin/electron-builder");
  const configurationDirectory = await mkdtemp(path.join(os.tmpdir(), "wanx-client-build-"));
  const configurationFile = path.join(configurationDirectory, "builder.json");
  // Snapshot the checked keys, so a parallel edit cannot change the trust root
  // between validation, packaging, and the verification report.
  const trustSnapshot = path.join(configurationDirectory, "trust.json");
  if (trust) await writeFile(trustSnapshot, JSON.stringify(trust), { mode: 0o600 });
  const testCASnapshot = path.join(configurationDirectory, "test-ca.pem");
  if (test) await writeFile(testCASnapshot, testCA, { mode: 0o600 });
  await writeFile(configurationFile, JSON.stringify({ ...pkg.build, appId, productName: name,
    afterPack: path.join(root, "tools/package-client-native.mjs"),
    forceCodeSigning: true, mac: { ...pkg.build.mac, defaultArch: "x64" },
    directories: { ...pkg.build.directories, output: outputDir }, extraMetadata: { version, wanxBuild: build,
      ...(test ? { name: TEST_PACKAGE_NAME, productName: TEST_PRODUCT_NAME, main: "updates/test-entry.mjs" } : {}) },
    extraResources: [...pkg.build.extraResources, ...(trust ? [{ from: trustSnapshot, to: "wanx-update-trust.json" }] : []),
      ...(test ? [{ from: testCASnapshot, to: "wanx-test-ca.pem" }] : [])],
  }));
  const args = ["--mac", "dmg", "zip", `--${arch}`, "--config", configurationFile, "--publish", "never"];
  const electronDist = path.join(root, "node_modules/electron/dist");
  if (arch === process.arch) {
    try { await access(path.join(electronDist, "Electron.app")); args.push(`-c.electronDist=${electronDist}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try { run(builder, args); } finally {
    await rm(configurationDirectory, { recursive: true, force: true });
    await assertSourceClientManifestUnchanged(manifest);
  }

  const app = await mustExist(path.join(outputDir, arch === "x64" ? "mac" : `mac-${arch}`, `${name}.app`));
  const plist = path.join(app, "Contents/Info.plist");
  const plistValue = (key) => output("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]);
  if (plistValue("CFBundleIdentifier") !== appId || plistValue("CFBundleShortVersionString") !== version ||
      plistValue("CFBundleName") !== name)
    throw new Error("应用包 ID、版本或名称与发行参数不一致。");
  const executable = await mustExist(path.join(app, "Contents/MacOS", plistValue("CFBundleExecutable")));
  if (!output("lipo", ["-archs", executable]).split(/\s+/).includes(arch === "x64" ? "x86_64" : arch))
    throw new Error("应用包处理器架构不匹配。");
  const nativeBinaries = await readPackagedNativeBinaries({ resourcesPath: path.join(app, "Contents/Resources"),
    platform: "darwin", arch });
  const packed = readPackagedClientManifest(path.join(app, "Contents/Resources/app.asar"));
  if (packed.version !== version) throw new Error("包内 package.json 版本与发行参数不一致。");
  if (packed.wanxBuild?.buildId !== build.buildId) throw new Error("包内构建身份与发行参数不一致。");
  if (test) {
    testPackageIdentity(packed);
    const packedCA = await readFile(path.join(app, "Contents/Resources/wanx-test-ca.pem"), "utf8");
    if (new X509Certificate(packedCA).fingerprint256 !== testCAFingerprint) throw new Error("UPDATE_TEST_CONFIGURATION_INVALID");
  }
  const updateTrust = trust ? clientTrustFingerprints(trust) : {};
  if (trust && JSON.stringify(clientTrustFingerprints(JSON.parse(await readFile(path.join(app, "Contents/Resources/wanx-update-trust.json"), "utf8")))) !== JSON.stringify(updateTrust))
    throw new Error("包内更新信任根与已验证配置不一致。");
  await prepareMacUpdatePermissions(app, { checkOnly: true });
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const signature = spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  if (signature.error || signature.status !== 0) throw signature.error || new Error("无法读取应用包签名。");
  const signatureText = signature.stderr;
  if (!signatureText.includes("Developer ID Application:")) throw new Error("应用包缺少 Developer ID Application 签名。");
  const dmgs = (await readdir(outputDir)).filter(file => file.endsWith(".dmg"));
  if (dmgs.length !== 1) throw new Error(`预期生成一个 DMG，实际找到 ${dmgs.length} 个。`);
  const dmg = path.join(outputDir, dmgs[0]);
  const zips = (await readdir(outputDir)).filter(file => file.endsWith(".zip"));
  if (zips.length !== 1) throw new Error(`预期生成一个自动更新 ZIP，实际找到 ${zips.length} 个。`);
  const zip = path.join(outputDir, zips[0]);
  if (!local && !test) clientBuildSource(root, { expectedCommit: source.sourceCommit });
  if (test && clientTestSourceSnapshot(root) !== build.sourceSnapshot) throw new Error("CLIENT_SOURCE_CHANGED_DURING_BUILD");
  run("hdiutil", ["verify", dmg]);
  if (!local && !test) {
    for (const artifact of [zip, dmg]) {
      const notarization = output("xcrun", ["notarytool", "submit", artifact, "--keychain-profile", notaryProfile, "--wait"]);
      if (!/status:\s*Accepted\b/i.test(notarization)) throw new Error(`Apple 公证未通过：${notarization}`);
    }
    run("xcrun", ["stapler", "staple", app]);
    run("xcrun", ["stapler", "validate", app]);
    // ZIPs cannot carry a stapled ticket themselves; rebuild from the verified
    // app so the application installed by OTA contains its ticket too.
    await rm(zip);
    run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
  }
  const blockMap = await createClientBlockMap(zip);
  const digest = await sha256(dmg);
  const zipDigest = await sha256(zip);
  const zipSha512 = createHash("sha512");
  for await (const chunk of createReadStream(zip)) zipSha512.update(chunk);
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "SHA256SUMS.txt"), `${digest}  ${path.basename(dmg)}\n${zipDigest}  ${path.basename(zip)}\n${blockMap.sha256}  ${path.basename(blockMap.path)}\n`);
  const report = { version, appId, name, platform: "macos", arch, dmg, sha256: digest,
    build, updateTrust, nativeBinaries, updateArtifact: { path: zip, kind: "mac-zip", notarized: !local && !test, sizeBytes: (await stat(zip)).size, sha256: zipDigest, sha512: zipSha512.digest("base64"), blockMap },
    signed: true, notarized: !local && !test, distributionClass: build.distributionClass };
  await writeFile(path.join(outputDir, "verification-client.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      version: { type: "string" }, arch: { type: "string" }, out: { type: "string" },
      "notary-profile": { type: "string" }, local: { type: "boolean" }, help: { type: "boolean" },
      "trust-file": { type: "string" }, channel: { type: "string" }, "security-epoch": { type: "string" },
      test: { type: "boolean" }, "test-run-id": { type: "string" }, "test-feed-url": { type: "string" }, "test-ca": { type: "string" },
    } });
    if (values.help) console.log("用法：./wanx-client/package-client.sh --version <SemVer> [--arch arm64|x64] [--out <新目录>] --notary-profile <Apple 公证钥匙串配置> --trust-file <生产更新公钥JSON> [--channel stable] [--security-epoch 0]\n正式包生成 Developer ID 签名并公证的 macOS DMG 和更新 ZIP；--local 仅生成未公证的本地验证包。市场应用请用 wanx-client/package-app.sh。Windows 正式包使用 tools/package-client-windows.mjs。\n隔离测试包：--test --test-run-id <小写标识> --test-feed-url https://127.0.0.1:<端口>/ --test-ca <证书PEM> --trust-file <测试公钥JSON> --version <预发布版本>。测试包独立安装且不公证，不能发布到正式渠道。");
    else console.log(JSON.stringify(await packageClient({ version: values.version, arch: values.arch,
      out: values.out, notaryProfile: values["notary-profile"] || process.env.WANX_NOTARY_PROFILE,
      trustFile: values["trust-file"], channel: values.channel || "stable", securityEpoch: Number(values["security-epoch"] || 0),
      local: values.local === true, test: values.test === true, testRunId: values["test-run-id"],
      testFeedURL: values["test-feed-url"], testCAFile: values["test-ca"] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

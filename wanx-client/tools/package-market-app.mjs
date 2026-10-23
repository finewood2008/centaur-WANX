import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { access, cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { validateApplicationManifest } from "../applications/manifest.mjs";
import { verifyPackageHash } from "../applications/verified-archive.mjs";
import { assertCurrentMarketProtocol, packageApplication } from "./package-application.mjs";
import { applyApplicationDependencyConfig } from "./application-dependency-config.mjs";

const clientRoot = fileURLToPath(new URL("../", import.meta.url));
const configFields = ["version", "out", "key", "key-id", "os", "arch", "dependency-config"];

function expandHome(value) {
  return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function runBuild(project, args, env = process.env) {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: project, stdio: "inherit", shell: process.platform === "win32", env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`构建失败：npm ${args.join(" ")}`);
}

export async function stageMarketSource(project, destination, manifest, { dependencyConfig } = {}) {
  runBuild(project, ["run", "build:market-source"], { ...process.env, WANX_MARKET_VERSION: manifest.version });
  await cp(path.join(project, "dist/application"), destination, { recursive: true });
  const appManifest = path.join(destination, "application.manifest.json");
  const value = await readJson(appManifest);
  const validated = validateApplicationManifest(value, { signed: true });
  if (validated.version !== manifest.version) throw new Error("市场源目录的应用版本与发行版本不一致。");
  if (!isDeepStrictEqual(validated, manifest)) throw new Error("市场源目录的应用清单与发行清单不一致。");
  const pkg = await readJson(path.join(destination, "package.json"));
  if (pkg.version !== manifest.version) throw new Error("市场源目录的 package.json 版本与发行版本不一致。");
  await access(path.join(destination, manifest.entrypoint));
  for (const file of [appManifest, path.join(destination, "wanx-app.json")]) {
    const info = await lstat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info && !info.isFile()) throw new Error("市场源目录的清单必须是普通文件，不能通过链接改写源码。");
  }
  // First verify the unmodified build against its source contract. The exported
  // selection may only change the two manifests in this private staging copy.
  const releaseManifest = dependencyConfig === undefined ? manifest : applyApplicationDependencyConfig(manifest, dependencyConfig);
  if (dependencyConfig !== undefined)
    await writeFile(appManifest, JSON.stringify(releaseManifest, null, 2) + "\n");
  await writeFile(path.join(destination, "wanx-app.json"), JSON.stringify(releaseManifest, null, 2) + "\n");
  return releaseManifest;
}

export async function readProjectManifest(project, version) {
  const canonical = path.join(project, "market/wanx-app.json");
  try {
    await access(canonical);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(`应用工程缺少标准市场清单：${canonical}`);
  }
  const manifest = validateApplicationManifest({ ...await readJson(canonical), version }, { signed: true });
  assertCurrentMarketProtocol(manifest);
  const pkg = await readJson(path.join(project, "package.json"));
  if (!pkg.scripts?.["build:market-source"])
    throw new Error("应用工程缺少 npm run build:market-source，无法构建标准市场源目录。");
  return { manifest };
}

export async function readMarketOptions(cli = {}) {
  if (!cli.project) throw new Error("请用 --project 指定应用工程目录。");
  const project = path.resolve(expandHome(cli.project));
  const configPath = path.resolve(expandHome(cli.config || path.join(project, "market-release.local.json")));
  let config = {};
  try { config = await readJson(configPath); }
  catch (error) {
    if (error.code !== "ENOENT" || cli.config) throw new Error(`无法读取市场配置 ${configPath}：${error.message}`);
  }
  if (!config || Array.isArray(config) || typeof config !== "object" ||
      Object.entries(config).some(([name, value]) => !configFields.includes(name) || typeof value !== "string" || !value.trim()))
    throw new Error(`市场配置仅支持非空字符串字段：${configFields.join(", ")}`);
  const values = { ...config, ...cli };
  if (Object.hasOwn(values, "dependency-config") &&
      (typeof values["dependency-config"] !== "string" || !values["dependency-config"].trim()))
    throw new Error("dependency-config 必须是非空文件路径。");
  if (!values.version) throw new Error("请用 --version 指定版本，或在项目的 market-release.local.json 中设置 version；不会修改源码版本。");
  const resolveOption = (name, fallback) => path.resolve(
    cli[name] ? process.cwd() : path.dirname(configPath), expandHome(values[name] || fallback),
  );
  const osName = values.os || "universal", arch = values.arch || "universal";
  if (!((osName === "universal" && arch === "universal") ||
        (["macos", "windows"].includes(osName) && ["arm64", "x64"].includes(arch))))
    throw new Error("通用包请省略 --os/--arch；平台专用包须同时指定 macos/windows 与 arm64/x64。");
  const keyId = values["key-id"] || "release-2026";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) throw new Error("无效的发行 key-id。");
  return {
    project, version: values.version, os: osName, arch, keyId,
    targetConfigured: Boolean(values.os || values.arch),
    keyFile: resolveOption("key", path.join(os.homedir(), ".config/wanx-release/release-private.pem")),
    outputDir: resolveOption("out", path.join(clientRoot, "release/market")),
    dependencyConfigFile: values["dependency-config"] ? resolveOption("dependency-config") : undefined,
  };
}

export async function packageMarketApp(cli = {}) {
  const options = await readMarketOptions(cli);
  const { project, version, keyId, keyFile, outputDir } = options;
  const { manifest } = await readProjectManifest(project, version);
  const dependencyConfig = options.dependencyConfigFile ? await readJson(options.dependencyConfigFile) : undefined;
  if (dependencyConfig !== undefined) applyApplicationDependencyConfig(manifest, dependencyConfig);
  const { targetOS, targetArch } = resolveMarketTarget(options, manifest);
  const trusted = (await readJson(path.join(clientRoot, "applications/market-trust.json"))).keys || {};
  if (!trusted[keyId]) throw new Error(`万象客户端未配置信任公钥 ${keyId}。`);
  const privateKey = createPrivateKey(await readFile(keyFile));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("签名私钥必须为 Ed25519。");
  const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const expected = createPublicKey(trusted[keyId]).export({ type: "spki", format: "der" });
  if (!actual.equals(expected)) throw new Error(`签名私钥与万象客户端 ${keyId} 的公钥不匹配。`);
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "wanx-market-"));
  try {
    console.log(`构建 ${manifest.name} 市场包 ${version}（${targetOS}/${targetArch}）`);
    await stageMarketSource(project, sourceDir, manifest, { dependencyConfig });
    const result = await packageApplication({
      sourceDir, outputDir, os: targetOS, arch: targetArch,
      keyFile, keyId, overwrite: true,
      minWanxVersion: "0.1.4",
    });
    const envelope = await readJson(result.envelopePath);
    const descriptor = verifyEnvelope(envelope, trusted);
    await verifyPackageHash(result.archivePath, descriptor);
    return result;
  } finally { await rm(sourceDir, { recursive: true, force: true }); }
}

export function resolveMarketTarget(options, manifest) {
  const targetOS = !options.targetConfigured ? { darwin: "macos", win32: "windows" }[manifest.platform] || options.os : options.os;
  const targetArch = !options.targetConfigured && manifest.arch ? manifest.arch : options.arch;
  if (manifest.platform && (manifest.platform !== (targetOS === "macos" ? "darwin" : "win32") || manifest.arch !== targetArch))
    throw new Error("打包目标平台或架构与应用市场清单不一致。");
  return { targetOS, targetArch };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = ["project", "version", "config", "out", "key", "key-id", "os", "arch", "dependency-config"];
    const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: "string" }])), help: { type: "boolean" } } });
    if (values.help) {
      console.log("用法：./package-app.sh --project <应用工程> --version <SemVer> [--dependency-config <Admin导出的依赖配置>] [--out <目录>] [--key <私钥>] [--key-id <ID>] [--os macos|windows --arch arm64|x64]\n标准工程提供 market/wanx-app.json 和 npm run build:market-source，产物放在 dist/application。也可在应用工程的 market-release.local.json 中配置 version、out、key、key-id、os、arch、dependency-config；命令行优先。依赖配置须与应用 ID 和发行版本一致，仅修改暂存包中的协议 3 清单。默认签名密钥 ~/.config/wanx-release/release-private.pem，默认输出 wanx-client/release/market/。通用应用省略平台参数；清单限定平台时自动使用该平台。同名包会在新包构建校验通过后覆盖；不会修改应用源码或上传市场。");
    } else {
      const result = await packageMarketApp(values);
      console.log(JSON.stringify({ archivePath: result.archivePath, envelopePath: result.envelopePath, sha256: result.descriptor.sha256, verified: true }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

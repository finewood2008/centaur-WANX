import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { verifyEnvelope } from "../applications/descriptor.mjs";
import { validateApplicationManifest } from "../applications/manifest.mjs";
import { verifyPackageHash } from "../applications/verified-archive.mjs";
import { packageApplication } from "./package-application.mjs";

const clientRoot = fileURLToPath(new URL("../", import.meta.url));
const zhijunServerFiles = ["app", "attachments", "expert-selection", "host-client", "host-runtime", "interaction", "interaction-schema", "knowledge-error", "library", "memory", "ontology", "policy", "provision", "roles", "static"];
const configFields = ["version", "out", "key", "key-id", "os", "arch"];

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

async function stageZhijun(project, destination, version) {
  const rendererDir = path.join(destination, "renderer");
  runBuild(project, ["run", "build", "--", "--outDir", rendererDir], { ...process.env, VITE_ZHIJUN_RELEASE_VERSION: version });
  await access(path.join(rendererDir, "index.html"));
  await mkdir(path.join(destination, "market"), { recursive: true });
  await mkdir(path.join(destination, "server"), { recursive: true });
  await cp(path.join(project, "market/main.mjs"), path.join(destination, "market/main.mjs"));
  for (const name of zhijunServerFiles)
    await cp(path.join(project, `server/${name}.mjs`), path.join(destination, `server/${name}.mjs`));
  await cp(path.join(project, "server/wanx-host-sdk.cjs"), path.join(destination, "server/wanx-host-sdk.cjs"));
  await mkdir(path.join(destination, "resources"), { recursive: true });
  for (const name of ["icon.png", "icon.ico"])
    await cp(path.join(project, "desktop/resources", name), path.join(destination, "resources", name));
  await cp(path.join(project, "desktop/THIRD_PARTY_NOTICES.md"), path.join(destination, "THIRD_PARTY_NOTICES.md"));
  await mkdir(path.join(destination, "node_modules"), { recursive: true });
  await cp(path.join(project, "node_modules/ws"), path.join(destination, "node_modules/ws"), { recursive: true });
  const ws = await readJson(path.join(destination, "node_modules/ws/package.json"));
  await writeFile(path.join(destination, "package.json"), JSON.stringify({
    name: "zhijun-wanx-application", version, private: true, type: "module", dependencies: { ws: ws.version },
  }, null, 2) + "\n");
  const verification = spawnSync(process.execPath, ["--input-type=module", "--eval", "await import(process.argv[1])", pathToFileURL(path.join(destination, "server/host-runtime.mjs")).href], {
    cwd: destination, encoding: "utf8",
  });
  if (verification.error || verification.status !== 0)
    throw new Error(`知君发行包的服务模块加载失败：${verification.error?.message || verification.stderr?.trim() || "未知错误"}`);
}

async function stageApplication(project, destination, version) {
  runBuild(project, ["run", "--silent", "package"], { ...process.env, WANX_MARKET_VERSION: version });
  await cp(path.join(project, "dist/application"), destination, { recursive: true });
  const appManifest = path.join(destination, "application.manifest.json");
  const value = await readJson(appManifest);
  value.version = version;
  await writeFile(appManifest, JSON.stringify(value, null, 2) + "\n");
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
    keyFile: resolveOption("key", path.join(os.homedir(), ".config/wanx-release/release-private.pem")),
    outputDir: resolveOption("out", path.join(clientRoot, "release/market")),
  };
}

export async function packageMarketApp(cli = {}) {
  const options = await readMarketOptions(cli);
  const { project, version, keyId, keyFile, outputDir } = options;
  let manifestPath, layout;
  try { await access(path.join(project, "market/wanx-app.json")); manifestPath = path.join(project, "market/wanx-app.json"); layout = "zhijun"; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!manifestPath) {
    try { await access(path.join(project, "application.manifest.json")); manifestPath = path.join(project, "application.manifest.json"); layout = "application"; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!manifestPath) throw new Error("未找到 market/wanx-app.json 或 application.manifest.json，无法识别应用工程。");
  const manifest = validateApplicationManifest({ ...await readJson(manifestPath), version }, { signed: true });
  const trusted = (await readJson(path.join(clientRoot, "applications/market-trust.json"))).keys || {};
  if (!trusted[keyId]) throw new Error(`万象客户端未配置信任公钥 ${keyId}。`);
  const privateKey = createPrivateKey(await readFile(keyFile));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("签名私钥必须为 Ed25519。");
  const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const expected = createPublicKey(trusted[keyId]).export({ type: "spki", format: "der" });
  if (!actual.equals(expected)) throw new Error(`签名私钥与万象客户端 ${keyId} 的公钥不匹配。`);
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), "wanx-market-"));
  try {
    console.log(`构建 ${manifest.name} 市场包 ${version}（${options.os}/${options.arch}）`);
    if (layout === "zhijun") await stageZhijun(project, sourceDir, version);
    else await stageApplication(project, sourceDir, version);
    await writeFile(path.join(sourceDir, "wanx-app.json"), JSON.stringify(manifest, null, 2) + "\n");
    const result = await packageApplication({
      sourceDir, outputDir, os: options.os, arch: options.arch,
      keyFile, keyId, overwrite: true,
    });
    const envelope = await readJson(result.envelopePath);
    const descriptor = verifyEnvelope(envelope, trusted);
    await verifyPackageHash(result.archivePath, descriptor);
    return result;
  } finally { await rm(sourceDir, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = ["project", "version", "config", "out", "key", "key-id", "os", "arch"];
    const { values } = parseArgs({ options: { ...Object.fromEntries(names.map(name => [name, { type: "string" }])), help: { type: "boolean" } } });
    if (values.help) {
      console.log("用法：./package-app.sh --project <应用工程> --version <SemVer> [--out <目录>] [--key <私钥>] [--key-id <ID>] [--os macos|windows --arch arm64|x64]\n也可在应用工程的 market-release.local.json 中配置 version、out、key、key-id、os、arch；命令行优先。默认签名密钥 ~/.config/wanx-release/release-private.pem，默认输出 wanx-client/release/market/。通用应用省略平台参数。同名包会在新包构建校验通过后覆盖；不会修改应用源码或上传市场。");
    } else {
      const result = await packageMarketApp(values);
      console.log(JSON.stringify({ archivePath: result.archivePath, envelopePath: result.envelopePath, sha256: result.descriptor.sha256, verified: true }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import yazl from "yazl";
import { validateApplicationManifest } from "../applications/manifest.mjs";
import { validateDescriptor } from "../applications/descriptor.mjs";
import { extractApplicationArchive } from "../applications/verified-archive.mjs";

const fail = (message) => { throw new Error(message); };
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function signingKey(keyFile) {
  const key = createPrivateKey(await readFile(keyFile));
  if (key.asymmetricKeyType !== "ed25519") fail("签名私钥必须为 Ed25519。");
  return key;
}

async function packageManifest(sourceDir) {
  let source;
  try { source = await stat(sourceDir); }
  catch (error) {
    if (error.code === "ENOENT") fail(`应用构建目录不存在：${sourceDir}\n--source 需要填写实际构建产物目录；文档中的 /build/zhijun 是示例路径。`);
    throw error;
  }
  if (!source.isDirectory()) fail(`--source 必须是应用构建产物目录：${sourceDir}`);
  const manifestPath = path.join(sourceDir, "wanx-app.json");
  let content;
  try { content = await readFile(manifestPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") fail(`应用构建目录缺少市场清单：${manifestPath}\n请先准备入口、运行依赖和 wanx-app.json；此命令只封装签名包，不负责构建应用或接入 WANX Host。`);
    throw error;
  }
  return validateApplicationManifest(JSON.parse(content), { signed: true });
}

export function assertCurrentMarketProtocol(manifest) {
  if (manifest.protocolVersion !== 3 || manifest.releaseAccess !== "account")
    fail("新市场应用包仅支持协议 3 和账号许可，请更新 market/wanx-app.json 后重新打包。");
}

async function envelopeFor(file, metadata, key) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const descriptor = validateDescriptor({
    schemaVersion: 1, artifactId: randomUUID(), hostProtocol: 1,
    minWanxVersion: "0.1.0", ...metadata,
    sha256: digest.digest("hex"), size: (await lstat(file)).size,
  });
  const bytes = Buffer.from(JSON.stringify(descriptor));
  return { descriptor, descriptorBase64: bytes.toString("base64"), signatureBase64: sign(null, bytes, key).toString("base64") };
}

/** Package a prepared build directory, never a working tree containing secrets.
 * protocol3 releaseAccess="account" is retained in the normalized ZIP manifest
 * and the signed descriptor; publication audience is selected later in Admin.
 */
export async function packageApplication({ sourceDir, outputDir, os = "universal", arch = "universal", keyFile, keyId, minWanxVersion = "0.1.0", buildId, overwrite = false }) {
  sourceDir = path.resolve(sourceDir); outputDir = path.resolve(outputDir);
  if (!keyId || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) fail("需要有效的 --key-id。");
  if (inside(sourceDir, outputDir) || inside(sourceDir, path.resolve(keyFile)))
    fail("输出目录和签名私钥必须位于打包目录之外。");
  const manifest = await packageManifest(sourceDir);
  if (os === "universal" || arch === "universal") {
    if (os !== "universal" || arch !== "universal") fail("通用应用包的 --os 和 --arch 必须同时为 universal，或同时省略。");
    if (manifest.launchMode !== "shared" || manifest.platform || manifest.arch) fail("通用应用包必须共享万象运行时，且清单不能限制平台或架构。");
  } else if (!["macos", "windows"].includes(os) || !["x64", "arm64"].includes(arch)) {
    fail("应用包平台必须为 macos/windows，架构必须为 x64/arm64；通用应用包可省略这两个参数。");
  }
  const key = await signingKey(keyFile);
  const fileName = `${manifest.applicationId}-${manifest.version.replaceAll("+", "_")}-${os}-${arch}.wanxapp`;
  await mkdir(outputDir, { recursive: true });
  const staging = await mkdtemp(path.join(outputDir, ".package-"));
  const archivePath = path.join(staging, fileName);
  let moved = false;
  try {
    const zip = new yazl.ZipFile();
    const written = pipeline(zip.outputStream, createWriteStream(archivePath, { flags: "wx" }));
    // Observe asynchronous source errors even while the directory is enumerated.
    zip.on("error", (error) => zip.outputStream.destroy(error));
    void written.catch(() => {});
    try {
      let count = 0;
      async function addDirectory(directory, prefix = "") {
        for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const relative = prefix + item.name, absolute = path.join(directory, item.name);
          if (++count > 20000) fail("应用文件数超过 20000。");
          const info = await lstat(absolute);
          if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) fail(`应用包不支持符号链接或特殊文件：${relative}`);
          if (info.isDirectory()) await addDirectory(absolute, `${relative}/`);
          else if (relative === "wanx-app.json") zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), relative);
          else zip.addFile(absolute, relative, { mode: info.mode & 0o100 ? 0o100755 : 0o100644, mtime: new Date("2020-01-01T00:00:00Z") });
        }
      }
      await addDirectory(sourceDir);
      zip.end();
      await written;
    } catch (error) { zip.outputStream.destroy(error); await written.catch(() => {}); throw error; }
    const { descriptor, ...envelope } = await envelopeFor(archivePath, {
      applicationId: manifest.applicationId, version: manifest.version, os, arch,
      packageType: "wanxapp", fileName, minWanxVersion, manifest,
      ...(manifest.protocolVersion >= 2 ? { schemaVersion: manifest.protocolVersion, compatibility: manifest.compatibility, critical: [] } : {}),
      ...(buildId ? { buildId } : {}),
    }, key);
    await extractApplicationArchive(archivePath, path.join(staging, "validation"), descriptor);
    const destination = path.join(outputDir, fileName), sidecar = `${destination}.release.json`;
    const envelopeText = JSON.stringify({ keyId, ...envelope }, null, 2) + "\n";
    if (overwrite) {
      const nextSidecar = path.join(staging, "next.release.json");
      const previousArchive = path.join(staging, "previous.wanxapp");
      const previousSidecar = path.join(staging, "previous.release.json");
      await writeFile(nextSidecar, envelopeText);
      const moveIfPresent = async (from, to) => {
        try { await rename(from, to); return true; }
        catch (error) { if (error.code === "ENOENT") return false; throw error; }
      };
      let oldArchive = false, oldSidecar = false, newArchive = false, newSidecar = false;
      try {
        oldArchive = await moveIfPresent(destination, previousArchive);
        oldSidecar = await moveIfPresent(sidecar, previousSidecar);
        await rename(archivePath, destination); newArchive = true;
        await rename(nextSidecar, sidecar); newSidecar = true;
      } catch (error) {
        if (newArchive) await rm(destination, { force: true });
        if (newSidecar) await rm(sidecar, { force: true });
        if (oldArchive) await rename(previousArchive, destination);
        if (oldSidecar) await rename(previousSidecar, sidecar);
        throw error;
      }
    } else {
      // The low-level release tool keeps its original no-overwrite default.
      const output = createWriteStream(destination, { flags: "wx" });
      try { await pipeline(createReadStream(archivePath), output); moved = true; }
      catch (error) { if (error.code !== "EEXIST") await rm(destination, { force: true }); throw error; }
      try { await writeFile(sidecar, envelopeText, { flag: "wx" }); }
      catch (error) { if (moved) await rm(destination, { force: true }); throw error; }
    }
    return { archivePath: destination, envelopePath: sidecar, descriptor };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function signNativePackage({ inputFile, applicationId, version, os, arch, keyFile, keyId, minWanxVersion = "0.1.0", buildId }) {
  if (!keyId || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) fail("需要有效的 --key-id。");
  if (!["x64", "arm64"].includes(arch)) fail("原生安装包必须指定 --arch x64 或 arm64。");
  const packageType = path.extname(inputFile).slice(1);
  if (!((packageType === "dmg" && os === "macos") || (packageType === "exe" && os === "windows"))) fail("DMG 必须属于 macOS，EXE 必须属于 Windows。");
  const { descriptor, ...envelope } = await envelopeFor(inputFile, {
    applicationId, version, os, arch, packageType, fileName: path.basename(inputFile), minWanxVersion,
    ...(buildId ? { buildId } : {}),
  }, await signingKey(keyFile));
  const envelopePath = `${inputFile}.release.json`;
  await writeFile(envelopePath, JSON.stringify({ keyId, ...envelope }, null, 2) + "\n", { flag: "wx" });
  return { archivePath: inputFile, envelopePath, descriptor };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = Object.fromEntries(["source", "out", "file", "application-id", "version", "os", "arch", "key", "key-id", "min-wanx-version", "build-id"].map((name) => [name, { type: "string" }]));
  try {
    const { values } = parseArgs({ options: { ...options, help: { type: "boolean" } } });
    if (values.help) {
      console.log("node tools/package-application.mjs --source <build-dir> --out <output-dir> --key <ed25519-private.pem> --key-id <id> [--min-wanx-version 0.1.0] [--build-id <commit>]\n新市场应用包必须使用协议 3 和账号许可，默认通用（universal/universal）；仅平台专用应用需指定 --os macos|windows --arch x64|arm64。\n原生安装包签名：将 --source/--out 换为 --file <package.dmg|exe> --application-id <id> --version <semver>，必须指定 --os 和 --arch。");
    } else {
      if (!values.key || (values.file && (!values.os || !values.arch)) || (!values.file && (!values.source || !values.out))) fail("参数不完整，使用 --help 查看用法。");
      if (!values.file) assertCurrentMarketProtocol(await packageManifest(path.resolve(values.source)));
      const input = { sourceDir: values.source, outputDir: values.out, inputFile: values.file, applicationId: values["application-id"], version: values.version, os: values.os, arch: values.arch, keyFile: values.key, keyId: values["key-id"], minWanxVersion: values["min-wanx-version"], buildId: values["build-id"] };
      const result = await (values.file ? signNativePackage(input) : packageApplication(input));
      console.log(JSON.stringify({ package: result.archivePath, signature: result.envelopePath, artifactId: result.descriptor.artifactId, sha256: result.descriptor.sha256 }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

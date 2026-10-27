import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validClientEdition, editionForApplicationId } from "../updates/edition.mjs";

const require = createRequire(import.meta.url);

// Packaged metadata deliberately drops build/scripts and may have a test
// identity. It must never become the source manifest for another build.
export async function readSourceClientManifest(root) {
  const file = path.join(root, "package.json");
  const text = await readFile(file, "utf8");
  const pkg = JSON.parse(text);
  if (pkg.wanxEdition !== "personal" || editionForApplicationId(pkg.build?.appId) !== pkg.wanxEdition || pkg.name !== "centuarai-wanx-client" || pkg.main !== "shell/entry.mjs" || pkg.wanxBuild ||
      pkg.build?.appId !== "ai.centuarai.wanx.client" || !pkg.scripts?.start || !pkg.scripts?.test ||
      !pkg.devDependencies?.electron || !pkg.dependencies?.["electron-updater"] ||
      !pkg.build?.files?.includes("updates/**"))
    throw new Error("CLIENT_SOURCE_MANIFEST_INVALID: 请使用保留正式身份及构建配置的源码 package.json，不能使用安装包内的 package.json。");
  return { file, text, pkg };
}

export async function assertSourceClientManifestUnchanged(snapshot) {
  if (await readFile(snapshot.file, "utf8") !== snapshot.text)
    throw new Error("CLIENT_SOURCE_MANIFEST_CHANGED: 打包期间源码 package.json 已变化，停止发行；请检查修改来源。");
}

// Unlike `asar extract-file`, this reads into memory and never writes a file
// named package.json into the working directory.
export function readPackagedClientManifest(archive, expectedEdition) {
  const pkg = JSON.parse(require("@electron/asar").extractFile(archive, "package.json").toString("utf8"));
  if (expectedEdition !== undefined && (!validClientEdition(expectedEdition) || pkg.wanxEdition !== expectedEdition))
    throw new Error("CLIENT_PACKAGE_EDITION_MISMATCH");
  return pkg;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("用法：node tools/client-package-manifest.mjs <app.asar>（只读输出包内清单）");
    console.log(JSON.stringify(readPackagedClientManifest(path.resolve(process.argv[2])), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

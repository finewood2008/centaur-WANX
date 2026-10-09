import {
  mkdtemp,
  cp,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const zip = process.argv[2];
if (!zip || process.platform !== "darwin")
  throw new Error("请在 macOS 上提供已下载的 Electron darwin zip 路径");
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const stage = await mkdtemp(join(tmpdir(), "wanx-admin-electron-"));
const target = resolve("release/mac-arm64/万象管理员.app");
try {
  execFileSync("/usr/bin/ditto", ["-x", "-k", resolve(zip), stage]);
  const electronVersion = (
    await readFile(join(stage, "version"), "utf8")
  ).trim();
  if (electronVersion !== "37.10.3")
    throw new Error(`Electron 版本应为 37.10.3，实际为 ${electronVersion}`);
  // This path is a generated artifact only; never modify another installed application.
  await mkdir(resolve("release/mac-arm64"), { recursive: true });
  try {
    await readFile(join(target, "Contents/Info.plist"));
    if (!process.argv.includes("--replace-built"))
      throw new Error(
        "输出应用已存在，请选择新的输出目录或自行移除旧构建后重试",
      );
    const built = JSON.parse(
      await readFile(
        join(target, "Contents/Resources/app/package.json"),
        "utf8",
      ),
    );
    if (built.name !== "centaurai-wanx-admin" || built.private !== true)
      throw new Error("只允许替换本工具生成的私有管理员构建");
    await rm(target, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rename(join(stage, "Electron.app"), target);
  const runtime = join(target, "Contents/Resources/app");
  await mkdir(join(runtime, "dist-shell"), { recursive: true });
  await cp("dist", join(runtime, "dist"), { recursive: true });
  await copyFile("dist-shell/main.cjs", join(runtime, "dist-shell/main.cjs"));
  await copyFile(
    "dist-shell/preload.cjs",
    join(runtime, "dist-shell/preload.cjs"),
  );
  await copyFile(
    "dist-shell/third-party-licenses.json",
    join(runtime, "dist-shell/third-party-licenses.json"),
  );
  await writeFile(
    join(runtime, "package.json"),
    JSON.stringify(
      {
        name: "centaurai-wanx-admin",
        productName: "万象管理员",
        version,
        private: true,
        license: "UNLICENSED",
        main: "dist-shell/main.cjs",
      },
      null,
      2,
    ),
  );
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    await copyFile(file, join(runtime, file));
  await copyFile(
    join(stage, "LICENSE"),
    join(target, "Contents/Resources/ELECTRON_LICENSE"),
  );
  const chromium = join(stage, "LICENSES.chromium.html");
  try {
    await copyFile(
      chromium,
      join(target, "Contents/Resources/LICENSES.chromium.html"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  execFileSync("/usr/bin/python3", [
    "-c",
    "import plistlib,sys; p=sys.argv[1]; f=open(p,'rb'); d=plistlib.load(f); f.close(); d.update(CFBundleDisplayName='万象管理员',CFBundleName='万象管理员',CFBundleIdentifier='ai.centaurai.wanx.admin',CFBundleShortVersionString=sys.argv[2],CFBundleVersion=sys.argv[2],LSApplicationCategoryType='public.app-category.developer-tools'); plistlib.dump(d,open(p,'wb'))",
    join(target, "Contents/Info.plist"),
    version,
  ]);
  execFileSync(
    "/usr/bin/codesign",
    ["--force", "--deep", "--sign", "-", target],
    { stdio: "inherit" },
  );
  console.log(target);
} finally {
  await rm(stage, { recursive: true, force: true });
}

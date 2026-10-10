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
  throw new Error(
    "Provide the cached Electron 37.10.3 darwin-arm64 ZIP on macOS.",
  );
const stage = await mkdtemp(join(tmpdir(), "wanx-computer-electron-"));
const target = resolve("release/mac-arm64/万象电脑端.app");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
try {
  try {
    await readFile(join(target, "Contents/Info.plist"));
    throw new Error("Output already exists; choose a fresh output directory.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  execFileSync("/usr/bin/ditto", ["-x", "-k", resolve(zip), stage]);
  if ((await readFile(join(stage, "version"), "utf8")).trim() !== "37.10.3")
    throw new Error("Wrong Electron version");
  await mkdir(resolve("release/mac-arm64"), { recursive: true });
  await rename(join(stage, "Electron.app"), target);
  const runtime = join(target, "Contents/Resources/app");
  await mkdir(runtime, { recursive: true });
  for (const directory of ["shell", "dist-ui", "node_modules"])
    await cp(directory, join(runtime, directory), { recursive: true });
  for (const file of ["package.json", "LICENSE", "THIRD_PARTY_NOTICES.md"])
    await copyFile(file, join(runtime, file));
  await copyFile("../LICENSE", join(runtime, "WANX_FRAMEWORK_LICENSE"));
  try {
    await copyFile("deployment.json", join(runtime, "deployment.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await copyFile(
    join(stage, "LICENSE"),
    join(target, "Contents/Resources/ELECTRON_LICENSE"),
  );
  await copyFile(
    join(stage, "LICENSES.chromium.html"),
    join(target, "Contents/Resources/LICENSES.chromium.html"),
  );
  execFileSync("/usr/bin/python3", [
    "-c",
    "import plistlib,sys; p=sys.argv[1]; d=plistlib.load(open(p,'rb')); d.update(CFBundleDisplayName='万象电脑端',CFBundleName='万象电脑端',CFBundleIdentifier='ai.centaurai.wanx.desktop',CFBundleShortVersionString=sys.argv[2],CFBundleVersion=sys.argv[2],NSMicrophoneUsageDescription='万象电脑端在你使用语音输入时访问麦克风。'); plistlib.dump(d,open(p,'wb'))",
    join(target, "Contents/Info.plist"),
    pkg.version,
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

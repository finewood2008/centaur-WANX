import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { nativeBinaryPaths } from "../shell/native-binaries.mjs";

test("installed branded Electron uses bundled helpers even when isPackaged is false", () => {
  const resourcesPath = path.resolve("installed", "万象.app", "Contents", "Resources");
  for (const app of ["app", "app.asar"]) {
    for (const packaged of [false, true]) {
      const binaries = nativeBinaryPaths({ appPath: path.join(resourcesPath, app), resourcesPath,
        packaged, platform: "darwin", arch: "arm64" });
      assert.equal(binaries.engine, path.join(resourcesPath, "network", "wanx-netbird-darwin-arm64"));
      assert.equal(binaries.discovery, path.join(resourcesPath, "network", "wanx-discovery-darwin-arm64"));
    }
  }
});

test("source launches keep their native/bin independently of the Electron resources directory", () => {
  const appPath = path.resolve("source", "wanx-client");
  const binaries = nativeBinaryPaths({ appPath, resourcesPath: path.resolve("electron", "Resources"),
    packaged: false, platform: "darwin", arch: "x64" });
  assert.equal(binaries.engine, path.join(appPath, "native", "bin", "wanx-netbird-darwin-x64"));
  assert.equal(binaries.discovery, path.join(appPath, "native", "bin", "wanx-discovery-darwin-x64"));
});

test("Windows keeps target-specific engines and the shipped x64 discovery helper", () => {
  const resourcesPath = path.resolve("installed", "resources");
  for (const arch of ["x64", "arm64"]) {
    const binaries = nativeBinaryPaths({ appPath: path.join(resourcesPath, "app.asar"), resourcesPath,
      packaged: true, platform: "win32", arch });
    assert.equal(binaries.engine, path.join(resourcesPath, "network", `wanx-netbird-win32-${arch}.exe`));
    assert.equal(binaries.discovery, path.join(resourcesPath, "network", "wanx-discovery-win32-x64.exe"));
  }
});

import path from "node:path";

// A branded Electron development bundle can load Resources/app while still
// reporting isPackaged=false. Its native helpers belong to the installed
// resources layout, not to an omitted source-only native/bin directory.
export function nativeBinaryPaths({ appPath, resourcesPath, packaged,
  platform = process.platform, arch = process.arch }) {
  const installed = packaged || ["app", "app.asar"].some(
    name => path.resolve(appPath) === path.resolve(resourcesPath, name),
  );
  const directory = installed ? path.join(resourcesPath, "network") : path.join(appPath, "native", "bin");
  const suffix = platform === "win32" ? ".exe" : "";
  return {
    engine: path.join(directory, `wanx-netbird-${platform}-${arch}${suffix}`),
    discovery: path.join(directory, `wanx-discovery-${platform}-${platform === "win32" ? "x64" : arch}${suffix}`),
  };
}

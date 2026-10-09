import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { saveLicenses } from "./licenses.mjs";
import path from "node:path";
const appPackage = JSON.parse(await readFile("package.json", "utf8"));
const sdkPackage = JSON.parse(
  await readFile(
    "../output/codeup-centaurai-wanx-sdk/sdks/centaurai-wanx/package.json",
    "utf8",
  ),
);
if (sdkPackage.version !== appPackage.wanxSdkVersion)
  throw new Error(
    `SDK version mismatch: expected ${appPackage.wanxSdkVersion}, got ${sdkPackage.version}`,
  );
const main = await build({
  metafile: true,
  entryPoints: ["shell/main.mjs"],
  outfile: "dist-shell/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  nodePaths: ["node_modules"],
  logLevel: "info",
});
await build({
  entryPoints: ["shell/preload.cjs"],
  outfile: "dist-shell/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  nodePaths: ["node_modules"],
  logLevel: "info",
});

await saveLicenses(
  "dist-shell/third-party-licenses.json",
  Object.keys(main.metafile.inputs).map((file) => path.resolve(file)),
);

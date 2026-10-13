import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const portable = resolve(root, ".tooling/go/bin/go");
const go = process.env.WANX_GO || (existsSync(portable) ? portable : "go");
const env = {
  ...process.env,
  WANX_GO: go,
  GOCACHE: process.env.GOCACHE || resolve(root, ".tooling/gocache"),
  GOMODCACHE: process.env.GOMODCACHE || resolve(root, ".tooling/gomodcache"),
  GOPROXY: process.env.GOPROXY || "https://goproxy.cn,direct",
  GOTOOLCHAIN: "local",
};
execFileSync("npm", ["run", "build"], { cwd: resolve(root, "packages/wanx-client-adapter"), env, stdio: "inherit" });
const platform = `${process.platform}-${process.arch}`;
execFileSync(process.platform === "win32" ? "python" : "python3", ["tools/build_native.py", platform], {
  cwd: resolve(root, "packages/wanx-client-adapter"), env, stdio: "inherit",
});
// Install an immutable snapshot so npm cannot retain a cached older file dependency.
const vendor = resolve(root, "vendor");
mkdirSync(vendor, { recursive: true });
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", vendor,
  "--cache", resolve(root, ".tooling/npm-cache")], {
  cwd: resolve(root, "packages/wanx-client-adapter"), env, encoding: "utf8",
}));
const archive = resolve(vendor, packed.filename);
const hash = createHash("sha256").update(readFileSync(archive)).digest("hex").slice(0, 12);
const filename = packed.filename.replace(/\.tgz$/, `-${hash}.tgz`);
renameSync(archive, resolve(vendor, filename));
const manifest = resolve(root, "dashboard/package.json");
const pkg = JSON.parse(readFileSync(manifest, "utf8"));
pkg.dependencies["centaurai-wanx"] = `file:../vendor/${filename}`;
writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\n");
execFileSync("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
  "--cache", resolve(root, ".tooling/npm-cache")], {
  cwd: resolve(root, "dashboard"), env, stdio: "inherit",
});
execFileSync("npm", ["run", "build"], { cwd: resolve(root, "dashboard"), env, stdio: "inherit" });

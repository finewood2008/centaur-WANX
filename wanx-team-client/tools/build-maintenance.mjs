import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:maintenance"], {
  cwd: fileURLToPath(new URL("../../dashboard/", import.meta.url)),
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cp } from "node:fs/promises";

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:maintenance"], {
  cwd: fileURLToPath(new URL("../../dashboard/", import.meta.url)),
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (result.status === 0) {
  await cp(new URL("../../wanx-client/local-ui/maintenance/", import.meta.url),
    new URL("../local-ui/maintenance/", import.meta.url), { recursive: true });
}

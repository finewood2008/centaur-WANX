import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { testPackageIdentity } from "./test-build.mjs";

export async function readClientIdentity({ app, platform = process.platform, arch = process.arch, versions = process.versions }) {
  const root = app.getAppPath();
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const build = pkg.wanxBuild || {};
  const testIdentity = app.isPackaged ? testPackageIdentity(pkg) : null;
  let buildId = build.buildId || "unknown";
  if (!app.isPackaged) {
    const hash = createHash("sha256").update(JSON.stringify(pkg));
    async function visit(directory) {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) hash.update(path.relative(root, file)).update(await readFile(file));
      }
    }
    for (const directory of ["shell", "updates", "applications", "local-ui", "account", "app-host", "network", "octop"]) await visit(path.join(root, directory));
    for (const file of ["client.mjs", "platform.mjs"]) hash.update(await readFile(path.join(root, file)));
    buildId = `source-${hash.digest("hex").slice(0, 16)}`;
  }
  return Object.freeze({
    productVersion: app.getVersion(), buildId, channel: build.channel || "stable-studio",
    distributionClass: app.isPackaged ? build.distributionClass || "unverified" : "development",
    platform, osVersion: os.release(), arch, electronVersion: versions.electron || null,
    nodeVersion: versions.node, hostProtocol: 1, securityEpoch: build.securityEpoch || 0,
    sourceCommit: build.sourceCommit || null, packaged: Boolean(app.isPackaged),
    installationScope: build.installationScope || null,
    ...(testIdentity ? { applicationId: testIdentity.applicationId, testRunId: testIdentity.testRunId } : {}),
  });
}

// Paths are used only for local recovery; snapshots never disclose them.
export async function installationIdentity(app) {
  return createHash("sha256").update(await realpath(app.getPath("exe"))).digest("hex");
}

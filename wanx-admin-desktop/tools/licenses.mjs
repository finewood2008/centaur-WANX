import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
export async function collectLicenses(files) {
  const packages = new Map();
  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    const match = normalized.match(/^(.*\/node_modules\/)((?:@[^/]+\/)?[^/]+)/);
    if (match) packages.set(match[1] + match[2], null);
  }
  const notices = [];
  for (const folder of [...packages.keys()].sort()) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(folder, "package.json"), "utf8"));
    } catch {
      continue;
    }
    let licenseText = "";
    for (const filename of [
      "LICENSE",
      "LICENSE.md",
      "LICENSE.txt",
      "LICENSE-MIT",
      "license",
      "license.md",
      "LICENSE.md.txt",
    ]) {
      try {
        licenseText = await readFile(join(folder, filename), "utf8");
        break;
      } catch {
        /* Try the package's next conventional license filename. */
      }
    }
    // icons-svg declares the same MIT repository as icons, but its npm tarball omits LICENSE.
    if (!licenseText && pkg.name === "@ant-design/icons-svg") {
      const sibling = resolve(folder, "../icons");
      const linked = JSON.parse(
        await readFile(join(sibling, "package.json"), "utf8"),
      );
      if (
        linked.repository?.url === pkg.repository?.url &&
        linked.license === pkg.license
      )
        licenseText = await readFile(join(sibling, "LICENSE"), "utf8");
    }
    notices.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || "See package license",
      licenseText,
    });
  }
  return notices;
}
export async function saveLicenses(output, files) {
  const notices = await collectLicenses(files);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(notices, null, 2));
  return notices;
}

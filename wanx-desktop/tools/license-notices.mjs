import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const modules = resolve("../dashboard/node_modules");
const directories = [];
for (const name of await readdir(modules)) {
  if (name.startsWith(".")) continue;
  if (name.startsWith("@"))
    for (const scoped of await readdir(join(modules, name)))
      directories.push(join(modules, name, scoped));
  else directories.push(join(modules, name));
}
const notices = [];
for (const directory of directories) {
  let pkg;
  try {
    pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const licenses = [];
  for (const file of await readdir(directory))
    if (/^(licen[cs]e|copying|notice)(\..*)?$/i.test(file)) {
      try {
        licenses.push({
          file,
          text: await readFile(join(directory, file), "utf8"),
        });
      } catch {
        /* Some packages use a license directory. */
      }
    }
  notices.push({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license || null,
    licenses,
  });
}
await writeFile(
  "dist-ui/third-party-licenses.json",
  JSON.stringify(notices, null, 2),
);
console.log(
  `Preserved license notices for ${notices.length} dashboard build dependencies.`,
);

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createUpdateStore(filePath) {
  let pending = Promise.resolve();
  return {
    async load() {
      try { return JSON.parse(await readFile(filePath, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, sequences: {}, operation: null }; throw error; }
    },
    save(value) {
      const text = JSON.stringify(value);
      pending = pending.catch(() => {}).then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(`${filePath}.tmp`, text, { mode: 0o600 });
        await rename(`${filePath}.tmp`, filePath);
      });
      return pending;
    },
  };
}

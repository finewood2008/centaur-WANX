import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const fail = code => Object.assign(new Error(code), { code });

// This preference selects the next process's authentication path. It never
// changes the current connection or grants access to a box.
export async function createIdentitySecuritySettings({ filePath }) {
  let enabled = false, contents;
  try { contents = await readFile(filePath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw fail("IDENTITY_SECURITY_READ_FAILED"); }
  if (contents !== undefined) {
    let saved;
    try { saved = JSON.parse(contents); }
    catch { throw fail("IDENTITY_SECURITY_CONFIG_INVALID"); }
    if (!saved || Array.isArray(saved) || saved.version !== 1 || typeof saved.enabled !== "boolean" ||
        Object.keys(saved).some(key => !["version", "enabled"].includes(key)))
      throw fail("IDENTITY_SECURITY_CONFIG_INVALID");
    enabled = saved.enabled;
  }
  const active = enabled;
  const snapshot = () => ({ enabled, active, restartRequired: enabled !== active });
  let writing = Promise.resolve();
  return {
    snapshot,
    async set(input) {
      if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.enabled !== "boolean" ||
          Object.keys(input).length !== 1 || Object.keys(input)[0] !== "enabled")
        throw fail("IDENTITY_SECURITY_INVALID_INPUT");
      const next = input.enabled;
      const operation = writing.catch(() => {}).then(async () => {
        if (next === enabled) return snapshot();
        const temporary = `${filePath}.${randomUUID()}.tmp`;
        try {
          await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
          await writeFile(temporary, JSON.stringify({ version: 1, enabled: next }), { mode: 0o600, flag: "wx" });
          await rename(temporary, filePath);
          enabled = next;
          return snapshot();
        } catch { throw fail("IDENTITY_SECURITY_WRITE_FAILED"); }
        finally { await unlink(temporary).catch(() => {}); }
      });
      writing = operation;
      return operation;
    },
  };
}

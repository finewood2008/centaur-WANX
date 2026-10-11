import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// Main process only. Never fall back to plaintext when OS encryption is locked.
export function createSecureAccountStore({ filePath, safeStorage }) {
  const check = () => {
    if (
      !safeStorage?.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new Error("SECURE_STORAGE_UNAVAILABLE");
  };
  return {
    async load() {
      check();
      try {
        return JSON.parse(safeStorage.decryptString(await readFile(filePath)));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("SECURE_STORAGE_READ_FAILED");
      }
    },
    async save(value) {
      check();
      const temporary = `${filePath}.${randomUUID()}`;
      try {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFile(
          temporary,
          safeStorage.encryptString(JSON.stringify(value)),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, filePath);
      } catch {
        await unlink(temporary).catch(() => {});
        throw new Error("SECURE_STORAGE_WRITE_FAILED");
      }
    },
    async clear() {
      try {
        await unlink(filePath);
      } catch (error) {
        if (error.code !== "ENOENT")
          throw new Error("SECURE_STORAGE_WRITE_FAILED");
      }
    },
  };
}

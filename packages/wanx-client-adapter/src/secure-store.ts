import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WanxError } from "./errors.js";
import type { SecureStore } from "./native-host.js";

export interface ElectronSafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
/** Call after Electron app.whenReady(). Account keys and sessions share one record. */
export function createElectronSecureStore(config: { safeStorage: ElectronSafeStorage; directory: string }): SecureStore {
  const file = join(config.directory, "centaurai-wanx.credentials.enc");
  const check = () => { if (!config.safeStorage.isEncryptionAvailable() || config.safeStorage.getSelectedStorageBackend?.() === "basic_text") throw new WanxError("SECURE_STORAGE_UNAVAILABLE"); };
  return {
    async load() { check(); try { return config.safeStorage.decryptString(await readFile(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new WanxError("SECURE_STORAGE_READ_FAILED"); } },
    async save(value) {
      check(); await mkdir(config.directory, { recursive: true, mode: 0o700 });
      const temporary = file + "." + randomUUID();
      try { await writeFile(temporary, config.safeStorage.encryptString(value), { mode: 0o600 }); await rename(temporary, file); }
      catch { await unlink(temporary).catch(() => undefined); throw new WanxError("SECURE_STORAGE_WRITE_FAILED"); }
    },
    async clear() { await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new WanxError("SECURE_STORAGE_WRITE_FAILED"); }); },
  };
}

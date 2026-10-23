"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
class ConsumerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const MAX_BYTES = 65536;
const MAX_RECORDS = 32;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const STATES = new Set([
  "waitingAppProof",
  "waitingDeviceProof",
  "ownershipCommitted",
  "projectionPending",
  "deviceAckPending",
  "completed",
  "cancelled",
  "expired",
  "attentionRequired",
  "failed",
]);
const RECORD_FIELDS = new Set([
  "accountId",
  "deviceId",
  "pairingSessionId",
  "taskId",
  "claimState",
  "expiresAt",
  "updatedAt",
  "cancelIntent",
]);
const INTENT_FIELDS = new Set(["idempotencyKey", "bodySha256", "createdAt"]);

function invalid() {
  throw new ConsumerError("INVALID_REQUEST");
}
function plain(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
function exact(value, fields, required) {
  return (
    plain(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => fields.has(key))
  );
}
function date(value) {
  return (
    typeof value === "string" &&
    ISO.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function validateRecord(value) {
  if (
    !exact(value, RECORD_FIELDS, [
      "accountId",
      "deviceId",
      "pairingSessionId",
      "claimState",
      "expiresAt",
      "updatedAt",
    ]) ||
    !ID.test(value.accountId) ||
    !ID.test(value.deviceId) ||
    !UUID.test(value.pairingSessionId) ||
    (Object.hasOwn(value, "taskId") &&
      (typeof value.taskId !== "string" || !ID.test(value.taskId))) ||
    !STATES.has(value.claimState) ||
    !date(value.expiresAt) ||
    !date(value.updatedAt)
  )
    invalid();
  const clean = {
    accountId: value.accountId,
    deviceId: value.deviceId,
    pairingSessionId: value.pairingSessionId,
    ...(Object.hasOwn(value, "taskId") ? { taskId: value.taskId } : {}),
    claimState: value.claimState,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
  };
  if (Object.hasOwn(value, "cancelIntent")) {
    const intent = value.cancelIntent;
    if (
      !exact(intent, INTENT_FIELDS, [
        "idempotencyKey",
        "bodySha256",
        "createdAt",
      ]) ||
      typeof intent.idempotencyKey !== "string" ||
      !UUID.test(intent.idempotencyKey) ||
      typeof intent.bodySha256 !== "string" ||
      !HEX.test(intent.bodySha256) ||
      !date(intent.createdAt)
    )
      invalid();
    clean.cancelIntent = {
      idempotencyKey: intent.idempotencyKey,
      bodySha256: intent.bodySha256,
      createdAt: intent.createdAt,
    };
  }
  return clean;
}

/** Persist only resumable pairing metadata; never credentials or local proof material. */
function createClaimResumeStore({ directory, safeStorage, consumerBaseUrl }) {
  const scope = crypto
    .createHash("sha256")
    .update(consumerBaseUrl)
    .digest("hex");
  const root = path.join(directory, "consumer", scope, "claim-resume");
  let queue = Promise.resolve();
  function secure() {
    if (
      !safeStorage?.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === "basic_text"
    )
      throw new ConsumerError("SECURE_STORAGE_UNAVAILABLE");
  }
  function serial(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next.catch((error) => {
      if (error instanceof ConsumerError) throw error;
      throw new ConsumerError("SECURE_STORAGE_UNAVAILABLE");
    });
  }
  function filename(accountId) {
    return path.join(
      root,
      crypto.createHash("sha256").update(accountId).digest("hex") + ".enc",
    );
  }
  async function checkDirectory(location, create) {
    try {
      if (create) await fs.mkdir(location, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let stat;
    try {
      stat = await fs.lstat(location);
    } catch (error) {
      if (!create && error.code === "ENOENT") return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid storage directory");
    if (process.platform !== "win32") await fs.chmod(location, 0o700);
    return true;
  }
  async function checkRoot(create) {
    if (!(await checkDirectory(directory, false)))
      throw new Error("Missing user data directory");
    for (const location of [
      path.join(directory, "consumer"),
      path.join(directory, "consumer", scope),
      root,
    ]) {
      if (!(await checkDirectory(location, create))) return false;
    }
    return true;
  }
  async function read(accountId) {
    secure();
    if (!(await checkRoot(false))) return [];
    const target = filename(accountId);
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > MAX_BYTES ||
      (process.platform !== "win32" && stat.mode & 0o077)
    )
      throw new Error("Invalid encrypted record");
    let handle;
    try {
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > MAX_BYTES ||
        (process.platform !== "win32" && stat.mode & 0o077)
      )
        throw new Error("Invalid encrypted record");
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_BYTES) throw new Error("Invalid encrypted record");
      const stored = JSON.parse(
        safeStorage.decryptString(bytes.subarray(0, bytesRead)),
      );
      if (
        !exact(stored, new Set(["version", "accountId", "records"]), [
          "version",
          "accountId",
          "records",
        ]) ||
        stored.version !== 1 ||
        stored.accountId !== accountId ||
        !Array.isArray(stored.records) ||
        stored.records.length > MAX_RECORDS
      )
        throw new Error("Invalid claim index");
      let records;
      try {
        records = stored.records.map(validateRecord);
      } catch {
        throw new Error("Invalid claim index");
      }
      if (
        records.some((record) => record.accountId !== accountId) ||
        new Set(records.map((record) => record.pairingSessionId)).size !==
          records.length
      )
        throw new Error("Invalid claim index");
      return records;
    } finally {
      await handle.close();
    }
  }
  async function write(accountId, records) {
    secure();
    if (records.length > MAX_RECORDS)
      throw new ConsumerError("RESOURCE_EXHAUSTED");
    await checkRoot(true);
    const raw = JSON.stringify({ version: 1, accountId, records });
    if (Buffer.byteLength(raw) > MAX_BYTES)
      throw new ConsumerError("RESOURCE_EXHAUSTED");
    const encrypted = safeStorage.encryptString(raw);
    if (!Buffer.isBuffer(encrypted) || encrypted.length > MAX_BYTES)
      throw new ConsumerError("RESOURCE_EXHAUSTED");
    const temporary = path.join(root, `.${crypto.randomUUID()}.tmp`);
    try {
      const handle = await fs.open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(encrypted);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, filename(accountId));
      if (process.platform !== "win32") {
        const directoryHandle = await fs.open(
          root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  return Object.freeze({
    async load(accountId) {
      if (typeof accountId !== "string" || !ID.test(accountId)) invalid();
      return serial(() => read(accountId));
    },
    async save(record) {
      const clean = validateRecord(record);
      return serial(async () => {
        const records = await read(clean.accountId);
        const next = records.filter(
          (item) => item.pairingSessionId !== clean.pairingSessionId,
        );
        next.push(clean);
        await write(clean.accountId, next);
      });
    },
    async delete(accountId, pairingSessionId) {
      if (
        typeof accountId !== "string" ||
        !ID.test(accountId) ||
        typeof pairingSessionId !== "string" ||
        !UUID.test(pairingSessionId)
      )
        invalid();
      return serial(async () => {
        const records = await read(accountId);
        if (records.some((item) => item.pairingSessionId === pairingSessionId))
          await write(
            accountId,
            records.filter(
              (item) => item.pairingSessionId !== pairingSessionId,
            ),
          );
      });
    },
  });
}
module.exports = { createClaimResumeStore };

import path from "node:path";
import { constants, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";

export const DEFAULT_APPLICATION_IDS = Object.freeze([
  "centaurai.wanx.ai-browser",
  "centaurai.wanx.centaurloop",
  "centaurai.wanx.superadvisors",
  "centaurai.wanx.dialogue",
  "centaurai.wanx.zhijun",
]);

const failure = code => Object.assign(new Error(code), { code });
const known = id => DEFAULT_APPLICATION_IDS.includes(id);
const scopeKey = scope => scope && typeof scope.accountId === "string" && scope.accountId &&
  typeof scope.deviceId === "string" && scope.deviceId
  ? createHash("sha256").update(JSON.stringify([scope.accountId, scope.deviceId])).digest("hex") : null;
const receiptCode = (value, fallback) => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,99}$/.test(value) ? value : fallback;
const complete = item => ["installed", "existing", "dismissed"].includes(item?.status);
const sameVersion = (item, local) => item?.version === local?.version && item?.artifactId === local?.artifactId;

// This is Host-owned metadata. It contains no credentials or customer content.
// Dismissal follows the local installation (which is shared across accounts),
// while dependency preparation receipts are scoped to an account and a box.
export function createDefaultApplicationStore(directory) {
  const invalid = () => failure("DEFAULT_APPLICATION_STATE_INVALID");
  const checkScope = key => { if (!/^[a-f0-9]{64}$/.test(key)) throw invalid(); };
  async function checkDirectory(create = false) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
      return true;
    } catch (error) { if (error.code === "ENOENT" && !create) return false; throw error; }
  }
  async function read(name) {
    if (!await checkDirectory()) return null;
    let handle;
    try {
      handle = await open(path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 65536) throw invalid();
      const value = JSON.parse(await handle.readFile("utf8"));
      if (value?.schemaVersion !== 1) throw invalid();
      return value;
    } catch (error) { if (error.code === "ENOENT") return null; throw invalid(); }
    finally { await handle?.close(); }
  }
  async function write(name, value, assertSession) {
    assertSession();
    await checkDirectory(true);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
      finally { await handle.close(); }
      await checkDirectory();
      // Keep the final session check and commit in one event-loop turn.
      assertSession();
      renameSync(temporary, path.join(directory, name));
    } finally { await rm(temporary, { force: true }); }
  }
  return Object.freeze({
    async load(key) {
      checkScope(key);
      const value = await read(`${key}.json`);
      if (!value) return null;
      if (value.scopeKey !== key || !Array.isArray(value.items) || value.items.length !== DEFAULT_APPLICATION_IDS.length ||
          new Set(value.items.map(item => item?.applicationId)).size !== DEFAULT_APPLICATION_IDS.length ||
          value.items.some(item => !known(item?.applicationId) || !["pending", "installed", "existing", "dismissed"].includes(item.status))) throw invalid();
      return value;
    },
    save(key, value, assertSession) {
      checkScope(key);
      return write(`${key}.json`, value, assertSession);
    },
    async isDismissed(id) {
      if (!known(id)) return false;
      const value = await read(`dismissed-${id}.json`);
      if (value && (value.applicationId !== id || value.dismissed !== true)) throw invalid();
      return Boolean(value);
    },
    async dismiss(id, assertSession = () => {}) {
      if (known(id)) await write(`dismissed-${id}.json`, { schemaVersion: 1, applicationId: id, dismissed: true }, assertSession);
    },
  });
}

/** Prepare delivery defaults through the normal signed market installation path.
 * getScope must return null until account authentication AND box connection are ready.
 * A receipt's installed/existing state describes package/dependency preparation,
 * not a successful model invocation or a complete delivery acceptance test.
 */
export function createDefaultApplicationDelivery({
  market, applications, getScope, captureSession,
  store = applications?.defaultApplicationDeliveryStore, onChanged = () => {}, now = Date.now,
} = {}) {
  const tasks = new Map();
  let latest = null, closed = false, activeScope = null, queue = Promise.resolve();
  function publish(value) {
    latest = structuredClone(value);
    // Delivery progress must not turn a successful box connection into an error.
    try { onChanged(structuredClone(latest)); } catch { /* Observer only. */ }
  }
  function invalidate() {
    for (const task of tasks.values()) task.controller.abort(failure("DEFAULT_APPLICATION_SESSION_CHANGED"));
    activeScope = null;
    latest = null;
  }
  async function run(key, check) {
    check();
    const previous = await store.load(key);
    check();
    const items = DEFAULT_APPLICATION_IDS.map(applicationId => ({ applicationId, status: "pending", code: "DEFAULT_APPLICATION_NOT_PREPARED" }));
    const receipt = { schemaVersion: 1, scopeKey: key, status: "preparing", items, updatedAt: now() };
    publish(receipt);
    for (const item of items) {
      try {
        check();
        const local = (await applications.listInstalled()).find(value => value.applicationId === item.applicationId);
        check();
        const prior = previous?.items.find(value => value.applicationId === item.applicationId);
        if (!local && (await store.isDismissed(item.applicationId) || ["installed", "existing", "dismissed"].includes(prior?.status))) {
          check();
          await store.dismiss(item.applicationId, check);
          Object.assign(item, { status: "dismissed", code: "DEFAULT_APPLICATION_USER_REMOVED" });
        } else if (local && local.installationState !== "pending") {
          if (complete(prior) && sameVersion(prior, local)) Object.assign(item, prior);
          else {
            const prepared = await applications.prepareInstalledApplication(item.applicationId, check);
            check();
            Object.assign(item, prepared.resourcePreparation && prepared.resourcePreparation.status !== "ready"
              ? { status: "pending", code: receiptCode(prepared.resourcePreparation.code, "APPLICATION_RESOURCES_PENDING") }
              : { status: "existing", code: "DEFAULT_APPLICATION_PRESERVED" },
            { version: local.version, ...(local.artifactId ? { artifactId: local.artifactId } : {}) });
          }
        } else {
          const candidate = await market.candidate(item.applicationId, { assertSession: check });
          check();
          if (candidate.status !== "available") {
            Object.assign(item, { status: "pending", code: receiptCode(candidate.reason,
              candidate.status === "incompatible" ? "MARKET_INCOMPATIBLE" : "DEFAULT_APPLICATION_RELEASE_UNAVAILABLE") });
          } else {
            const installed = await market.install(item.applicationId, { assertSession: check, onlyIfMissing: true });
            check();
            const pending = installed.installationState === "pending" || installed.resourcePreparation && installed.resourcePreparation.status !== "ready";
            Object.assign(item, { status: pending ? "pending" : "installed",
              code: pending ? receiptCode(installed.resourcePreparation?.code, "APPLICATION_RESOURCES_PENDING") : "DEFAULT_APPLICATION_INSTALLED",
              version: installed.version, ...(installed.artifactId ? { artifactId: installed.artifactId } : {}) });
          }
        }
      } catch (error) {
        // A changed account/box cancels the whole pass, not just this application.
        check();
        Object.assign(item, { status: "pending", code: receiptCode(error.code, "DEFAULT_APPLICATION_PREPARATION_FAILED") });
      }
      check();
      receipt.updatedAt = now();
      await store.save(key, receipt, check);
      check();
      publish(receipt);
    }
    receipt.status = items.every(complete) ? "ready" : "pending";
    receipt.updatedAt = now();
    await store.save(key, receipt, check);
    check();
    publish(receipt);
    return structuredClone(receipt);
  }
  return Object.freeze({
    ensureDefaultApplications() {
      if (closed) return Promise.resolve({ status: "cancelled", code: "APPLICATIONS_CLOSED" });
      const key = scopeKey(getScope());
      if (!key) { invalidate(); return Promise.resolve({ status: "waiting", code: "DEFAULT_APPLICATION_CONNECTION_REQUIRED" }); }
      if (activeScope !== key) { invalidate(); activeScope = key; }
      if (tasks.has(key)) return tasks.get(key).promise;
      let captured;
      try { captured = captureSession(); }
      catch { return Promise.resolve({ status: "waiting", code: "DEFAULT_APPLICATION_CONNECTION_REQUIRED" }); }
      const controller = new AbortController();
      const check = () => {
        controller.signal.throwIfAborted();
        captured();
        if (closed || key !== scopeKey(getScope())) throw failure("DEFAULT_APPLICATION_SESSION_CHANGED");
      };
      check.signal = AbortSignal.any([controller.signal, ...(captured.signal ? [captured.signal] : [])]);
      const promise = queue.catch(() => {}).then(() => run(key, check)).catch(error => {
        const cancelled = check.signal.aborted || closed || key !== scopeKey(getScope());
        const result = { status: cancelled ? "cancelled" : "pending", code: receiptCode(error.code, "DEFAULT_APPLICATION_PREPARATION_FAILED") };
        if (!cancelled) publish(result);
        return result;
      }).finally(() => { if (tasks.get(key)?.promise === promise) tasks.delete(key); });
      tasks.set(key, { promise, controller });
      queue = promise;
      return promise;
    },
    snapshot: () => latest && structuredClone(latest),
    invalidate,
    async close() { closed = true; invalidate(); await Promise.allSettled([...tasks.values()].map(task => task.promise)); },
  });
}

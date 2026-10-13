import path from "node:path";
import { verifyEnvelope } from "./descriptor.mjs";
import { createApplicationSession } from "../app-host/session.mjs";
import { createApplicationInstaller } from "./installer.mjs";
import { createApplicationLauncher } from "./launcher.mjs";

export async function createApplicationManager({
  applicationRoot,
  applicationId,
  context,
  request,
  stream,
  createConnection,
  spawn,
  electronPath,
  runtimeArgs,
  launcherArgs,
  trustedKeys = {},
} = {}) {
  const installer = createApplicationInstaller({ rootDir: applicationRoot, trustedKeys });
  await installer.recover();
  const mutations = new Map();
  function assertOpen() {
    if (closed) throw Object.assign(new Error("APPLICATIONS_CLOSED"), { code: "APPLICATIONS_CLOSED" });
  }
  async function track(operation) {
    installing.add(operation);
    try { return await operation; } finally { installing.delete(operation); }
  }
  function mutate(id, operation, assertSession = () => {}) {
    assertOpen();
    if (mutations.has(id)) return Promise.reject(Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" }));
    const check = () => { controller.signal.throwIfAborted(); assertSession(); };
    const pending = Promise.resolve().then(async () => {
      check();
      await launcher.stop(id);
      check();
      return operation(id, check);
    }).finally(() => mutations.delete(id));
    mutations.set(id, pending);
    return track(pending);
  }
  const installing = new Set(), controller = new AbortController();
  let closed = false, closing;
  const launcher = createApplicationLauncher({
    resolveRecord: installer.resolveCurrent,
    onStarted: record => installer.prune(record.applicationId, record.version),
    host: {
      createSession(record, { signal }) {
        return createApplicationSession({
          hostApplicationId: applicationId,
          applicationId: record.applicationId,
          installPath: record.installPath,
          createConnection: async () => await createConnection?.(record.applicationId) || { context, request, openStream: stream },
          signal,
        });
      },
    },
    spawn,
    electronPath,
    runtimeArgs,
    launcherArgs,
  });
  return Object.freeze({
    async install(input) {
      assertOpen();
      if (mutations.size) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
      return track(installer.install(input, { signal: controller.signal }));
    },
    async installVerifiedPackage(input) {
      assertOpen();
      const descriptor = verifyEnvelope(input.envelope, trustedKeys);
      if (mutations.has(descriptor.applicationId)) throw Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" });
      // Preparing an update never interrupts the running version; launch owns switching.
      return track(installer.installVerifiedPackage(input, { signal: controller.signal }));
    },
    uninstall: (id, check) => mutate(id, installer.uninstall, check),
    rollback: (id, check) => mutate(id, installer.rollback, check),
    async selectCurrent(id, version) {
      if (closed) throw Object.assign(new Error("APPLICATIONS_CLOSED"), { code: "APPLICATIONS_CLOSED" });
      return track(installer.selectCurrent(id, version, { signal: controller.signal }));
    },
    listInstalled: installer.list,
    launch(id) {
      if (mutations.has(id)) return Promise.reject(Object.assign(new Error("MARKET_OPERATION_BUSY"), { code: "MARKET_OPERATION_BUSY" }));
      return launcher.launch(id);
    },
    stop: launcher.stop,
    close() {
      closed = true;
      controller.abort();
      return closing ||= (async () => {
        const results = await Promise.allSettled([launcher.close(), ...installing]);
        if (results[0].status === "rejected") throw results[0].reason;
      })().catch(error => { closing = null; throw error; });
    },
    installRoot: path.resolve(applicationRoot),
  });
}

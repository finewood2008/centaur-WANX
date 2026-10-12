import path from "node:path";
import { verifyEnvelope } from "./descriptor.mjs";
import { randomUUID } from "node:crypto";
import { createApplicationHost } from "../app-host/server.mjs";
import { createApplicationGateway } from "../app-host/http-gateway.mjs";
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
  const sessions = new Map(), mutations = new Map();
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
  const host = await createApplicationHost({
    applicationId,
    context: (id, launchId) => sessions.get(launchId)?.connection?.context?.() || context(),
    request: (input, id, launchId) => sessions.get(launchId)?.connection?.request?.(input) || request(input),
    openStream: (input, id, launchId) => sessions.get(launchId)?.connection?.openStream?.(input) || stream(input),
    isApplicationAllowed: (id, launchId, sessionToken) => {
      const session = sessions.get(launchId);
      return session?.applicationId === id && session.token === sessionToken;
    },
    closeSession: (_id, launchId) => sessions.get(launchId)?.gateway?.revoke(),
  });
  const launcher = createApplicationLauncher({
    resolveRecord: installer.resolveCurrent,
    onStarted: record => installer.prune(record.applicationId, record.version),
    host: {
      async createSession(record, { signal }) {
        const launchId = randomUUID();
        const token = randomUUID() + randomUUID();
        const connection = await createConnection?.() || { context, request, openStream: stream };
        signal.throwIfAborted();
        const gateway = await createApplicationGateway({
          connection, token,
          onInvalidated: () => { sessions.delete(launchId); host.revoke(launchId); },
        });
        try { signal.throwIfAborted(); gateway.assertLive(); }
        catch (error) { await gateway.close(); throw error; }
        sessions.set(launchId, { ...record, token, connection, gateway });
        return {
          launchId,
          assertLive: gateway.assertLive,
          environment: {
            WANX_HOST_SOCKET: host.endpoint,
            WANX_HOST_TOKEN: token,
            WANX_HOST_APPLICATION_ID: applicationId,
            WANX_HOST_CLIENT_APPLICATION_ID: record.applicationId,
            WANX_HOST_LAUNCH_ID: launchId,
            WANX_HOST_PROTOCOL_VERSION: "1",
            WANX_HOST_INSTALL_ROOT: record.installPath,
            WANX_HOST_TRANSPORT: "http-v1",
            WANX_HOST_BASE_URL: gateway.url,
          },
          async close() { sessions.delete(launchId); host.revoke(launchId); await gateway.close(); },
        };
      },
    },
    spawn,
    electronPath,
    runtimeArgs,
    launcherArgs,
  });
  return Object.freeze({
    host,
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
        try {
          const results = await Promise.allSettled([launcher.close(), ...installing]);
          if (results[0].status === "rejected") throw results[0].reason;
        } finally { await host.close(); }
      })().catch(error => { closing = null; throw error; });
    },
    installRoot: path.resolve(applicationRoot),
  });
}

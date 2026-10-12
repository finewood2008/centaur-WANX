import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApplicationHost } from "../app-host/server.mjs";
import { createApplicationInstaller } from "./installer.mjs";
import { createApplicationLauncher } from "./launcher.mjs";
import { marketFailure, verifyEnvelope } from "./descriptor.mjs";

export async function createApplicationManager({
  applicationRoot,
  applicationId,
  context,
  request,
  stream,
  createConnection,
  spawn,
  electronPath,
  launcherArgs,
  trustedKeys = {},
} = {}) {
  const installer = createApplicationInstaller({ rootDir: applicationRoot, trustedKeys });
  await installer.recover();
  const sessions = new Map();
  const operations = new Set();
  async function lifecycle(id, operation) {
    if (operations.has(id)) throw marketFailure("MARKET_OPERATION_BUSY");
    operations.add(id);
    try { return await operation(); } finally { operations.delete(id); }
  }
  const host = await createApplicationHost({
    applicationId,
    context: (id, launchId) => sessions.get(launchId)?.connection?.context?.() || context(),
    request: (input, id, launchId) => sessions.get(launchId)?.connection?.request?.(input) || request(input),
    openStream: (input, id, launchId) => sessions.get(launchId)?.connection?.openStream?.(input) || stream(input),
    isApplicationAllowed: (id, launchId, sessionToken) => {
      const session = sessions.get(launchId);
      return session?.applicationId === id && session.token === sessionToken;
    },
    capabilitiesFor: (id, launchId) => {
      const record = sessions.get(launchId);
      return record?.applicationId === id ? record.capabilities : [];
    },
    closeSession: (_id, launchId) => { sessions.delete(launchId); host.revoke(launchId); },
  });
  const launcher = createApplicationLauncher({
    host: {
      async createSession(record) {
        const launchId = randomUUID();
        const token = randomUUID() + randomUUID();
        const connection = await createConnection?.();
        sessions.set(launchId, { ...record, token, connection });
        return {
          launchId,
          assertLive: () => connection?.context(),
          environment: {
            WANX_HOST_SOCKET: host.endpoint,
            WANX_HOST_TOKEN: token,
            WANX_HOST_APPLICATION_ID: applicationId,
            WANX_HOST_CLIENT_APPLICATION_ID: record.applicationId,
            WANX_HOST_LAUNCH_ID: launchId,
            WANX_HOST_PROTOCOL_VERSION: "1",
            WANX_HOST_INSTALL_ROOT: record.installPath,
            WANX_HOST_APPLICATION_DATA: path.join(path.dirname(path.resolve(applicationRoot)), "application-data", record.applicationId),
          },
          async close() { sessions.delete(launchId); host.revoke(launchId); },
        };
      },
    },
    spawn,
    electronPath,
    launcherArgs,
  });
  return Object.freeze({
    host,
    async install(input) { return installer.install(input); },
    async installVerifiedPackage(input) {
      const descriptor = verifyEnvelope(input.envelope, trustedKeys);
      return lifecycle(descriptor.applicationId, async () => {
        await launcher.stop(descriptor.applicationId);
        input.assertSession?.();
        return installer.installVerifiedPackage(input);
      });
    },
    listInstalled: installer.list,
    async launch(id, version) {
      return lifecycle(id, async () => {
        const records = await installer.list();
        const record = records.find((item) => item.applicationId === id);
        if (!record) throw Object.assign(new Error("APPLICATION_NOT_INSTALLED"), { code: "APPLICATION_NOT_INSTALLED" });
        if (version && record.version !== version) throw marketFailure("APPLICATION_VERSION_NOT_ACTIVE");
        return launcher.launch(record);
      });
    },
    stop: (id) => lifecycle(id, () => launcher.stop(id)),
    async uninstall(id, assertSession) {
      return lifecycle(id, async () => {
        assertSession?.();
        await launcher.stop(id);
        return installer.uninstall(id, assertSession);
      });
    },
    async rollback(id, assertSession) {
      return lifecycle(id, async () => {
        assertSession?.();
        await launcher.stop(id);
        return installer.rollback(id, assertSession);
      });
    },
    async close() { for (const id of launcher.running.keys()) await launcher.stop(id); await host.close(); },
    installRoot: path.resolve(applicationRoot),
  });
}

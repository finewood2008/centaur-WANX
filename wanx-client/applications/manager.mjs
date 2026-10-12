import path from "node:path";
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
} = {}) {
  const installer = createApplicationInstaller({ rootDir: applicationRoot });
  const sessions = new Map();
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
    closeSession: (_id, launchId) => sessions.get(launchId)?.gateway?.revoke(),
  });
  const launcher = createApplicationLauncher({
    host: {
      async createSession(record) {
        const launchId = randomUUID();
        const token = randomUUID() + randomUUID();
        const connection = await createConnection?.() || { context, request, openStream: stream };
        const gateway = await createApplicationGateway({
          connection, token, capabilities: record.capabilities,
          onInvalidated: () => { sessions.delete(launchId); host.revoke(launchId); },
        });
        try { gateway.assertLive(); }
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
  });
  return Object.freeze({
    host,
    async install(input) { return installer.install(input); },
    listInstalled: installer.list,
    async launch(id, version) {
      const records = await installer.list();
      const record = records.find((item) => item.applicationId === id && (!version || item.version === version));
      if (!record) throw Object.assign(new Error("APPLICATION_NOT_INSTALLED"), { code: "APPLICATION_NOT_INSTALLED" });
      return launcher.launch(record);
    },
    stop: launcher.stop,
    async close() { for (const id of launcher.running.keys()) await launcher.stop(id); await host.close(); },
    installRoot: path.resolve(applicationRoot),
  });
}

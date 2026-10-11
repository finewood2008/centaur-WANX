import path from "node:path";
import { randomUUID } from "node:crypto";
import { createApplicationHost } from "../app-host/server.mjs";
import { createApplicationInstaller } from "./installer.mjs";
import { createApplicationLauncher } from "./launcher.mjs";

export async function createApplicationManager({
  applicationRoot,
  applicationId,
  context,
  request,
  spawn,
  electronPath,
} = {}) {
  const installer = createApplicationInstaller({ rootDir: applicationRoot });
  const sessions = new Map();
  const host = await createApplicationHost({
    applicationId,
    context,
    request,
    isApplicationAllowed: (id, launchId) => sessions.get(launchId)?.applicationId === id,
    capabilitiesFor: (id, launchId) => {
      const record = sessions.get(launchId);
      return record?.applicationId === id ? record.capabilities : [];
    },
    closeSession: (_id, launchId) => { sessions.delete(launchId); },
  });
  const launcher = createApplicationLauncher({
    host: {
      async createSession(record) {
        const launchId = randomUUID();
        sessions.set(launchId, record);
        return {
          launchId,
          environment: {
            WANX_HOST_SOCKET: host.endpoint,
            WANX_HOST_TOKEN: host.token,
            WANX_HOST_APPLICATION_ID: applicationId,
            WANX_HOST_CLIENT_APPLICATION_ID: record.applicationId,
            WANX_HOST_LAUNCH_ID: launchId,
            WANX_HOST_PROTOCOL_VERSION: "1",
          },
          async close() { sessions.delete(launchId); },
        };
      },
    },
    spawn,
    electronPath,
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

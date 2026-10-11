import { spawn as defaultSpawn } from "node:child_process";

const fail = (code) => Object.assign(new Error(code), { code });

export function createApplicationLauncher({
  host,
  spawn = defaultSpawn,
  electronPath = process.execPath,
} = {}) {
  if (!host) throw new TypeError("host is required");
  const running = new Map();
  async function launch(record) {
    if (!record?.applicationId || !record.installPath || !record.entrypoint)
      throw fail("APPLICATION_RECORD_INVALID");
    const previous = running.get(record.applicationId);
    if (previous && previous.child.exitCode === null) return { applicationId: record.applicationId, launchId: previous.launchId, state: "running" };
    const session = await host.createSession(record);
    const launchId = session.launchId;
    const child = spawn(electronPath, [`--app=${record.installPath}`], {
      cwd: record.installPath,
      env: { ...process.env, ...session.environment },
      stdio: "ignore",
      windowsHide: true,
      detached: false,
    });
    child.once("error", () => { if (running.get(record.applicationId)?.child === child) running.delete(record.applicationId); void session.close(); });
    child.once("exit", () => { if (running.get(record.applicationId)?.child === child) running.delete(record.applicationId); void session.close(); });
    running.set(record.applicationId, { child, launchId, session });
    return { applicationId: record.applicationId, launchId, state: "running" };
  }
  async function stop(applicationId) {
    const current = running.get(applicationId);
    if (!current) return { applicationId, state: "stopped" };
    current.child.kill();
    await current.session.close();
    running.delete(applicationId);
    return { applicationId, state: "stopped" };
  }
  return Object.freeze({ launch, stop, running });
}

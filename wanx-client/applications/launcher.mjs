import { spawn as defaultSpawn } from "node:child_process";

const fail = (code) => Object.assign(new Error(code), { code });

export function createApplicationLauncher({
  host,
  spawn = defaultSpawn,
  electronPath = process.execPath,
  launcherArgs = ["--wanx-managed-app"],
} = {}) {
  if (!host) throw new TypeError("host is required");
  const running = new Map();
  async function launch(record) {
    if (!record?.applicationId || !record.installPath || !record.entrypoint)
      throw fail("APPLICATION_RECORD_INVALID");
    const previous = running.get(record.applicationId);
    if (previous && previous.child.exitCode === null) {
      try {
        previous.session.assertLive?.();
        if (previous.version === record.version)
          return { applicationId: record.applicationId, launchId: previous.launchId, state: "running" };
      } catch {
        // A box switch invalidates the old launch; reopening binds a fresh session.
      }
      await stop(record.applicationId);
    }
    const session = await host.createSession(record);
    const launchId = session.launchId;
    let child;
    try {
      child = spawn(electronPath, launcherArgs, {
        cwd: record.installPath,
        env: { ...process.env, ...session.environment },
        stdio: "ignore",
        windowsHide: true,
        detached: false,
      });
    } catch (error) {
      await session.close();
      throw error;
    }
    child.once("error", () => { if (running.get(record.applicationId)?.child === child) running.delete(record.applicationId); void session.close(); });
    child.once("exit", () => { if (running.get(record.applicationId)?.child === child) running.delete(record.applicationId); void session.close(); });
    running.set(record.applicationId, { child, launchId, session, version: record.version });
    return { applicationId: record.applicationId, launchId, state: "running" };
  }
  async function stop(applicationId) {
    const current = running.get(applicationId);
    if (!current) return { applicationId, state: "stopped" };
    try {
      if (current.child.exitCode === null) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(fail("APPLICATION_STOP_FAILED")), 5000);
          const done = () => { clearTimeout(timeout); resolve(); };
          current.child.once("exit", done);
          current.child.once("error", done);
          current.child.kill();
          if (current.child.exitCode !== null) done();
        });
      }
    } finally { await current.session.close(); }
    running.delete(applicationId);
    return { applicationId, state: "stopped" };
  }
  return Object.freeze({ launch, stop, running });
}

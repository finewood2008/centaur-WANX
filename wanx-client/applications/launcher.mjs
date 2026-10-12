import { spawn as defaultSpawn } from "node:child_process";

const fail = (code) => Object.assign(new Error(code), { code });

export function createApplicationLauncher({
  host,
  spawn = defaultSpawn,
  electronPath = process.execPath,
  runtimeArgs = [],
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
        if (previous.version === record.version) {
          const result = await previous.ready;
          previous.child.send?.({ type: "wanx:application-activate", launchId: previous.launchId }, () => {});
          return result;
        }
      } catch {
        // A box switch invalidates the old launch; reopening binds a fresh session.
      }
      await stop(record.applicationId);
    }
    const session = await host.createSession(record);
    const launchId = session.launchId;
    let child;
    try {
      child = spawn(electronPath, [...runtimeArgs, `--wanx-application=${record.installPath}`], {
        cwd: record.installPath,
        env: { ...process.env, ...session.environment },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
        detached: false,
      });
    } catch (error) {
      await session.close();
      throw error;
    }
    let closing;
    const release = () => {
      if (running.get(record.applicationId)?.child === child) running.delete(record.applicationId);
      return closing ||= Promise.resolve().then(() => session.close());
    };
    let settleFailure;
    const ready = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("message", onMessage);
        if (error) {
          child.kill();
          void release().then(() => reject(error), () => reject(error));
        } else resolve({ applicationId: record.applicationId, launchId, state: "running" });
      };
      const onMessage = (message) => {
        if (message?.launchId !== launchId) return;
        if (message.type === "wanx:application-failed") finish(fail("APPLICATION_START_FAILED"));
        if (message.type === "wanx:application-ready") {
          try { session.assertLive?.(); finish(); }
          catch (error) { finish(error); }
        }
      };
      const timer = setTimeout(() => finish(fail("APPLICATION_START_TIMEOUT")), 30_000);
      settleFailure = () => finish(fail("APPLICATION_START_FAILED"));
      child.on("message", onMessage);
    });
    const onExit = () => { settleFailure(); void release().catch(() => {}); };
    child.once("error", onExit);
    child.once("exit", onExit);
    running.set(record.applicationId, { child, launchId, session, ready, release, version: record.version });
    return ready;
  }
  async function stop(applicationId) {
    const current = running.get(applicationId);
    if (!current) return { applicationId, state: "stopped" };
    current.child.kill();
    await current.release();
    return { applicationId, state: "stopped" };
  }
  return Object.freeze({ launch, stop, running });
}

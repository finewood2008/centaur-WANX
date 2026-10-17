import { spawn as defaultSpawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertApplicationPlatform, resolveApplicationEntry } from "./manifest.mjs";

const fail = (code) => Object.assign(new Error(code), { code });

export function createApplicationLauncher({
  host,
  resolveRecord = async record => record,
  onStarted = async () => {},
  spawn = defaultSpawn,
  electronPath = process.execPath,
  runtimeArgs = [],
  launcherArgs = ["--wanx-managed-app"],
} = {}) {
  if (!host) throw new TypeError("host is required");
  const applications = new Map();
  let closed = false, closing;

  function stateFor(id) {
    if (!applications.has(id)) applications.set(id, { entry: null, task: null, stopping: null, queued: null });
    return applications.get(id);
  }
  function assertActive(signal) {
    if (signal.aborted || closed) throw fail("APPLICATION_START_CANCELED");
  }
  function release(entry) {
    if (!entry.released) {
      try { entry.released = Promise.resolve(entry.session.close()); }
      catch (error) { entry.released = Promise.reject(error); }
    }
    return entry.released;
  }
  async function waitForExit(entry, milliseconds) {
    if (entry.exited) return true;
    let timer;
    try {
      return await Promise.race([entry.exit.then(() => true), new Promise(resolve => {
        timer = setTimeout(() => resolve(false), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  function terminate(state, entry) {
    if (entry.stopping) return entry.stopping;
    entry.stopping = (async () => {
      // Revoke credentials immediately; listener shutdown and process exit may finish independently.
      const released = release(entry);
      released.catch(() => {});
      if (!entry.exited) {
        entry.child.kill();
        if (!await waitForExit(entry, 5000)) {
          entry.child.kill("SIGKILL");
          if (!await waitForExit(entry, 2000)) throw fail("APPLICATION_STOP_FAILED");
        }
      }
      await released;
      if (state.entry === entry) state.entry = null;
    })().finally(() => { entry.stopping = null; });
    return entry.stopping;
  }

  async function start(state, input, signal) {
    const record = await resolveRecord(input);
    assertActive(signal);
    if (!record?.applicationId || !record.installPath || !record.entrypoint)
      throw fail("APPLICATION_RECORD_INVALID");
    assertApplicationPlatform(record);
    const previous = state.entry;
    if (previous) {
      let live = !previous.exited;
      try { previous.session.assertLive?.(); } catch { live = false; }
      if (live && previous.version === record.version && previous.installPath === record.installPath) {
        previous.child.send?.({ type: "wanx:application-activate", launchId: previous.session.launchId }, () => {});
        return { applicationId: record.applicationId, launchId: previous.session.launchId, state: "running" };
      }
      await terminate(state, previous);
      assertActive(signal);
    }
    const bundled = record.launchMode === "bundled";
    const executable = bundled ? await resolveApplicationEntry(record.installPath, record) : electronPath;
    const userData = bundled ? path.resolve(record.installPath, "..", "..", ".runtime", record.applicationId) : null;
    if (userData) await mkdir(userData, { recursive: true, mode: 0o700 });
    assertActive(signal);
    const session = await host.createSession(record, { signal });
    let entry;
    try {
      assertActive(signal);
      const child = spawn(executable, bundled ? [] : record.envelope ? launcherArgs : [...runtimeArgs, `--wanx-application=${record.installPath}`], {
        cwd: record.installPath,
        env: { ...process.env, ...session.environment, ...(userData ? { WANX_HOST_USER_DATA_DIR: userData } : {}) },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
        detached: false,
      });
      let exited;
      entry = { child, session, installPath: record.installPath, version: record.version, exited: false, exit: new Promise(resolve => { exited = resolve; }) };
      state.entry = entry;
      const onExit = () => {
        entry.exited = true;
        exited();
        void release(entry).then(() => { if (state.entry === entry) state.entry = null; }, () => {});
      };
      child.once("exit", onExit);
      child.on("error", () => { if (!child.pid) onExit(); });
      await new Promise((resolve, reject) => {
        let timer;
        const finish = error => {
          clearTimeout(timer);
          child.removeListener("message", onMessage);
          child.removeListener("error", onError);
          child.removeListener("exit", onEarlyExit);
          signal.removeEventListener("abort", onAbort);
          if (error) reject(error); else resolve();
        };
        const onError = () => finish(fail("APPLICATION_START_FAILED"));
        const onEarlyExit = onError;
        const onAbort = () => finish(fail("APPLICATION_START_CANCELED"));
        const onMessage = message => {
          if (message?.launchId !== session.launchId) return;
          if (message.type === "wanx:application-failed") onError();
          if (message.type === "wanx:application-ready") {
            try { assertActive(signal); session.assertLive?.(); finish(); }
            catch (error) { finish(error); }
          }
        };
        timer = setTimeout(() => finish(fail("APPLICATION_START_TIMEOUT")), 30_000);
        child.on("message", onMessage);
        child.once("error", onError);
        child.once("exit", onEarlyExit);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      assertActive(signal);
      if (entry.exited) throw fail("APPLICATION_START_FAILED");
      await onStarted(record);
      assertActive(signal);
      if (entry.exited) throw fail("APPLICATION_START_FAILED");
      return { applicationId: record.applicationId, launchId: session.launchId, state: "running" };
    } catch (error) {
      if (entry) await terminate(state, entry);
      else await session.close();
      throw error;
    }
  }

  function launch(input) {
    if (closed) return Promise.reject(fail("APPLICATIONS_CLOSED"));
    const id = typeof input === "string" ? input : input?.applicationId;
    if (!id) return Promise.reject(fail("APPLICATION_RECORD_INVALID"));
    const state = stateFor(id);
    if (state.stopping) {
      if (!state.queued) {
        const queued = { canceled: false, input };
        queued.promise = state.stopping.then(() => {
          if (queued.canceled || closed) throw fail("APPLICATION_START_CANCELED");
          return launch(queued.input);
        }).finally(() => { if (state.queued === queued) state.queued = null; });
        state.queued = queued;
      } else state.queued.input = input;
      return state.queued.promise;
    }
    if (state.task) return state.task.promise;
    const task = { controller: new AbortController() };
    state.task = task;
    // Ownership is registered before even the installed-record lookup can yield.
    task.promise = Promise.resolve().then(() => start(state, input, task.controller.signal))
      .catch(error => {
        if (task.controller.signal.aborted && error.code !== "APPLICATION_STOP_FAILED") throw fail("APPLICATION_START_CANCELED");
        throw error;
      })
      .finally(() => { if (state.task === task) state.task = null; });
    return task.promise;
  }

  function stop(id) {
    const state = stateFor(id);
    if (state.queued) state.queued.canceled = true;
    if (state.stopping) return state.stopping;
    const task = state.task;
    task?.controller.abort();
    state.stopping = (async () => {
      // Revoke an existing child now, even if lookup or post-start cleanup is blocked.
      // The task independently owns disposal of any session that arrives later.
      const results = await Promise.allSettled([
        state.entry ? terminate(state, state.entry) : Promise.resolve(),
        task?.promise,
      ]);
      if (results[0].status === "rejected") throw results[0].reason;
      if (results[1].status === "rejected" && results[1].reason.code === "APPLICATION_STOP_FAILED") throw results[1].reason;
      if (state.entry) await terminate(state, state.entry);
      return { applicationId: id, state: "stopped" };
    })().finally(() => { state.stopping = null; });
    return state.stopping;
  }
  function close() {
    closed = true;
    return closing ||= Promise.allSettled([...applications.keys()].map(stop)).then(results => {
      const failure = results.find(result => result.status === "rejected");
      if (failure) { closing = null; throw failure.reason; }
    });
  }
  function activate(id) {
    const entry = applications.get(id)?.entry;
    if (!entry || entry.exited) return false;
    try { entry.session.assertLive?.(); } catch { return false; }
    entry.child.send?.({ type: "wanx:application-activate", launchId: entry.session.launchId }, () => {});
    return true;
  }
  return Object.freeze({ launch, activate, stop, close });
}

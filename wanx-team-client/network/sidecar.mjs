import { spawn } from "node:child_process";

const failure = (code) => Object.assign(new Error(code), { code });

/** Private NDJSON transport. Credentials go over stdin, never argv or logs. */
export function createSidecar({
  binaryPath,
  onFailure,
  spawnProcess = spawn,
  requestTimeoutMs = 45_000,
  shutdownTimeoutMs = 1_500,
  maxLineBytes = 1024 * 1024,
}) {
  const child = spawnProcess(binaryPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let ended = false;
  let stopping = false;
  let sequence = 0;
  let buffer = "";
  let killTimer;
  let exited = false;
  let terminating = false;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const finishExit = () => {
    if (exited) return;
    exited = true;
    clearTimeout(killTimer);
    killTimer = null;
    resolveExit();
  };
  const requests = new Map();
  const rejectAll = (code) => {
    for (const operation of requests.values()) {
      clearTimeout(operation.timer);
      operation.reject(failure(code));
    }
    requests.clear();
  };
  const fail = (code) => {
    if (ended) return;
    ended = true;
    buffer = "";
    rejectAll(code);
    if (!stopping) onFailure?.(code);
    terminate();
  };
  function terminate() {
    if (exited || terminating) return;
    terminating = true;
    clearTimeout(killTimer);
    child.kill();
    if (!exited)
      killTimer = setTimeout(() => child.kill("SIGKILL"), shutdownTimeoutMs);
  }
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (ended) return;
    buffer += chunk;
    // Bound even incomplete lines; stdout is protocol-only.
    if (Buffer.byteLength(buffer) > maxLineBytes)
      return fail("engine_protocol_error");
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return fail("engine_protocol_error");
      }
      if (!message || typeof message !== "object")
        return fail("engine_protocol_error");
      const operation = requests.get(message.id);
      if (!operation) continue;
      requests.delete(message.id);
      clearTimeout(operation.timer);
      if (message.error) {
        const code = message.error.code;
        operation.reject(
          failure(
            typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
              ? code
              : "engine_error",
          ),
        );
      } else if (Object.hasOwn(message, "result"))
        operation.resolve(message.result);
      else {
        operation.reject(failure("engine_protocol_error"));
        fail("engine_protocol_error");
      }
    }
  });
  child.stdout.on("end", () => fail("engine_exited"));
  // Drain logs without forwarding potentially sensitive SDK diagnostics.
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => fail("engine_exited"));
  child.on("error", (error) => {
    // A failed spawn has no PID and may never emit `exit`.
    if (!child.pid) finishExit();
    fail(error.code === "ENOENT" ? "engine_missing" : "engine_unavailable");
  });
  child.on("exit", () => {
    finishExit();
    fail("engine_exited");
  });
  child.on("close", () => {
    finishExit();
    fail("engine_exited");
  });
  return {
    request(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
      if (ended || stopping) return Promise.reject(failure("engine_exited"));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => fail("engine_timeout"), timeoutMs);
        requests.set(id, { resolve, reject, timer });
        child.stdin.write(
          JSON.stringify({ id, method, params }) + "\n",
          (error) => {
            if (error) fail("engine_exited");
          },
        );
      });
    },
    close() {
      if (stopping) return exitPromise;
      stopping = true;
      rejectAll("network_disabled");
      if (!ended && !exited && child.stdin.writable) {
        child.stdin.end(
          JSON.stringify({ id: ++sequence, method: "stop", params: {} }) + "\n",
        );
        killTimer = setTimeout(terminate, shutdownTimeoutMs);
      } else terminate();
      ended = true;
      return exitPromise;
    },
  };
}

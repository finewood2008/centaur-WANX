import { mkdir, stat, rename, appendFile } from "node:fs/promises";
import path from "node:path";

// Codes are an allowlist, not a pattern: even a plausible code may contain a secret.
const errorCodes = new Set([
  "ACCOUNT_ACCESS_DENIED", "ACCOUNT_CANCELLED", "ACCOUNT_INVALID_RESPONSE",
  "ACCOUNT_INVALID_STORED_SESSION", "ACCOUNT_LOGIN_REQUIRED", "ACCOUNT_NETWORK_ERROR",
  "ACCOUNT_REDIRECT_REJECTED", "ACCOUNT_REQUEST_FAILED", "ACCOUNT_SESSION_EXPIRED",
  "NETWORK_CANCELLED", "NETWORK_CHANGED", "NETWORK_DEVICE_ACCESS_DENIED",
  "NETWORK_ENGINE_UNAVAILABLE", "NETWORK_ENROLLMENT_REQUIRED", "NETWORK_ENROLLMENT_TIMEOUT",
  "NETWORK_INVALID_RESPONSE", "NETWORK_LEASE_EXPIRED", "NETWORK_NOT_READY",
  "NETWORK_REVOCATION_PENDING", "NETWORK_SERVICE_NOT_DEPLOYED", "NETWORK_UNAVAILABLE",
  "engine_missing", "engine_unavailable", "engine_exited", "engine_timeout",
  "engine_protocol_error", "auth_required", "auth_unsupported", "auth_failed",
  "auth_expired", "start_failed", "invalid_status", "network_unavailable",
  "network_disabled", "netbird_peer_disconnected", "netbird_peer_unknown",
]);
const phases = new Set(["idle", "disabled", "checking", "enrolling", "authorizing", "ready", "recovering", "unavailable", "auth_required"]);
const safeCode = code => errorCodes.has(code) ? code : "UNKNOWN_ERROR";

// Bounded local diagnostics never serialize request/response data or error objects.
export function createTimingRecorder({
  filePath,
  consoleOutput = false,
  maxBytes = 512 * 1024,
}) {
  let writes = Promise.resolve();
  const previousStates = new Map();
  function record(step, outcome, durationMs, details = {}) {
    if (!/^[a-z]+(?:\.[a-z]+){1,3}$/.test(step)) return;
    const event = { time: new Date().toISOString(), step, outcome, durationMs, ...details };
    if (consoleOutput) console.info("[wanx-timing]", JSON.stringify(event));
    writes = writes
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const size = await stat(filePath)
          .then((s) => s.size)
          .catch(() => 0);
        if (size >= maxBytes) await rename(filePath, `${filePath}.previous`);
        await appendFile(filePath, `${JSON.stringify(event)}\n`, {
          mode: 0o600,
        });
      })
      .catch(() => {}); // Diagnostic I/O must never break a connection.
  }
  return {
    state(component, value) {
      if (!["network", "platform"].includes(component)) return;
      const state = {
        phase: phases.has(value.phase) ? value.phase : "unknown",
        reason: value.reason == null ? null : safeCode(value.reason),
        ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
      };
      const key = JSON.stringify(state);
      if (previousStates.get(component) === key) return;
      previousStates.set(component, key);
      record(`${component}.state`, "changed", undefined, state);
    },
    async run(step, operation) {
      const start = performance.now();
      let outcome = "failed";
      let details;
      try {
        const value = await operation();
        outcome = "completed";
        return value;
      } catch (error) {
        details = {
          errorCode: safeCode(error?.code),
          ...(Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
            ? { httpStatus: error.status } : {}),
        };
        throw error;
      } finally {
        record(step, outcome, Math.round(performance.now() - start), details);
      }
    },
    flush: () => writes,
  };
}

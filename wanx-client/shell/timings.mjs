import { mkdir, stat, rename, appendFile } from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { BOX_SESSION_ERROR_CODES } from "../octop/platform.mjs";

// Codes are an allowlist, not a pattern: even a plausible code may contain a secret.
const errorCodes = new Set([
  "health_unavailable", "health_timeout", "health_invalid", "NETWORK_SESSION_REVOKED",
  "LOCAL_CONNECT_TIMEOUT", "LOCAL_CONNECT_UNSUPPORTED_BOND_FLOW", "LOCAL_SELECTION_LEASE_INVALID",
  "LOCAL_DEVICE_INFO_INVALID", "LOCAL_DEVICE_INCOMPATIBLE", "LOCAL_TRANSPORT_DISCONNECTED",
  "LOCAL_USER_CANCELLED", "GATT_SERVICE_NOT_FOUND", "GATT_CHARACTERISTIC_MISMATCH",
  "GATT_FRAGMENT_PROTOCOL_ERROR", "GATT_FRAGMENT_INCOMPLETE", "PROTOCOL_CHANGED", "RESOURCE_EXHAUSTED",
  ...BOX_SESSION_ERROR_CODES,
  "PLATFORM_SESSION_EXPIRED", "SPACE_RETRY_EXHAUSTED", "ENOENT", "ENOSPC", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "SPACE_TRANSFER_FAILED", "SPACE_CONNECTION_TIMEOUT", "SPACE_CHUNK_STALLED", "SPACE_LOCAL_FILE_CHANGED", "SPACE_UPLOAD_OFFSET", "SPACE_UPLOAD_OFFSET_INVALID", "SPACE_CONTEXT_CHANGED", "SPACE_NETWORK_WAIT", "SPACE_PAUSED", "SECURE_STORAGE_WRITE_FAILED",
  "ACCOUNT_ACCESS_DENIED", "ACCOUNT_CANCELLED", "ACCOUNT_INVALID_RESPONSE",
  "ACCOUNT_INVALID_STORED_SESSION", "ACCOUNT_LOGIN_REQUIRED", "ACCOUNT_NETWORK_ERROR",
  "ACCOUNT_REDIRECT_REJECTED", "ACCOUNT_REQUEST_FAILED", "ACCOUNT_SESSION_EXPIRED",
  "NETWORK_CANCELLED", "NETWORK_CHANGED", "NETWORK_DEVICE_ACCESS_DENIED",
  "NETWORK_ENGINE_UNAVAILABLE", "NETWORK_ENROLLMENT_REQUIRED", "NETWORK_ENROLLMENT_TIMEOUT",
  "NETWORK_INVALID_RESPONSE", "NETWORK_LEASE_EXPIRED", "NETWORK_NOT_READY",
  "NETWORK_REVOCATION_PENDING", "NETWORK_SERVICE_NOT_DEPLOYED", "NETWORK_UNAVAILABLE",
  "engine_missing", "engine_unavailable", "engine_exited", "engine_timeout",
  "engine_protocol_error", "auth_required", "auth_unsupported", "auth_failed",
  "auth_expired", "start_failed", "invalid_status", "network_unavailable", "network_status_stale",
  "network_disabled", "netbird_peer_disconnected", "netbird_peer_unknown",
]);
const phases = new Set(["idle", "disabled", "checking", "enrolling", "authorizing", "ready", "recovering", "unavailable", "auth_required"]);
const paymentStages = new Set(["confirm", "qr", "close"]);
const safeCode = code => errorCodes.has(code) ? code : "UNKNOWN_ERROR";

// Bounded local diagnostics never serialize request/response data or error objects.
export function createTimingRecorder({
  filePath,
  consoleOutput = false,
  maxBytes = 512 * 1024,
}) {
  let writes = Promise.resolve();
  const connections = new AsyncLocalStorage();
  const previousStates = new Map();
  function record(step, outcome, durationMs, details = {}) {
    if (!/^[a-z]+(?:\.[a-z]+){1,3}$/.test(step)) return;
    const connection = connections.getStore();
    const event = { time: new Date().toISOString(), step, outcome, durationMs, ...details,
      ...(connection?.active ? { connectionId: connection.id } : {}) };
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
    grantResponse(value = {}) {
      const details = {};
      if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.requestId || "")) details.requestId = value.requestId;
      if (Number.isFinite(value.serverDurationMs) && value.serverDurationMs >= 0) details.serverDurationMs = value.serverDurationMs;
      if (Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) details.httpStatus = value.httpStatus;
      record("account.grant.response", "received", undefined, details);
    },
    provisioning(value) {
      if (!["connect", "readDeviceInfo", "request", "subscribeStatus", "close", "closeAll"].includes(value.operation)
          || !["completed", "failed"].includes(value.outcome)) return;
      const details = { operation: value.operation };
      if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.requestId || ""))
        details.requestId = value.requestId;
      if ([1, 2].includes(value.attempt)) details.attempt = value.attempt;
      if (["renderer", "deadline", "abort", "send", "lifecycle"].includes(value.source)) details.source = value.source;
      if (["connect", "service", "characteristic", "notifications"].includes(value.stage)) details.stage = value.stage;
      if (["NetworkError", "NotFoundError", "NotSupportedError", "InvalidStateError", "SecurityError",
        "AbortError", "TimeoutError", "UnknownError", "LocalProvisioningFailure"].includes(value.errorName))
        details.errorName = value.errorName;
      if (["device.info.result", "hello.result", "status.result", "pairing.start.result",
        "pairing.challenge.result", "pairing.token.result", "pairing.cancel.result",
        "wifi.scan.result", "wifi.apply.result", "job.status.result"].includes(value.messageType))
        details.messageType = value.messageType;
      if (value.errorCode) details.errorCode = safeCode(value.errorCode);
      const duration = Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 ? value.durationMs : undefined;
      record("setup.transport", value.outcome, duration, details);
    },
    transfer(value) {
      if (!["enqueued", "connection", "reconciled", "confirmed", "completed", "interrupted", "resumed", "paused", "request"].includes(value.action)) return;
      const details = {};
      for (const key of ["taskId", "batchId"]) if (/^[a-f0-9]{32}$/.test(value[key] || "")) details[key] = value[key];
      for (const key of ["offset", "size", "attempt", "httpStatus", "durationMs", "requestBytes", "responseBytes"]) if (Number.isSafeInteger(value[key]) && value[key] >= 0) details[key] = value[key];
      if (["queued", "checking", "running", "waiting", "retrying", "paused", "complete", "canceled"].includes(value.phase)) details.phase = value.phase;
      if (["commit", "chunk", "reconcile"].includes(value.stage)) details.stage = value.stage;
      if (["connecting", "sending", "awaiting_response", "receiving"].includes(value.transportPhase)) details.transportPhase = value.transportPhase;
      if (typeof value.reusedSocket === "boolean") details.reusedSocket = value.reusedSocket;
      if (value.errorCode) details.errorCode = safeCode(value.errorCode);
      record("space.transfer", value.action, undefined, details);
    },
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
    creditPayment(value = {}) {
      if (!paymentStages.has(value.stage) || !Number.isFinite(value.durationMs) || value.durationMs < 0) return;
      const details = {};
      if (typeof value.qrReady === "boolean") details.qrReady = value.qrReady;
      if (typeof value.ready === "boolean") details.qrReady = value.ready;
      record(`credit.payment.${value.stage}`, value.outcome === "failed" ? "failed" : "completed",
        Math.round(value.durationMs), details);
    },
    async run(step, operation) {
      if (step === "box.connect") {
        const connection = { id: randomUUID(), active: true };
        return connections.run(connection, async () => {
          try { return await run(step, operation); }
          finally { connection.active = false; }
        });
      }
      return run(step, operation);
    },
    flush: () => writes,
  };

  async function run(step, operation) {
    const start = performance.now();
    let outcome = "failed";
    let details;
    try {
      const value = await operation();
      outcome = "completed";
      return value;
    } catch (error) {
      details = {
        errorCode: safeCode(error?.code || error?.message),
        ...(Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
          ? { httpStatus: error.status } : {}),
      };
      throw error;
    } finally {
      record(step, outcome, Math.round(performance.now() - start), details);
    }
  }
}

import http from "node:http";
import https from "node:https";

const MAX_RESPONSE = 256 * 1024;
// Fixed public diagnostics only: response messages/details may contain secrets.
export const BOX_SESSION_ERROR_CODES = Object.freeze([
  "BOX_PLATFORM_AUTH_FAILED", "BOX_PLATFORM_SESSION_EXPIRED", "BOX_PLATFORM_BUSY",
  "BOX_PLATFORM_CAPACITY", "BOX_PLATFORM_STATE_INVALID", "BOX_PLATFORM_CONFIG_INVALID",
  "BOX_PLATFORM_UPSTREAM_INVALID", "BOX_PLATFORM_UPSTREAM_UNAVAILABLE",
  "BOX_PLATFORM_RESPONSE_INVALID", "BOX_PLATFORM_TIMEOUT", "PLATFORM_RESPONSE_TOO_LARGE",
  "BOX_UPSTREAM_UNAVAILABLE", "BOX_UPSTREAM_NOT_READY", "BOX_UPSTREAM_CREDENTIALS_INVALID",
  "BOX_UPSTREAM_AUTH_FAILED", "BOX_UPSTREAM_ADMIN_REQUIRED", "BOX_UPSTREAM_CAPTCHA_REQUIRED",
  "BOX_UPSTREAM_PROTOCOL_INVALID", "BOX_UPSTREAM_RESPONSE_TOO_LARGE",
  "BOX_UPSTREAM_OIDC_CONFLICT", "BOX_UPSTREAM_OIDC_INVALID", "BOX_UPSTREAM_OIDC_FAILED",
  "BOX_UPSTREAM_IDENTITY_INVALID", "BOX_UPSTREAM_IDENTITY_MISMATCH",
  "BOX_UPSTREAM_ROLE_SYNC_FAILED", "BOX_ZHIJUN_INITIALIZATION_FAILED", "BOX_ZHIJUN_EXPERT_CONFLICT",
]);
const boxSessionErrorCodes = new Set(BOX_SESSION_ERROR_CODES);
const platformError = (code, status) => Object.assign(new Error(code), {
  code, ...(status === undefined ? {} : { status }),
});

/** Main-process-only box session. Neither grants nor JWTs enter renderer state. */
export async function createPlatformSession({
  url,
  agent,
  account,
  device,
  networkSessionId,
  onExpired = () => {},
  signal,
  measure = (_step, operation) => operation(),
}) {
  const target = new URL(url);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error("INVALID_TARGET_URL");
  const identity = await account.getIdentity();
  if (
    !identity?.accountId ||
    !identity?.clientId ||
    !device?.deviceId ||
    !networkSessionId
  )
    throw new Error("PLATFORM_IDENTITY_REQUIRED");
  const controller = new AbortController();
  const requests = new Set();
  const expiryListeners = new Set();
  let token = "";
  let expiresAt = 0;
  let closed = false;
  let renewTimer;
  let expiryTimer;
  const abort = () => close();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) close();

  function close() {
    if (closed) return;
    closed = true;
    token = "";
    clearTimeout(renewTimer);
    clearTimeout(expiryTimer);
    controller.abort();
    signal?.removeEventListener("abort", abort);
    for (const request of requests) request.destroy();
  }

  function expire(reason = "expired") {
    if (closed) return;
    close();
    try {
      onExpired(reason);
    } finally {
      for (const listener of expiryListeners) listener(reason);
      expiryListeners.clear();
    }
  }

  function post(path, body) {
    controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const request = (target.protocol === "https:" ? https : http).request(
        target,
        {
          path,
          method: "POST",
          agent: agent ?? false,
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE)
              request.destroy(platformError("PLATFORM_RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              let code = "BOX_PLATFORM_AUTH_FAILED";
              try {
                const body = JSON.parse(Buffer.concat(chunks).toString());
                if (boxSessionErrorCodes.has(body?.code)) code = body.code;
              } catch { /* An invalid error response must not hide the HTTP failure. */ }
              reject(platformError(code, response.statusCode));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              reject(platformError("BOX_PLATFORM_RESPONSE_INVALID"));
            }
          });
        },
      );
      requests.add(request);
      const timeout = setTimeout(
        () => request.destroy(platformError("BOX_PLATFORM_TIMEOUT")),
        15_000,
      );
      timeout.unref();
      request.once("close", () => {
        clearTimeout(timeout);
        requests.delete(request);
      });
      request.on("error", reject);
      request.end(data);
    });
  }

  async function exchange() {
    const challenge = await measure("box.challenge", () =>
      post("/api/auth/platform/challenge", {
        accountId: identity.accountId,
        clientId: identity.clientId,
        networkSessionId,
      }),
    );
    if (
      typeof challenge.challengeReceipt !== "string" ||
      !challenge.challengeReceipt
    )
      throw platformError("BOX_PLATFORM_RESPONSE_INVALID");
    const authorization = await account.request({
      path: `/app-api/devices/${encodeURIComponent(
        device.deviceId,
      )}/wanx/sso-grants`,
      method: "POST",
      body: { challengeReceipt: challenge.challengeReceipt, networkSessionId },
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (typeof authorization?.grant !== "string" || !authorization.grant)
      throw new Error("PLATFORM_GRANT_INVALID");
    const result = await measure("box.exchange", () =>
      post("/api/auth/platform/exchange", {
        grant: authorization.grant,
      }),
    );
    controller.signal.throwIfAborted();
    if (
      typeof result.access_token !== "string" ||
      !result.access_token ||
      !/^Bearer$/i.test(result.token_type) ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0
    )
      throw platformError("BOX_PLATFORM_RESPONSE_INVALID");
    token = result.access_token;
    expiresAt = Date.now() + result.expires_in * 1000;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(expire, result.expires_in * 1000);
    expiryTimer.unref();
    schedule(Math.min(60_000, result.expires_in * 500));
  }

  function schedule(delay) {
    clearTimeout(renewTimer);
    renewTimer = setTimeout(async () => {
      try {
        await exchange();
      } catch (error) {
        if (closed) return;
        if ([401, 403].includes(error.status) || Date.now() >= expiresAt)
          expire([401, 403].includes(error.status) ? "denied" : "expired");
        else
          schedule(Math.min(5000, Math.max(1, (expiresAt - Date.now()) / 2)));
      }
    }, delay);
    renewTimer.unref();
  }

  try {
    await exchange();
  } catch (error) {
    close();
    throw error;
  }
  return {
    getToken() {
      if (!closed && Date.now() >= expiresAt) expire();
      return token;
    },
    close,
    expire,
    onExpired(listener) {
      expiryListeners.add(listener);
      return () => expiryListeners.delete(listener);
    },
  };
}

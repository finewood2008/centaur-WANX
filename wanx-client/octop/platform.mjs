import http from "node:http";
import https from "node:https";

const MAX_RESPONSE = 256 * 1024;

/** Main-process-only box session. Neither grants nor JWTs enter renderer state. */
export async function createPlatformSession({
  url,
  agent,
  account,
  device,
  networkSessionId,
  onExpired = () => {},
  signal,
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

  function expire() {
    if (closed) return;
    close();
    try {
      onExpired();
    } finally {
      for (const listener of expiryListeners) listener();
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
              request.destroy(new Error("PLATFORM_RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              const error = new Error("BOX_PLATFORM_AUTH_FAILED");
              error.status = response.statusCode;
              reject(error);
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch {
              reject(new Error("BOX_PLATFORM_RESPONSE_INVALID"));
            }
          });
        },
      );
      requests.add(request);
      const timeout = setTimeout(
        () => request.destroy(new Error("BOX_PLATFORM_TIMEOUT")),
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
    const challenge = await post("/api/auth/platform/challenge", {
      accountId: identity.accountId,
      clientId: identity.clientId,
      networkSessionId,
    });
    if (
      typeof challenge.challengeReceipt !== "string" ||
      !challenge.challengeReceipt
    )
      throw new Error("BOX_PLATFORM_RESPONSE_INVALID");
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
    const result = await post("/api/auth/platform/exchange", {
      grant: authorization.grant,
    });
    controller.signal.throwIfAborted();
    if (
      typeof result.access_token !== "string" ||
      !result.access_token ||
      !/^Bearer$/i.test(result.token_type) ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0
    )
      throw new Error("BOX_PLATFORM_RESPONSE_INVALID");
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
          expire();
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

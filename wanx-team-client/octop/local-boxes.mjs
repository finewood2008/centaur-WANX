import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { probeEndpoint } from "./probe.mjs";

const fail = (code) => Object.assign(new Error(code), { code });
const validID = (id) => typeof id === "string" && /^local-[a-f0-9]{24}$/.test(id);

/** Registrations belong to this OS user. Credentials never leave the main process. */
export function createLocalBoxes({ directory = path.join(os.homedir(), ".wanx", "local-boxes"), probe = probeEndpoint } = {}) {
  async function read(deviceId) {
    if (!validID(deviceId)) throw fail("LOCAL_BOX_INVALID_REGISTRATION");
    const file = path.join(directory, `${deviceId}.json`);
    const info = await lstat(file);
    if (!info.isFile() || info.size > 16384 ||
        (process.platform !== "win32" && (info.uid !== process.getuid() || (info.mode & 0o077))))
      throw fail("LOCAL_BOX_INVALID_REGISTRATION");
    const value = JSON.parse(await readFile(file, "utf8"));
    const url = new URL(value.serviceUrl);
    if (value.version !== 1 || value.deviceId !== deviceId ||
        !["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
        typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 128 ||
        typeof value.username !== "string" || !value.username || typeof value.password !== "string" || !value.password)
      throw fail("LOCAL_BOX_INVALID_REGISTRATION");
    return { ...value, serviceUrl: url.origin };
  }
  return {
    async list() {
      let names;
      try { names = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
      const rows = await Promise.all(names.filter(name => /^local-[a-f0-9]{24}\.json$/.test(name)).map(async name => {
        let value;
        try { value = await read(name.slice(0, -5)); } catch { return null; }
        let ready = false;
        try { const health = await probe(value.serviceUrl); ready = health.db === true && health.users_loaded > 0; } catch { /* stopped or uninitialized service */ }
        return { deviceId: value.deviceId, displayName: value.displayName, serviceUrl: value.serviceUrl,
          local: true, accessState: ready ? "ready" : "offline", networkReady: ready, canOpen: ready };
      }));
      return rows.filter(Boolean);
    },
    async createSession(deviceId, { url, signal, onExpired }) {
      const registration = await read(deviceId);
      if (registration.serviceUrl !== new URL(url).origin) throw fail("LOCAL_BOX_INVALID_REGISTRATION");
      return createLocalSession({ read: () => read(deviceId), url: registration.serviceUrl, signal, onExpired, probe });
    },
  };
}

async function createLocalSession({ read, url, signal, onExpired = () => {}, probe }) {
  const controller = new AbortController(), listeners = new Set();
  let closed = false, token = "", expiresAt = 0, renewTimer, healthTimer;
  const close = () => {
    closed = true; token = ""; controller.abort();
    clearTimeout(renewTimer); clearTimeout(healthTimer);
    signal?.removeEventListener("abort", close);
  };
  const expire = () => {
    if (closed) return;
    close();
    onExpired();
    for (const listener of listeners) listener();
    listeners.clear();
  };
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  async function login() {
    const registration = await read();
    if (registration.serviceUrl !== url) throw fail("LOCAL_BOX_REGISTRATION_CHANGED");
    controller.signal.throwIfAborted();
    const body = JSON.stringify({ username: registration.username, password: registration.password });
    const result = await new Promise((resolve, reject) => {
      const request = (new URL(url).protocol === "https:" ? https : http).request(new URL("/api/auth/login", url), {
        method: "POST", agent: false, signal: controller.signal,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      }, response => {
        const chunks = []; let size = 0;
        response.on("data", chunk => { size += chunk.length; if (size > 262144) request.destroy(fail("LOCAL_BOX_AUTH_INVALID")); else chunks.push(chunk); });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode !== 200) return reject(fail("LOCAL_BOX_AUTH_FAILED"));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(fail("LOCAL_BOX_AUTH_INVALID")); }
        });
      });
      const timeout = setTimeout(() => request.destroy(fail("LOCAL_BOX_AUTH_TIMEOUT")), 10000);
      timeout.unref(); request.once("close", () => clearTimeout(timeout));
      request.on("error", reject); request.end(body);
    });
    controller.signal.throwIfAborted();
    if (typeof result.access_token !== "string" || !result.access_token || result.token_type !== "Bearer" ||
        !Number.isFinite(result.expires_in) || result.expires_in <= 0) throw fail("LOCAL_BOX_AUTH_INVALID");
    token = result.access_token; expiresAt = Date.now() + result.expires_in * 1000;
    renewTimer = setTimeout(() => { void login().catch(expire); }, Math.min(1800000, result.expires_in * 500));
    renewTimer.unref();
  }
  async function checkHealth() {
    try {
      if ((await read()).serviceUrl !== url) throw fail("LOCAL_BOX_REGISTRATION_CHANGED");
      if (!(await probe(url, { signal: controller.signal })).db) throw fail("LOCAL_BOX_OFFLINE");
      if (closed) return;
      healthTimer = setTimeout(checkHealth, 30000); healthTimer.unref();
    } catch { expire(); }
  }
  try { await login(); } catch (error) { close(); throw error; }
  healthTimer = setTimeout(checkHealth, 30000); healthTimer.unref();
  return {
    applicationExchangePath: "/api/auth/application/exchange",
    getToken() { if (!closed && Date.now() >= expiresAt) expire(); return token; },
    close, expire,
    onExpired(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

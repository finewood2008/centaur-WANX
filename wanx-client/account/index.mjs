import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";

export const DEFAULT_CONSUMER_URL = "https://boss.nexusaos.qitus.cn/prod-api";
const failure = (code, status) =>
  Object.assign(new Error(code), { code, status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const encode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

export function consumerSignature({
  identity,
  accountId,
  method,
  path,
  body = "",
  now = Date.now(),
  nonce = randomUUID(),
}) {
  const url = new URL(path, "https://consumer.invalid");
  const versioned = url.pathname.startsWith("/app-api/v1/");
  const timestamp = String(Math.floor(now / 1000));
  const bodyHash = hash(body);
  const query = [...url.searchParams]
    .sort(
      ([a, av], [b, bv]) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)) ||
        Buffer.compare(Buffer.from(av), Buffer.from(bv)),
    )
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
  const version = versioned
    ? "NEXUSAOS-CONSUMER-APP-V1"
    : "NEXUSAOS-CONSUMER-V1";
  const canonical = [
    version,
    accountId,
    identity.clientId,
    method.toUpperCase(),
    decodeURI(url.pathname),
    ...(versioned ? [query] : []),
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  return {
    "X-Nexus-Client-Id": identity.clientId,
    "X-Nexus-Timestamp": timestamp,
    "X-Nexus-Nonce": nonce,
    "X-Nexus-Body-SHA256": bodyHash,
    "X-Nexus-Signature": sign(
      "sha256",
      Buffer.from(canonical),
      identity.privateKey,
    ).toString("base64"),
    ...(versioned ? { "X-Nexus-Signature-Version": version } : {}),
  };
}

function newIdentity() {
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    clientId: randomUUID(),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

/** Consumer protocol without the retired connectivity SDK. Keep this in main. */
export function createAccount({
  baseURL = DEFAULT_CONSUMER_URL,
  store,
  fetch: fetcher = globalThis.fetch,
  emit = () => {},
  platform = process.platform,
  deviceModel = "万象连接",
  now = Date.now,
} = {}) {
  let base;
  try {
    base = new URL(baseURL);
  } catch {
    throw failure("ACCOUNT_INVALID_URL");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw failure("ACCOUNT_INVALID_URL");
  const prefix = base.pathname.replace(/\/$/, "");
  let record = null,
    epoch = 0,
    closed = false,
    refreshPromise = null;
  let vault = { version: 2, baseURL: base.href, accounts: {}, active: null };
  let loaded = false;
  let state = {
    phase: "signed_out",
    accountId: null,
    clientId: null,
    devices: [],
    reason: null,
  };
  const pending = new Set();
  const listeners = new Set();
  let writes = Promise.resolve();
  const snapshot = () => structuredClone(state);
  const publish = (patch) => {
    state = { ...state, ...patch };
    emit(snapshot());
    for (const listener of listeners) listener(snapshot());
    return snapshot();
  };
  const assert = (generation) => {
    if (closed || generation !== epoch) throw failure("ACCOUNT_CANCELLED");
  };
  const persist = (value) => {
    const generation = epoch;
    const next = writes.then(async () => {
      if (generation !== epoch) return;
      const candidate = {
        ...vault,
        accounts: { ...vault.accounts },
        active: value?.session
          ? { phone: value.phone, session: value.session }
          : null,
      };
      if (value) candidate.accounts[value.phone] = { identity: value.identity };
      await store.save(candidate);
      vault = candidate;
    });
    writes = next.catch(() => {});
    return next;
  };
  async function loadVault(generation) {
    if (loaded) return;
    const saved = await store.load();
    assert(generation);
    if (saved) {
      if (
        saved.version !== 2 ||
        saved.baseURL !== base.href ||
        !saved.accounts ||
        typeof saved.accounts !== "object"
      )
        throw failure("ACCOUNT_INVALID_STORED_SESSION");
      vault = saved;
    }
    loaded = true;
  }
  const cancel = () => {
    epoch++;
    for (const controller of pending) controller.abort();
    pending.clear();
    refreshPromise = null;
  };
  function route(path) {
    // Only these Consumer paths are accepted; no host, fragments or traversal.
    if (
      typeof path !== "string" ||
      !/^\/app-api\/[A-Za-z0-9_/?=&.%:-]+$/.test(path) ||
      /%2f|%5c|%2e|\/\.\.?($|\/)/i.test(path)
    )
      throw failure("ACCOUNT_INVALID_PATH");
    const parsed = new URL(path, base.origin);
    if (
      parsed.origin !== base.origin ||
      !parsed.pathname.startsWith("/app-api/")
    )
      throw failure("ACCOUNT_INVALID_PATH");
    return `${base.origin}${prefix}${path}`;
  }
  async function wire(
    {
      method = "GET",
      path,
      body,
      authenticated = true,
      signal,
      responseMetadata = false,
      idempotencyKey,
    },
    generation,
    auth = record,
  ) {
    const url = route(path);
    assert(generation);
    const text = body === undefined ? "" : JSON.stringify(body);
    const controller = new AbortController();

    const signals = [
      controller.signal,
      AbortSignal.timeout(20000),
      ...(signal ? [signal] : []),
    ];
    const headers = {
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    };
    if (idempotencyKey !== undefined) {
      if (
        typeof idempotencyKey !== "string" ||
        !/^[\w-]{1,128}$/.test(idempotencyKey)
      )
        throw failure("ACCOUNT_INVALID_INPUT");
      headers["Idempotency-Key"] = idempotencyKey;
    }
    if (authenticated) {
      if (!auth?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
      Object.assign(
        headers,
        consumerSignature({
          identity: auth.identity,
          accountId: auth.session.accountId,
          method,
          path,
          body: text,
          now: now(),
        }),
        { Authorization: `Bearer ${auth.session.accessToken}` },
      );
    }
    pending.add(controller);
    try {
      const response = await fetcher(url, {
        method,
        headers,
        ...(body !== undefined ? { body: text } : {}),
        redirect: "error",
        signal: AbortSignal.any(signals),
      });
      assert(generation);
      if (
        response.redirected ||
        (response.url && new URL(response.url).origin !== base.origin)
      )
        throw failure("ACCOUNT_REDIRECT_REJECTED");
      const reader = response.body?.getReader();
      let responseText = "";
      if (reader) {
        let size = 0;
        const chunks = [];
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2 * 1024 * 1024)
              throw failure("ACCOUNT_INVALID_RESPONSE");
            chunks.push(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        responseText = Buffer.concat(chunks).toString("utf8");
      }
      let payload;
      const missingNetworkRoute =
        response.status === 404 && path.startsWith("/app-api/network/");
      try {
        payload = JSON.parse(responseText);
      } catch {
        if (missingNetworkRoute)
          throw failure("NETWORK_SERVICE_NOT_DEPLOYED", 404);
        throw failure("ACCOUNT_INVALID_RESPONSE");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        if (missingNetworkRoute)
          throw failure("NETWORK_SERVICE_NOT_DEPLOYED", 404);
        throw failure("ACCOUNT_INVALID_RESPONSE");
      }
      assert(generation);
      let metadata;
      if (responseMetadata) {
        if (response.status === 401 || payload.code === 401)
          throw failure("ACCOUNT_SESSION_EXPIRED", 401);
        const requestId =
          response.headers.get("x-request-id") ||
          response.headers.get("request-id");
        if (
          typeof requestId !== "string" ||
          !requestId ||
          requestId !== payload.requestId ||
          typeof payload.serverTime !== "string" ||
          !Number.isFinite(Date.parse(payload.serverTime))
        )
          throw failure("ACCOUNT_INVALID_RESPONSE");
        metadata = {
          requestId,
          serverTime: payload.serverTime,
          receivedMonotonicMs: Math.floor(performance.now()),
        };
      }
      if (
        !response.ok ||
        payload.success === false ||
        (typeof payload.code === "number" && payload.code !== 200 &&
          !(responseMetadata && payload.code === 0 && payload.success === true))
      ) {
        const status =
          response.status === 200 && typeof payload.code === "number"
            ? payload.code
            : response.status;
        // Never expose arbitrary server text, request bodies or token values.
        const remoteCode =
          payload.errorCode || payload.data?.errorCode || payload.code;
        const explicitNetworkCode =
          typeof remoteCode === "string" &&
          /^NETWORK_[A-Z0-9_]{1,64}$/.test(remoteCode);
        const code =
          missingNetworkRoute && !explicitNetworkCode
            ? "NETWORK_SERVICE_NOT_DEPLOYED"
            : typeof remoteCode === "string" &&
              /^(NETWORK|SSO|OMNIA)_[A-Z0-9_]{1,64}$/.test(remoteCode)
            ? remoteCode
            : status === 401
            ? "ACCOUNT_SESSION_EXPIRED"
            : status === 403
            ? "ACCOUNT_ACCESS_DENIED"
            : "ACCOUNT_REQUEST_FAILED";
        const pairingCode =
          responseMetadata &&
          typeof remoteCode === "string" &&
          /^[A-Z][A-Z0-9_]{1,79}$/.test(remoteCode)
            ? remoteCode
            : code;
        throw Object.assign(failure(pairingCode, status), metadata);
      }
      if (responseMetadata) {
        if (payload.success !== true || payload.errorCode != null)
          throw failure("ACCOUNT_INVALID_RESPONSE");
        return { data: payload.data, ...metadata };
      }
      return Object.hasOwn(payload, "data") ? payload.data : payload;
    } catch (error) {
      assert(generation);
      if (error.status || error.code?.startsWith("ACCOUNT_")) throw error;
      throw failure(
        signal?.aborted ? "ACCOUNT_CANCELLED" : "ACCOUNT_NETWORK_ERROR",
      );
    } finally {
      pending.delete(controller);
    }
  }
  function sessionFrom(data, identity) {
    if (
      !data ||
      typeof data.accessToken !== "string" ||
      typeof data.refreshToken !== "string" ||
      typeof data.accountId !== "string" ||
      data.clientId !== identity.clientId ||
      !Number.isFinite(data.expiresIn) ||
      data.expiresIn <= 0
    )
      throw failure("ACCOUNT_INVALID_RESPONSE");
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      accountId: data.accountId,
      clientId: data.clientId,
      expiresAt: now() + data.expiresIn * 1000,
    };
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
    const generation = epoch,
      previous = record;
    refreshPromise = (async () => {
      const data = await wire(
        {
          method: "POST",
          path: "/app-api/auth/refresh",
          body: { refreshToken: previous.session.refreshToken },
          authenticated: false,
        },
        generation,
      );
      assert(generation);
      const session = sessionFrom(data, previous.identity);
      if (session.accountId !== previous.session.accountId)
        throw failure("ACCOUNT_INVALID_RESPONSE");
      const next = { ...previous, session };
      await persist(next);
      assert(generation);
      record = next;
      return snapshot();
    })();
    try {
      return await refreshPromise;
    } catch (error) {
      if (
        generation === epoch &&
        (error.status === 401 || error.status === 403)
      ) {
        record = null;
        publish({
          phase: "signed_out",
          accountId: null,
          clientId: null,
          devices: [],
          reason: "ACCOUNT_SESSION_EXPIRED",
        });
        await persist(null);
      }
      throw error;
    } finally {
      if (generation === epoch) refreshPromise = null;
    }
  }
  async function request(input) {
    const generation = epoch;
    if (!record?.session) throw failure("ACCOUNT_LOGIN_REQUIRED");
    if (record.session.expiresAt <= now() + 30000) await refresh();
    assert(generation);
    try {
      return await wire({ ...input, authenticated: true }, generation);
    } catch (error) {
      if (error.status !== 401) throw error;
      await refresh();
      assert(generation);
      return wire({ ...input, authenticated: true }, generation);
    }
  }
  async function login(input, mode) {
    if (
      !/^1\d{10}$/.test(input?.phone || "") ||
      (mode === "sms"
        ? !/^\d{6}$/.test(input.code || "")
        : typeof input.password !== "string" ||
          !input.password ||
          Buffer.byteLength(input.password) > 72)
    )
      throw failure("ACCOUNT_INVALID_INPUT");
    if (closed) throw failure("ACCOUNT_CANCELLED");
    if (record?.session) throw failure("ACCOUNT_ALREADY_SIGNED_IN");
    cancel();
    const generation = epoch;
    publish({ phase: "authenticating", reason: null });
    try {
      await loadVault(generation);
      const identity = vault.accounts[input.phone]?.identity || newIdentity();
      if (!vault.accounts[input.phone]) {
        await persist({ phone: input.phone, identity, session: null });
        assert(generation);
      }
      const data = await wire(
        {
          method: "POST",
          path: `/app-api/auth/${mode}/login`,
          authenticated: false,
          body: {
            phone: input.phone,
            ...(mode === "sms"
              ? { code: input.code }
              : { password: input.password }),
            clientId: identity.clientId,
            clientPublicKey: identity.publicKey,
            platform:
              { darwin: "macos", win32: "windows" }[platform] ||
              (["linux", "macos", "windows"].includes(platform)
                ? platform
                : "unknown"),
            deviceModel,
            displayName: "万象连接",
          },
        },
        generation,
      );
      const next = {
        phone: input.phone,
        identity,
        session: sessionFrom(data, identity),
      };
      await persist(next);
      assert(generation);
      record = next;
      return publish({
        phase: "authenticated",
        accountId: next.session.accountId,
        clientId: identity.clientId,
        devices: [],
        reason: null,
      });
    } catch (error) {
      if (generation === epoch)
        publish({
          phase: "signed_out",
          accountId: null,
          clientId: null,
          devices: [],
          reason: error.code || error.message,
        });
      throw error;
    }
  }
  return {
    snapshot,
    request,
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getIdentity: () =>
      record?.session
        ? {
            accountId: record.session.accountId,
            clientId: record.identity.clientId,
          }
        : null,
    loginPassword: (input) => login(input, "password"),
    loginSMS: (input) => login(input, "sms"),
    async sendSMS(phone) {
      if (!/^1\d{10}$/.test(phone || ""))
        throw failure("ACCOUNT_INVALID_INPUT");
      const result = await wire(
        {
          method: "POST",
          path: "/app-api/auth/sms/send",
          body: { phone, scene: "consumer_login" },
          authenticated: false,
        },
        epoch,
      );
      return { expiresIn: Number(result?.expiresIn) || 300 };
    },
    async listDevices() {
      const generation = epoch;
      const data = await request({ path: "/app-api/devices" });
      assert(generation);
      if (!Array.isArray(data)) throw failure("ACCOUNT_INVALID_RESPONSE");
      const devices = data
        .filter((item) => typeof item.deviceId === "string")
        .map((item) => ({
          deviceId: item.deviceId,
          deviceName:
            typeof item.deviceName === "string"
              ? item.deviceName
              : item.deviceId,
          online: item.online === true,
          ownershipEpoch: item.ownershipEpoch,
          role: item.role,
          status: item.status,
        }));
      publish({ devices });
      return structuredClone(devices);
    },
    async restore() {
      const generation = epoch;
      await loadVault(generation);
      const active = vault.active;
      if (!active) return snapshot();
      const identity = vault.accounts[active.phone]?.identity;
      if (
        !identity?.privateKey ||
        !active.session?.refreshToken ||
        identity.clientId !== active.session.clientId
      )
        throw failure("ACCOUNT_INVALID_STORED_SESSION");
      record = { phone: active.phone, identity, session: active.session };
      try {
        await refresh();
        assert(generation);
        return publish({
          phase: "authenticated",
          accountId: record.session.accountId,
          clientId: record.identity.clientId,
          reason: null,
        });
      } catch (error) {
        if (generation === epoch) {
          record = null;
          publish({ phase: "signed_out", reason: error.code });
          if (error.status === 401 || error.status === 403) await persist(null);
        }
        throw error;
      }
    },
    async logout() {
      const previous = record;
      cancel();
      const generation = epoch;
      record = null;
      publish({
        phase: "signed_out",
        accountId: null,
        clientId: null,
        devices: [],
        reason: null,
      });
      try {
        if (previous)
          await wire(
            {
              method: "POST",
              path: "/app-api/auth/logout",
              body: { refreshToken: previous.session.refreshToken },
            },
            generation,
            previous,
          );
      } finally {
        if (generation === epoch) await persist(null);
      }
      return snapshot();
    },
    async close() {
      closed = true;
      cancel();
      record = null;
      await writes;
    },
  };
}

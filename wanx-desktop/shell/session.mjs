import { randomUUID } from "node:crypto";
import {
  createCentaurAIWanxHost,
  createCentaurAIWanxClient,
  createHTTPTransport,
  operationRegistry,
} from "centaurai-wanx";

// This is the standard WANX computer client, using the SDK's approved identity.
// Product applications retain their own separately registered network identities.
export const policy = Object.freeze({
  applicationId: "omnia-desktop",
  operations: operationRegistry.map((op) => op.operationId),
  sockets: [
    "chat",
    "notifications",
    "terminal",
    "browser-stream",
    "desktop-stream",
    "mobile-stream",
    "mobile-adb-shell",
  ],
});

export function normalizeDirectURL(raw) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("INVALID_BOX_URL");
  return url.origin;
}

export function createDesktopSession({
  deployment,
  secureStore,
  draftStore,
  hostFactory = createCentaurAIWanxHost,
  emit = () => {},
}) {
  let host,
    hostPromise,
    current,
    epoch = 0,
    connectionQueue = Promise.resolve();
  let state = {
    phase: "disconnected",
    identity: null,
    devices: [],
    box: null,
    user: null,
    sessionId: null,
    reason: null,
    platformConfigured: Boolean(
      deployment?.trustedGatewayHosts?.length &&
        deployment?.trustedICEHosts?.length,
    ),
  };
  const snapshot = () => structuredClone(state);
  const publish = (patch) => {
    state = { ...state, ...patch };
    emit(snapshot());
    return snapshot();
  };
  const requireCurrent = (id) => {
    if (!current || current.id !== id || state.phase !== "ready")
      throw new Error("SESSION_CLOSED");
    return current;
  };
  const assertCurrent = (context) => {
    if (current !== context || epoch !== context.epoch)
      throw new Error("SESSION_CLOSED");
  };
  async function getHost() {
    if (!state.platformConfigured)
      throw new Error("DEPLOYMENT_CONFIG_REQUIRED");
    if (!hostPromise)
      hostPromise = hostFactory({
        consumerBaseURL:
          deployment?.consumerBaseURL ||
          "https://boss.nexusaos.qitus.cn/prod-api",
        trustedGatewayHosts: deployment?.trustedGatewayHosts || [],
        trustedICEHosts: deployment?.trustedICEHosts || [],
        secureStore,
        policy,
      })
        .then((value) => {
          host = value;
          host.connection.onStatus((status) => {
            if (
              current?.mode === "p2p" &&
              ["failed", "disconnected", "closed"].includes(status.phase)
            )
              void disconnect(status.reason || "NATIVE_SESSION_ENDED");
          });
          return value;
        })
        .catch((error) => {
          hostPromise = undefined;
          throw error;
        });
    return hostPromise;
  }
  async function disconnect(reason = null) {
    epoch++;
    const old = current;
    current = undefined;
    publish({
      phase: "disconnected",
      box: null,
      user: null,
      sessionId: null,
      reason,
    });
    await old?.client.close();
  }
  async function prepare() {
    await disconnect();
    const generation = epoch;
    publish({ phase: "connecting", reason: null });
    return generation;
  }
  async function finish(client, box, generation, mode) {
    try {
      const reply = await client.modules.auth.me();
      if (reply.status !== 200) throw new Error("WANX_AUTH_FAILED");
      if (epoch !== generation) throw new Error("SESSION_CLOSED");
      current = { id: randomUUID(), epoch: generation, client, mode };
      publish({
        phase: "ready",
        box,
        user: reply.body,
        sessionId: current.id,
        reason: null,
      });
      return snapshot();
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  async function connectDevice({ deviceId, linkExisting }) {
    const generation = await prepare();
    try {
      if (!state.platformConfigured)
        throw new Error("DEPLOYMENT_CONFIG_REQUIRED");
      const sdk = await getHost();
      // Refresh the authenticated directory before accepting the selected UUID.
      const devices = await sdk.devices.list();
      const device = devices.find((item) => item.deviceId === deviceId);
      if (!device || !device.online) throw new Error("DEVICE_NOT_AVAILABLE");
      if (generation !== epoch) throw new Error("SESSION_CLOSED");
      const client = await sdk.connection.connect({
        deviceId,
        ...(linkExisting ? { linkExisting } : {}),
      });
      return await finish(
        client,
        {
          id: device.deviceId,
          name: device.deviceName || device.deviceId,
          mode: "p2p",
        },
        generation,
        "p2p",
      );
    } catch (error) {
      if (generation === epoch)
        publish({ phase: "disconnected", reason: error.code || error.message });
      throw error;
    }
  }
  async function connectDirect({ baseURL, username, password, captchaToken }) {
    const base = normalizeDirectURL(baseURL);
    const generation = await prepare();
    let token = null;
    const transport = createHTTPTransport({
      baseURL: base,
      token: async () => token,
    });
    const client = createCentaurAIWanxClient({ transport, policy });
    try {
      const reply = await client.modules.auth.login({
        body: {
          username,
          password,
          ...(captchaToken ? { captcha_token: captchaToken } : {}),
          application_id: "wanx",
        },
      });
      if (reply.status !== 200 || typeof reply.body?.access_token !== "string")
        throw new Error("WANX_AUTH_FAILED");
      token = reply.body.access_token;
      const result = await finish(
        client,
        { id: base, name: base, mode: "https" },
        generation,
        "https",
      );
      current.renew = (headers) => {
        if (headers["x-octop-access-token"])
          token = headers["x-octop-access-token"];
      };
      return result;
    } catch (error) {
      await client.close();
      if (generation === epoch)
        publish({ phase: "disconnected", reason: error.code || error.message });
      throw error;
    }
  }
  return {
    snapshot,
    disconnect,
    requireCurrent,
    assertCurrent,
    async action(action, input = {}) {
      if (action === "state") return snapshot();
      if (action === "account.current") {
        const generation = epoch;
        const sdk = await getHost();
        const identity = await sdk.auth.current();
        if (generation !== epoch) throw new Error("SESSION_CLOSED");
        publish({ identity });
        return snapshot();
      }
      if (action === "account.password" || action === "account.sms") {
        await disconnect();
        const generation = epoch;
        const sdk = await getHost();
        const identity = await (action === "account.password"
          ? sdk.auth.loginPassword(input)
          : sdk.auth.loginSMS(input));
        if (generation !== epoch) throw new Error("SESSION_CLOSED");
        const devices = await sdk.devices.list();
        if (generation !== epoch) throw new Error("SESSION_CLOSED");
        publish({ identity, devices });
        return snapshot();
      }
      if (action === "account.sendSMS") {
        const sdk = await getHost();
        return sdk.auth.sendSMS(input.phone);
      }
      if (action === "devices.list") {
        const generation = epoch;
        const sdk = await getHost();
        const devices = await sdk.devices.list();
        if (generation !== epoch) throw new Error("SESSION_CLOSED");
        publish({ devices });
        return snapshot();
      }
      if (action === "connection.connect" || action === "connection.direct") {
        const stopping = disconnect();
        const requested = epoch;
        const next = connectionQueue.then(async () => {
          await stopping;
          if (requested !== epoch) throw new Error("SESSION_CLOSED");
          return action === "connection.connect"
            ? connectDevice(input)
            : connectDirect(input);
        });
        connectionQueue = next.catch(() => {});
        return next;
      }
      if (action === "connection.disconnect") {
        await disconnect();
        return snapshot();
      }
      if (action === "draft.get" || action === "draft.put") {
        const context = requireCurrent(input.sessionId);
        const scope = {
          boxId: state.box.id,
          userId: state.user.id,
          applicationId: input.applicationId,
        };
        // The selected box remains authoritative for management permissions.
        const permission = await context.client.applications.list();
        assertCurrent(context);
        if (permission.status !== 200)
          throw new Error("DRAFT_PERMISSION_DENIED");
        if (!draftStore) throw new Error("DRAFT_STORE_UNAVAILABLE");
        const result = await (action === "draft.put"
          ? draftStore.put(scope, input.value)
          : draftStore.get(scope));
        assertCurrent(context);
        return result;
      }
      if (action === "account.logout") {
        await disconnect();
        if (host) await host.auth.logout();
        publish({ identity: null, devices: [] });
        return snapshot();
      }
      throw new Error("UNKNOWN_CLIENT_ACTION");
    },
    async stream(sessionId, operationId, input, options) {
      const context = requireCurrent(sessionId);
      let response;
      try {
        response = await context.client.native.stream(
          operationId,
          input,
          options,
        );
      } catch (error) {
        if (
          current === context &&
          !options?.signal?.aborted &&
          (error instanceof TypeError ||
            /NETWORK|SESSION|NATIVE_HOST|CONNECT_FAILED/.test(error.code || ""))
        )
          await disconnect("CONNECTION_LOST");
        throw error;
      }
      try {
        assertCurrent(context);
      } catch (error) {
        await response.close();
        throw error;
      }
      context.renew?.(response.headers);
      if (response.status === 401) {
        await response.close();
        await disconnect("WANX_AUTH_REVOKED");
        throw new Error("SESSION_CLOSED");
      }
      return { context, response };
    },
    async socket(sessionId, input, options) {
      const context = requireCurrent(sessionId);
      const socket = await context.client.openSocket(input, options);
      try {
        assertCurrent(context);
      } catch (error) {
        await socket.close();
        throw error;
      }
      return { context, socket };
    },
    async refresh() {
      const context = current;
      if (!context) return;
      try {
        const reply = await context.client.modules.auth.me(
          {},
          { signal: AbortSignal.timeout(5000) },
        );
        assertCurrent(context);
        if (reply.status !== 200) throw new Error("WANX_AUTH_REVOKED");
        context.renew?.(reply.headers);
        publish({ user: reply.body });
      } catch {
        if (current === context)
          await disconnect("CONNECTION_OR_PERMISSION_LOST");
      }
    },
    async close() {
      await disconnect();
      await hostPromise?.catch(() => {});
      await host?.dispose();
    },
  };
}

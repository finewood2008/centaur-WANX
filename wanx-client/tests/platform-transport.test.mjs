import test from "node:test";
import vm from "node:vm";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { createPlatformSession } from "../octop/platform.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { createTunnelAgent } from "../network/tunnel.mjs";

async function fixture(t, { lease = 120, tunnel = false, failure } = {}) {
  const state = { exchanges: 0, fail: false, expired: 0, calls: [], cloud: [] };
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    state.calls.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: body
        ? request.headers["content-type"]?.includes("application/json")
          ? JSON.parse(body)
          : body
        : null,
    });
    response.setHeader("content-type", "application/json");
    if (failure?.path === request.url) {
      response.writeHead(failure.status);
      response.end(failure.body);
      return;
    }
    if (state.fail) {
      response.writeHead(503);
      response.end("{}");
      return;
    }
    if (request.url === "/api/auth/platform/challenge")
      response.end(
        JSON.stringify({
          challengeReceipt: "signed-box-challenge",
          expiresIn: 60,
        }),
      );
    else if (request.url === "/api/auth/platform/exchange") {
      state.exchanges++;
      response.end(
        JSON.stringify({
          access_token: `private-box-jwt-${state.exchanges}`,
          token_type: "Bearer",
          expires_in: lease,
          user: { id: 7 },
        }),
      );
    } else if (
      request.url.startsWith(
        "/api/agents/agent-a/threads/thread-a/trajectory/stream?",
      )
    ) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"seq":5}\n\n');
    } else if (request.url.startsWith("/api/redirect?")) {
      response.writeHead(302, {
        location: `/api/next?token=private-box-jwt-${state.exchanges}&access_token=private-box-jwt-${state.exchanges}`,
      });
      response.end();
    } else {
      response.setHeader("x-octop-access-token", "private-sliding-jwt");
      response.setHeader("set-cookie", "auth=private-cookie");
      response.end("{}");
    }
  });
  upstream.on("connection", track);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on("connection", (ws, request) => {
    state.calls.push({ path: request.url, headers: request.headers });
    ws.on("message", (data) => {
      state.frames ||= [];
      state.frames.push(data.toString());
      ws.send("ok");
    });
  });
  let proxy, agent;
  let url = `http://127.0.0.1:${upstream.address().port}`;
  if (tunnel) {
    url = "http://198.51.100.9:8088";
    proxy = http.createServer();
    proxy.on("connection", track);
    proxy.on("connect", (request, socket, head) => {
      assert.equal(request.url, "198.51.100.9:8088");
      const destination = net.connect(upstream.address().port, "127.0.0.1");
      track(destination);
      destination.once("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) destination.write(head);
        socket.pipe(destination).pipe(socket);
      });
      socket.on("error", () => destination.destroy());
      destination.on("error", () => socket.destroy());
      socket.on("close", () => destination.destroy());
      destination.on("close", () => socket.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    agent = createTunnelAgent({
      url,
      proxy: { port: proxy.address().port, token: "proxy-secret" },
    });
  }
  const account = {
    getIdentity: () => ({ accountId: "account-a", clientId: "client-a" }),
    request: async (request) => {
      state.cloud.push(request);
      return { grant: "private-cloud-grant" };
    },
  };
  const options = {
    url,
    agent,
    account,
    device: { deviceId: "box-a" },
    networkSessionId: "network-a",
    onExpired: () => {
      state.expired++;
    },
  };
  t.after(async () => {
    agent?.destroy();
    for (const ws of wsServer.clients) ws.terminate();
    wsServer.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((r) => upstream.close(r)),
      ...(proxy ? [new Promise((r) => proxy.close(r))] : []),
    ]);
  });
  return { options, state };
}

for (const endpoint of ["challenge", "exchange"]) {
  test(`platform ${endpoint} preserves an allowlisted box error without returning backend details`, async (t) => {
    const { options } = await fixture(t, { failure: {
      path: `/api/auth/platform/${endpoint}`, status: 503,
      body: JSON.stringify({ code: "BOX_ZHIJUN_INITIALIZATION_FAILED", detail: "SECRET private-token", token: "SECRET" }),
    } });
    await assert.rejects(createPlatformSession(options), error => {
      assert.equal(error.code, "BOX_ZHIJUN_INITIALIZATION_FAILED");
      assert.equal(error.message, error.code);
      assert.equal(error.status, 503);
      assert.doesNotMatch(JSON.stringify(error), /SECRET|private-token|detail|token/);
      return true;
    });
  });
}

for (const body of [
  '{"code":"SECRET_TOKEN","detail":"BOX_ZHIJUN_INITIALIZATION_FAILED"}',
  '{"code":"BOX_ZHIJUN_INITIALIZATION_FAILED SECRET_TOKEN"}',
  '{"code":{"secret":"SECRET_TOKEN"}}',
  '{"detail":"BOX_UPSTREAM_OIDC_FAILED"}',
  '"SECRET_TOKEN"', 'null', '<html>SECRET_TOKEN</html>',
]) {
  test(`untrusted box error response falls back to a connection error: ${body.slice(0, 28)}`, async (t) => {
    const { options } = await fixture(t, { failure: {
      path: "/api/auth/platform/exchange", status: 503, body,
    } });
    await assert.rejects(createPlatformSession(options), error => {
      assert.equal(error.code, "BOX_PLATFORM_AUTH_FAILED");
      assert.equal(error.message, error.code);
      assert.equal(error.status, 503);
      assert.doesNotMatch(JSON.stringify(error), /SECRET|detail|secret/);
      return true;
    });
  });
}

test("platform challenge and grant exchange use selected tunnel; bootstrap exposes only opaque marker", async (t) => {
  const { options, state } = await fixture(t, { tunnel: true });
  const session = await createPlatformSession(options);
  const gateway = await createDashboardGateway({
    targetURL: options.url,
    agent: options.agent,
    session,
  });
  t.after(() => gateway.close());
  assert.deepEqual(state.calls[0].body, {
    accountId: "account-a",
    clientId: "client-a",
    networkSessionId: "network-a",
  });
  assert.equal(state.cloud[0].path, "/app-api/devices/box-a/wanx/sso-grants");
  assert.deepEqual(state.cloud[0].body, {
    challengeReceipt: "signed-box-challenge",
    networkSessionId: "network-a",
  });
  assert.equal((await fetch(gateway.origin + "/api/auth/me")).status, 401);
  assert.equal(
    (await fetch(gateway.origin + "/__wanx_session/guessed")).status,
    404,
  );
  const bootstrap = await fetch(gateway.url);
  const html = await bootstrap.text();
  assert.equal(bootstrap.headers.get("cache-control"), "no-store");
  assert.equal(bootstrap.headers.get("referrer-policy"), "no-referrer");
  assert.match(bootstrap.headers.get("content-security-policy"), /nonce-/);
  assert.doesNotMatch(html, /private-|signed-box/);
  const marker = html.match(/setItem\("auth_token","([a-f0-9]+)"\)/)[1];
  assert.equal(marker.length, 64);
  const response = await fetch(gateway.origin + "/api/auth/me", {
    headers: { authorization: `Bearer ${marker}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-octop-access-token"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(
    state.calls.at(-1).headers.authorization,
    "Bearer private-box-jwt-1",
  );
  for (const path of [
    "/api/auth/login",
    "/api/auth/platform/exchange",
    "/api/auth/register",
    "/api/auth/oidc/callback",
  ])
    assert.equal(
      (
        await fetch(gateway.origin + path, {
          headers: { authorization: `Bearer ${marker}` },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await fetch(gateway.origin + "/api/auth/me", {
        headers: { authorization: "Bearer forged" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await fetch(gateway.origin + `/api/file?token=${marker}`)).status,
    200,
  );
  assert.equal(
    new URL(state.calls.at(-1).path, options.url).searchParams.get("token"),
    "private-box-jwt-1",
  );
  const ws = new WebSocket(
    gateway.origin.replace("http:", "ws:") + `/api/ws?token=${marker}`,
    { origin: gateway.origin },
  );
  await once(ws, "open");
  assert.equal(
    new URL(state.calls.at(-1).path, options.url).searchParams.get("token"),
    "private-box-jwt-1",
  );
  assert.equal(
    state.calls.at(-1).headers.authorization,
    "Bearer private-box-jwt-1",
  );
  const reply = once(ws, "message");
  ws.send("hi");
  assert.equal((await reply)[0].toString(), "ok");
  const ended = once(ws, "close");
  await gateway.close();
  await ended;
  assert.equal(session.getToken(), "");
});

test("platform profile edits and avatar uploads require a current session and preserve the request", async (t) => {
  const { options, state } = await fixture(t, { tunnel: true });
  const session = await createPlatformSession(options);
  const gateway = await createDashboardGateway({
    targetURL: options.url,
    agent: options.agent,
    session,
  });
  t.after(() => gateway.close());
  const html = await (await fetch(gateway.url)).text();
  const marker = html.match(/setItem\("auth_token","([a-f0-9]+)"\)/)[1];
  const avatar = new FormData();
  avatar.append(
    "file",
    new Blob(["image-data"], { type: "image/png" }),
    "avatar.png",
  );
  const requests = [
    { method: "GET", path: "/api/auth/me" },
    {
      method: "PATCH",
      path: "/api/auth/me",
      body: JSON.stringify({ display_name: "bruce" }),
      headers: { "content-type": "application/json" },
    },
    {
      method: "PATCH",
      path: "/api/auth/me",
      body: JSON.stringify({ avatar_icon: "scientist" }),
      headers: { "content-type": "application/json" },
    },
    { method: "POST", path: "/api/auth/me/avatar", body: avatar },
    { method: "DELETE", path: "/api/auth/me/avatar" },
  ];
  for (const { path, ...request } of requests) {
    for (const authorization of [undefined, "Bearer forged"]) {
      const before = state.calls.length;
      const response = await fetch(gateway.origin + path, {
        ...request,
        headers: {
          ...request.headers,
          origin: gateway.origin,
          ...(authorization ? { authorization } : {}),
        },
      });
      assert.equal(response.status, 401, `${request.method} ${path}`);
      assert.equal(state.calls.length, before);
    }
    const response = await fetch(gateway.origin + path, {
      ...request,
      headers: {
        ...request.headers,
        origin: gateway.origin,
        authorization: `Bearer ${marker}`,
      },
    });
    assert.equal(response.status, 200, `${request.method} ${path}`);
    const forwarded = state.calls.at(-1);
    assert.equal(forwarded.method, request.method);
    assert.equal(forwarded.path, path);
    assert.equal(forwarded.headers.authorization, "Bearer private-box-jwt-1");
    if (request.body instanceof FormData) {
      assert.match(
        forwarded.headers["content-type"],
        /^multipart\/form-data; boundary=/,
      );
      assert.match(forwarded.body, /name="file"; filename="avatar.png"/);
      assert.match(forwarded.body, /image-data/);
    } else {
      assert.deepEqual(
        forwarded.body,
        request.body ? JSON.parse(request.body) : null,
      );
    }
  }
  for (const [method, path] of [
    ["POST", "/api/auth/me"],
    ["DELETE", "/api/auth/me"],
    ["GET", "/api/auth/me/avatar"],
    ["PUT", "/api/auth/me/avatar"],
    ["POST", "/api/auth/login"],
    ["POST", "/api/auth/change-password"],
    ["POST", "/api/auth/platform/exchange"],
    ["POST", "/api/auth/oauth/bind/start"],
  ]) {
    const before = state.calls.length;
    const response = await fetch(gateway.origin + path, {
      method,
      headers: { origin: gateway.origin, authorization: `Bearer ${marker}` },
    });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(state.calls.length, before);
  }
  session.close();
  for (const { path, ...request } of requests) {
    const before = state.calls.length;
    const response = await fetch(gateway.origin + path, {
      ...request,
      headers: {
        ...request.headers,
        origin: gateway.origin,
        authorization: `Bearer ${marker}`,
      },
    });
    assert.equal(response.status, 401, `${request.method} ${path} after expiry`);
    assert.equal(state.calls.length, before);
  }
});

test("session renews before lease end and gateway close cancels renewals", async (t) => {
  const { options, state } = await fixture(t, { lease: 0.2 });
  const session = await createPlatformSession(options);
  t.after(() => session.close());
  await delay(140);
  assert.ok(state.exchanges >= 2);
  assert.match(session.getToken(), /private-box-jwt-[2-9]/);
  session.close();
  const count = state.exchanges;
  await delay(180);
  assert.equal(state.exchanges, count);
  assert.equal(state.expired, 0);
});

test("renewal outage expires original lease and clears token exactly once", async (t) => {
  const { options, state } = await fixture(t, { lease: 0.2 });
  const session = await createPlatformSession(options);
  t.after(() => session.close());
  state.fail = true;
  await delay(260);
  assert.equal(session.getToken(), "");
  assert.equal(state.expired, 1);
});

test("denied grant expires immediately; cancellation never exchanges a delayed cloud grant", async (t) => {
  const { options, state } = await fixture(t, { lease: 0.2 });
  const session = await createPlatformSession(options);
  options.account.request = async () => {
    throw Object.assign(new Error("denied"), { status: 403 });
  };
  await delay(140);
  assert.equal(session.getToken(), "");
  assert.equal(state.expired, 1);
  const controller = new AbortController();
  let release;
  options.account.request = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = createPlatformSession({
    ...options,
    signal: controller.signal,
  });
  while (!release) await delay(5);
  controller.abort();
  release({ grant: "cancelled-grant" });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(state.exchanges, 1);
});

test("expired lease tears down already-open WebSockets and the local gateway", async (t) => {
  const { options, state } = await fixture(t, { lease: 0.2 });
  const session = await createPlatformSession(options);
  const gateway = await createDashboardGateway({
    targetURL: options.url,
    session,
  });
  t.after(() => gateway.close());
  const html = await (await fetch(gateway.url)).text();
  const marker = html.match(/setItem\("auth_token","([a-f0-9]+)"\)/)[1];
  const ws = new WebSocket(
    gateway.origin.replace("http:", "ws:") + `/api/ws?token=${marker}`,
    { origin: gateway.origin },
  );
  await once(ws, "open");
  const closed = once(ws, "close");
  state.fail = true;
  await closed;
  assert.equal(state.expired, 1);
  await assert.rejects(fetch(gateway.origin + "/api/health"));
});

test("platform WebSocket rejects missing or forged marker before contacting box", async (t) => {
  const { options, state } = await fixture(t);
  const session = await createPlatformSession(options);
  const gateway = await createDashboardGateway({
    targetURL: options.url,
    session,
  });
  t.after(() => gateway.close());
  await fetch(gateway.url);
  const before = state.calls.length;
  for (const suffix of ["/api/ws", "/api/ws?token=forged"]) {
    const ws = new WebSocket(gateway.origin.replace("http:", "ws:") + suffix, {
      origin: gateway.origin,
    });
    await assert.rejects(once(ws, "open"), /401/);
  }
  assert.equal(state.calls.length, before);
});

test("trajectory EventSource access_token uses opaque marker through CONNECT, rejects conflicting credentials and scrubs redirects", async (t) => {
  const { options, state } = await fixture(t, { tunnel: true });
  const session = await createPlatformSession(options);
  const gateway = await createDashboardGateway({
    targetURL: options.url,
    agent: options.agent,
    session,
  });
  t.after(() => gateway.close());
  const html = await (await fetch(gateway.url)).text();
  const marker = html.match(/setItem\("auth_token","([a-f0-9]+)"\)/)[1];
  const path = "/api/agents/agent-a/threads/thread-a/trajectory/stream";
  const stream = await fetch(
    `${gateway.origin}${path}?after_seq=4&access_token=${marker}`,
  );
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  const reader = stream.body.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    'data: {"seq":5}\n\n',
  );
  const incoming = state.calls.at(-1);
  const upstreamURL = new URL(incoming.path, options.url);
  assert.equal(
    upstreamURL.searchParams.get("access_token"),
    "private-box-jwt-1",
  );
  assert.equal(upstreamURL.searchParams.get("after_seq"), "4");
  assert.equal(incoming.headers.authorization, "Bearer private-box-jwt-1");
  await reader.cancel();
  const before = state.calls.length;
  for (const query of [
    `token=${marker}&access_token=forged`,
    `token=forged&access_token=${marker}`,
    `access_token=${marker}&access_token=forged`,
  ]) {
    assert.equal(
      (await fetch(`${gateway.origin}${path}?${query}`)).status,
      401,
    );
  }
  assert.equal(
    (
      await fetch(`${gateway.origin}${path}?access_token=${marker}`, {
        headers: { authorization: "Bearer forged" },
      })
    ).status,
    401,
  );
  assert.equal(state.calls.length, before);
  const redirect = await fetch(
    `${gateway.origin}/api/redirect?access_token=${marker}&token=${marker}`,
    { redirect: "manual" },
  );
  assert.equal(redirect.status, 302);
  const location = new URL(redirect.headers.get("location"));
  assert.equal(location.origin, gateway.origin);
  assert.equal(location.searchParams.get("token"), marker);
  assert.equal(location.searchParams.get("access_token"), marker);
  assert.doesNotMatch(location.href, /private-box/);
});

for (const stream of ["desktop", "mobile"]) {
  test(`${stream} first-frame authentication is verified before dialing and rewritten with its connection token`, async (t) => {
    const { options, state } = await fixture(t);
    const session = await createPlatformSession(options);
    const gateway = await createDashboardGateway({
      targetURL: options.url,
      session,
    });
    t.after(() => gateway.close());
    const marker = (await (await fetch(gateway.url)).text()).match(
      /setItem\("auth_token","([a-f0-9]+)"\)/,
    )[1];
    const url =
      gateway.origin.replace("http:", "ws:") + `/api/${stream}-stream/ws`;
    const before = state.calls.length;
    const denied = new WebSocket(url, { origin: gateway.origin });
    await once(denied, "open");
    const deniedClose = once(denied, "close");
    denied.send(JSON.stringify({ type: "start", token: "forged" }));
    assert.equal((await deniedClose)[0], 1008);
    assert.equal(state.calls.length, before);
    const ws = new WebSocket(url, { origin: gateway.origin });
    await once(ws, "open");
    const reply = once(ws, "message");
    ws.send(JSON.stringify({ type: "start", token: marker, mode: "view" }));
    await reply;
    assert.deepEqual(JSON.parse(state.frames.at(-1)), {
      type: "start",
      token: "private-box-jwt-1",
      mode: "view",
    });
    assert.equal(
      state.calls.at(-1).headers.authorization,
      "Bearer private-box-jwt-1",
    );
    const next = once(ws, "message");
    ws.send(JSON.stringify({ type: "start", token: marker }));
    await next;
    assert.equal(JSON.parse(state.frames.at(-1)).token, "private-box-jwt-1");
    const ended = once(ws, "close");
    ws.send(JSON.stringify({ type: "start", token: "forged" }));
    await ended;
  });
}

 test("gateway bootstrap keeps only fixed maintenance destinations and the opaque session", async (t) => {
  const { options } = await fixture(t);
  const session = await createPlatformSession(options);
  const gateway = await createDashboardGateway({ targetURL: options.url, agent: options.agent, session });
  t.after(() => gateway.close());
  t.after(() => session.close());
  const html = await (await fetch(gateway.url)).text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
  for (const [hash, expected] of [["#/__wanx_tools/terminal", "/__wanx_tools/terminal"], ["#/__wanx_tools/desktop", "/__wanx_tools/desktop"], ["", "/"], ["#https://untrusted.example/", "/"], ["#//untrusted.example/", "/"], ["#/api/auth/logout", "/"]]) {
    const stored = new Map();
    let redirected;
    vm.runInNewContext(script, {
      localStorage: { removeItem: key => stored.delete(key) },
      sessionStorage: { setItem: (key, value) => stored.set(key, value) },
      location: { hash, replace: path => { redirected = path; } },
    });
    assert.equal(redirected, expected);
    assert.match(stored.get("auth_token"), /^[a-f0-9]{64}$/);
    assert.doesNotMatch(stored.get("auth_token"), /private-box/);
  }
});

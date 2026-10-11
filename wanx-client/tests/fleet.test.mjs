import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(
  new URL("../fleet/app.js", import.meta.url),
  "utf8",
);
const html = await readFile(
  new URL("../fleet/index.html", import.meta.url),
  "utf8",
);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function element(id = "") {
  return {
    id,
    value: "",
    hidden: false,
    disabled: false,
    textContent: "",
    listeners: {},
    children: [],
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    append(...children) {
      this.children.push(...children);
    },
  };
}
async function harness() {
  const ui = Object.fromEntries(
    [...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, element(id)]),
  );
  Object.assign(ui["login-method"], { value: "password" });
  ui.phone.value = "13800000000";
  ui["device-id"].value = "local";
  ui.name.value = "本地万象";
  ui.url.value = "http://127.0.0.1:8088";
  const initial = {
    phase: "disconnected",
    account: { phase: "signed_out" },
    platform: { phase: "idle" },
    devices: [],
    network: { enabled: true, phase: "auth_required", peers: [] },
  };
  const signed = {
    ...initial,
    account: { phase: "authenticated", accountId: "a" },
    platform: { phase: "ready" },
    network: { enabled: true, phase: "ready" },
    devices: [
      {
        deviceId: "box-1",
        displayName: "我的盒子",
        serviceUrl: "http://100.64.0.8:8088",
      },
    ],
  };
  let notify;
  const calls = [];
  const login = deferred();
  const api = {
    subscribe(fn) {
      notify = fn;
    },
    getState: async () => initial,
    loginPassword: (input) => {
      calls.push(["password", input]);
      return login.promise;
    },
    loginSMS: (input) => {
      calls.push(["sms", input]);
      return login.promise;
    },
    sendSMS: async (input) => {
      calls.push(["send", input]);
      return { expiresIn: 300 };
    },
    logout: async () => {
      calls.push(["logout"]);
      notify(initial);
      return initial;
    },
    refreshDevices: async () => {
      calls.push(["refresh"]);
      return signed;
    },
    connectBox: async (id) => {
      calls.push(["box", id]);
      return signed;
    },
    connect: async (input) => {
      calls.push(["direct", input]);
      return initial;
    },
    disconnect: async () => initial,
    setNetworkEnabled: async (enabled) => {
      const next = {
        ...signed,
        network: { enabled, phase: enabled ? "ready" : "disabled" },
      };
      notify(next);
      return next;
    },
  };
  vm.runInNewContext(source, {
    window: { wanxClient: api },
    document: {
      querySelectorAll: () => Object.values(ui),
      createElement: () => element(),
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  await flush();
  return {
    ui,
    calls,
    initial,
    signed,
    notify,
    login,
    api,
    event(id, name = "click") {
      ui[id].listeners[name]({ preventDefault() {} });
    },
  };
}
test("password clears immediately and logout rejects a stale login result", async () => {
  const h = await harness();
  h.ui.password.value = " secret ";
  h.event("login-form", "submit");
  assert.equal(h.ui.password.value, "");
  assert.equal(h.calls[0][1].password, " secret ");
  assert.equal(h.ui.logout.hidden, false);
  h.event("logout");
  await flush();
  h.login.resolve(h.signed);
  await flush();
  assert.equal(h.ui["login-form"].hidden, false);
  assert.equal(h.ui.devices.children.length, 0);
});
test("SMS login clears credentials and sending code has a local cooldown", async () => {
  const h = await harness();
  h.ui["login-method"].value = "sms";
  h.event("login-method", "change");
  assert.equal(h.ui.password.disabled, true);
  assert.equal(h.ui["sms-code"].required, true);
  h.event("send-sms");
  await flush();
  h.event("send-sms");
  assert.equal(h.calls.filter(([name]) => name === "send").length, 1);
  assert.match(h.ui["sms-state"].textContent, /5 分钟/);
  h.ui["sms-code"].value = "123456";
  h.event("login-form", "submit");
  assert.equal(h.ui["sms-code"].value, "");
  assert.equal(h.calls.at(-1)[1].code, "123456");
  h.login.resolve(h.signed);
  await flush();
  assert.equal(h.ui["login-form"].hidden, true);
});
test("only authorized devices render, open sends ID only, stale button cannot open after logout", async () => {
  const h = await harness();
  h.notify({
    ...h.signed,
    devices: [
      { ...h.signed.devices[0], displayName: "<script>bad()</script>" },
    ],
  });
  const row = h.ui.devices.children[0];
  assert.equal(row.children[0].textContent, "<script>bad()</script>");
  const button = row.children[1];
  button.listeners.click();
  await flush();
  assert.deepEqual(h.calls[0], ["box", "box-1"]);
  h.notify({ ...h.initial, devices: h.signed.devices });
  assert.equal(h.ui.devices.children.length, 0);
  button.listeners.click();
  assert.equal(h.calls.length, 1);
});
test("disabled or enrolling P2P blocks box opening but preserves local development", async () => {
  const h = await harness();
  for (const next of [
    { ...h.signed, network: { enabled: false, phase: "disabled" } },
    { ...h.signed, platform: { phase: "enrolling" } },
  ]) {
    h.notify(next);
    const button = h.ui.devices.children[0].children[1];
    assert.equal(button.disabled, true);
    button.listeners.click();
    assert.equal(h.calls.filter(([name]) => name === "box").length, 0);
    assert.equal(h.ui.connect.disabled, false);
    h.event("connect-form", "submit");
    await flush();
    assert.equal(h.calls.at(-1)[1].mode, "direct");
  }
});
test("independent account login does not block direct development or cancellation", async () => {
  const h = await harness();
  h.ui.password.value = "secret";
  h.event("login-form", "submit");
  assert.equal(h.ui.connect.disabled, false);
  assert.equal(h.ui["network-enabled"].disabled, false);
  h.event("connect-form", "submit");
  await flush();
  assert.equal(h.calls.at(-1)[0], "direct");
  h.notify(h.signed);
  h.login.resolve(h.initial);
  await flush();
  assert.equal(h.ui["login-form"].hidden, true);
});
test("network UI has no manual enrollment or provider and arbitrary errors cannot leak", async () => {
  const h = await harness();
  assert.doesNotMatch(html, /netbird|候选节点|入网码|浏览器授权/i);
  assert.match(h.ui["network-state"].textContent, /登录万象后自动连接/);
  h.notify({ ...h.initial, reason: "secret-token NetBird stacktrace" });
  assert.equal(h.ui.error.hidden, false);
  assert.doesNotMatch(h.ui.error.textContent, /secret|netbird/i);
  h.notify({ ...h.signed, reason: null });
  assert.equal(h.ui.error.hidden, true);
});

test("actual account, enrollment and box SSO errors give actionable Chinese explanations", async () => {
  const h = await harness();
  for (const [reason, explanation] of [
    ["ACCOUNT_NETWORK_ERROR", /账号服务.*互联网连接/],
    ["ACCOUNT_SESSION_EXPIRED", /重新登录/],
    ["SMS_CODE_INVALID", /验证码.*重新获取/],
    ["SECURE_STORAGE_UNAVAILABLE", /安全存储/],
    ["NETWORK_ENROLLMENT_TIMEOUT", /自动入网超时/],
    ["NETWORK_DEVICE_ACCESS_DENIED", /没有访问该盒子/],
    ["NETWORK_UNSAFE_EXISTING_POLICY", /账号隔离/],
    ["BOX_PLATFORM_TIMEOUT", /登录盒子超时/],
    ["PLATFORM_GRANT_INVALID", /访问授权无效/],
    ["SSO_DISABLED", /免登录服务尚未启用/],
    ["SSO_MEMBERSHIP_REVOKED", /授权已撤销/],
  ]) {
    h.notify({ ...h.initial, reason });
    assert.match(h.ui.error.textContent, explanation, reason);
    assert.doesNotMatch(h.ui.error.textContent, /netbird/i);
  }
  h.api.connect = async () => {
    throw new Error(
      "Error invoking remote method 'wanx-client:connect': Error: BOX_PLATFORM_AUTH_FAILED",
    );
  };
  h.event("connect-form", "submit");
  await flush();
  assert.match(h.ui.error.textContent, /盒子未接受本次登录/);
});

test("undeployed automatic enrollment explains the missing service inline and never implies an empty account", async () => {
  const h = await harness();
  for (const source of ["platform", "network"]) {
    h.notify({
      ...h.signed,
      account: { ...h.signed.account, reason: "ACCOUNT_REQUEST_FAILED" },
      devices: [],
      platform: {
        phase: "unavailable",
        reason: source === "platform" ? "NETWORK_SERVICE_NOT_DEPLOYED" : null,
      },
      network: {
        enabled: true,
        phase: "unavailable",
        reason: source === "network" ? "NETWORK_SERVICE_NOT_DEPLOYED" : null,
      },
    });
    assert.equal(
      h.ui["network-state"].textContent,
      "自动入网服务尚未部署，请联系管理员完成服务更新。",
    );
    assert.equal(
      h.ui["devices-empty"].textContent,
      "暂时无法获取盒子列表，请恢复网络服务后刷新。",
    );
    assert.equal(h.ui["devices-empty"].hidden, false);
    assert.equal(h.ui.connect.disabled, false);
    assert.equal(h.ui["refresh-devices"].disabled, false);
  }
  h.notify({ ...h.signed, devices: [] });
  assert.equal(h.ui["network-state"].textContent, "P2P 网络已连接");
  assert.equal(h.ui["devices-empty"].textContent, "暂无已绑定或获授权的盒子。");
  h.notify({
    ...h.signed,
    devices: [],
    platform: { phase: "unavailable", reason: "private-server-message" },
  });
  assert.equal(h.ui["network-state"].textContent, "P2P 网络暂时不可用");
});

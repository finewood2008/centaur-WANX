import { test } from "node:test";
import assert from "node:assert/strict";
import { registerControlActions } from "../shell/control.mjs";
function harness() {
  const handlers = new Map(),
    calls = [];
  const controlURL = "file:///client/fleet/index.html",
    frame = { url: controlURL },
    contents = { mainFrame: frame };
  const client = Object.fromEntries(
    [
      "snapshot",
      "loginPassword",
      "loginSMS",
      "register",
      "sendSMS",
      "logout",
      "refreshDevices",
      "connectBox",
      "connect",
      "disconnect",
      "setNetworkEnabled",
    ].map((name) => [name, (input) => calls.push([name, input])]),
  );
  registerControlActions({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    control: { webContents: contents, isDestroyed: () => false },
    controlURL,
    client,
  });
  return {
    calls,
    handlers,
    contents,
    frame,
    invoke(name, input) {
      return handlers.get(`wanx-client:${name}`)(
        { sender: contents, senderFrame: frame },
        input,
      );
    },
  };
}
test("every account/device IPC rejects remote windows, same-url subframes and navigated control", () => {
  const h = harness();
  for (const handler of h.handlers.values()) {
    for (const event of [
      { sender: {}, senderFrame: h.frame },
      { sender: h.contents, senderFrame: { url: h.frame.url } },
    ])
      assert.throws(() => handler(event, {}), /无权/);
  }
  h.frame.url = "https://box.example";
  for (const handler of h.handlers.values())
    assert.throws(
      () => handler({ sender: h.contents, senderFrame: h.frame }, {}),
      /无权/,
    );
  assert.deepEqual(h.calls, []);
});

test("registration IPC validates credentials and pins the SMS scene", () => {
  const h = harness();
  const input = { phone: " 13800138000 ", password: " password ", code: "000001", role: "admin", clientId: "injected" };
  h.invoke("register", input);
  h.invoke("send-registration-code", { phone: input.phone, scene: "consumer_login" });
  assert.deepEqual(h.calls, [
    ["register", { phone: "13800138000", password: input.password, code: "000001" }],
    ["sendSMS", { phone: "13800138000", scene: "consumer_register" }],
  ]);
  for (const password of [null, "short", "密".repeat(25), "password\n", "password\0"])
    assert.throws(() => h.invoke("register", { ...input, password }), /invalid_credentials/);
  for (const code of [null, "12345", "1234567", "abcdef"])
    assert.throws(() => h.invoke("register", { ...input, code }), /invalid_sms_code/);
  assert.equal(h.calls.length, 2);
});
test("account IPC validates and forwards only allowed fields preserving password whitespace", () => {
  const h = harness();
  for (const input of [
    null,
    {},
    { phone: "bad", password: "x" },
    { phone: "13800000000", password: "" },
    { phone: "13800000000", password: "x".repeat(1025) },
  ])
    assert.throws(() => h.invoke("login-password", input), /invalid_/);
  h.invoke("login-password", {
    phone: " 13800000000 ",
    password: " secret ",
    token: "injected",
  });
  h.invoke("login-sms", {
    phone: "13800000000",
    code: "123456",
    clientId: "injected",
  });
  h.invoke("send-sms", { phone: "13800000000", scope: "admin" });
  assert.deepEqual(h.calls, [
    ["loginPassword", { phone: "13800000000", password: " secret " }],
    ["loginSMS", { phone: "13800000000", code: "123456" }],
    ["sendSMS", { phone: "13800000000" }],
  ]);
  for (const code of [null, "abcd", "1", "1".repeat(13)])
    assert.throws(
      () => h.invoke("login-sms", { phone: "13800000000", code }),
      /invalid_sms_code/,
    );
});
test("box actions accept only bounded IDs and direct connection cannot inject transport credentials", () => {
  const h = harness();
  for (const input of [null, {}, " ", "a".repeat(129)])
    assert.throws(() => h.invoke("connect-box", input), /invalid_device/);
  h.invoke("connect-box", "box-1");
  const input = {
    mode: "direct",
    deviceId: "local",
    name: "本地",
    url: "http://127.0.0.1:8088",
    agent: {},
    token: "injected",
  };
  h.invoke("connect", input);
  assert.deepEqual(h.calls, [
    ["connectBox", "box-1"],
    [
      "connect",
      {
        mode: "direct",
        deviceId: "local",
        name: "本地",
        url: "http://127.0.0.1:8088",
      },
    ],
  ]);
  assert.throws(
    () => h.invoke("connect", { ...input, mode: "netbird" }),
    /invalid_network_mode/,
  );
  assert.throws(
    () => h.invoke("set-network-enabled", "true"),
    /invalid_network_mode/,
  );
  for (const name of ["login-network", "enroll-network", "open-auth-url"])
    assert.equal(h.handlers.has(`wanx-client:${name}`), false);
});

test("IPC matches Consumer phone, six-digit SMS and UTF-8 password byte limits", () => {
  const h = harness();
  for (const phone of [
    "123456",
    "+8613800000000",
    "23800000000",
    "138000000000",
  ])
    assert.throws(() => h.invoke("send-sms", { phone }), /invalid_phone/);
  for (const code of ["1234", "12345", "1234567", "12345678"])
    assert.throws(
      () => h.invoke("login-sms", { phone: "13800000000", code }),
      /invalid_sms_code/,
    );
  for (const password of ["a".repeat(73), "密".repeat(25), "🔑".repeat(19)])
    assert.throws(
      () => h.invoke("login-password", { phone: "13800000000", password }),
      /invalid_credentials/,
    );
  const password = " " + "密".repeat(23) + "  ";
  assert.equal(Buffer.byteLength(password), 72);
  h.invoke("login-password", { phone: "13800000000", password });
  assert.equal(h.calls[0][1].password, password);
  h.invoke("login-sms", { phone: "13800000000", code: "000001" });
  assert.equal(h.calls[1][1].code, "000001");
});

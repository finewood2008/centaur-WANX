import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createDashboardWindows } from "../shell/dashboard.mjs";
import {
  externalHTTPURL,
  isControlSender,
  isDashboardURL,
  sameOrigin,
} from "../shell/security.mjs";

test("managed application arguments retain userData without inheriting debug ports", async () => {
  const source = await readFile(new URL("../shell/main.mjs", import.meta.url), "utf8");
  const expression = source.match(/launcherArgs: (\[[\s\S]*?\n        \]),/)[1];
  const userData = "/isolated profile/万象";
  for (const isPackaged of [false, true]) {
    for (const mockKeychain of [false, true]) {
      const switches = new Set(["remote-debugging-port", "inspect", ...(mockKeychain ? ["use-mock-keychain"] : [])]);
      const args = vm.runInNewContext(expression, {
        userData,
        app: {
          isPackaged,
          getAppPath: () => "/source/wanx-client",
          commandLine: { hasSwitch: (name) => switches.has(name) },
        },
      });
      assert.deepEqual([...args], [
        ...(isPackaged ? [] : ["/source/wanx-client"]),
        "--wanx-managed-app",
        `--user-data-dir=${userData}`,
        ...(mockKeychain ? ["--use-mock-keychain"] : []),
      ]);
    }
  }
});

test("only the exact trusted main frame can invoke shell actions", () => {
  const url = "file:///client/local-ui/renderer/index.html";
  const frame = { url };
  const contents = { mainFrame: frame };
  const control = { webContents: contents, isDestroyed: () => false };
  assert.equal(
    isControlSender({ sender: contents, senderFrame: frame }, control, url),
    true,
  );
  assert.equal(
    isControlSender({ sender: contents, senderFrame: { url } }, control, url),
    false,
  );
  assert.equal(
    isControlSender({ sender: {}, senderFrame: frame }, control, url),
    false,
  );
  frame.url = "https://box.example/";
  assert.equal(
    isControlSender({ sender: contents, senderFrame: frame }, control, url),
    false,
  );
});

test("navigation guard rejects scheme, port and credential changes", () => {
  const base = "http://127.0.0.1:41000";
  assert.equal(sameOrigin(`${base}/chats#thread`, base), true);
  for (const url of [
    "javascript:alert(1)",
    "file:///tmp/page",
    "http://127.0.0.1:8088",
    "https://127.0.0.1:41000",
    "http://user@127.0.0.1:41000",
    "https://example.com",
  ]) {
    assert.equal(sameOrigin(url, base), false, url);
  }
  assert.equal(
    isDashboardURL("blob:http://127.0.0.1:41000/document", base),
    true,
  );
  assert.equal(
    isDashboardURL("blob:https://example.com/document", base),
    false,
  );
  assert.equal(
    externalHTTPURL("https://docs.example.com/guide"),
    "https://docs.example.com/guide",
  );
  for (const url of [
    "file:///tmp/page",
    "javascript:alert(1)",
    "custom://callback",
    "https://user:secret@example.com",
  ]) {
    assert.equal(externalHTTPURL(url), null);
  }
});

function harness() {
  const windows = [];
  const sessions = [];
  let disconnects = 0;
  const errors = [];
  const external = [];
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.shown = 0;
      this.focused = 0;
      this.minimized = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openHandler = handler;
      };
      this.webContents.getURL = () => this.url;
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    async loadURL(url) {
      this.url = url;
      if (this.options.title === "unavailable") throw new Error("ERR_CONNECTION_REFUSED");
    }
  }
  const controller = createDashboardWindows({
    BrowserWindow: Window,
    session: {
      fromPartition(partition) {
        const item = {
          partition,
          storageCleared: false,
          cacheCleared: false,
          async clearStorageData() {
            this.storageCleared = true;
          },
          async clearCache() {
            this.cacheCleared = true;
          },
          setPermissionRequestHandler(handler) {
            this.permission = handler;
          },
        };
        sessions.push(item);
        return item;
      },
    },
    disconnect: async () => {
      disconnects += 1;
    },
    onError: (error) => errors.push(error),
    openExternal: async (url) => {
      external.push(url);
    },
  });
  const ready = (port) => ({
    phase: "ready",
    connection: { name: "测试万象", gatewayURL: `http://127.0.0.1:${port}` },
  });
  return {
    controller,
    windows,
    sessions,
    errors,
    external,
    Window,
    ready,
    disconnects: () => disconnects,
  };
}

test("each connection uses an isolated transient session and cleans previous credentials", async () => {
  const h = harness();
  h.controller.sync(h.ready(41000));
  assert.equal(h.windows.length, 0, "connecting alone must not open Dashboard");
  await h.controller.open(h.ready(41000));
  h.windows[0].minimized = true;
  await h.controller.open(h.ready(41000));
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].minimized, false);
  assert.equal(h.windows[0].shown, 1);
  assert.equal(h.windows[0].focused, 1);
  const prefs = h.windows[0].options.webPreferences;
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.preload, undefined);
  h.controller.sync(h.ready(42000));
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.windows.length, 1, "switching boxes closes the old Dashboard without opening a new one");
  await h.controller.open(h.ready(42000));
  assert.equal(
    h.disconnects(),
    0,
    "replacement must not disconnect the new client",
  );
  assert.notEqual(h.sessions[0].partition, h.sessions[1].partition);
  assert.equal(
    h.sessions.some((item) => item.partition.startsWith("persist:")),
    false,
  );
  assert.equal(h.sessions[0].storageCleared, true);
  assert.equal(h.sessions[0].cacheCleared, true);
  await h.controller.close();
  assert.equal(h.windows[1].destroyed, true);
  assert.equal(h.sessions[1].storageCleared, true);
  assert.deepEqual(h.errors, []);
});

test("closing and reopening Dashboard preserves the box connection; disconnect revokes the window", async () => {
  const h = harness();
  await h.controller.open(h.ready(41000));
  h.windows[0].destroy();
  assert.equal(h.disconnects(), 0);
  assert.equal(h.sessions[0].storageCleared, true);
  await h.controller.open(h.ready(41000));
  assert.equal(h.windows[1].url, h.ready(41000).connection.gatewayURL);
  assert.notEqual(h.sessions[0], h.sessions[1]);
  h.controller.sync({ phase: "disconnected", connection: null });
  assert.equal(h.windows[1].destroyed, true);
  assert.equal(h.disconnects(), 0);
  await h.controller.close();
});

test("Dashboard safely opens external documents and isolates same-origin previews", async () => {
  const h = harness();
  await h.controller.open(h.ready(41000));
  assert.deepEqual(h.windows[0].openHandler({ url: "https://example.com" }), {
    action: "deny",
  });
  assert.deepEqual(h.external, ["https://example.com/"]);
  h.windows[0].openHandler({ url: "custom://untrusted" });
  assert.equal(h.external.length, 1);
  const preview = h.windows[0].openHandler({
    url: "blob:http://127.0.0.1:41000/document",
  });
  assert.equal(preview.action, "allow");
  assert.equal(
    preview.overrideBrowserWindowOptions.webPreferences.sandbox,
    true,
  );
  assert.equal(
    preview.overrideBrowserWindowOptions.webPreferences.session,
    h.sessions[0],
  );
  const child = new h.Window(preview.overrideBrowserWindowOptions);
  h.windows[0].webContents.emit("did-create-window", child);
  let prevented = false;
  h.windows[0].webContents.emit(
    "will-redirect",
    {
      preventDefault() {
        prevented = true;
      },
    },
    "https://example.com",
  );
  assert.equal(prevented, true);
  let allowed;
  h.sessions[0].permission(
    h.windows[0].webContents,
    "clipboard-sanitized-write",
    (result) => {
      allowed = result;
    },
    { requestingUrl: "https://example.com" },
  );
  assert.equal(allowed, false);
  await h.controller.close();
  assert.equal(child.isDestroyed(), true);
});

test("transient recovery retains the existing isolated dashboard, revocation closes it", async () => {
  const h = harness();
  await h.controller.open(h.ready(41000));
  h.controller.sync({ ...h.ready(41000), phase: "recovering" });
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].destroyed, false);
  assert.equal(h.sessions[0].cacheCleared, false);
  h.controller.sync(h.ready(41000));
  assert.equal(h.windows.length, 1);
  h.controller.sync({ phase: "disconnected", connection: null });
  assert.equal(h.windows[0].destroyed, true);
  await h.controller.close();
});

test("a failed Dashboard load cleans its session and allows retry without disconnecting apps", async () => {
  const h = harness();
  const state = h.ready(41000);
  state.connection.name = "unavailable";
  await assert.rejects(h.controller.open(state), /DASHBOARD_OPEN_FAILED/);
  assert.equal(h.windows[0].destroyed, true);
  assert.equal(h.sessions[0].storageCleared, true);
  assert.equal(h.disconnects(), 0);
  await h.controller.open(h.ready(41000));
  assert.equal(h.windows[1].destroyed, false);
  await h.controller.close();
});

for (const [label, override] of [
  ["logout", { account: { phase: "signed_out" } }],
  ["disabled network", { network: { enabled: false } }],
]) {
  test(`${label} closes Dashboard even if a stale gateway is still present`, async () => {
    const h = harness();
    await h.controller.open(h.ready(41000));
    h.controller.sync({ ...h.ready(41000), ...override });
    assert.equal(h.windows[0].destroyed, true);
    await h.controller.close();
  });
}

test("maintenance tools bootstrap their fixed routes in separate reusable windows", async () => {
  const h = harness();
  const state = h.ready(41000);
  state.connection.gatewayURL += "/__wanx_session/test";
  await h.controller.open(state, "terminal");
  await h.controller.open(state, "desktop");
  assert.equal(h.windows[0].url, state.connection.gatewayURL + "#/__wanx_tools/terminal");
  assert.equal(h.windows[1].url, state.connection.gatewayURL + "#/__wanx_tools/desktop");
  let blocked = false;
  h.windows[0].webContents.emit("will-navigate", { preventDefault() { blocked = true; } }, "http://127.0.0.1:41000/workbench/terminal");
  assert.equal(blocked, true, "a tool window cannot navigate into the Dashboard");
  assert.equal(h.windows[0].openHandler({ url: "http://127.0.0.1:41000/chat" }).action, "deny");

  await h.controller.open(state, "terminal");
  assert.equal(h.windows.length, 2);
  assert.equal(h.windows[0].focused, 1);
  assert.equal(h.windows[0].url, state.connection.gatewayURL + "#/__wanx_tools/terminal", "reopening must not reload a live terminal");
  for (const destination of ["constructor", "__proto__", "https://untrusted.example/"]) {
    assert.throws(() => h.controller.open(state, destination), /INVALID_MAINTENANCE_TOOL/);
  }
  h.controller.sync(h.ready(42000));
  assert.ok(h.windows.every(window => window.destroyed));
  assert.ok(h.sessions.every(session => session.storageCleared));
  await h.controller.open(h.ready(42000), "desktop");
  assert.equal(h.windows[2].url, "http://127.0.0.1:42000/__wanx_tools/desktop");
  h.controller.sync({ phase: "disconnected", connection: null });
  assert.ok(h.windows.every(window => window.destroyed));
  await h.controller.close();
});


test("terminal Dashboard shortcut opens and reuses a separate bootstrapped window", async () => {
  const h = harness();
  const state = h.ready(41000);
  state.connection.gatewayURL += "/__wanx_session/test";
  await h.controller.open(state, "terminal");
  const terminal = h.windows[0];
  const terminalURL = terminal.url;
  assert.equal(terminal.openHandler({ url: "http://127.0.0.1:41000/" }).action, "deny");
  assert.equal(h.windows.length, 2);
  assert.equal(h.windows[1].url, state.connection.gatewayURL);
  assert.notEqual(h.sessions[0], h.sessions[1]);
  assert.equal(h.windows[1].options.webPreferences.preload, undefined);
  assert.equal(terminal.destroyed, false);
  assert.equal(terminal.url, terminalURL);
  terminal.openHandler({ url: "http://127.0.0.1:41000/" });
  assert.equal(h.windows.length, 2);
  assert.equal(h.windows[1].focused, 1);
  assert.deepEqual(h.external, []);
  h.controller.sync(h.ready(42000));
  assert.ok(h.windows.every(window => window.destroyed));
  terminal.openHandler({ url: "http://127.0.0.1:41000/" });
  assert.equal(h.windows.length, 2, "stale terminals cannot reopen old box credentials");
  await h.controller.close();
});

for (const change of [
  { phase: "recovering" },
  { phase: "disconnected", connection: null },
  { account: { phase: "signed_out" } },
  { network: { enabled: false } },
]) {
  test(`terminal Dashboard shortcut stops after context changes: ${JSON.stringify(change)}`, async () => {
    const h = harness();
    await h.controller.open(h.ready(41000), "terminal");
    h.controller.sync({ ...h.ready(41000), ...change });
    h.windows[0].openHandler({ url: "http://127.0.0.1:41000/" });
    assert.equal(h.windows.length, 1);
    await h.controller.close();
  });
}

test("Dashboard shortcut does not widen maintenance navigation or desktop access", async () => {
  const h = harness();
  await h.controller.open(h.ready(41000), "terminal");
  await h.controller.open(h.ready(41000), "desktop");
  for (const suffix of ["/chat", "/?redirect=/chat", "/#chat"]) {
    assert.equal(h.windows[0].openHandler({ url: `http://127.0.0.1:41000${suffix}` }).action, "deny");
  }
  assert.equal(h.windows[1].openHandler({ url: "http://127.0.0.1:41000/" }).action, "deny");
  let prevented = false;
  h.windows[0].webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "http://127.0.0.1:41000/");
  assert.equal(prevented, true);
  assert.equal(h.windows.length, 2);
  assert.deepEqual(h.external, []);
  await h.controller.close();
});

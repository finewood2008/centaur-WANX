import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDashboardWindows } from "../shell/dashboard.mjs";
import {
  externalHTTPURL,
  isControlSender,
  isDashboardURL,
  sameOrigin,
} from "../shell/security.mjs";

test("only the exact trusted main frame can invoke shell actions", () => {
  const url = "file:///client/fleet/index.html";
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

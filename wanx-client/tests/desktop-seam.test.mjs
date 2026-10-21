import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createDesktopIntegration, DESKTOP_NAME } from "../shell/desktop.mjs";
import { openConnectedDashboard } from "../shell/control.mjs";

const ready = {
  account: { phase: "authenticated" }, platform: { phase: "ready" },
  network: { enabled: true, phase: "ready" }, phase: "ready",
  connection: { mode: "netbird", deviceId: "box-102", name: "测试盒子 102", gatewayURL: "http://127.0.0.1:41000" },
};

function harness(platform = "darwin", panelMode = false, options = {}) {
  let state = ready;
  const opened = [], errors = [], sent = [], images = [], menus = [], trays = [], management = [], hidden = [];
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, getVersion: () => "0.1.0", setAboutPanelOptions: (options) => { app.about = options; },
    dock: { setIcon: (icon) => { app.dockIcon = icon; }, hide: () => { app.dockHidden = true; } },
    quitCalls: 0, quit: () => { app.quitCalls++; },
  });
  const control = new EventEmitter();
  Object.assign(control, {
    destroyed: false, hidden: false, minimized: false, focused: false,
    isDestroyed: () => control.destroyed, isMinimized: () => control.minimized,
    restore: () => { control.minimized = false; },
    show: () => { control.hidden = false; }, hide: () => { control.hidden = true; },
    focus: () => { control.focused = true; },
    webContents: { send: (...args) => sent.push(args) },
  });
  const panel = new EventEmitter();
  Object.assign(panel, {
    hidden: true, focused: false, destroyed: false, bounds: { x: 0, y: 0, width: 400, height: 520 },
    isDestroyed: () => panel.destroyed, isVisible: () => !panel.hidden,
    show: () => { panel.hidden = false; }, hide: () => { panel.hidden = true; },
    focus: () => { panel.focused = true; },
    getBounds: () => panel.bounds, setBounds: (bounds) => { panel.bounds = { ...panel.bounds, ...bounds }; },
  });
  const screen = new EventEmitter();
  Object.assign(screen, {
    display: { workArea: { x: 0, y: 24, width: 1440, height: 876 } },
    cursor: { x: 500, y: 500 },
    getDisplayMatching: (bounds) => { screen.matched = bounds; return screen.display; },
    getDisplayNearestPoint: (point) => { screen.nearest = point; return screen.display; },
    getCursorScreenPoint: () => screen.cursor,
  });
  const Menu = {
    buildFromTemplate(template) {
      const all = (items) => items.flatMap((item) => [item, ...all(item.submenu || [])]);
      return { items: template, getMenuItemById: (id) => all(template).find((item) => item.id === id) };
    },
    setApplicationMenu: (menu) => menus.push(menu),
  };
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; this.bounds = { x: 1340, y: 0, width: 22, height: 24 }; trays.push(this); }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
    popUpContextMenu(menu) { this.poppedMenu = menu; }
    getBounds() { return this.bounds; }
    destroy() { this.destroyed = true; }
  }
  const client = { snapshot: () => state };
  const desktop = createDesktopIntegration({
    app, Menu, Tray, control, client, platform,
    ...(panelMode ? {
      panel, screen, onPanelHidden: () => hidden.push(true),
      openManagement: (page) => { management.push(page); control.show(); control.focus(); },
    } : {}),
    nativeImage: { createFromPath(path) { const image = { path, setTemplateImage(value) { this.template = value; } }; images.push(image); return image; } },
    openDashboard: () => openConnectedDashboard(client, { open: (snapshot) => opened.push(snapshot.connection) }),
    onError: (error) => errors.push(error.message),
    ...options,
  });
  return { app, control, panel, screen, desktop, menus, trays, images, opened, sent, errors, management, hidden, update(next, publish = true) { state = next; if (publish) desktop.sync(state); } };
}

test("macOS menus and tray expose the current box, restore the window and revoke stale actions", async () => {
  const h = harness();
  assert.equal(h.app.about.applicationName, DESKTOP_NAME);
  assert.match(h.app.dockIcon, /icon\.png$/);
  assert.equal(h.trays[0].icon.template, true);
  assert.match(h.trays[0].icon.path, /trayTemplate\.png$/);
  assert.equal(h.app.about.credits, "你的 AI 应用底座");
  assert.match(h.trays[0].menu.getMenuItemById("connection-status").label, /测试盒子 102/);
  h.control.hidden = true;
  h.control.minimized = true;
  h.menus[0].getMenuItemById("settings").click();
  assert.equal(h.control.hidden, false);
  assert.equal(h.control.minimized, false);
  assert.equal(h.control.focused, true);
  assert.deepEqual(h.sent, [["wanx-client:navigate", "settings"]]);
  assert.equal(h.trays[0].menu.getMenuItemById("dashboard"), undefined);
  assert.equal(h.menus[0].getMenuItemById("dashboard"), undefined);
  h.menus[0].getMenuItemById("space").click();
  assert.deepEqual(h.sent.at(-1), ["wanx-client:navigate", "space"]);
  h.update({ ...ready, account: { phase: "signed_out" } });
  for (const menu of [h.menus[0], h.trays[0].menu]) {
    assert.equal(menu.getMenuItemById("space").enabled, false);
    assert.equal(menu.getMenuItemById("settings").enabled, false);
  }
  h.desktop.dispose();
});

test("About shows the client edition without mixing in build or box diagnostics", () => {
  const h = harness("darwin", false, {
    versionInfo: { buildId: "source-123", distributionClass: "development" },
  });
  assert.equal(h.app.about.applicationVersion, "0.1.0");
  assert.equal(h.app.about.credits, "你的 AI 应用底座\n开发构建");
  h.update({ ...ready, connection: { ...ready.connection, name: "另一台盒子" } });
  assert.equal(h.app.about.credits, "你的 AI 应用底座\n开发构建");
  h.desktop.dispose();
});

test("closing the host keeps its connection alive; Dock activation restores it and quit releases the tray", () => {
  const h = harness();
  let prevented = 0;
  h.control.emit("close", { preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(h.control.hidden, true);
  h.app.emit("activate");
  assert.equal(h.control.hidden, false);
  h.desktop.dispose();
  assert.equal(h.trays[0].destroyed, true);
  h.control.emit("close", { preventDefault: () => prevented++ });
  assert.equal(prevented, 1, "explicit quit must be allowed to close the host");
});

test("Windows uses a color tray and standard editing/window roles", () => {
  const h = harness("win32", true);
  assert.match(h.trays[0].icon.path, /icon\.ico$/);
  assert.equal(h.trays[0].icon.template, undefined);
  const roles = h.menus[0].items.flatMap((item) => item.submenu || []).map((item) => item.role);
  for (const role of ["copy", "paste", "selectAll", "minimize", "close", "quit"]) assert.ok(roles.includes(role), role);
  assert.ok(!roles.includes("hide"));
  h.control.hidden = true;
  h.trays[0].emit("click");
  assert.equal(h.control.hidden, true);
  assert.equal(h.panel.hidden, false);
  assert.equal(h.panel.focused, true);
  assert.equal(h.trays[0].menu, undefined);
  assert.equal(h.app.dockHidden, undefined);
  h.panel.emit("blur");
  assert.equal(h.panel.hidden, true, "clicking outside dismisses the panel");
  h.trays[0].emit("right-click");
  h.trays[0].poppedMenu.getMenuItemById("settings").click();
  assert.deepEqual(h.management, ["settings"]);
  assert.equal(h.control.hidden, false);
  assert.equal(h.panel.hidden, true);
  h.desktop.dispose();
});

test("tray panel dismisses when focus moves outside and can be reopened", () => {
  for (const platform of ["darwin", "win32"]) {
    const h = harness(platform, true);
    h.trays[0].emit("click");
    assert.equal(h.panel.hidden, false);
    h.panel.emit("blur");
    assert.equal(h.panel.hidden, true, `${platform}: clicking outside must dismiss the panel`);
    assert.equal(h.hidden.length, 1);
    h.panel.emit("blur");
    assert.equal(h.hidden.length, 1, "a delayed blur must not dismiss twice");
    h.trays[0].emit("click");
    assert.equal(h.panel.hidden, false, "the next tray click opens the panel again");
    h.desktop.dispose();
  }
});

test("macOS tray dismisses on blur and still toggles on repeated icon clicks", () => {
  const h = harness("darwin", true);
  const tray = h.trays[0];
  assert.equal(h.app.dockHidden, true);
  assert.equal(tray.menu, undefined, "a context menu must not consume the left click");
  tray.emit("click");
  assert.equal(h.panel.hidden, false);
  assert.equal(h.panel.focused, true);
  assert.deepEqual(h.panel.bounds, { x: 1032, y: 32, width: 400, height: 520 });
  tray.emit("click");
  assert.equal(h.panel.hidden, true);
  assert.equal(h.hidden.length, 1);
  tray.emit("click");
  h.panel.emit("blur");
  assert.equal(h.panel.hidden, true);
  tray.emit("click");
  h.screen.cursor = { x: 1345, y: 10 };
  h.panel.emit("blur");
  tray.emit("click");
  assert.equal(h.panel.hidden, true, "the tray click explicitly hides the panel even after focus loss");
  h.desktop.show();
  tray.emit("right-click");
  assert.equal(h.panel.hidden, true);
  assert.match(tray.poppedMenu.getMenuItemById("connection-status").label, /测试盒子 102/);
  h.update({ ...ready, account: { phase: "signed_out" } });
  assert.equal(tray.poppedMenu.getMenuItemById("space").enabled, false);
  h.desktop.dispose();
});

test("a tray click that blurs the panel cannot reopen it, but later clicks can", (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const platform of ["darwin", "win32"]) {
    const h = harness(platform, true);
    const tray = h.trays[0];
    h.screen.cursor = { x: 1345, y: 10 };
    tray.emit("click");
    h.panel.emit("blur");
    assert.equal(h.panel.hidden, true, "focus loss closes even with the cursor over the tray");
    tray.emit("click");
    assert.equal(h.panel.hidden, true, "the same gesture must not reopen the panel");
    assert.equal(h.hidden.length, 1);
    tray.emit("click");
    assert.equal(h.panel.hidden, false, "the following click can reopen the panel");
    h.panel.emit("blur");
    now += 1000;
    tray.emit("click");
    assert.equal(h.panel.hidden, false, "switching apps with the cursor over the tray must not swallow a later click");
    h.desktop.dispose();
  }
});

test("panel placement handles negative coordinates, small work areas, Retina-neutral sizes and removed displays", () => {
  const h = harness("darwin", true);
  h.screen.display = { scaleFactor: 2, workArea: { x: -1280, y: 0, width: 1280, height: 800 } };
  h.trays[0].bounds = { x: -90, y: -24, width: 22, height: 24 };
  h.desktop.resizePanel(900);
  h.desktop.show();
  assert.deepEqual(h.panel.bounds, { x: -408, y: 8, width: 400, height: 560 });
  h.screen.display = { workArea: { x: -1280, y: 0, width: 1280, height: 420 } };
  h.screen.emit("display-metrics-changed");
  assert.deepEqual(h.panel.bounds, { x: -408, y: 8, width: 400, height: 404 });
  h.trays[0].bounds = { x: 0, y: 0, width: 0, height: 0 };
  h.screen.display = { workArea: { x: 0, y: 24, width: 800, height: 576 } };
  h.screen.cursor = { x: 650, y: 200 };
  h.screen.emit("display-removed");
  assert.deepEqual(h.screen.nearest, h.screen.cursor);
  assert.deepEqual(h.panel.bounds, { x: 392, y: 32, width: 400, height: 560 });
  h.desktop.resizePanel(360);
  assert.equal(h.panel.bounds.height, 360);
  h.desktop.resizePanel(NaN);
  assert.equal(h.panel.bounds.height, 360);
  h.desktop.dispose();
  assert.equal(h.screen.listenerCount("display-removed"), 0);
});

test("management navigation preserves its window and both close handlers release on explicit shutdown", () => {
  const h = harness("darwin", true);
  h.desktop.show();
  h.desktop.showManagement("devices");
  assert.deepEqual(h.management, ["devices"]);
  assert.equal(h.control.hidden, false);
  assert.equal(h.panel.hidden, true);
  let prevented = 0;
  h.control.emit("close", { preventDefault: () => prevented++ });
  assert.equal(h.control.hidden, true);
  h.app.emit("activate");
  assert.equal(h.panel.hidden, false);
  assert.equal(h.control.hidden, true);
  h.panel.emit("close", { preventDefault: () => prevented++ });
  assert.equal(h.panel.hidden, true);
  assert.equal(prevented, 2);
  h.desktop.dispose();
  h.control.emit("close", { preventDefault: () => prevented++ });
  h.panel.emit("close", { preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  assert.equal(h.panel.listenerCount("blur"), 0);
  assert.equal(h.trays[0].destroyed, true);
});

test("management handoff preserves the pending launch intent despite synchronous and delayed blur events", () => {
  const h = harness("darwin", true);
  const hide = h.panel.hide;
  h.panel.hide = () => {
    h.panel.emit("blur");
    hide();
  };
  h.desktop.show();
  h.desktop.showManagement("devices");
  assert.equal(h.panel.hidden, true);
  assert.deepEqual(h.management, ["devices"]);
  assert.equal(h.hidden.length, 0, "moving to setup must retain the selected application");
  h.panel.emit("blur");
  assert.equal(h.hidden.length, 0, "a late blur from the hidden panel must not dismiss the intent");
  h.desktop.show();
  h.desktop.hidePanel();
  assert.equal(h.hidden.length, 1, "an explicit dismissal still cancels once, even if hide emits blur");
  h.desktop.show();
  h.panel.emit("blur");
  assert.equal(h.panel.hidden, true);
  assert.equal(h.hidden.length, 2, "ordinary focus loss dismisses once, even if hide emits blur");
  h.desktop.dispose();
});

test("Mac application and tray menus route quit through the Host confirmation and expose About", () => {
  let requested = 0;
  const h = harness("darwin", true, { requestQuit: () => requested++ });
  const quit = h.menus[0].getMenuItemById("quit");
  assert.equal(quit.role, undefined, "Electron's built-in quit role would bypass the Host callback");
  assert.equal(quit.accelerator, "Command+Q");
  quit.click();
  h.trays[0].emit("right-click");
  const trayMenu = h.trays[0].poppedMenu;
  assert.ok(trayMenu.items.some(item => item.role === "about"));
  trayMenu.getMenuItemById("quit").click();
  assert.equal(requested, 2);
  assert.equal(h.app.quitCalls, 0);
  h.desktop.dispose();
  const defaults = harness();
  defaults.menus[0].getMenuItemById("quit").click();
  assert.equal(defaults.app.quitCalls, 1);
  defaults.desktop.dispose();
});

test("packaging ships readable platform icons and Retina tray artwork", async () => {
  const root = new URL("../", import.meta.url);
  const config = JSON.parse(await readFile(new URL("package.json", root), "utf8")).build;
  assert.equal(config.productName, "万象");
  assert.equal(DESKTOP_NAME, "万象");
  assert.ok(config.files.includes("resources/**"));
  const icns = await readFile(new URL(config.mac.icon, root));
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const ico = await readFile(new URL(config.win.icon, root));
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16] || 256);
  for (const size of [16, 32, 48, 256]) assert.ok(sizes.includes(size));
  for (const [name, size] of [["icon.png", 1024], ["tray.png", 22], ["tray@2x.png", 44], ["trayTemplate.png", 22], ["trayTemplate@2x.png", 44]]) {
    const png = await readFile(new URL(`resources/${name}`, root));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

test("Windows popup follows bottom, top and side taskbars and stays within each display work area", () => {
  const h = harness("win32", true);
  const cases = [
    [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1830, y: 1040, width: 24, height: 40 }, { x: 1512, y: 512 }],
    [{ x: 0, y: 40, width: 1920, height: 1040 }, { x: 1830, y: 0, width: 24, height: 40 }, { x: 1512, y: 48 }],
    [{ x: -1920, y: 0, width: 1840, height: 1080 }, { x: -80, y: 900, width: 80, height: 24 }, { x: -488, y: 552 }],
    [{ x: 80, y: 0, width: 1840, height: 1080 }, { x: 0, y: 900, width: 80, height: 24 }, { x: 88, y: 552 }],
  ];
  for (const [workArea, bounds, position] of cases) {
    h.screen.display = { scaleFactor: 1.5, workArea };
    h.trays[0].bounds = bounds;
    h.desktop.show();
    assert.deepEqual(h.panel.bounds, { ...position, width: 400, height: 520 });
  }
  h.trays[0].bounds = { x: 0, y: 0, width: 0, height: 0 };
  h.screen.display = { workArea: { x: 0, y: 0, width: 800, height: 600 } };
  h.screen.emit("display-removed");
  assert.deepEqual(h.panel.bounds, { x: 392, y: 72, width: 400, height: 520 });
  h.desktop.dispose();
});
test("Windows tray click toggles only the popup and ordinary dismissal cancels once", () => {
  const h = harness("win32", true);
  h.control.hidden = true;
  h.trays[0].emit("click");
  h.trays[0].emit("click");
  assert.equal(h.panel.hidden, true);
  assert.equal(h.hidden.length, 1);
  h.trays[0].emit("double-click");
  assert.equal(h.panel.hidden, false);
  assert.equal(h.control.hidden, true);
  h.desktop.dispose();
});

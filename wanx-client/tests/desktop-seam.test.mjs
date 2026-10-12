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

function harness(platform = "darwin") {
  let state = ready;
  const opened = [], errors = [], sent = [], images = [], menus = [], trays = [];
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, getVersion: () => "0.1.0", setAboutPanelOptions: (options) => { app.about = options; },
    dock: { setIcon: (icon) => { app.dockIcon = icon; } },
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
  const Menu = {
    buildFromTemplate(template) {
      const all = (items) => items.flatMap((item) => [item, ...all(item.submenu || [])]);
      return { items: template, getMenuItemById: (id) => all(template).find((item) => item.id === id) };
    },
    setApplicationMenu: (menu) => menus.push(menu),
  };
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; trays.push(this); }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const client = { snapshot: () => state };
  const desktop = createDesktopIntegration({
    app, Menu, Tray, control, client, platform,
    nativeImage: { createFromPath(path) { const image = { path, setTemplateImage(value) { this.template = value; } }; images.push(image); return image; } },
    openDashboard: () => openConnectedDashboard(client, { open: (snapshot) => opened.push(snapshot.connection) }),
    onError: (error) => errors.push(error.message),
  });
  return { app, control, desktop, menus, trays, images, opened, sent, errors, update(next, publish = true) { state = next; if (publish) desktop.sync(state); } };
}

test("macOS menus and tray expose the current box, restore the window and revoke stale actions", async () => {
  const h = harness();
  assert.equal(h.app.about.applicationName, DESKTOP_NAME);
  assert.match(h.app.dockIcon, /icon\.png$/);
  assert.equal(h.trays[0].icon.template, true);
  assert.match(h.trays[0].icon.path, /trayTemplate\.png$/);
  assert.match(h.trays[0].menu.getMenuItemById("connection-status").label, /测试盒子 102/);
  h.control.hidden = true;
  h.control.minimized = true;
  h.menus[0].getMenuItemById("settings").click();
  assert.equal(h.control.hidden, false);
  assert.equal(h.control.minimized, false);
  assert.equal(h.control.focused, true);
  assert.deepEqual(h.sent, [["wanx-client:navigate", "settings"]]);
  await h.trays[0].menu.getMenuItemById("dashboard").click();
  assert.deepEqual(h.opened, [ready.connection]);
  h.update({ ...ready, connection: null, phase: "disconnected" }, false);
  await h.menus[0].getMenuItemById("dashboard").click();
  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.errors, ["BOX_CONNECTION_REQUIRED"]);
  h.update({ ...ready, account: { phase: "signed_out" } });
  for (const menu of [h.menus[0], h.trays[0].menu]) {
    assert.equal(menu.getMenuItemById("dashboard").enabled, false);
    assert.equal(menu.getMenuItemById("settings").enabled, false);
  }
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
  const h = harness("win32");
  assert.match(h.trays[0].icon.path, /icon\.ico$/);
  assert.equal(h.trays[0].icon.template, undefined);
  const roles = h.menus[0].items.flatMap((item) => item.submenu || []).map((item) => item.role);
  for (const role of ["copy", "paste", "selectAll", "minimize", "close", "quit"]) assert.ok(roles.includes(role), role);
  assert.ok(!roles.includes("hide"));
  h.desktop.dispose();
});

test("packaging ships readable platform icons and Retina tray artwork", async () => {
  const root = new URL("../", import.meta.url);
  const config = JSON.parse(await readFile(new URL("package.json", root), "utf8")).build;
  assert.ok(config.files.includes("resources/**"));
  const icns = await readFile(new URL(config.mac.icon, root));
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const ico = await readFile(new URL(config.win.icon, root));
  assert.equal(ico.readUInt16LE(2), 1);
  const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + index * 16] || 256);
  for (const size of [16, 32, 48, 256]) assert.ok(sizes.includes(size));
  for (const [name, size] of [["icon.png", 1024], ["trayTemplate.png", 22], ["trayTemplate@2x.png", 44]]) {
    const png = await readFile(new URL(`resources/${name}`, root));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
});

import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

// Exercise Chromium's native mouse sequence: element.click() cannot reproduce
// a control being replaced by a state broadcast between mouseDown and mouseUp.
let window;
const errors = [];
let radioStatus = "available";
const settingsOpened = [];
const state = {
  phase: "idle",
  account: { phase: "authenticated", accountId: "interaction-test" },
  network: { enabled: false, phase: "disabled" },
  platform: { phase: "idle" },
  devices: [{ deviceId: "box-test", displayName: "交互测试盒子", deviceRole: "owner", accessState: "ready" }],
  applications: [],
  desktopStartup: { supported: true, enabled: false, reason: "初始启动状态" },
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verify() {
  try {
    await app.whenReady();
    ipcMain.handle("wanx:discovery:bluetooth-state", () => ({ status: radioStatus }));
    ipcMain.handle("wanx:discovery:open-bluetooth-settings", (_event, section) => { settingsOpened.push(section); return { ok: true }; });
    for (const method of ["state", "reset", "resume"]) ipcMain.handle(`wanx:setup:${method}`, () => ({ ok: true, value: { state: "idle" } }));
    ipcMain.handle("wanx-client:get-state", () => state);
    ipcMain.handle("wanx-client:market-list", () => ({ items: [] }));
    ipcMain.handle("wanx-client:ownership-list", () => []);
    window = new BrowserWindow({
      show: false, width: 1180, height: 900,
      webPreferences: {
        preload: fileURLToPath(new URL("../../local-ui/remote-preload.cjs", import.meta.url)),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    window.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
    await window.loadFile(fileURLToPath(new URL("../../local-ui/renderer/index.html", import.meta.url)));
    const js = source => window.webContents.executeJavaScript(source);
    await js(`window.until = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error('UI timeout');
    }; void 0;`);
    await js(`until(() => !!document.querySelector('[data-action="show-settings"]') && document.querySelector('.market-section')?.getAttribute('aria-busy') === 'false')`);

    async function pointFor(action) {
      return js(`(() => {
        const element = document.querySelector('[data-action="${action}"]');
        element.scrollIntoView({ block: 'center' });
        const rect = element.getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      })()`);
    }
    async function click(action, between) {
      const point = await pointFor(action);
      window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      // Allow Chromium to dispatch mouseDown before injecting IPC.
      await pause(60);
      if (between) await between();
      window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await pause(60);
    }

    await click("show-settings");
    await js(`until(() => !!document.querySelector('[data-action="logout"]'))`);
    await js(`window.originalButton = document.querySelector('[data-action="show-boxes"]'); void 0;`);
    window.webContents.send("wanx-client:state", state);
    await pause(80);
    assert.equal(await js(`window.originalButton === document.querySelector('[data-action="show-boxes"]')`), true,
      "unchanged state must preserve the actual control node");

    await click("show-boxes", async () => {
      state.desktopStartup.reason = "广播更新后的启动状态";
      window.webContents.send("wanx-client:state", state);
      await pause(80);
    });
    assert.equal(await js(`!!document.querySelector('[aria-label="设备管理"]')`), true,
      "a state broadcast during mouseDown must not swallow the first click");
    await js(`until(() => document.querySelector('[data-action="transfer-refresh"]')?.getAttribute('aria-busy') === 'false')`);
    for (const selector of ['[data-action="transfer-open"]', '.ownership-section']) {
      assert.equal(await js(`document.querySelector('${selector}')?.hidden === true`), true,
        `ownership UI must be hidden in the HTML itself: ${selector}`);
      assert.equal(await js(`getComputedStyle(document.querySelector('${selector}')).display`), "none");
    }
    // Stub the radio at the browser boundary; never start a real hardware scan.
    await js(`navigator.bluetooth.getAvailability = async () => true;
      window.scanCalls = 0;
      navigator.bluetooth.requestDevice = () => { window.scanCalls++; return new Promise((_resolve, reject) => { window.endScan = () => reject(new DOMException('No devices', 'NotFoundError')); }); };
      void 0;`);
    radioStatus = "unavailable";
    window.webContents.send("wanx:setup:ready");
    await click("provisioning");
    await js(`until(() => document.body.textContent.includes('请先开启蓝牙'))`);
    assert.equal(await js(`document.querySelector('[data-action="start-provisioning"]').disabled`), true);
    await click("start-provisioning");
    assert.equal(await js(`window.scanCalls`), 0, "powered-off radio must never start discovery");
    await click("bluetooth-settings");
    assert.deepEqual(settingsOpened, ["bluetooth"]);
    if (process.env.WANX_INTERACTIONS_SCREENSHOT) await writeFile(process.env.WANX_INTERACTIONS_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    radioStatus = "available";
    await click("bluetooth-refresh");
    await js(`until(() => !document.querySelector('[data-action="start-provisioning"]').disabled)`);
    await click("start-provisioning");
    assert.equal(await js(`document.querySelector('[data-action="start-provisioning"]').disabled`), true);
    assert.equal(await js(`document.querySelector('[data-action="start-provisioning"]').getAttribute('aria-busy')`), "true");
    assert.equal(await js(`(() => {
      const swatch = document.createElement('span'); swatch.style.backgroundColor = 'var(--fn-bg-secondary)'; document.body.append(swatch);
      const muted = getComputedStyle(swatch).backgroundColor; swatch.remove();
      return getComputedStyle(document.querySelector('[data-action="start-provisioning"]')).backgroundColor === muted;
    })()`), true, "active scan uses the muted disabled background");
    await click("start-provisioning");
    assert.equal(await js(`window.scanCalls`), 1, "disabled scan button must reject native repeat clicks");
    await js(`window.endScan(); void 0;`);
    await js(`until(() => !document.querySelector('[data-action="start-provisioning"]').disabled)`);
    assert.deepEqual(errors, []);
    console.log("INTERACTIONS_ELECTRON_PASS: stable controls, native first-click delivery during state broadcasts, ownership UI hidden in source DOM, Bluetooth preflight guidance, scan lock and recovery");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.exit(process.exitCode || 0);
  }
}
void verify();

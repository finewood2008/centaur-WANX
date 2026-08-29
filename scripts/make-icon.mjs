/**
 * 把 electron/icon.svg 栅格化成 PNG。
 *
 * 这台机器上没有 convert / rsvg-convert，但装了 Electron——直接用它的渲染器
 * 截一张图，顺便保证图标里的「万」用的是系统真字体。
 * 窗口必须真的显示出来（show:true）才能 capturePage，所以放到屏幕外去。
 */
import { app, BrowserWindow } from "electron";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;

app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();
await app.whenReady();

const win = new BrowserWindow({
  width: SIZE,
  height: SIZE,
  x: -2200,
  y: -2200,
  show: true,
  frame: false,
  skipTaskbar: true,
  webPreferences: { contextIsolation: true },
});

const svg = readFileSync(join(ROOT, "electron", "icon.svg"), "utf-8");
await win.loadURL(
  "data:text/html;charset=utf-8," +
    encodeURIComponent(`<html><body style="margin:0">${svg}</body></html>`),
);
await new Promise((r) => setTimeout(r, 600));
const image = await win.webContents.capturePage();
writeFileSync(join(ROOT, "electron", "icon.png"), image.toPNG());
console.log("图标已生成:", image.getSize().width + "×" + image.getSize().height);
app.exit(0);

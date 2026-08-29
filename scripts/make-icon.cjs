/**
 * 从半人马 logo 生成方形图标。
 *
 * 本机没有 convert / rsvg-convert，但装了 Electron——用它的渲染器把 logo
 * 摆在方形底上截图。顺便把 1446×1920、979KB 的原图压成界面用得起的尺寸。
 *
 * 用法：npm run icon
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const SOURCE = process.env.LOGO_SOURCE ?? join(ROOT, "public", "static", "logo.png");

/** 每张要出的图：文件名、边长、是否带圆角底。 */
const TARGETS = [
  { out: join(ROOT, "electron", "icon.png"), size: 512, plate: true },
  { out: join(ROOT, "public", "static", "logo-256.png"), size: 256, plate: false },
  { out: join(ROOT, "public", "static", "favicon.png"), size: 64, plate: true },
];

app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration();

function pageFor(src, size, plate) {
  // plate=true 时给一块暖纸色圆角底，桌面和标签页上才不会糊成一团；
  // plate=false 保留透明，界面里叠在自己的背景上。
  const body = plate
    ? `<div style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;
         background:#F0EEE6;display:flex;align-items:center;justify-content:center">
         <img src="${src}" style="width:${Math.round(size * 0.72)}px;height:${Math.round(size * 0.72)}px;object-fit:contain">
       </div>`
    : `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">
         <img src="${src}" style="max-width:100%;max-height:100%;object-fit:contain">
       </div>`;
  return `<html><body style="margin:0;background:transparent">${body}</body></html>`;
}

app.whenReady().then(async () => {
  // 用临时 HTML 文件 + 相对路径引图，而不是把整张图塞进 data URI：
  // 1.3MB 的 data URL 在连续加载时会 ERR_FAILED。
  const stage = join(ROOT, ".icon-stage");
  mkdirSync(stage, { recursive: true });
  const htmlPath = join(stage, "icon.html");

  // 复用同一个窗口、改尺寸——建了又销毁再建第二个，第二次 load 必 ERR_FAILED。
  const biggest = Math.max(...TARGETS.map((t) => t.size));
  const win = new BrowserWindow({
    width: biggest,
    height: biggest,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { contextIsolation: true },
  });

  for (const target of TARGETS) {
    writeFileSync(htmlPath, pageFor(`file://${SOURCE}`, target.size, target.plate), "utf-8");
    win.setContentSize(target.size, target.size);
    await win.loadFile(htmlPath);
    await new Promise((r) => setTimeout(r, 450));
    const image = await win.webContents.capturePage({
      x: 0,
      y: 0,
      width: target.size,
      height: target.size,
    });
    mkdirSync(join(target.out, ".."), { recursive: true });
    writeFileSync(target.out, image.toPNG());
    console.log("生成", target.out, image.getSize().width + "×" + image.getSize().height);
  }
  win.destroy();
  rmSync(stage, { recursive: true, force: true });
  app.exit(0);
}).catch((e) => {
  console.error("生成失败:", e && e.message ? e.message : e);
  app.exit(1);
});

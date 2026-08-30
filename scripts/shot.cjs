/**
 * 截一张界面的图。
 *
 * 改 UI 不能只靠「代码看起来对」——得真的看一眼。本机没有别的无头浏览器，
 * 项目里已经有 Electron（图标生成也用它），就不引新依赖了。
 *
 * 跑法：electron scripts/shot.cjs <url> <输出路径> [宽] [高] [等待毫秒]
 *
 * 需要图形会话。没有窗口服务器时（ssh 进去的机器、CI、某些沙箱），
 * BrowserWindow 会一直建不出来、进程挂住——加了 --headless / --disable-gpu
 * 也一样。那种环境下别用这个脚本，改在本地桌面上跑。
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");

const [url, out, w = "1440", h = "900", wait = "1500"] = process.argv.slice(2);

app.commandLine.appendSwitch("no-sandbox");
// 没有窗口服务器会话时，只有关掉 GPU / 走离屏渲染才起得来。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("headless");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: Number(w),
    height: Number(h),
    show: false,
    backgroundColor: "#FAF9F5",
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    await win.loadURL(url);
    // 首屏要等接口回来（助手列表、资料、历史都是 fetch 出来的）
    await new Promise((r) => setTimeout(r, Number(wait)));
    const image = await win.webContents.capturePage();
    writeFileSync(out, image.toPNG());
    console.log(`已截图 ${out}`);
  } catch (e) {
    console.error("截图失败:", e.message);
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
});

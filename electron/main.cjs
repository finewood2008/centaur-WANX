/**
 * 半人马AI-万象 · 桌面外壳
 *
 * Electron 主进程负责三件事：
 *   1. 按需拉起万象服务（已经在跑就直接复用，不重复起）
 *   2. 等它真的能应答了再加载界面——不然用户看到的是一片空白
 *   3. 退出时把自己拉起来的进程收掉
 *
 * 窗口里加载的就是 http://127.0.0.1:<port>，跟浏览器打开是同一套界面；
 * 好处是它有独立的缓存和窗口，不会像浏览器那样攥着旧页面不放。
 */
const { app, BrowserWindow, shell, Menu } = require("electron");
const { spawn } = require("node:child_process");
const { request } = require("node:http");
const { join } = require("node:path");
const { existsSync, appendFileSync, mkdirSync } = require("node:fs");
const { homedir } = require("node:os");

const ROOT = join(__dirname, "..");
const PORT = Number(process.env.WANXIANG_PORT ?? 8788);
const DSH_PORT = Number(process.env.WANXIANG_DSH_PORT ?? 8891);
const URL = `http://127.0.0.1:${PORT}`;

let serverProcess = null;
let win = null;

/**
 * 双击 .desktop 启动时没有终端，出了错什么都看不到。
 * 所有关键步骤都落到日志文件里，排查时看一眼就知道卡在哪。
 */
const LOG_DIR = join(homedir(), ".cache", "wanxiang");
const LOG_FILE = join(LOG_DIR, "desktop.log");
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  process.stdout.write(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch {
    /* 日志写不了也不该拖垮启动 */
  }
}

/** 这个外壳要求的界面契约版本。服务端 /health 的 ui 低于它就是老实例。 */
const REQUIRED_UI = 2;

/**
 * 端口上是什么。用 node:http 直连回环，绕开代理环境变量。
 *
 * 返回 "none"（没人）/ "ours"（自己人且版本够）/ "stale"（万象但版本旧）/
 * "foreign"（别的程序占着）。
 * 分清楚很重要：端口被一个老版本万象占着时直接复用，用户看到的还是旧界面——
 * 这正是「改了半天还是旧的」的由来。
 */
function probe() {
  return new Promise((resolve) => {
    const req = request({ hostname: "127.0.0.1", port: PORT, path: "/health", timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve("foreign"); return; }
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const info = JSON.parse(body);
          if (info.app === "wanxiang") {
            resolve(Number(info.ui) >= REQUIRED_UI ? "ours" : "stale");
            return;
          }
          // 旧版万象的 /health 只回 {ok:true,status:"up"}，没有 app 字段。
          // 认出这个形状，提示里才能说清是「旧版本的万象」而不是含糊的「另一个程序」。
          resolve(info.ok === true && info.status === "up" ? "stale" : "foreign");
        } catch {
          resolve("foreign");
        }
      });
      res.on("error", () => resolve("foreign"));
    });
    req.on("timeout", () => { req.destroy(); resolve("none"); });
    req.on("error", () => resolve("none"));
    req.end();
  });
}

async function isUp() {
  return (await probe()) === "ours";
}

function startServer() {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) throw new Error(`找不到 ${tsx}，先在项目目录跑一次 npm install`);
  log("拉起服务:", tsx, "src/server.ts", "端口", PORT);
  serverProcess = spawn(tsx, ["src/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      WANXIANG_PORT: String(PORT),
      WANXIANG_DSH_PORT: String(DSH_PORT),
      // Node 内置 fetch 默认不认 HTTP(S)_PROXY，配了代理的机器上调不通 DeepSeek。
      // NO_PROXY 必须带上，否则连回环也被塞进代理，DSH 永远探不到。
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout.on("data", (c) => log("[服务]", String(c).trim()));
  serverProcess.stderr.on("data", (c) => log("[服务错误]", String(c).trim()));
  serverProcess.on("exit", (code) => {
    log("服务进程退出，退出码", code);
    serverProcess = null;
  });
  serverProcess.on("error", (e) => log("服务进程起不来:", e.message));
}

async function waitUntilUp(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let ticks = 0;
  while (Date.now() < deadline) {
    if (await isUp()) return true;
    ticks += 1;
    if (ticks % 10 === 0) log("还在等服务…", Math.round((deadline - Date.now()) / 1000), "秒后放弃");
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function splash(title, detail) {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<html><head><meta charset="utf-8"><style>
      body{margin:0;height:100vh;display:grid;place-items:center;background:#FAF9F5;color:#141413;
        font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif}
      .box{text-align:center;max-width:440px;padding:24px}
      .mark{width:52px;height:52px;margin:0 auto 16px;border-radius:14px;background:#D97757;color:#fff;
        display:grid;place-items:center;font-size:24px;font-weight:700}
      h1{margin:0 0 6px;font-size:17px;font-weight:650}
      p{margin:0;color:#5C5A54;font-size:13.5px}
    </style></head><body><div class="box"><div class="mark">万</div>
    <h1>${title}</h1><p>${detail}</p></div></body></html>`)
  );
}

async function createWindow() {
  const iconPath = join(__dirname, "icon.png");
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: "半人马AI-万象",
    backgroundColor: "#FAF9F5",
    autoHideMenuBar: true,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // 外部链接不在应用里打开，扔给系统浏览器。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(splash("正在启动万象", "第一次启动要装载运行核心，通常十几秒。"));
  log("窗口已创建");

  const found = await probe();
  log(`端口 ${PORT} 探测结果: ${found}`);

  if (found === "stale" || found === "foreign") {
    const who = found === "stale" ? "一个旧版本的万象" : "另一个程序";
    log(`端口被${who}占着，拒绝复用`);
    await win.loadURL(
      splash(
        `端口 ${PORT} 被占用了`,
        `上面跑着${who}。用它的话你看到的还是旧界面，所以我不复用。<br><br>` +
          `先收掉它：<code style="background:#F0EEE6;padding:2px 6px;border-radius:5px">` +
          `pkill -f 'tsx src/server.ts'</code><br>然后重新打开本应用。`,
      ),
    );
    return;
  }

  const already = found === "ours";
  if (!already) {
    try {
      startServer();
    } catch (e) {
      log("拉起失败:", e.message);
      await win.loadURL(splash("没能启动", e.message));
      return;
    }
  }

  if (!(await waitUntilUp())) {
    log("等服务超时");
    await win.loadURL(
      splash("服务没起来", `端口 ${PORT} 一直没应答。日志在 ${LOG_FILE}，或到项目目录跑 npm start 看报什么错。`),
    );
    return;
  }

  log("服务就绪，加载界面", URL);
  await win.loadURL(URL);
}

Menu.setApplicationMenu(null);
// 这台机器上 chrome-sandbox 不是 root:4755，开沙箱会直接 FATAL。
// 正规修法见 README；本地自用先关掉。
app.commandLine.appendSwitch("no-sandbox");

process.on("uncaughtException", (e) => {
  log("未捕获异常:", e && e.stack ? e.stack : String(e));
});

app.whenReady().then(() => {
  log("=== 万象桌面启动 ===", "root=" + ROOT);
  return createWindow();
}).catch(async (e) => {
  log("启动失败:", e && e.stack ? e.stack : String(e));
  if (!win) {
    win = new BrowserWindow({ width: 720, height: 460, title: "半人马AI-万象", backgroundColor: "#FAF9F5" });
  }
  await win.loadURL(splash("启动失败", String(e && e.message ? e.message : e)));
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("before-quit", () => {
  // 只收自己拉起来的那个；用户手动跑的 npm start 不动它。
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill("SIGTERM");
});

import type { ApplicationManifest } from "./application-contracts.js";

const main = `import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createCentaurAIWanxClient, createHTTPTransport, createElectronSecureStore, operationRegistry, type CentaurAIWanxClient } from "centaurai-wanx";
import { applicationId, applicationName } from "../src/product.js";

const root = dirname(fileURLToPath(import.meta.url));
let session: CentaurAIWanxClient | undefined;
let agentId: string | undefined;
let epoch = 0;
const policy = { applicationId, operations: operationRegistry.filter(op => ["/api/auth/login", "/api/auth/me", "/api/auth/logout", "/api/settings/capabilities", "/api/applications/{application_id}/profile", "/api/applications/{application_id}/release", "/api/agents/{agent_id}/memory/atoms/list"].includes(op.path)).map(op => op.operationId), sockets: [] };
async function disconnect() { epoch++; const old = session; session = undefined; agentId = undefined; await old?.close(); }
await app.whenReady();
const credentials = createElectronSecureStore({ safeStorage, directory: app.getPath("userData") });
const document = pathToFileURL(join(root, "../../dist/index.html")).href;
const window = new BrowserWindow({ title: applicationName, width: 1100, height: 760, webPreferences: { preload: join(root, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
window.webContents.on("will-navigate", event => event.preventDefault());
let queue: Promise<unknown> = Promise.resolve();
ipcMain.handle("wanx-product:v1", (event, raw: { method: string; params?: Record<string, unknown> }) => {
  if (event.sender.id !== window.webContents.id || !event.senderFrame || event.senderFrame.parent || event.senderFrame.url.split("#")[0] !== document) return { ok: false, code: "IPC_SENDER_NOT_ALLOWED" };
  const run = async () => {
    const { method, params = {} } = raw;
    try {
      if (method === "auth.login") {
        await disconnect();
        const generation = epoch;
        const baseURL = String(params.baseURL ?? "");
        let token: string | null = null;
        const next = createCentaurAIWanxClient({ transport: createHTTPTransport({ baseURL, token: async () => token }), policy });
        try {
          const reply = await next.native.invoke("login_api_auth_login_post", { body: { username: String(params.username ?? ""), password: String(params.password ?? ""), captcha_token: typeof params.captcha_token === "string" ? params.captcha_token : null, application_id: applicationId } });
          const body = reply.body as Record<string, unknown>;
          if (reply.status !== 200 || typeof body.access_token !== "string") throw new Error("LOGIN_FAILED");
          token = body.access_token;
          const current = await next.modules.auth.me();
          if (current.status !== 200 || epoch !== generation) throw new Error("SESSION_REJECTED");
          const identity = current.body as Record<string, unknown>;
          if (identity.application_id !== applicationId) throw new Error("APPLICATION_SCOPE_MISMATCH");
          await credentials.save(JSON.stringify({ baseURL, token }));
          session = next;
          return { ok: true, value: { username: identity.username, application_id: identity.application_id } };
        } catch (error) { await next.close(); throw error; }
      }
      if (method === "auth.logout") {
        try { await session?.modules.auth.logout(); } finally { await disconnect(); await credentials.clear(); }
        return { ok: true };
      }
      if (method === "connection.remote") throw new Error("APPLICATION_CONTRACT_NOT_SUPPORTED");
      if (!session) throw new Error("NOT_CONNECTED");
      let reply;
      if (method === "capabilities") reply = await session.modules.settings.getCapabilities();
      else if (method === "profile.open") { reply = await session.applications.createProfile(applicationId); if ((reply.status === 200 || reply.status === 201) && typeof reply.body.agent_id === "string") agentId = reply.body.agent_id; }
      else if (method === "memory.list") { if (!agentId) throw new Error("PROFILE_REQUIRED"); reply = await session.agents.use(agentId).memory.listAtoms({ body: { limit: 20 } }); }
      else if (method === "release.check") {
        const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : undefined;
        const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
        if (!platform || !arch) throw new Error("HOST_PLATFORM_NOT_SUPPORTED");
        reply = await session.applications.compatibleRelease(applicationId, { platform, arch, current_version: app.getVersion(), sdk_version: "0.1.0-alpha.3" });
      } else throw new Error("IPC_METHOD_NOT_ALLOWED");
      if (reply.status === 401 || reply.status === 403) { await disconnect(); await credentials.clear(); }
      if (reply.status < 200 || reply.status >= 300) throw new Error("SERVER_REJECTED_" + reply.status);
      return { ok: true, value: reply.body };
    } catch (error) { await disconnect(); await credentials.clear(); return { ok: false, code: error instanceof Error ? error.message : "REQUEST_FAILED" }; }
  };
  const result = queue.then(run, run); queue = result; return result;
});
window.on("closed", () => { void disconnect(); ipcMain.removeHandler("wanx-product:v1"); });
app.on("window-all-closed", () => app.quit());
await window.loadURL(document);
`;

const renderer = `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { applicationName } from "./product.js";
import "./style.css";
declare global { interface Window { wanxProduct: { call(method: string, params?: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; code?: string }> } } }
function App() {
  const [box, setBox] = useState(""); const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [boxes, setBoxes] = useState<string[]>(() => JSON.parse(localStorage.getItem("wanx-boxes") ?? "[]"));
  const [busy, setBusy] = useState(false); const [connected, setConnected] = useState(false); const [result, setResult] = useState("请选择盒子并登录。");
  async function invoke(method: string, params?: Record<string, unknown>) {
    setBusy(true);
    try {
      const reply = await window.wanxProduct.call(method, params);
      if (!reply.ok) { setResult(reply.code ?? "REQUEST_FAILED"); setConnected(false); return; }
      if (method === "auth.login") { setConnected(true); const next = [...new Set([...boxes, box])]; setBoxes(next); localStorage.setItem("wanx-boxes", JSON.stringify(next)); }
      if (method === "auth.logout") setConnected(false);
      setResult(JSON.stringify(reply.value ?? "完成", null, 2));
    } finally { setBusy(false); setPassword(""); }
  }
  return <main><header><small>基于 centaurai-wanx SDK</small><h1>{applicationName}</h1><p>{connected ? "当前盒子：" + box : "未连接"}</p></header><section><h2>盒子与账号</h2><label>已登记盒子<select disabled={busy || connected} value={box} onChange={e => setBox(e.target.value)}><option value="">选择或输入地址</option>{boxes.map(url => <option key={url}>{url}</option>)}</select></label><label>可信 HTTPS 地址（本机可使用 HTTP）<input disabled={busy || connected} value={box} onChange={e => setBox(e.target.value)} placeholder="https://your-box.example" /></label><label>用户名<input disabled={busy} value={username} onChange={e => setUsername(e.target.value)} /></label><label>密码<input disabled={busy} type="password" value={password} onChange={e => setPassword(e.target.value)} /></label><button disabled={busy || connected || !box || !username || !password} onClick={() => void invoke("auth.login", { baseURL: box, username, password })}>登录这台盒子</button><button disabled={busy || !connected} onClick={() => void invoke("auth.logout")}>断开与退出</button><p>产品连接身份待正式登记；签票与 P2P 入口暂不可用。</p></section><section><h2>原生能力示例</h2><button disabled={busy || !connected} onClick={() => void invoke("capabilities")}>查询能力</button><button disabled={busy || !connected} onClick={() => void invoke("profile.open")}>创建或打开我的应用档案</button><button disabled={busy || !connected} onClick={() => void invoke("memory.list")}>调用 WANX 原生记忆</button><button disabled={busy || !connected} onClick={() => void invoke("release.check")}>检查兼容版本</button><pre aria-live="polite">{result}</pre></section></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
`;

export function projectTemplates(manifest: ApplicationManifest): Record<string, string> {
  const { product } = manifest;
  return {
    "package.json": JSON.stringify({ name: product.application_id.replace(/\./gu, "-"), version: "0.1.0", private: true, license: "UNLICENSED", type: "module", main: "dist-electron/electron/main.js", scripts: { build: "tsc -p tsconfig.json && vite build", start: "electron .", "package:mac": "npm run build && electron-builder --mac", "package:win": "npm run build && electron-builder --win" }, dependencies: { "centaurai-wanx": "file:vendor/centaurai-wanx.tgz", react: "18.3.1", "react-dom": "18.3.1" }, devDependencies: { "@types/node": "22.20.4", "@types/react": "18.3.30", "@types/react-dom": "18.3.7", typescript: "5.8.3", vite: "6.4.3", electron: "37.10.3", "electron-builder": "26.15.3" }, build: { appId: product.application_id, productName: product.name, files: ["dist/**", "dist-electron/**", "package.json"], asarUnpack: ["node_modules/centaurai-wanx/native/bin/**"], mac: { target: ["dmg", "zip"] }, win: { target: ["nsis"] } } }, null, 2) + "\n",
    "application.manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", jsx: "react-jsx", outDir: "dist-electron", rootDir: ".", lib: ["ES2022", "DOM"], skipLibCheck: true }, include: ["electron/**/*.ts", "electron/**/*.cts", "src/**/*.ts", "src/**/*.tsx"] }, null, 2) + "\n",
    "vite.config.mjs": 'import { defineConfig } from "vite";\nexport default defineConfig({ base: "./", build: { outDir: "dist" } });\n',
    "index.html": '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; connect-src \'none\'"><title>WANX 应用</title></head><body><div id="root"></div><script type="module" src="/src/App.tsx"></script></body></html>\n',
    "electron/main.ts": main,
    "electron/preload.cts": 'import { contextBridge, ipcRenderer } from "electron";\nconst methods = new Set(["auth.login", "auth.logout", "capabilities", "profile.open", "memory.list", "release.check"]);\ncontextBridge.exposeInMainWorld("wanxProduct", Object.freeze({ call: (method: string, params?: Record<string, unknown>) => methods.has(method) ? ipcRenderer.invoke("wanx-product:v1", { method, params }) : Promise.resolve({ ok: false, code: "IPC_METHOD_NOT_ALLOWED" }) }));\n',
    "src/product.ts": 'export const applicationId = ' + JSON.stringify(product.application_id) + ';\nexport const applicationName = ' + JSON.stringify(product.name) + ';\n',
    "src/App.tsx": renderer,
    "src/style.css": 'body{margin:0;background:#f4f5f7;color:#18304a;font:16px system-ui}main{max-width:940px;margin:40px auto;padding:24px}header{margin-bottom:32px}section{background:white;border:1px solid #e1e6ec;border-radius:12px;padding:24px;margin:20px 0}label{display:block;margin:12px 0}input,select{display:block;box-sizing:border-box;width:100%;padding:10px;margin-top:5px;border:1px solid #ccd4de;border-radius:6px}button{padding:10px 16px;margin:6px;border:0;border-radius:6px;background:#245fa4;color:white}button:disabled{opacity:.4}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:20px;background:#f4f5f7}small,p{color:#5e7185}\n',
    ".gitignore": "node_modules/\ndist/\ndist-electron/\nrelease/\n*.credentials.enc\n",
    "LICENSE": "公司私有产品。保留所有权利。未经权利人书面许可，不得复制、分发或再许可本项目；第三方依赖遵循各自许可证。\n",
    "README.md": '# ' + product.name + '\n\n由 WANX 应用中心生成的 TypeScript / React / Electron 工程，使用公司私有 centaurai-wanx SDK。\n\n## 开发\n\n```sh\nnpm install\nnpm run build\nnpm start\n```\n\nSDK 已复制到 vendor/centaurai-wanx.tgz，无需公开 npm 包。其他开发依赖按 package.json 安装；Node.js 22 或更新版本。macOS / Windows 安装包分别使用 npm run package:mac / npm run package:win，签名证书由正式发布环境提供。\n\n## 接入\n\n先由管理员将 application.manifest.json 导入盒子、启用产品并给用户授权，再使用该用户登录。界面可登记可信 HTTPS 盒子；本机模拟服务可使用回环 HTTP。切换盒子必须先断开。Token、加密持久化和 SDK 请求只在 Electron main；renderer 通过固定 IPC 方法调用，不能选任意路径、注入 token 或指定其他用户。\n\n点击“创建或打开我的应用档案”使用服务端应用域 profile，再调用 WANX 原生 memory；项目不实现自己的记忆数据库。生成清单不包含账号、用户实例、凭据和私人记忆。模板更新与已存在用户档案分开管理。\n\n## 远程与发布边界\n\n新产品的正式网络身份仍为 pending。本工程不会借用 omnia-desktop 身份；签票、统一身份和 P2P 接入须等待平台正式登记合同后接入。此版本使用可信 HTTPS 或本机模拟服务进行联调。不得将一次本机 HTTP 成功标为真实盒子通过。\n\n安装包在外部构建、托管，将 URL、SHA256、系统架构和最低 WANX/SDK 版本登记到产品中心。检查版本仅显示兼容建议，不自动下载运行安装包。远程连接、macOS/Windows 打包、系统签名与安装需分别验收。\n',
  };
}

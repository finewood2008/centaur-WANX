import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";
import { runPipeline, writeAppPackage } from "./pipeline";
import { deepseekFromEnv } from "./definer/deepseek";
import { conductDialog, generateFromConversation, type ChatMessage } from "./definer/interviewer";
import { slugFromName } from "./appspec/slug";
import type { AppSpec } from "./appspec/schema";

const PORT = Number(process.env.WANXIANG_PORT ?? 8787);
const DSH_PORT = Number(process.env.WANXIANG_DSH_PORT ?? 8891);
const APPS_DIR = process.env.WANXIANG_APPS ?? join(process.cwd(), "apps");
const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, "..", "public", "index.html");
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(__dirname, "..", ".dsh-home");
const DSH_BIN = join(__dirname, "..", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const DSH_PATCH = join(DSH_HOME, "wanxiang-web.patch.yml");
const DSH_SETTINGS = join(DSH_HOME, "settings.yaml");
const DSH_URL = `http://127.0.0.1:${DSH_PORT}`;

type AppSummary = {
  slug: string;
  name: string;
  description: string;
  goal: string;
  domain: AppSpec["domain"];
  capabilities: AppSpec["capabilities"];
  memoryBinding: AppSpec["memory_binding"];
  delivery: AppSpec["delivery"];
  params: AppSpec["params"];
};

function appSummary(slug: string, appspec: AppSpec): AppSummary {
  return {
    slug,
    name: appspec.name,
    description: appspec.description,
    goal: appspec.goal,
    domain: appspec.domain,
    capabilities: [...appspec.capabilities],
    memoryBinding: {
      read: [...appspec.memory_binding.read],
      write: [...appspec.memory_binding.write],
      retrieval: appspec.memory_binding.retrieval,
    },
    delivery: { ...appspec.delivery },
    params: appspec.params.map((param) => ({
      ...param,
      options: param.options ? [...param.options] : undefined,
    })),
  };
}

function summaryFromStoredMeta(slug: string, raw: unknown): AppSummary | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const meta = raw as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name : slug;
  const description = typeof meta.description === "string" ? meta.description : "";
  const goal = typeof meta.goal === "string" ? meta.goal : description;
  const domain = typeof meta.domain === "string" ? meta.domain : "general";
  const capabilities = Array.isArray(meta.capabilities)
    ? meta.capabilities.filter((item): item is AppSpec["capabilities"][number] => typeof item === "string")
    : [];
  const memory = meta.memory_binding;
  const memoryBinding =
    memory && typeof memory === "object" && !Array.isArray(memory)
      ? (memory as AppSpec["memory_binding"])
      : { read: ["*"], write: [], retrieval: "semantic" as const };
  const delivery =
    meta.delivery && typeof meta.delivery === "object" && !Array.isArray(meta.delivery)
      ? (meta.delivery as AppSpec["delivery"])
      : { form: goal, trigger: "conversational" as const, output: "chat" as const };
  const params = Array.isArray(meta.params) ? (meta.params as AppSpec["params"]) : [];
  return { slug, name, description, goal, domain: domain as AppSpec["domain"], capabilities, memoryBinding, delivery, params };
}

async function readAppSummary(slug: string): Promise<AppSummary | null> {
  try {
    const text = await readFile(join(APPS_DIR, slug, "app.yml"), "utf-8");
    return summaryFromStoredMeta(slug, load(text));
  } catch {
    return null;
  }
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseMessages(input: unknown): ChatMessage[] | null {
  if (!Array.isArray(input)) return null;
  const msgs: ChatMessage[] = [];
  for (const m of input) {
    if (typeof m !== "object" || m === null) continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    msgs.push({ role, content: typeof content === "string" ? content : "" });
  }
  return msgs;
}

/** 把应用包落盘到 apps/<slug>/，同时把 preset 装到 DSH_HOME/.agent-presets/<slug>/。 */
async function installApp(slug: string, files: Record<string, string>): Promise<string> {
  const appDir = join(APPS_DIR, slug);
  await writeAppPackage(files, appDir);
  const presetDir = join(DSH_HOME, ".agent-presets", slug);
  await mkdir(presetDir, { recursive: true });
  await writeFile(join(presetDir, "preset.yml"), files["preset.yml"] ?? "", "utf-8");
  await writeFile(join(presetDir, "agent.cordis.yml"), files["agent.cordis.yml"] ?? "", "utf-8");
  await writeDshDefaultPreset(slug);
  return appDir;
}

async function writeDshPatch(): Promise<void> {
  const patch = [
    "# Generated by Wanxiang. DSH is the runtime core behind the Wanxiang product.",
    "- id: ui-brand-official",
    "  disabled: true",
    "# Keep directory selection inside Wanxiang instead of opening a chooser on the server host.",
    "- id: directory-picker",
    "  disabled: true",
    "- insert:",
    "    - id: directory-picker-browser-host",
    "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    "    - id: directory-picker-browser-client",
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    "",
  ].join("\n");
  await mkdir(DSH_HOME, { recursive: true });
  await writeFile(DSH_PATCH, patch, "utf-8");
}

async function writeDshDefaultPreset(slug: string): Promise<void> {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = load(await readFile(DSH_SETTINGS, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // A new DSH home has no settings file yet.
  }
  const previous = settings["agent-presets"];
  const agentPresets = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : {};
  settings["agent-presets"] = { ...agentPresets, default: slug };
  await mkdir(DSH_HOME, { recursive: true });
  await writeFile(DSH_SETTINGS, dump(settings, { noRefs: true, lineWidth: 100 }), "utf-8");
}

async function acknowledgeDshOnboarding(): Promise<void> {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = load(await readFile(DSH_SETTINGS, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // A new DSH home has no settings file yet.
  }
  const previous = settings["ui-onboarding"];
  const onboarding = previous && typeof previous === "object" && !Array.isArray(previous)
    ? previous as Record<string, unknown>
    : {};
  settings["ui-onboarding"] = { ...onboarding, welcomeNoticeVersion: "2026-08-13.1" };
  const previousLocale = settings.locale;
  const locale = previousLocale && typeof previousLocale === "object" && !Array.isArray(previousLocale)
    ? previousLocale as Record<string, unknown>
    : {};
  settings.locale = { ...locale, preference: "zh" };
  await mkdir(DSH_HOME, { recursive: true });
  await writeFile(DSH_SETTINGS, dump(settings, { noRefs: true, lineWidth: 100 }), "utf-8");
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { messages?: unknown; generate?: unknown };
    const messages = parseMessages(body.messages);
    if (messages === null) {
      return json(res, 400, { ok: false, error: "缺少 messages 数组" });
    }

    const llm = deepseekFromEnv();

    if (body.generate === true) {
      const outcome = await generateFromConversation(messages, llm);
      if (outcome.done && outcome.app) {
        const slug = slugFromName(outcome.app.name);
        const appDir = await installApp(slug, outcome.app.files);
        json(res, 200, {
          ok: true,
          done: true,
          reply: outcome.reply,
          app: {
            ...appSummary(slug, outcome.app.appspec),
            dir: appDir,
          },
        });
      } else {
        json(res, 200, { ok: true, done: false, reply: outcome.reply });
      }
      return;
    }

    const guide = await conductDialog(messages, llm);
    json(res, 200, { ok: true, done: false, reply: guide.text, options: guide.options ?? [] });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { intent?: unknown };
    const intent = typeof body.intent === "string" ? body.intent.trim() : "";
    if (!intent) {
      return json(res, 400, { ok: false, error: "缺少 intent 字段" });
    }

    const llm = deepseekFromEnv();
    const r = await runPipeline(intent, llm, { includeCentaurPlugins: false });
    if (!r.ok) {
      return json(res, 422, { ok: false, error: r.error });
    }

    const slug = slugFromName(r.appspec.name);
    const appDir = await installApp(slug, r.files);

    json(res, 200, {
      ok: true,
      ...appSummary(slug, r.appspec),
      repairs: r.repairs,
      dir: appDir,
    });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}

async function handleListApps(res: ServerResponse): Promise<void> {
  try {
    await mkdir(APPS_DIR, { recursive: true });
    const names = await readdir(APPS_DIR, { withFileTypes: true });
    const apps = (await Promise.all(
      names.filter((d) => d.isDirectory()).map((d) => readAppSummary(d.name)),
    )).filter((app): app is AppSummary => app !== null);
    json(res, 200, { ok: true, apps });
  } catch {
    json(res, 200, { ok: true, apps: [] });
  }
}

async function handleActivate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { app?: unknown };
    const app = typeof body.app === "string" ? body.app.trim() : "";
    if (!/^[a-z0-9-]+$/u.test(app)) {
      return json(res, 400, { ok: false, error: "无效的 Agent 标识" });
    }
    if (await readAppSummary(app) === null) {
      return json(res, 404, { ok: false, error: "Agent 不存在" });
    }
    await writeDshDefaultPreset(app);
    json(res, 200, { ok: true, app });
  } catch (error) {
    json(res, 500, { ok: false, error: (error as Error).message });
  }
}

let dshWebProcess: ChildProcess | null = null;
let dshStartPromise: Promise<string> | null = null;

function dshIsReady(): Promise<boolean> {
  return fetch(DSH_URL, { signal: AbortSignal.timeout(1500) })
    .then(async (response) => response.ok && (await response.text()).includes("__DSH_BOOT__"))
    .catch(() => false);
}

async function waitForDsh(child: ChildProcess): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DSH Web 启动失败（退出码 ${child.exitCode}）`);
    }
    if (await dshIsReady()) return DSH_URL;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DSH Web 启动超时，请检查端口 ${DSH_PORT}`);
}

async function ensureDshWeb(): Promise<string> {
  if (await dshIsReady()) return DSH_URL;
  if (dshStartPromise) return dshStartPromise;

  dshStartPromise = (async () => {
    await writeDshPatch();
    await acknowledgeDshOnboarding();
    const child = spawn(
      process.execPath,
      [DSH_BIN, "web", "--patch", DSH_PATCH, "--no-open", "--host", "127.0.0.1", "--port", String(DSH_PORT)],
      {
        cwd: join(__dirname, ".."),
        env: { ...process.env, DSH_HOME },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    dshWebProcess = child;

    let stderr = "";
    let spawnError: Error | null = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => process.stdout.write(`[DSH] ${chunk}`));
    child.once("exit", () => {
      if (dshWebProcess === child) dshWebProcess = null;
    });

    try {
      if (spawnError) throw spawnError;
      return await waitForDsh(child);
    } catch (error) {
      if (child.exitCode === null) child.kill("SIGTERM");
      const detail = stderr.trim().split(/\r?\n/u).at(-1);
      throw new Error(detail ? `${(error as Error).message}: ${detail}` : (error as Error).message);
    }
  })();

  try {
    return await dshStartPromise;
  } finally {
    dshStartPromise = null;
  }
}

async function handleDsh(res: ServerResponse): Promise<void> {
  try {
    await ensureDshWeb();
    json(res, 200, { ok: true, dshUrl: "/runtime/" });
  } catch (error) {
    json(res, 503, { ok: false, error: (error as Error).message });
  }
}

function brandRuntimeHtml(html: string): string {
  const branding = `<style>
    #wanxiang-create-agent {
      display: flex;
      min-height: 38px;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin: 7px 14px 3px;
      padding: 0 12px;
      border: 1px solid #e1e2e4;
      border-radius: 10px;
      background: #fff;
      color: #15171a;
      font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      text-decoration: none;
      white-space: nowrap;
    }
    #wanxiang-create-agent:hover { background: #f5f6f7; }
    #wanxiang-create-agent.wanxiang-create-compact { min-width: 38px; padding: 0; }
    #wanxiang-create-agent.wanxiang-create-compact .wanxiang-create-copy { display: none; }
    .wanxiang-create-icon { font-size: 18px; font-weight: 400; }
  </style><script>(() => {
    const replacements = new Map([
      ["DeepSeek Harness", "万象"],
      ["DSH Local Build", "万象"],
      ["Into the Unknown", "万象"],
      ["探索未至之境", "万象"]
    ]);
    const newSessionButton = () => document.querySelector(
      'button[aria-label="新建会话"], button[aria-label="新会话"], button[aria-label="New session"], button[aria-label="New Session"]'
    );
    const ensureCreatorLink = () => {
      const newSession = newSessionButton();
      if (!newSession) return;
      let link = document.getElementById("wanxiang-create-agent");
      if (!link) {
        link = document.createElement("a");
        link.id = "wanxiang-create-agent";
        link.href = "/";
        link.setAttribute("aria-label", "创建 Agent");
        link.title = "创建 Agent";
        link.classList.add("wanxiang-create-compact");
        link.innerHTML = '<span class="wanxiang-create-icon" aria-hidden="true">+</span><span class="wanxiang-create-copy">创建 Agent</span>';
        newSession.insertAdjacentElement("afterend", link);
      }
    };
    let activatedAgentStarted = false;
    const startActivatedAgent = () => {
      if (activatedAgentStarted || !new URLSearchParams(location.search).get("agent")) return;
      const button = newSessionButton();
      if (!button) return;
      activatedAgentStarted = true;
      setTimeout(() => button.click(), 350);
    };
    let scheduled = false;
    const apply = () => {
      scheduled = false;
      if (document.title !== "万象") document.title = "万象";
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const key = node.data.trim();
        const parent = node.parentElement;
        const smallBuildLabel = parent && /^[a-f0-9]{7}$/iu.test(key)
          && Number.parseFloat(getComputedStyle(parent).fontSize) <= 10;
        if (key === "Preview" || key === "预览版" || smallBuildLabel) {
          if (parent) parent.style.display = "none";
          continue;
        }
        const replacement = replacements.get(key);
        if (replacement) node.data = node.data.replace(key, replacement);
      }
      ensureCreatorLink();
      startActivatedAgent();
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(apply);
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    addEventListener("DOMContentLoaded", apply);
  })()</script>`;
  return html
    .replace("<title>DeepSeek Harness</title>", "<title>万象</title>")
    .replace("</body>", `${branding}</body>`);
}

function dshTargetPath(pathWithQuery: string): string {
  const incoming = new URL(pathWithQuery, "http://wanxiang.local");
  const targetPathname = incoming.pathname === "/runtime" || incoming.pathname === "/runtime/"
    ? "/"
    : incoming.pathname.startsWith("/runtime/") ? incoming.pathname.slice("/runtime".length) : incoming.pathname;
  return `${targetPathname}${incoming.search}`;
}

async function proxyDsh(req: IncomingMessage, res: ServerResponse, pathWithQuery: string): Promise<void> {
  await ensureDshWeb();
  const targetPath = dshTargetPath(pathWithQuery);
  const targetPathname = new URL(targetPath, DSH_URL).pathname;
  const headers = { ...req.headers };
  delete headers.connection;
  delete headers.host;
  delete headers.origin;
  delete headers.referer;
  headers.host = `127.0.0.1:${DSH_PORT}`;
  headers.origin = DSH_URL;
  headers.referer = `${DSH_URL}/`;

  await new Promise<void>((resolve, reject) => {
    const upstream = httpRequest(
      { hostname: "127.0.0.1", port: DSH_PORT, path: targetPath, method: req.method, headers },
      (upstreamRes) => {
        const responseHeaders = { ...upstreamRes.headers };
        delete responseHeaders.connection;
        if (targetPathname === "/" && String(responseHeaders["content-type"] ?? "").includes("text/html")) {
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          upstreamRes.on("end", () => {
            const body = Buffer.from(brandRuntimeHtml(Buffer.concat(chunks).toString("utf-8")), "utf-8");
            delete responseHeaders["content-length"];
            res.writeHead(upstreamRes.statusCode ?? 200, responseHeaders);
            res.end(body);
            resolve();
          });
          upstreamRes.on("error", reject);
          return;
        }
        res.writeHead(upstreamRes.statusCode ?? 200, responseHeaders);
        upstreamRes.pipe(res);
        upstreamRes.once("end", resolve);
        upstreamRes.once("error", reject);
      },
    );
    upstream.once("error", reject);
    req.pipe(upstream);
  });
}

async function proxyDshUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  pathWithQuery: string,
): Promise<void> {
  await ensureDshWeb();
  const headers = { ...req.headers };
  headers.host = `127.0.0.1:${DSH_PORT}`;
  headers.origin = DSH_URL;
  headers.referer = `${DSH_URL}/`;

  await new Promise<void>((resolve, reject) => {
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: DSH_PORT,
      path: dshTargetPath(pathWithQuery),
      method: req.method,
      headers,
    });

    upstream.once("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      const status = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`;
      const responseHeaders: string[] = [];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        responseHeaders.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
      }
      socket.write(`${[status, ...responseHeaders, "", ""].join("\r\n")}`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      socket.once("error", () => upstreamSocket.destroy());
      upstreamSocket.once("error", () => socket.destroy());
      socket.pipe(upstreamSocket).pipe(socket);
      resolve();
    });
    upstream.once("response", (upstreamRes) => {
      const status = `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? "Bad Gateway"}`;
      const responseHeaders: string[] = [];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        responseHeaders.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
      }
      socket.write(`${[status, ...responseHeaders, "", ""].join("\r\n")}`);
      upstreamRes.pipe(socket);
      upstreamRes.once("end", resolve);
      upstreamRes.once("error", reject);
    });
    upstream.once("error", reject);
    upstream.end();
  });
}

async function serveIndex(res: ServerResponse): Promise<void> {
  const html = await readFile(INDEX_HTML, "utf-8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  void (async () => {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      return serveIndex(res);
    }
    if (req.method === "POST" && path === "/api/chat") {
      return handleChat(req, res);
    }
    if (req.method === "POST" && path === "/api/create") {
      return handleCreate(req, res);
    }
    if (req.method === "GET" && path === "/api/apps") {
      return handleListApps(res);
    }
    if (req.method === "GET" && path === "/api/dsh") {
      return handleDsh(res);
    }
    if (req.method === "POST" && path === "/api/activate") {
      return handleActivate(req, res);
    }
    if (
      path === "/runtime" || path.startsWith("/runtime/") ||
      path === "/api" || path.startsWith("/api/") ||
      path.startsWith("/assets/") || path.startsWith("/plugins/") ||
      path === "/manifest.webmanifest" || path === "/favicon.svg"
    ) {
      return proxyDsh(req, res, `${path}${url.search}`);
    }
    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, status: "up" });
    }
    json(res, 404, { ok: false, error: "not found" });
  })().catch((e) => json(res, 500, { ok: false, error: (e as Error).message }));
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  void proxyDshUpgrade(req, socket, head, `${url.pathname}${url.search}`).catch(() => {
    if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`万象已启动: http://127.0.0.1:${PORT}`);
  console.log(`应用落盘目录: ${APPS_DIR}`);
  console.log(`DSH Web 入口: ${DSH_URL}（首次打开时启动）`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn("警告: 未设置 DEEPSEEK_API_KEY，创建应用会失败");
  }
});

server.once("close", () => {
  if (dshWebProcess?.exitCode === null) dshWebProcess.kill("SIGTERM");
});

function shutdown(): void {
  if (dshWebProcess?.exitCode === null) dshWebProcess.kill("SIGTERM");
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPipeline, writeAppPackage } from "./pipeline";
import { deepseekFromEnv } from "./definer/deepseek";
import { conductDialog, generateFromConversation, type ChatMessage } from "./definer/interviewer";
import { slugFromName } from "./appspec/slug";
import { WanxiangRuntime } from "./runtime/dsh-runtime";

const PORT = Number(process.env.WANXIANG_PORT ?? 8787);
const APPS_DIR = process.env.WANXIANG_APPS ?? join(process.cwd(), "apps");
const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, "..", "public", "index.html");
const DSH_HOME = join(__dirname, "..", ".dsh-home");

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
  return appDir;
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
            name: outcome.app.name,
            slug,
            domain: outcome.app.appspec.domain,
            capabilities: outcome.app.appspec.capabilities,
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
      name: r.appspec.name,
      slug,
      domain: r.appspec.domain,
      capabilities: r.appspec.capabilities,
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
    const apps = names.filter((d) => d.isDirectory()).map((d) => d.name);
    json(res, 200, { ok: true, apps });
  } catch {
    json(res, 200, { ok: true, apps: [] });
  }
}

// —— 应用运行：runtime 单例 + 会话缓存 ——
let runtimePromise: Promise<WanxiangRuntime> | null = null;
const runSessions = new Map<string, string>();

function getRuntime(): Promise<WanxiangRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      const rt = new WanxiangRuntime();
      await rt.boot({ dshHome: DSH_HOME });
      return rt;
    })();
  }
  return runtimePromise;
}

async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { app?: unknown; prompt?: unknown };
    const app = typeof body.app === "string" ? body.app.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!app || !prompt) {
      return json(res, 400, { ok: false, error: "缺少 app 或 prompt 字段" });
    }

    const rt = await getRuntime();
    let sessionId = runSessions.get(app);
    if (!sessionId) {
      sessionId = await rt.createSession(app, join(APPS_DIR, app));
      runSessions.set(app, sessionId);
    }
    const reply = await rt.runTask(sessionId, prompt);
    json(res, 200, { ok: true, reply });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}

async function serveIndex(res: ServerResponse): Promise<void> {
  const html = await readFile(INDEX_HTML, "utf-8");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  void (async () => {
    if (req.method === "GET" && (url === "/" || url === "/index.html")) {
      return serveIndex(res);
    }
    if (req.method === "POST" && url === "/api/chat") {
      return handleChat(req, res);
    }
    if (req.method === "POST" && url === "/api/create") {
      return handleCreate(req, res);
    }
    if (req.method === "POST" && url === "/api/run") {
      return handleRun(req, res);
    }
    if (req.method === "GET" && url === "/api/apps") {
      return handleListApps(res);
    }
    if (req.method === "GET" && url === "/health") {
      return json(res, 200, { ok: true, status: "up" });
    }
    json(res, 404, { ok: false, error: "not found" });
  })().catch((e) => json(res, 500, { ok: false, error: (e as Error).message }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`万象已启动: http://127.0.0.1:${PORT}`);
  console.log(`应用落盘目录: ${APPS_DIR}`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn("警告: 未设置 DEEPSEEK_API_KEY，创建应用会失败");
  }
});

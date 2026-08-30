import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";
import { runFinalize, runPipeline, writeAppPackage } from "./pipeline";
import { validateAppSpec } from "./appspec/validate";
import { compile } from "./compiler/compile";
import { serializePreset } from "./compiler/serialize";
import { deepseekFromEnv, verifyKey } from "./definer/deepseek";
import { configPath, keySource, maskKey, readConfig, resolveKey, syncKeyEnv, writeConfig } from "./config";
import {
  buildPmPrompt,
  fallbackAsk,
  OPENING,
  parsePmOutput,
  visiblePart,
  type ChatMessage,
} from "./definer/interviewer";
import {
  emptyDraft,
  applyPatch,
  applyAnswered,
  missingSlots,
  SLOT_KEYS,
  type PRDDraft,
  type SlotKey,
} from "./definer/draft";
import { slugFromName } from "./appspec/slug";
import type { AppSpec } from "./appspec/schema";
import { createAppAgent, runAgentTask } from "./runtime/run-agent";
import {
  listRuns,
  newRunId,
  readRun,
  saveRun,
  workspaceDir,
  type RunRecord,
} from "./runs";
import {
  deleteMaterial,
  listMaterials,
  saveMaterial,
  MAX_MATERIAL_BYTES,
} from "./materials";
import { addMcpServer, listMcpServers, removeMcpServer } from "./mcp";

/**
 * 应用落盘目录。**必须在 git 仓库之外。**
 *
 * DSH 发现项目技能时走 findProjectRoot——向上找 `.git`，找不到才用 cwd 本身。
 * 应用要是落在仓库里，所有应用的 projectRoot 都会解析到仓库根，共享同一个
 * `<repo>/.dsh/skills`，按应用隔离就没了。放在家目录下，每个应用的 workspace
 * 自己就是 projectRoot。
 */
export const APPS_DIR =
  process.env.WANXIANG_APPS ?? join(homedir(), ".local", "share", "wanxiang", "apps");
const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, "..", "public", "index.html");
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(__dirname, "..", ".dsh-home");
const DSH_SETTINGS = join(DSH_HOME, "settings.yaml");
/** MCP 行写在 wanxiang profile 的用户补丁层——boot 的 HMR 盯着它，改完热生效。 */
const MCP_PATCH_FILE = join(DSH_HOME, "profiles", "wanxiang", "cordis.patch.yml");

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
  /** 界面上「它会做的事」那一段。用户在第 7 节亲口排的步骤。 */
  workflow: AppSpec["workflow"];
  /** 「它不会做的事」。让用户看得见边界，比看不见更安心。 */
  boundaries: AppSpec["boundaries"];
  /** 有没有需求文档。走 /api/create 单发造出来的助手没有，界面不该给个点了 404 的按钮。 */
  hasPrd: boolean;
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
    workflow: { steps: [...appspec.workflow.steps] },
    boundaries: [...appspec.boundaries],
    hasPrd: false,
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
  const wf = meta.workflow;
  const steps =
    wf && typeof wf === "object" && !Array.isArray(wf) && Array.isArray((wf as { steps?: unknown }).steps)
      ? ((wf as { steps: unknown[] }).steps.filter((x): x is string => typeof x === "string"))
      : [];
  const boundaries = Array.isArray(meta.boundaries)
    ? meta.boundaries.filter((x): x is string => typeof x === "string")
    : [];
  return {
    slug, name, description, goal, domain: domain as AppSpec["domain"],
    capabilities, memoryBinding, delivery, params,
    workflow: { steps }, boundaries,
    hasPrd: false,
  };
}

async function readAppSummary(slug: string): Promise<AppSummary | null> {
  try {
    const text = await readFile(join(APPS_DIR, slug, "app.yml"), "utf-8");
    const summary = summaryFromStoredMeta(slug, load(text));
    if (!summary) return null;
    summary.hasPrd = await readFile(join(APPS_DIR, slug, "prd.md"), "utf-8").then(
      () => true,
      () => false,
    );
    return summary;
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

  // 技能装进**应用自己的 workspace**：`<workspace>/.dsh/skills/<name>/SKILL.md`。
  //
  // preset 里的 `customSkillDirs` / `includeDefaultRoots` 确实不生效（实测：写进
  // agent.cordis.yml 的 config 根本到不了 skill-filesystem 实例）。但 DSH 还有一条
  // 根是通的——findProjectRoot(cwd) 之下的 `.dsh/skills`。实测放在那儿的技能会被发现。
  //
  // 所以隔离的做法不是「挡住共享根」（关不掉），而是**让共享根保持空**：万象不再往
  // `$DSH_HOME/skills/` 写任何东西，每个应用只看得见自己 workspace 里的手册。
  // 前提是 APPS_DIR 在 git 仓库之外——见上面的注释。
  const workspace = workspaceDir(APPS_DIR, slug);
  for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith("skills/")) continue;
    const target = join(workspace, ".dsh", name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
  }

  // 这里**不**写 DSH default preset。生成不等于激活——
  // 「先跑一次给你看」那一下才激活，由 /api/activate 负责。
  return appDir;
}

/**
 * 自愈：把旧编译器装出来的 preset 升级到当前基线。
 *
 * 单进程融合之前，「跑一次」走 headless profile——host 平面直接给全套工具，
 * preset 里只有 persona + skill 也能干活。融合后跑在 web profile 上，preset
 * 说什么助手才有什么：旧 preset 连 tool-fs 都没有，助手读不了自己的资料。
 * 启动时按 app.yml（完整的 AppSpec 投影）重编译一遍，幂等，认不出的目录跳过。
 */
export async function healInstalledPresets(): Promise<void> {
  let slugs: string[];
  try {
    slugs = (await readdir(APPS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const slug of slugs) {
    try {
      const cordisPath = join(APPS_DIR, slug, "agent.cordis.yml");
      const current = await readFile(cordisPath, "utf-8");
      if (current.includes("@deepseek-ai/dsh-tool-fs")) continue; // 已是新基线

      const meta = load(await readFile(join(APPS_DIR, slug, "app.yml"), "utf-8"));
      const validated = validateAppSpec(meta);
      if (!validated.ok) continue;

      // 保留原 order（preset.yml 里的），别把用户的排序洗掉。
      let order = 0;
      try {
        const preset = load(await readFile(join(APPS_DIR, slug, "preset.yml"), "utf-8"));
        if (preset && typeof preset === "object" && typeof (preset as { order?: unknown }).order === "number") {
          order = (preset as { order: number }).order;
        }
      } catch {
        /* 没有就用 0 */
      }

      const { presetYml, agentCordisYml } = serializePreset(
        compile(validated.value, { includeCentaurPlugins: false, order }),
      );
      for (const dir of [join(APPS_DIR, slug), join(DSH_HOME, ".agent-presets", slug)]) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "preset.yml"), presetYml, "utf-8");
        await writeFile(join(dir, "agent.cordis.yml"), agentCordisYml, "utf-8");
      }
      console.log(`已把「${validated.value.name}」的 preset 升级到当前工具基线 (${slug})`);
    } catch {
      // 单个应用坏了不挡启动
    }
  }
}

/*
 * 曾经这里有个 pruneOrphanSkills()：技能装在共享的 $DSH_HOME/skills/ 下、助手之间
 * 不隔离，改过名的助手会留下旧 slug 的技能被所有人看见。技能改装进应用自己的
 * workspace 之后，共享根里不再有万象的东西，孤儿问题不存在了，那个补丁已删除。
 */

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

export async function acknowledgeDshOnboarding(): Promise<void> {
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

const MAX_TURNS = 20;

/** 界面契约版本。界面或接口有不兼容改动时 +1。3 = 单进程融合：API 迁到 /wanx/api，细聊在 /chat。 */
const UI_REVISION = 3;

/** 客户端告诉我们它刚回答的是哪个槽位。槽位名不合法就丢掉。 */
function parseAnswered(input: unknown): { slot: SlotKey; value: string | string[] } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as { slot?: unknown; value?: unknown };
  if (typeof obj.slot !== "string" || !(SLOT_KEYS as readonly string[]).includes(obj.slot)) return null;
  const value = Array.isArray(obj.value)
    ? obj.value.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : typeof obj.value === "string" && obj.value.trim() !== ""
      ? obj.value.trim()
      : null;
  if (value === null || (Array.isArray(value) && value.length === 0)) return null;
  return { slot: obj.slot as SlotKey, value };
}

function parseDraft(input: unknown): PRDDraft {
  if (!input || typeof input !== "object" || Array.isArray(input)) return emptyDraft();
  const obj = input as { slots?: unknown; derived?: unknown };
  const base = emptyDraft();
  // 走 applyPatch 做一遍清洗：客户端传来的东西不直接信。
  const { draft } = applyPatch(base, obj.slots, obj.derived);
  return draft;
}

/**
 * 产品经理的一轮：SSE 流式吐散文，结束时给出结构化的 patch / ask / 新草稿。
 *
 * 分隔符之前的字符实时推给界面，之后的攒起来解析——用户永远看不到 JSON。
 */
async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { messages?: unknown; draft?: unknown; turn?: unknown; answered?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
  }
  const messages = parseMessages(body.messages);
  if (messages === null) return json(res, 400, { ok: false, error: "缺少 messages 数组" });
  const draft = parseDraft(body.draft);
  const turn = Number.isFinite(Number(body.turn)) ? Math.max(0, Number(body.turn)) : 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!resolveKey()) {
    send("error", { error: "还没设置模型 key", needsKey: true });
    res.end();
    return;
  }

  try {
    const llm = deepseekFromEnv();
    const prompt = buildPmPrompt(messages, draft, turn);

    let raw = "";
    let emitted = 0;
    const flush = (final: boolean): void => {
      const visible = visiblePart(raw, final);
      if (visible.length > emitted) {
        send("delta", { text: visible.slice(emitted) });
        emitted = visible.length;
      }
    };

    if (typeof llm.stream === "function") {
      await llm.stream(prompt, (delta) => {
        raw += delta;
        flush(false);
      });
    } else {
      raw = await llm.complete(prompt);
    }
    flush(true);

    const parsed = parsePmOutput(raw);
    let { draft: nextDraft, touched } = applyPatch(draft, parsed.patch, parsed.derive);

    // 用户刚答过的那个槽位由**用户的原始选择**说了算，盖在模型的改写之上。
    // 见 applyAnswered 的注释：模型把三条步骤揉成一句，工作手册就只剩一行。
    const answered = parseAnswered(body.answered);
    const settled = applyAnswered(nextDraft, answered);
    nextDraft = settled.draft;
    touched = [...settled.touched, ...touched];

    const missing = missingSlots(nextDraft);
    const nextTurn = turn + 1;

    // 完整性由代码把关，**两头都管**：
    // 槽位没填满就不接受模型说的 done；填满了也不许它接着问——
    // 实测模型在 9/9 之后会一直重问同一个槽位，界面就卡在那儿转圈。
    const done = missing.length === 0 || nextTurn >= MAX_TURNS;
    // 「每一轮都有选择项」同样由代码兜底：模型没给合法选项就补一组。
    const ask = done ? null : (parsed.ask ?? fallbackAsk(missing[0]));

    send("done", {
      prose: parsed.prose,
      draft: nextDraft,
      touched,
      ask,
      done,
      turn: nextTurn,
      answered: 9 - missing.length,
    });
  } catch (e) {
    send("error", { error: (e as Error).message });
  } finally {
    res.end();
  }
}

/** 确认后组装：草稿 → 助手，落盘并装进 DSH。 */
async function handleFinalize(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as { draft?: unknown; turns?: unknown };
    const draft = parseDraft(body.draft);
    if (Object.keys(draft.slots).length === 0) {
      return json(res, 400, { ok: false, error: "还没聊出任何东西" });
    }
    if (!resolveKey()) return json(res, 400, { ok: false, error: "还没设置模型 key", needsKey: true });
    const llm = deepseekFromEnv();
    const outcome = await runFinalize(draft, llm, {
      turns: Number(body.turns ?? 0),
      date: new Date().toISOString().slice(0, 10),
      // 创建时刻当排序值：DSH 的 preset 选择器按 order 升序，先造的排前面。
      order: Math.floor(Date.now() / 1000),
    });
    if (!outcome.ok) return json(res, 422, { ok: false, error: outcome.error });

    const slug = slugFromName(outcome.appspec.name);
    const appDir = await installApp(slug, outcome.files);
    json(res, 200, {
      ok: true,
      ...appSummary(slug, outcome.appspec),
      hasPrd: true,
      dir: appDir,
      repairs: outcome.repairs,
      prdUrl: `/api/apps/${slug}/prd.md`,
    });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}

/** 当前的模型设置。**永远不把完整 key 送回前端**，只给遮罩形式。 */
function settingsPayload(): Record<string, unknown> {
  const config = readConfig();
  const key = resolveKey();
  const source = keySource();
  return {
    ok: true,
    hasKey: Boolean(key),
    source,
    masked: key ? maskKey(key) : null,
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? config.baseUrl ?? "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL ?? config.model ?? "deepseek-chat",
    configPath: configPath(),
    // 环境变量优先级更高。用户改了配置却不生效时，界面要能说清为什么。
    envOverride: source === "env",
  };
}

async function handleSaveSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as {
      apiKey?: unknown;
      baseUrl?: unknown;
      model?: unknown;
    };
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : undefined;
    const model = typeof body.model === "string" ? body.model.trim() : undefined;

    if (apiKey === "") return json(res, 400, { ok: false, error: "请填入模型 key" });

    // 先验再存。存了一把用不了的 key，用户会在聊到一半时才发现。
    const failure = await verifyKey(apiKey, baseUrl);
    if (failure) return json(res, 400, { ok: false, error: failure });

    writeConfig({
      deepseekApiKey: apiKey,
      baseUrl: baseUrl || undefined,
      model: model || undefined,
    });

    // DSH 的 llm 适配器每次请求都经 credentials 解析 DEEPSEEK_API_KEY 这个
    // 环境变量——所以改完 key 只要把 env 同步掉，下一次模型调用就用新的，
    // 不用重启任何东西（以前要收掉 headless 运行时和 dsh 子进程，都没了）。
    syncKeyEnv();

    json(res, 200, settingsPayload());
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}

/** slug 直接进文件路径，凡是从 URL 来的都要过这一关。 */
const SLUG_RE = /^[a-z0-9-]+$/u;

/** 导出人读的 PRD。 */
async function handlePrd(res: ServerResponse, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) return json(res, 400, { ok: false, error: "无效的助手标识" });
  try {
    const text = await readFile(join(APPS_DIR, slug, "prd.md"), "utf-8");
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-prd.md"`,
    });
    res.end(text);
  } catch {
    json(res, 404, { ok: false, error: "这个助手还没有文档" });
  }
}

const STATIC_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/** 图片必须按二进制读。用 utf-8 读 PNG 会把它读坏，浏览器只显示裂图。 */
const BINARY_TYPES = new Set([".png"]);

/**
 * 万象自己的静态资源。
 * 注意路径是 `/static/` 不是 `/assets/`——后者被路由转发给 DSH 了。
 */
async function serveStatic(res: ServerResponse, path: string): Promise<void> {
  const name = path.slice("/static/".length).split("?")[0];
  const ext = name.slice(name.lastIndexOf("."));
  if (!/^[\w.-]+$/u.test(name) || !STATIC_TYPES[ext]) {
    return json(res, 404, { ok: false, error: "not found" });
  }
  try {
    const file = join(__dirname, "..", "public", "static", name);
    const body = BINARY_TYPES.has(ext) ? await readFile(file) : await readFile(file, "utf-8");
    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[ext],
      // 图片带指纹意义不大，但也不该缓存住——换 logo 时用户不该看到旧的。
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    json(res, 404, { ok: false, error: "not found" });
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
    const r = await runPipeline(intent, llm, {
      includeCentaurPlugins: false,
      order: Math.floor(Date.now() / 1000),
    });
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

/* ═══════════════ job 模式运行时 ═══════════════════════════════════
 *
 * 助手在万象自己的进程里跑——而且就跑在**同一个** DSH 运行时上：万象服务
 * boot 的是完整的 web profile（见 src/main.ts），「跑一次」和浏览器里的
 * 「细聊」共享同一个 ctx、同一个 agent 平面、同一套 preset 语义。以前
 * 「跑一次走 headless、细聊走 web 子进程」导致同一个助手在两种模式下
 * 工具集完全不同的 bug，从结构上消失了。
 *
 * 每次跑都开**全新会话**：同一个助手、同样的输入，行为不该因为「这是第几次跑」
 * 而变——跟编译器的确定性是同一条原则。跨次状态将来走记忆绑定，显式声明，
 * 不是会话历史的副产品。
 */

/** 万象插件 apply 时塞进来的宿主 ctx。路由只在插件激活后注册，所以不会是 null。 */
let hostCtx: any = null;

/**
 * 交给助手的任务文本。
 *
 * 实测：任务写得中性（「今天适合做什么？」）时，模型是靠 glob 撞见工作手册的
 * ——它读到了，但那不是可靠的契约。所以这里**显式**让它按手册走。
 * 同时把交付物形式说清楚，那是用户在第 8 节亲口选的。
 */
function buildJobTask(app: AppSummary, materials: string[]): string {
  const lines = [
    "按你的工作手册跑一遍。",
    `产出：${app.delivery.form}`,
  ];
  // 把资料清单直接给它。不给的话它会满目录 glob 去找——实测一次运行为此
  // 空转了 80 秒，连着推了 18 条一模一样的进度。
  if (materials.length > 0) {
    lines.push("", "当前目录下的资料（只有这些，不用再去别处找）：");
    for (const name of materials) lines.push(`- ${name}`);
  } else {
    lines.push(
      "",
      "当前目录下还没有任何资料。别去别处翻，也别编——" +
        "直接说清楚你需要什么样的资料，让用户放进来。",
    );
  }
  lines.push("", "直接给结果本身，不要复述手册、不要解释你打算怎么做。");
  return lines.join("\n");
}

async function handleListMaterials(res: ServerResponse, slug: string): Promise<void> {
  json(res, 200, { ok: true, materials: await listMaterials(APPS_DIR, slug) });
}

/** 存一份资料，或删掉一份。名字清洗在 materials.ts 里，这里只管协议。 */
async function handleSaveMaterial(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as {
      name?: unknown;
      text?: unknown;
      remove?: unknown;
    };
    const name = typeof body.name === "string" ? body.name : "";
    if (name.trim() === "") return json(res, 400, { ok: false, error: "先给这份资料起个名字" });

    if (body.remove === true) {
      await deleteMaterial(APPS_DIR, slug, name);
      return json(res, 200, { ok: true, materials: await listMaterials(APPS_DIR, slug) });
    }

    const text = typeof body.text === "string" ? body.text : "";
    if (text.trim() === "") return json(res, 400, { ok: false, error: "内容是空的" });
    const saved = await saveMaterial(APPS_DIR, slug, name, text);
    if (!saved) {
      const tooBig = Buffer.byteLength(text, "utf-8") > MAX_MATERIAL_BYTES;
      return json(res, 400, {
        ok: false,
        error: tooBig ? "这份资料太大了，先拆小一点" : "这个名字不能用，换一个",
      });
    }
    json(res, 200, { ok: true, materials: await listMaterials(APPS_DIR, slug) });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}

/** 跑一次。SSE：step 是白话进度，text 是助手的话，done 带上落盘后的记录。 */
async function handleRun(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  const app = await readAppSummary(slug);
  if (!app) return json(res, 404, { ok: false, error: "没有这个助手" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  if (!resolveKey()) {
    send("error", { error: "还没设置模型 key", needsKey: true });
    res.end();
    return;
  }

  const id = newRunId();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const materials = (await listMaterials(APPS_DIR, slug)).map((m) => m.name);
  const task = buildJobTask(app, materials);

  try {
    send("step", { text: "正在唤醒助手" });
    const agent = await createAppAgent(hostCtx, slug, workspaceDir(APPS_DIR, slug));

    const output = await runAgentTask(hostCtx, agent, task, (e) => {
      send(e.kind, { text: e.text });
    });

    const record: RunRecord = {
      id,
      status: "ok",
      task,
      startedAt,
      ms: Date.now() - started,
      trigger: "manual",
    };
    await saveRun(APPS_DIR, slug, record, output);
    send("done", { run: record, output });
  } catch (e) {
    const message = (e as Error).message;
    const record: RunRecord = {
      id,
      status: "failed",
      task,
      startedAt,
      ms: Date.now() - started,
      trigger: "manual",
      error: message,
    };
    // 失败也存档：用户下次打开该看得见「上次没跑成，因为什么」。
    await saveRun(APPS_DIR, slug, record, "").catch(() => {});
    send("error", { error: message });
  } finally {
    res.end();
  }
}

async function handleListRuns(res: ServerResponse, slug: string): Promise<void> {
  json(res, 200, { ok: true, runs: await listRuns(APPS_DIR, slug) });
}

async function handleReadRun(res: ServerResponse, slug: string, id: string): Promise<void> {
  const one = await readRun(APPS_DIR, slug, id);
  if (!one) return json(res, 404, { ok: false, error: "没有这次记录" });
  json(res, 200, { ok: true, run: one.record, output: one.output });
}

async function serveIndex(res: ServerResponse): Promise<void> {
  const html = await readFile(INDEX_HTML, "utf-8");
  // no-store：旧版首页是整页内联的，一旦被浏览器缓存住，改了也看不见。
  // 开发期就别让它缓存。静态资源另外带 ?v= 指纹。
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(html);
}

/**
 * 万象自己的路由，挂在 DSH 的 webserver 上（同进程、同端口）。
 *
 * 版图：
 *   exact  /            万象首页（三栏产品界面）
 *   exact  /health      桌面外壳的探活与界面契约版本
 *   prefix /static      万象的静态资源（DSH 的 SPA 用 /assets，不冲突）
 *   prefix /wanx        万象的全部 API（内部仍按 /api/... 分发——DSH 的
 *                       connection 插件以 prefix 占住了真正的 /api）
 *   其余                落到 DSH 的 SPA fallback：/chat 之类无扩展名路径
 *                       返回 SPA index（「细聊」就开在那儿），/assets、
 *                       /plugins、/api 各归其主
 */
async function dispatchWanx(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // /wanx/api/chat → /api/chat：老路径原样复用，前端只改了前缀。
  const path = url.pathname.replace(/^\/wanx/u, "");

  if (req.method === "POST" && path === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && path === "/api/create") return handleCreate(req, res);
  if (req.method === "GET" && path === "/api/apps") return handleListApps(res);
  if (req.method === "GET" && path === "/api/settings") return json(res, 200, settingsPayload());
  if (req.method === "POST" && path === "/api/settings") return handleSaveSettings(req, res);
  if (req.method === "POST" && path === "/api/finalize") return handleFinalize(req, res);
  if (req.method === "GET" && path.startsWith("/api/apps/") && path.endsWith("/prd.md")) {
    return handlePrd(res, path.slice("/api/apps/".length, -"/prd.md".length));
  }
  const appPath =
    /^\/api\/apps\/([a-z0-9-]+)\/(run|runs|materials)(?:\/([\w-]+))?$/u.exec(path);
  if (appPath) {
    const [, slug, kind, id] = appPath;
    if (req.method === "POST" && kind === "run") return handleRun(req, res, slug);
    if (req.method === "GET" && kind === "runs" && !id) return handleListRuns(res, slug);
    if (req.method === "GET" && kind === "runs" && id) return handleReadRun(res, slug, id);
    if (req.method === "GET" && kind === "materials") return handleListMaterials(res, slug);
    if (req.method === "POST" && kind === "materials") return handleSaveMaterial(req, res, slug);
  }
  if (req.method === "GET" && path === "/api/mcp") return handleListMcp(res);
  if (req.method === "POST" && path === "/api/mcp") return handleMutateMcp(req, res);
  if (req.method === "GET" && path === "/api/opening") {
    return json(res, 200, { ok: true, opening: OPENING });
  }
  if (req.method === "POST" && path === "/api/activate") return handleActivate(req, res);
  json(res, 404, { ok: false, error: "not found" });
}

/** 外部能力（MCP）：列表。 */
async function handleListMcp(res: ServerResponse): Promise<void> {
  try {
    json(res, 200, { ok: true, servers: await listMcpServers(MCP_PATCH_FILE) });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  }
}

/** 外部能力（MCP）：接上或断开。改动写补丁层，HMR 热生效。 */
async function handleMutateMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (body.remove === true) {
      const name = typeof body.serverName === "string" ? body.serverName : "";
      const servers = await removeMcpServer(MCP_PATCH_FILE, name);
      return json(res, 200, { ok: true, servers });
    }
    const servers = await addMcpServer(MCP_PATCH_FILE, {
      serverName: String(body.serverName ?? ""),
      transport: body.transport === "streamable-http" ? "streamable-http" : "stdio",
      command: typeof body.command === "string" ? body.command : undefined,
      args:
        typeof body.args === "string" && body.args.trim() !== ""
          ? body.args.trim().split(/\s+/u)
          : undefined,
      url: typeof body.url === "string" ? body.url : undefined,
    });
    json(res, 200, { ok: true, servers });
  } catch (e) {
    json(res, 400, { ok: false, error: (e as Error).message });
  }
}

/** 包一层：路由 handler 抛错时回 500，别把 socket 晾着。 */
function guarded(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: (e as Error).message });
      else res.end();
    }
  };
}

/**
 * 万象作为 cordis 插件的入口：把 ctx 收下（job 运行走它），把路由挂上。
 * 由 @centaur/wanxiang bundle 的 apply() 调用。
 */
export function registerWanxiangRoutes(ctx: any): void {
  hostCtx = ctx;
  syncKeyEnv();

  const routes = [
    { kind: "exact" as const, path: "/", handler: guarded((_req, res) => serveIndex(res)) },
    { kind: "exact" as const, path: "/index.html", handler: guarded((_req, res) => serveIndex(res)) },
    {
      kind: "exact" as const,
      path: "/health",
      handler: guarded((_req, res) =>
        // ui 是界面契约版本。桌面外壳靠它认出「端口被一个老实例占着」。
        json(res, 200, { ok: true, status: "up", app: "wanxiang", ui: UI_REVISION }),
      ),
    },
    {
      kind: "prefix" as const,
      path: "/static",
      handler: guarded((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method !== "GET") return json(res, 405, { ok: false, error: "method not allowed" });
        return serveStatic(res, url.pathname);
      }),
    },
    { kind: "prefix" as const, path: "/wanx", handler: guarded(dispatchWanx) },
  ];

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register(route), `wanxiang: ${route.kind} ${route.path}`);
  }
}

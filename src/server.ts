import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";
import { runFinalize, runPipeline } from "./pipeline";
import { installApp, readPresetOrder } from "./install";
import { buildUiBlueprint, heroKindLabel, type UiBlueprint } from "./compiler/ui";
import { applyRevision, applyRollback, reviseManual } from "./tuning";
import { headRevision, listRevisions, reconcile, sliceOf, slicesEqual } from "./revisions";
import { compileSkill } from "./compiler/skill";
import {
  buildParamsSection,
  readParamValues,
  validateParamValues,
  writeParamValues,
} from "./params-store";
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
import { ChatPool } from "./runtime/chat-pool";
import { CHAT_PREFIX } from "./runtime/agent-session";
import { projectSessionEvent, type ChatEvent } from "./runtime/chat-events";
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
import { isTrustedWanxRequest } from "./trust";
import {
  isDue,
  markScheduleRun,
  readSchedule,
  validateSchedule,
  writeSchedule,
  type ScheduleSpec,
} from "./schedule";

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
  /** 工作台蓝图——app.yml 的纯函数投影，现算不落盘，永不过期。 */
  blueprint: UiBlueprint;
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
    blueprint: buildUiBlueprint(appspec),
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
  const summary: AppSummary = {
    slug, name, description, goal, domain: domain as AppSpec["domain"],
    capabilities, memoryBinding, delivery, params,
    workflow: { steps }, boundaries,
    hasPrd: false,
    blueprint: buildUiBlueprint({
      domain: domain as AppSpec["domain"],
      delivery,
      params,
    }),
  };
  return summary;
}

/** 读回完整的 AppSpec（app.yml 过校验）。调教要在真规格上做手术，摘要不够。 */
async function readAppSpec(slug: string): Promise<AppSpec | null> {
  try {
    const meta = load(await readFile(join(APPS_DIR, slug, "app.yml"), "utf-8"));
    const validated = validateAppSpec(meta);
    return validated.ok ? validated.value : null;
  } catch {
    return null;
  }
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

/*
 * 应用包的落盘原语在 src/install.ts（创建与调教共用同一条路径）。
 * 这里不写任何「默认助手」之类的全局状态——不存在那种东西。
 * 用哪个助手是建会话时的显式参数（agentPreset + cwd），见 runtime/agent-session.ts。
 */

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
      // 判据用 agent-instructions 这个精确行——"dsh-tool-fs" 是 "dsh-tool-fs-search"
      // 的前缀，裸子串会误判。另外 DSH 侧的 preset 副本缺失时也要重装（.dsh-home
      // 被清过），否则那个助手 mount 不起来却永远不自愈。
      const dshPresetExists = await readFile(
        join(DSH_HOME, ".agent-presets", slug, "agent.cordis.yml"),
        "utf-8",
      ).then(
        () => true,
        () => false,
      );
      if (current.includes("@deepseek-ai/dsh-agent-instructions") && dshPresetExists) continue;

      const meta = load(await readFile(join(APPS_DIR, slug, "app.yml"), "utf-8"));
      const validated = validateAppSpec(meta);
      if (!validated.ok) continue;

      // 保留原 order（preset.yml 里的），别把用户的排序洗掉。
      const order = await readPresetOrder(APPS_DIR, slug);

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

/**
 * 一次性迁移：抹掉旧版万象写进内核 settings.yaml 的三个键。
 *
 * `agent-presets.default` 是旧「激活」机制的落点——全局单值，整台机器一份，
 * 谁最后点谁说了算。现在每条会话在 header 里自己带 agentPreset，这个键彻底
 * 失去意义；留着它尤其危险：settings 的用户层优先级高于组合层，某天有人读
 * defaultId 会拿到一个业务助手的 slug 而不是 standard。
 * `ui-onboarding` / `locale` 的消费者（SPA 欢迎弹窗、client locale）都已
 * 不在组合里，一并清掉。其余键原样保留。
 */
export async function pruneLegacyDshSettings(): Promise<void> {
  let settings: Record<string, unknown>;
  try {
    const parsed = load(await readFile(DSH_SETTINGS, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    settings = parsed as Record<string, unknown>;
  } catch {
    return; // 没有文件就没有遗留
  }
  let changed = false;
  // permission 也要清：旧界面的权限设置页可能存过 defaultPreset
  // （如 danger-full-access），在新的单档表下是非法值，插件注册时会抛。
  for (const key of ["agent-presets", "ui-onboarding", "locale", "permission"]) {
    if (key in settings) {
      delete settings[key];
      changed = true;
    }
  }
  if (!changed) return;
  await mkdir(DSH_HOME, { recursive: true });
  await writeFile(DSH_SETTINGS, dump(settings, { noRefs: true, lineWidth: 100 }), "utf-8");
}

const MAX_TURNS = 20;

/**
 * 界面契约版本。界面或接口有不兼容改动时 +1。
 * 4 = 内核表面拆除：自建对话界面，/chat 与 /api 不再存在，切换收归万象层。
 */
const UI_REVISION = 4;

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
    const appDir = await installApp(APPS_DIR, DSH_HOME, slug, outcome.files);
    json(res, 200, {
      ok: true,
      ...appSummary(slug, outcome.appspec),
      hasPrd: true,
      dir: appDir,
      repairs: outcome.repairs,
      prdUrl: `/wanx/api/apps/${slug}/prd.md`,
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
    const appDir = await installApp(APPS_DIR, DSH_HOME, slug, r.files);

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

/* ═══════════════ 运行时：跑一次 + 对话 ═══════════════════════════
 *
 * 助手在万象自己的进程里跑——「跑一次」和「对话」都在同一个宿主 ctx 上
 * 建会话，同一个 agent 平面、同一套 preset 语义。preset 与 cwd 在建会话
 * 那一刻显式写进 header（见 runtime/agent-session.ts），此后不可变——
 * 「当前是哪个助手」只活在会话头上，不存在任何全局状态。
 *
 * 两类会话共存，靠 id 前缀分家：
 *   wanx-run-<slug>-…   一次性。每次跑都开**全新会话**：同一个助手、同样的
 *                       输入，行为不该因为「这是第几次跑」而变——跟编译器的
 *                       确定性是同一条原则。跑完即收，产出进 runs 台账。
 *   wanx-chat-<slug>-…  长活。上下文持续、可打断、可回放，由 ChatPool 管
 *                       生命周期；会话日志就是它的记录，不进 runs。
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
function buildJobTask(app: AppSummary, materials: string[], paramsSection: string[] = []): string {
  const lines = [
    "按你的工作手册跑一遍。",
    `产出：${app.delivery.form}`,
  ];
  // 用户拧过的旋钮（params.yml）注入在这里——运行期的生效值，
  // 段落开头会声明它盖过手册里渲染的默认值（见 buildParamsSection）。
  lines.push(...paramsSection);
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

/** 同一个应用同一时刻只跑一个：手动和定时都过这道闸。 */
const runningApps = new Set<string>();

/**
 * 正在调教（修订手册）的应用。跑与调互斥，两个方向都要挡：
 * 调教中放行一次跑，跑出来的结果「出自旧手册」，用户刚提的意见看起来没生效。
 * check-and-set 与首个 await 之间必须零间隙——纪律与 runningApps 相同。
 */
const tuningApps = new Set<string>();

/**
 * 跑一次的执行体。SSE 的 handleRun 和调度器共用——两边只在「进度去哪」和
 * 「trigger 记成什么」上不同。
 */
async function executeRun(
  slug: string,
  trigger: RunRecord["trigger"],
  onEvent: (event: string, data: { text: string }) => void,
): Promise<{ ok: boolean; record: RunRecord; output: string; error?: string }> {
  const app = await readAppSummary(slug);
  if (!app) throw new Error("没有这个助手");
  // check-and-set 紧挨、中间无 await：否则两个并发请求都能穿过 has()→add() 的
  // 窗口，同一助手被并发跑两次。add 之后的 await 都在闸门之内，安全。
  if (runningApps.has(slug)) throw new Error("它正在跑，等这一次结束");
  if (tuningApps.has(slug)) throw new Error("正在改它的手册，改完再跑");
  runningApps.add(slug);

  const id = newRunId();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  // task 提到 try 外：catch 分支的 record 要用它；占位值保证 listMaterials
  // 万一抛错时它仍有值。
  let task = "按你的工作手册跑一遍。";
  let disposeAgent: (() => Promise<void>) | null = null;
  // 这次跑用的是第几版手册——进闸后读账本头，成功失败两处记录都带上，
  // 用户在历史里才能把「产出」和「当时的手册」对上号。无账本则不写该字段。
  const manualVersion = (await headRevision(APPS_DIR, slug))?.version;
  try {
    const materials = (await listMaterials(APPS_DIR, slug)).map((m) => m.name);
    const paramValues = await readParamValues(APPS_DIR, slug);
    task = buildJobTask(app, materials, buildParamsSection(app.params, paramValues));
    onEvent("step", { text: "正在唤醒助手" });
    const created = await createAppAgent(hostCtx, slug, workspaceDir(APPS_DIR, slug));
    disposeAgent = created.dispose;
    const output = await runAgentTask(hostCtx, created.agent, task, (e) => {
      onEvent(e.kind, { text: e.text });
    });
    const record: RunRecord = {
      id,
      status: "ok",
      task,
      startedAt,
      ms: Date.now() - started,
      trigger,
      ...(manualVersion !== undefined ? { manualVersion } : {}),
    };
    await saveRun(APPS_DIR, slug, record, output);
    return { ok: true, record, output };
  } catch (e) {
    const message = (e as Error).message;
    const record: RunRecord = {
      id,
      status: "failed",
      task,
      startedAt,
      ms: Date.now() - started,
      trigger,
      error: message,
      ...(manualVersion !== undefined ? { manualVersion } : {}),
    };
    // 失败也存档：用户下次打开该看得见「上次没跑成，因为什么」。
    await saveRun(APPS_DIR, slug, record, "").catch(() => {});
    return { ok: false, record, output: "", error: message };
  } finally {
    // 释放这次跑用掉的 agent scope，别在长驻进程里越攒越多。
    // dispose 是 async（停驱动循环、等退出、摘 registry、卸 scope）——必须
    // await 完再放开 runningApps 的闸，否则「收掉的 agent 还在写日志」与
    // 下一次跑并发。
    try {
      await disposeAgent?.();
    } catch {
      /* dispose 抛错不该盖过这次运行本身的结果 */
    }
    runningApps.delete(slug);
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

  try {
    const result = await executeRun(slug, "manual", send);
    if (result.ok) send("done", { run: result.record, output: result.output });
    else send("error", { error: result.error });
  } catch (e) {
    send("error", { error: (e as Error).message });
  } finally {
    res.end();
  }
}

/* ── 定时 ────────────────────────────────────────────────────────────
 * 每分钟扫一遍：谁的 schedule.yml 到点了就跑一次（trigger 记 "schedule"）。
 * 补偿 latest-only：宕机跨过三个周期也只补一次。**真跑了才 mark**——撞上
 * 手动跑导致 executeRun 抛「正在跑」时不 mark，这个周期下个 tick 再试，
 * 不被静默吞掉；失败照常记进 runs 台账，绝不补跑风暴。
 * tick 自身全局互斥：一次跑可能超过 60 秒，两个 tick 并发的话，前一个
 * 「跑完还没 mark」的几毫秒窗口会让后一个立刻重跑同一个应用。
 */

const BOOT_AT = new Date();
let scheduleTicking = false;

async function scheduleTick(): Promise<void> {
  if (scheduleTicking) return;
  scheduleTicking = true;
  try {
    await scheduleTickOnce();
  } finally {
    scheduleTicking = false;
  }
}

async function scheduleTickOnce(): Promise<void> {
  if (!resolveKey()) return; // 没 key 跑不了，安静等着
  let slugs: string[];
  try {
    slugs = (await readdir(APPS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return;
  }
  for (const slug of slugs) {
    if (runningApps.has(slug) || tuningApps.has(slug)) continue;
    const spec = await readSchedule(APPS_DIR, slug);
    if (!spec || !isDue(spec, new Date(), BOOT_AT)) continue;
    console.log(`[wanxiang] 定时到点，跑「${slug}」`);
    try {
      const r = await executeRun(slug, "schedule", () => {});
      // 真跑了才记 lastRunAt（不论助手成没成）。撞上手动跑导致 executeRun 抛
      // 「正在跑」时走 catch，不 mark——这个周期下个 tick 再试，不被静默吞掉。
      await markScheduleRun(APPS_DIR, slug, new Date());
      console.log(
        r.ok
          ? `[wanxiang] 定时跑完「${slug}」：${(r.record.ms / 1000).toFixed(1)}s`
          : `[wanxiang] 定时没跑成「${slug}」：${r.error}`,
      );
    } catch (e) {
      console.warn(`[wanxiang] 定时这轮没跑（${(e as Error).message}），下次再试「${slug}」`);
    }
  }
}

async function handleGetSchedule(res: ServerResponse, slug: string): Promise<void> {
  const spec = await readSchedule(APPS_DIR, slug);
  json(res, 200, { ok: true, schedule: spec });
}

async function handleSaveSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<void> {
  try {
    if ((await readAppSummary(slug)) === null) {
      return json(res, 404, { ok: false, error: "没有这个助手" });
    }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const spec: ScheduleSpec = {
      enabled: body.enabled === true,
      every: body.every === "hour" || body.every === "week" ? body.every : "day",
      ...(typeof body.at === "string" ? { at: body.at } : {}),
      ...(typeof body.weekday === "number" ? { weekday: body.weekday } : {}),
    };
    // 保留既有的 lastRunAt——改配置不该把「跑过了」的记忆洗掉
    const prev = await readSchedule(APPS_DIR, slug);
    if (prev?.lastRunAt) {
      spec.lastRunAt = prev.lastRunAt;
    } else if (spec.enabled) {
      // 头一回开启定时：把锚设成此刻，从下一个周期开始跑。不设的话锚会回落到
      // 启动时刻，服务已开很久时「每天 09:00」这类会在保存后一分钟内立刻误跑。
      spec.lastRunAt = new Date().toISOString();
    }
    const invalid = validateSchedule(spec);
    if (invalid) return json(res, 400, { ok: false, error: invalid });
    await writeSchedule(APPS_DIR, slug, spec);
    json(res, 200, { ok: true, schedule: spec });
  } catch (e) {
    json(res, 400, { ok: false, error: (e as Error).message });
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

/* ═══════════════ 调教循环 ═══════════════════════════════════════════
 *
 * 用户说「这里不对，以后要…」→ LLM 修订工作手册 → 回写 app.yml → 全量
 * 重编译落盘 → 记账。app.yml 永远是当前态权威，账本只是历史（生效物先行，
 * 崩在记账前最多丢一条注记，账本永不撒谎）。机制细节见 src/tuning.ts。
 */

/** 一次调教。{text, runId?} → 铸出新版手册（或 applicable:false 的指路）。 */
async function handleTune(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  if (!resolveKey()) return json(res, 400, { ok: false, error: "还没设置模型 key", needsKey: true });
  let body: { text?: unknown; runId?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") return json(res, 400, { ok: false, error: "先说说哪里不对" });
  const runId = typeof body.runId === "string" ? body.runId : undefined;

  const spec = await readAppSpec(slug);
  if (!spec) return json(res, 404, { ok: false, error: "没有这个助手" });

  // 跑与调互斥（两个方向都挡，见 tuningApps 的注释）。check-and-set 零间隙。
  if (runningApps.has(slug)) return json(res, 409, { ok: false, error: "它正在跑，等这一次结束再调" });
  if (tuningApps.has(slug)) return json(res, 409, { ok: false, error: "正在改手册，稍等一下" });
  tuningApps.add(slug);
  try {
    const revised = await reviseManual(spec, text, deepseekFromEnv());
    if (!revised.ok) return json(res, 502, { ok: false, error: revised.error });
    if (!revised.applicable || !revised.slice) {
      return json(res, 200, { ok: true, changed: false, note: revised.note });
    }
    if (slicesEqual(revised.slice, sliceOf(spec))) {
      return json(res, 200, { ok: true, changed: false, note: revised.note || "手册不用改，它已经是这样做的" });
    }
    const applied = await applyRevision(APPS_DIR, DSH_HOME, slug, spec, revised.slice, {
      kind: "revise",
      note: revised.note,
      feedback: text,
      ...(runId ? { runId } : {}),
    });
    json(res, 200, { ok: true, changed: true, ...applied });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  } finally {
    tuningApps.delete(slug);
  }
}

/** 手册资源：当前版本、渲染好的正文、历史。蓝图与手册都是 app.yml 的现算投影。 */
async function handleGetManual(res: ServerResponse, slug: string): Promise<void> {
  const spec = await readAppSpec(slug);
  if (!spec) return json(res, 404, { ok: false, error: "没有这个助手" });
  // 对账：app.yml ≠ 账本末条时补记（调教闸被占时只读不写，避免抢账本号）。
  const { entry, synthetic } = await reconcile(APPS_DIR, slug, sliceOf(spec), {
    allowWrite: !tuningApps.has(slug),
  });
  const history = (await listRevisions(APPS_DIR, slug))
    .map((r) => ({ version: r.version, at: r.at, kind: r.kind, note: r.note }))
    .reverse();
  json(res, 200, {
    ok: true,
    version: entry.version,
    synthetic,
    current: { steps: [...spec.workflow.steps], boundaries: [...spec.boundaries] },
    skillMd: compileSkill(spec)?.content ?? null,
    history,
  });
}

/** 回到某一版。历史线性前进：回滚也是追加一条，走与调教相同的落盘路径。 */
async function handleRollback(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  let body: { to?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
  }
  const to = Number(body.to);
  if (!Number.isInteger(to) || to < 0) return json(res, 400, { ok: false, error: "要回到哪一版？" });
  const spec = await readAppSpec(slug);
  if (!spec) return json(res, 404, { ok: false, error: "没有这个助手" });
  if (runningApps.has(slug)) return json(res, 409, { ok: false, error: "它正在跑，等这一次结束" });
  if (tuningApps.has(slug)) return json(res, 409, { ok: false, error: "正在改手册，稍等一下" });
  tuningApps.add(slug);
  try {
    const target = (await listRevisions(APPS_DIR, slug)).find((r) => r.version === to);
    if (!target) return json(res, 404, { ok: false, error: "没有这一版" });
    const applied = await applyRollback(APPS_DIR, DSH_HOME, slug, spec, target);
    json(res, 200, { ok: true, changed: true, ...applied });
  } catch (e) {
    json(res, 500, { ok: false, error: (e as Error).message });
  } finally {
    tuningApps.delete(slug);
  }
}

/** 参数当前值。跑一次和定时都用这里存好的值。 */
async function handleGetParams(res: ServerResponse, slug: string): Promise<void> {
  json(res, 200, { ok: true, values: await readParamValues(APPS_DIR, slug) });
}

async function handleSaveParams(req: IncomingMessage, res: ServerResponse, slug: string): Promise<void> {
  const app = await readAppSummary(slug);
  if (!app) return json(res, 404, { ok: false, error: "没有这个助手" });
  try {
    const body = JSON.parse(await readBody(req)) as { values?: unknown };
    const checked = validateParamValues(app.params, body.values);
    if (!checked.ok) return json(res, 400, { ok: false, error: checked.error });
    await writeParamValues(APPS_DIR, slug, checked.values);
    json(res, 200, { ok: true, values: checked.values });
  } catch (e) {
    json(res, 400, { ok: false, error: (e as Error).message });
  }
}

/* ═══════════════ 对话链路 ═══════════════════════════════════════════
 *
 * 与助手的多轮对话。会话由 ChatPool 管（建/复活/扇出/回收），这里只做协议：
 *   POST   /api/apps/<slug>/chats     新开一条对话 → {sessionId}
 *   GET    /api/apps/<slug>/chats     该助手的历史对话列表
 *   GET    /api/chats/<sid>/events    SSE：先回放（?from=seq 之后的历史），再接直播
 *   POST   /api/chats/<sid>/say       发一句话（运行中=插话，空闲=新一轮）
 *   POST   /api/chats/<sid>/stop      停下当前这轮（turn/end 会以 aborted 收尾）
 *   DELETE /api/chats/<sid>           收掉活着的 agent（日志保留，随时能再开）
 *
 * SSE 铁律：一个事件一行 JSON。载荷里带换行的文本靠 JSON 转义活下来；
 * 拆成多行 data: 的话客户端解析会吃掉空白。
 */

let chatPool: ChatPool | null = null;

async function handleCreateChat(res: ServerResponse, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) return json(res, 400, { ok: false, error: "无效的助手标识" });
  if ((await readAppSummary(slug)) === null) {
    return json(res, 404, { ok: false, error: "没有这个助手" });
  }
  if (!chatPool) return json(res, 503, { ok: false, error: "对话服务还没就绪" });
  const entry = await chatPool.create(slug);
  json(res, 200, { ok: true, sessionId: entry.sessionId });
}

async function handleListChats(res: ServerResponse, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) return json(res, 400, { ok: false, error: "无效的助手标识" });
  const q = hostCtx?.get?.("sessionQuery");
  if (!q) return json(res, 200, { ok: true, chats: [] });
  const { SessionId } = await import("@deepseek-ai/dsh-session");
  // 按 cwd 过滤（每个助手的 workspace 天然唯一），再按 id 前缀把「跑一次」的
  // 会话滤掉——两类会话同 cwd 同 preset，分家靠前缀。
  const records: any[] = await q.filterSessions([
    { kind: "cwd", values: [workspaceDir(APPS_DIR, slug)] },
  ]);
  const chats = records.filter(
    (r) => String(r.header.id).startsWith(CHAT_PREFIX) && r.header.agentPreset === slug,
  );
  chats.sort((a, b) => (b.header.createdAt ?? 0) - (a.header.createdAt ?? 0));
  const titled = await Promise.allSettled(
    chats.map((c) => q.readTitleSnapshot(SessionId(String(c.header.id)))),
  );
  json(res, 200, {
    ok: true,
    chats: chats.map((c, i) => {
      const snap = titled[i].status === "fulfilled" ? (titled[i] as any).value : null;
      return {
        sessionId: String(c.header.id),
        title: snap?.title?.title ?? "新对话",
        createdAt: new Date(c.header.createdAt ?? 0).toISOString(),
        live: c.live === true,
      };
    }),
  });
}

/** 对话 SSE：先回放历史（打字机增量不回放，权威全文在 assistant 事件里），再接直播。 */
async function handleChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  sid: string,
): Promise<void> {
  if (!chatPool) return json(res, 503, { ok: false, error: "对话服务还没就绪" });

  // close 监听必须在任何 await **之前**挂上：open()（冷复活要读盘）期间连接
  // 断掉的话，事后再挂的监听永远收不到那个已经发射过的事件——订阅者就成了
  // 幽灵，把 entry 永久钉在池里（sweep 和淘汰都看 subscribers.size）。
  let closed = req.destroyed === true;
  let cleanup: () => void = () => {};
  req.on("close", () => {
    closed = true;
    cleanup();
  });

  let entry;
  try {
    entry = await chatPool.open(sid);
  } catch (e) {
    if (closed) return;
    return json(res, 404, { ok: false, error: (e as Error).message });
  }
  if (closed) return;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const fromRaw = Number(url.searchParams.get("from") ?? 0);
  const from = Number.isFinite(fromRaw) && fromRaw > 0 ? fromRaw : 0;

  const agent = entry.hold.agent;
  send("hello", {
    sessionId: sid,
    slug: entry.slug,
    running: agent.status === "running",
  });

  // 先订阅（进队列），再回放，最后放行直播——中间落进来的事件不丢。
  let replaying = true;
  let lastReplayed = 0;
  const queue: ChatEvent[] = [];
  const deliver = (ce: ChatEvent): void => {
    if (ce.t === "bye") {
      // 池要收掉这条会话（DELETE / 热重组）：干脆地结束流，
      // 别让客户端对着一条永远不再出声的连接干等。
      try {
        res.end();
      } catch {
        /* 已经断了 */
      }
      return;
    }
    if (replaying) {
      queue.push(ce);
      return;
    }
    send("chat", ce);
  };
  const off = chatPool.subscribe(sid, deliver);
  const ping = setInterval(() => {
    try {
      send("ping", {});
    } catch {
      /* 连接快没了，close 会收拾 */
    }
  }, 15_000);
  cleanup = () => {
    clearInterval(ping);
    off();
  };
  if (closed) {
    // open() 返回与挂好订阅之间断掉的最后一个窗口。
    cleanup();
    try {
      res.end();
    } catch {
      /* 已经断了 */
    }
    return;
  }

  for (const ev of agent.session.events) {
    if (typeof ev.seq === "number" && ev.seq < from) continue;
    for (const ce of projectSessionEvent(ev, entry.present)) {
      if (ce.t === "delta") continue; // 回放不打字机
      send("chat", ce);
      if ("seq" in ce && typeof ce.seq === "number") lastReplayed = Math.max(lastReplayed, ce.seq);
    }
  }
  replaying = false;
  for (const ce of queue) {
    // 回放循环可能已经带出了排队里的同一条（events 数组是活的）——按 seq 去重。
    if ("seq" in ce && typeof ce.seq === "number" && ce.seq <= lastReplayed) continue;
    send("chat", ce);
  }
  queue.length = 0;
}

async function handleChatSay(
  req: IncomingMessage,
  res: ServerResponse,
  sid: string,
): Promise<void> {
  if (!chatPool) return json(res, 503, { ok: false, error: "对话服务还没就绪" });
  if (!resolveKey()) return json(res, 400, { ok: false, error: "还没设置模型 key", needsKey: true });
  try {
    const body = JSON.parse(await readBody(req)) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "") return json(res, 400, { ok: false, error: "内容是空的" });
    await chatPool.say(sid, text); // 不在线会先复活——用户的话不该丢
    json(res, 202, { ok: true });
  } catch (e) {
    json(res, 400, { ok: false, error: (e as Error).message });
  }
}

async function handleChatStop(res: ServerResponse, sid: string): Promise<void> {
  if (!chatPool) return json(res, 503, { ok: false, error: "对话服务还没就绪" });
  chatPool.stop(sid);
  json(res, 202, { ok: true });
}

async function handleChatDelete(res: ServerResponse, sid: string): Promise<void> {
  if (!chatPool) return json(res, 503, { ok: false, error: "对话服务还没就绪" });
  await chatPool.close(sid);
  json(res, 202, { ok: true });
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
 * 万象自己的路由，挂在运行内核的 webserver 上（同进程、同端口）。
 *
 * 版图：
 *   exact  /            万象首页（三栏产品界面）
 *   exact  /health      桌面外壳的探活与界面契约版本
 *   prefix /static      万象的静态资源
 *   prefix /wanx        万象的全部 API（内部仍按 /api/... 分发——/wanx 前缀
 *                       是历史沿革，保持它前端就零改动）
 *   其余                404。没有第二个界面：以前留给内核 SPA 的 fallback
 *                       （/chat、/api、/assets、/plugins）已随那一层拆除。
 */
async function dispatchWanx(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // /wanx 的每个端点都能改状态（写 MCP 组合会热加载执行 stdio 命令、改模型
  // 后端能被 SSRF）。这里是全部流量的唯一信任栅栏：非回环 Host / 跨站
  // origin 一律 403。
  if (!isTrustedWanxRequest(req)) {
    return json(res, 403, { ok: false, error: "跨源请求被拒绝" });
  }
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
    /^\/api\/apps\/([a-z0-9-]+)\/(run|runs|materials|schedule|chats|tune|manual|params)(?:\/([\w-]+))?$/u.exec(
      path,
    );
  if (appPath) {
    const [, slug, kind, id] = appPath;
    if (req.method === "POST" && kind === "run") return handleRun(req, res, slug);
    if (req.method === "GET" && kind === "runs" && !id) return handleListRuns(res, slug);
    if (req.method === "GET" && kind === "runs" && id) return handleReadRun(res, slug, id);
    if (req.method === "GET" && kind === "materials") return handleListMaterials(res, slug);
    if (req.method === "POST" && kind === "materials") return handleSaveMaterial(req, res, slug);
    if (req.method === "GET" && kind === "schedule") return handleGetSchedule(res, slug);
    if (req.method === "POST" && kind === "schedule") return handleSaveSchedule(req, res, slug);
    if (req.method === "POST" && kind === "chats" && !id) return handleCreateChat(res, slug);
    if (req.method === "GET" && kind === "chats" && !id) return handleListChats(res, slug);
    if (req.method === "POST" && kind === "tune" && !id) return handleTune(req, res, slug);
    if (req.method === "GET" && kind === "manual" && !id) return handleGetManual(res, slug);
    if (req.method === "POST" && kind === "manual" && id === "rollback") {
      return handleRollback(req, res, slug);
    }
    if (req.method === "GET" && kind === "params" && !id) return handleGetParams(res, slug);
    if (req.method === "POST" && kind === "params" && !id) return handleSaveParams(req, res, slug);
  }
  const chatOp = /^\/api\/chats\/([\w-]+)(?:\/(events|say|stop))?$/u.exec(path);
  if (chatOp) {
    const [, sid, op] = chatOp;
    if (req.method === "GET" && op === "events") return handleChatStream(req, res, sid);
    if (req.method === "POST" && op === "say") return handleChatSay(req, res, sid);
    if (req.method === "POST" && op === "stop") return handleChatStop(res, sid);
    if (req.method === "DELETE" && !op) return handleChatDelete(res, sid);
  }
  if (req.method === "GET" && path === "/api/mcp") return handleListMcp(res);
  if (req.method === "POST" && path === "/api/mcp") return handleMutateMcp(req, res);
  if (req.method === "GET" && path === "/api/opening") {
    return json(res, 200, { ok: true, opening: OPENING });
  }
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

  // 定时扫描挂在插件生命周期上：插件卸载（热重组）时 interval 一起收掉。
  ctx.effect(() => {
    const timer = setInterval(() => void scheduleTick(), 60_000);
    return () => clearInterval(timer);
  }, "wanxiang: schedule tick");

  // 对话池与它的清扫器同样挂在插件生命周期上：热重组时先收干净所有
  // 长活 agent（dispose 是 async，closeAll 会逐个 await），不留孤儿。
  ctx.effect(() => {
    chatPool = new ChatPool(ctx, { appsDir: APPS_DIR });
    const sweeper = setInterval(() => void chatPool?.sweep(), 60_000);
    return () => {
      clearInterval(sweeper);
      const pool = chatPool;
      chatPool = null;
      void pool?.closeAll();
    };
  }, "wanxiang: chat pool");
}

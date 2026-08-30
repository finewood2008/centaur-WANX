import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump } from "js-yaml";
import type { AppSpec } from "./appspec/schema";
import { validateAppSpec } from "./appspec/validate";
import { compile } from "./compiler/compile";
import { serializeAppPackage } from "./compiler/serialize";
import { extractJson } from "./definer/parse";
import type { LLMClient } from "./definer/llm";
import { installApp, readPresetOrder } from "./install";
import { runsDir } from "./runs";
import {
  appendRevision,
  headRevision,
  sliceOf,
  slicesEqual,
  type ManualSlice,
  type RevisionEntry,
} from "./revisions";

/**
 * 调教引擎:用户说「这里不对,以后要…」→ LLM 修订工作手册 → 回写 AppSpec
 * → 全量重编译落盘 → 记账。
 *
 * 三条铁律:
 *   1. **字段冻结由代码强制**——模型只被允许影响 steps 与 boundaries,输出里
 *      夹带的 name/goal/params 一律丢弃(不靠 prompt 自觉;改名还会掉进 slug
 *      派生陷阱)。
 *   2. **生效物先行**——installApp 全部落盘之后才 append 账本。崩在记账前 =
 *      行为已正确、只丢一条历史注记(reconcile 会补),账本永不撒谎。
 *   3. 修订产物过 validateAppSpec 才落盘,这是最后防线。
 */

/** 调教层自己的钳制(schema 对数量/长度无上限,这里补上)。 */
export const TUNE_LIMITS = {
  maxSteps: 12,
  maxBoundaries: 8,
  maxItemChars: 200,
  maxFeedbackChars: 2000,
} as const;

export interface ReviseOutcome {
  ok: true;
  /** false = 反馈与手册无关(该去改定时/参数/名字),note 里指路,不铸版本。 */
  applicable: boolean;
  slice?: ManualSlice;
  note: string;
}

export interface ReviseFailure {
  ok: false;
  error: string;
}

export function buildTunePrompt(spec: AppSpec, feedback: string): string {
  const steps = spec.workflow.steps;
  const bounds = spec.boundaries;
  return [
    "你是一名助手产品的维护者。用户对助手的表现提了一条意见,你要把它落实到工作手册里。",
    "",
    `助手名称:${spec.name}(不许改)`,
    `它的目标:${spec.goal}`,
    "",
    "当前的工作步骤(「每次这样做」):",
    steps.length > 0 ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(还没有步骤)",
    "",
    "当前的边界(「不要做」):",
    bounds.length > 0 ? bounds.map((b) => `- ${b}`).join("\n") : "(还没有)",
    "",
    `用户的意见:${feedback}`,
    "",
    "只输出一个 JSON 对象,不要任何其他文字:",
    '{"applicable": true, "steps": ["…"], "boundaries": ["…"], "note": "一句话说明改了什么"}',
    "",
    "纪律:",
    "- 只改被意见指到的地方;没被指到的条目**逐字保留**,不许顺手润色。",
    "- 意见落不进手册时(比如要改名字、改定时、改参数),输出 applicable:false,",
    '  note 里用一句话告诉用户该去哪儿设置(如"定时在助手主页的定时卡里调")。',
    `- steps 是 1 到 ${TUNE_LIMITS.maxSteps} 条祈使句,每条一件事,不带编号,每条不超过 ${TUNE_LIMITS.maxItemChars} 字。`,
    `- boundaries 最多 ${TUNE_LIMITS.maxBoundaries} 条,每条不超过 ${TUNE_LIMITS.maxItemChars} 字。`,
    "- 不许改助手的名字、目标、参数——那些不归手册管。",
    "- note 用中文白话,是给不懂技术的用户看的。",
  ].join("\n");
}

export function buildTuneRepairPrompt(previous: string, error: string): string {
  return [
    "你上一次的输出有问题,原样修正后重发。",
    `问题:${error}`,
    "",
    "你上一次的输出:",
    previous,
    "",
    "只输出修正后的 JSON 对象,不要任何其他文字。",
  ].join("\n");
}

/** 模型输出的容错整形:数组化、去前导编号、trim、滤空。 */
export function normalizeSlice(raw: unknown): { slice: ManualSlice; note: string; applicable: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const toList = (v: unknown): string[] => {
    const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split("\n") : [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.replace(/^\s*\d+[.)、]\s*/u, "").trim())
      .filter((x) => x !== "");
  };
  return {
    applicable: o.applicable !== false,
    slice: { steps: toList(o.steps), boundaries: toList(o.boundaries) },
    note: typeof o.note === "string" && o.note.trim() !== "" ? o.note.trim() : "手册已按你的意见更新",
  };
}

/** 钳制校验。返回 null = 合法,否则是喂回 repair 的中文原因。 */
export function clampError(slice: ManualSlice): string | null {
  if (slice.steps.length < 1) return "steps 不能为空——手册至少要有一步";
  if (slice.steps.length > TUNE_LIMITS.maxSteps) {
    return `steps 太多了(${slice.steps.length} 条),压缩到 ${TUNE_LIMITS.maxSteps} 条以内`;
  }
  if (slice.boundaries.length > TUNE_LIMITS.maxBoundaries) {
    return `boundaries 太多了,压缩到 ${TUNE_LIMITS.maxBoundaries} 条以内`;
  }
  const long = [...slice.steps, ...slice.boundaries].find(
    (s) => s.length > TUNE_LIMITS.maxItemChars,
  );
  if (long) return `有一条太长了(超过 ${TUNE_LIMITS.maxItemChars} 字):「${long.slice(0, 40)}…」`;
  return null;
}

/**
 * 修订环:LLM(带超时)→ extractJson → normalize → 钳制 → 失败喂错重试。
 * 复用 define.ts 的骨架;FakeLLMClient 直接可测。
 */
export async function reviseManual(
  spec: AppSpec,
  feedback: string,
  llm: LLMClient,
  opts: { maxRepairs?: number; timeoutMs?: number } = {},
): Promise<ReviseOutcome | ReviseFailure> {
  const trimmed = feedback.trim();
  if (trimmed === "") return { ok: false, error: "意见是空的" };
  if (trimmed.length > TUNE_LIMITS.maxFeedbackChars) {
    return { ok: false, error: "这条意见太长了,拆短一点再说" };
  }
  const maxRepairs = opts.maxRepairs ?? 2;
  const timeoutMs = opts.timeoutMs ?? 90_000;

  const deadline = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("模型太久没回话,再试一次")), timeoutMs);
    // 不 hold 事件循环:正常完成后进程不用等它。
    if (typeof t.unref === "function") t.unref();
  });

  let prompt = buildTunePrompt(spec, trimmed);
  let lastRaw = "";
  let lastError = "";
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    let raw: string;
    try {
      raw = await Promise.race([llm.complete(prompt), deadline]);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    lastRaw = raw;
    try {
      const parsed = normalizeSlice(extractJson(raw));
      if (!parsed) throw new Error("输出不是期望的 JSON 对象");
      if (!parsed.applicable) {
        return { ok: true, applicable: false, note: parsed.note };
      }
      const clamp = clampError(parsed.slice);
      if (clamp) throw new Error(clamp);
      return { ok: true, applicable: true, slice: parsed.slice, note: parsed.note };
    } catch (e) {
      lastError = (e as Error).message;
      prompt = buildTuneRepairPrompt(lastRaw, lastError);
    }
  }
  return { ok: false, error: `模型没能给出合法的修订(${lastError})` };
}

export interface ApplyResult {
  version: number;
  note: string;
  before: ManualSlice;
  after: ManualSlice;
}

/**
 * 把一个新切片落成现实:组装 newSpec → validate → 重编译 → installApp(生效物
 * 先行)→ 首次补 v0 → append 账本 → 有 runId 时写 feedback.yml。
 *
 * 并发由调用方的 tuningApps 闸保证(本函数不自己加锁)。
 */
export async function applyRevision(
  appsDir: string,
  dshHome: string,
  slug: string,
  oldSpec: AppSpec,
  newSlice: ManualSlice,
  meta: { kind: "revise" | "rollback"; note: string; feedback?: string; runId?: string },
): Promise<ApplyResult> {
  const before = sliceOf(oldSpec);
  // 字段冻结:只有这两块来自修订,其余一律沿用旧 spec。
  const candidate = {
    ...oldSpec,
    workflow: { steps: [...newSlice.steps] },
    boundaries: [...newSlice.boundaries],
  };
  const validated = validateAppSpec(candidate);
  if (!validated.ok) {
    throw new Error(`修订没过规格校验:${validated.errors.join("; ")}`);
  }

  const order = await readPresetOrder(appsDir, slug);
  const pkg = compile(validated.value, { includeCentaurPlugins: false, order });
  const files = serializeAppPackage(pkg);
  await installApp(appsDir, dshHome, slug, files);

  // 记账在落盘之后(生效物先行)。首次调教先补一条 v0(调教前的样子),
  // 用户在历史里才看得到「出发点」。
  const head = await headRevision(appsDir, slug);
  let version: number;
  if (!head) {
    await appendRevision(appsDir, slug, {
      version: 0,
      at: new Date().toISOString(),
      kind: "external",
      note: "创建时的手册",
      ...before,
    });
    version = 1;
  } else {
    version = head.version + 1;
  }
  const entry: RevisionEntry = {
    version,
    at: new Date().toISOString(),
    kind: meta.kind,
    note: meta.note,
    ...(meta.feedback ? { feedback: meta.feedback } : {}),
    ...(meta.runId ? { runId: meta.runId } : {}),
    ...sliceOf(validated.value),
  };
  await appendRevision(appsDir, slug, entry);

  // 反馈针对某次运行时,在那次运行的目录里留一份关联(台账只读方不受影响)。
  if (meta.runId && /^\d{8}-\d{6}-[0-9a-f]{4}$/u.test(meta.runId)) {
    try {
      await writeFile(
        join(runsDir(appsDir, slug), meta.runId, "feedback.yml"),
        dump(
          { at: entry.at, text: meta.feedback ?? "", versionBefore: version - 1, versionAfter: version },
          { lineWidth: -1, noRefs: true },
        ),
        "utf-8",
      );
    } catch {
      /* run 目录不存在就算了,主流程不受影响 */
    }
  }

  return { version, note: meta.note, before, after: sliceOf(validated.value) };
}

/** 回滚 = 目标版切片走与调教完全相同的落盘路径,历史线性前进。 */
export async function applyRollback(
  appsDir: string,
  dshHome: string,
  slug: string,
  oldSpec: AppSpec,
  target: RevisionEntry,
): Promise<ApplyResult> {
  const slice: ManualSlice = { steps: [...target.steps], boundaries: [...target.boundaries] };
  if (slicesEqual(slice, sliceOf(oldSpec))) {
    // 已经就是这版了,别铸一个内容相同的新版本。
    return {
      version: (await headRevision(appsDir, slug))?.version ?? 0,
      note: "手册已经是这一版了,没有改动",
      before: sliceOf(oldSpec),
      after: slice,
    };
  }
  return applyRevision(appsDir, dshHome, slug, oldSpec, slice, {
    kind: "rollback",
    note: `回到第 ${target.version} 版的手册`,
  });
}

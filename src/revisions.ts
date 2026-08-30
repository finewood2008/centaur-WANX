import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import type { AppSpec } from "./appspec/schema";

/**
 * 工作手册的版本账本。
 *
 * 权威关系必须说死:**app.yml 永远是当前态的唯一权威**(heal 从它重编译、
 * 任务从它构建、蓝图从它投影),账本只是历史。写一半崩了、或者高级用户手改了
 * app.yml,以 app.yml 为准,账本靠 reconcile 补记自愈——账本可以缺一条注记,
 * 但永远不对用户撒谎。
 *
 * 历史线性前进:回滚不是删除,是追加一条 kind:"rollback"(内容 = 目标版切片)。
 * 一文件一版本(revisions/0001.yml),追加 = 写新文件,没有读改写竞态;
 * 文件名四位零填充,字典序即版本序(与 runs 台账同款约定)。
 */

/** 手册的可修订切片:AppSpec 里由调教管辖的那两块。 */
export interface ManualSlice {
  steps: string[];
  boundaries: string[];
}

export interface RevisionEntry extends ManualSlice {
  version: number;
  at: string;
  /** revise=一次调教;rollback=回到某版;external=在调教之外被改动的补记。 */
  kind: "revise" | "rollback" | "external";
  /** 给用户看的一句「改了什么」。 */
  note: string;
  /** 触发这次修订的反馈原文(external/rollback 没有)。 */
  feedback?: string;
  /** 反馈针对的那次运行(有才记)。 */
  runId?: string;
}

export function revisionsDir(appsDir: string, slug: string): string {
  return join(appsDir, slug, "revisions");
}

export function sliceOf(spec: Pick<AppSpec, "workflow" | "boundaries">): ManualSlice {
  return {
    steps: [...(spec.workflow?.steps ?? [])],
    boundaries: [...(spec.boundaries ?? [])],
  };
}

export function slicesEqual(a: ManualSlice, b: ManualSlice): boolean {
  return (
    a.steps.length === b.steps.length &&
    a.boundaries.length === b.boundaries.length &&
    a.steps.every((s, i) => s === b.steps[i]) &&
    a.boundaries.every((s, i) => s === b.boundaries[i])
  );
}

function parseEntry(raw: unknown): RevisionEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.version !== "number" || !Array.isArray(e.steps) || !Array.isArray(e.boundaries)) {
    return null;
  }
  return e as unknown as RevisionEntry;
}

/** 全部版本,旧→新。坏文件跳过不挡列表(与 listRuns 同款韧性)。 */
export async function listRevisions(appsDir: string, slug: string): Promise<RevisionEntry[]> {
  let names: string[];
  try {
    names = (await readdir(revisionsDir(appsDir, slug))).filter((n) => n.endsWith(".yml")).sort();
  } catch {
    return [];
  }
  const out: RevisionEntry[] = [];
  for (const name of names) {
    try {
      const entry = parseEntry(load(await readFile(join(revisionsDir(appsDir, slug), name), "utf-8")));
      if (entry) out.push(entry);
    } catch {
      /* 单个坏文件不挡整个账本 */
    }
  }
  return out;
}

/** 账本头(当前版本号的来源)。空账本返回 null。 */
export async function headRevision(appsDir: string, slug: string): Promise<RevisionEntry | null> {
  const all = await listRevisions(appsDir, slug);
  return all.length > 0 ? all[all.length - 1] : null;
}

/** 追加一条。version 由调用方给(编排层在闸内算好),文件名四位零填充。 */
export async function appendRevision(
  appsDir: string,
  slug: string,
  entry: RevisionEntry,
): Promise<void> {
  const dir = revisionsDir(appsDir, slug);
  await mkdir(dir, { recursive: true });
  const name = `${String(entry.version).padStart(4, "0")}.yml`;
  await writeFile(join(dir, name), dump(entry, { lineWidth: -1, noRefs: true }), "utf-8");
}

/**
 * 对账:app.yml 的当前切片 vs 账本末条。
 * - 无账本 → 合成 v0(不落盘;首次调教时才真正落 v0);
 * - 一致 → 返回末条;
 * - 不一致(写一半崩了 / 用户手改了 app.yml)→ 追加一条 kind:"external"
 *   补记并返回它——账本自愈,永远追认现实。
 */
export async function reconcile(
  appsDir: string,
  slug: string,
  current: ManualSlice,
  opts: { allowWrite?: boolean } = {},
): Promise<{ entry: RevisionEntry; synthetic: boolean }> {
  const head = await headRevision(appsDir, slug);
  if (!head) {
    return {
      synthetic: true,
      entry: {
        version: 0,
        at: "",
        kind: "external",
        note: "创建时的手册",
        ...current,
      },
    };
  }
  if (slicesEqual(sliceOf({ workflow: { steps: head.steps }, boundaries: head.boundaries }), current)) {
    return { entry: head, synthetic: false };
  }
  const corrective: RevisionEntry = {
    version: head.version + 1,
    at: new Date().toISOString(),
    kind: "external",
    note: "检测到手册在调教之外被改动(或上次修订中断),已按当前生效内容补记",
    ...current,
  };
  // 调教闸被占时只读不写(补记下次再说),避免与正在进行的修订抢账本号。
  if (opts.allowWrite !== false) {
    await appendRevision(appsDir, slug, corrective);
  }
  return { entry: corrective, synthetic: opts.allowWrite === false };
}

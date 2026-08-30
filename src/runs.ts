import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { dump, load } from "js-yaml";

/**
 * 一次运行的记录。
 *
 * job 模式的产品模型是「按一下，拿到一份东西」——那份东西必须存下来，
 * 否则用户关掉页面就没了，助手也就不像个能长期用的工具。
 *
 * 落盘在 `<APPS_DIR>/<slug>/runs/<id>/`：
 *   run.yml    元数据（谁、什么时候、跑了多久、成没成）
 *   output.md  交付物本体（人读的 Markdown）
 */
export interface RunRecord {
  id: string;
  status: "ok" | "failed";
  /** 交给助手的任务文本 */
  task: string;
  /** ISO 时间戳 */
  startedAt: string;
  /** 耗时毫秒 */
  ms: number;
  /** 触发方式。目前只有手动，schedule 留给 AppSpec v1.1。 */
  trigger: "manual" | "schedule";
  error?: string;
  /** 这次跑用的手册版本（revisions 账本头）。没调教过的助手不写。 */
  manualVersion?: number;
}

/** 列表项：元数据 ＋ 一句话摘要，不带全文（列表不该驮着几十 KB 正文）。 */
export interface RunSummary extends RunRecord {
  preview: string;
}

export function appDir(appsDir: string, slug: string): string {
  return join(appsDir, slug);
}

/** 会话 cwd。技能装在它下面的 `.dsh/skills/`，助手产出的文件也落这儿。 */
export function workspaceDir(appsDir: string, slug: string): string {
  return join(appsDir, slug, "workspace");
}

export function runsDir(appsDir: string, slug: string): string {
  return join(appsDir, slug, "runs");
}

/**
 * 运行 id：`YYYYMMDD-HHMMSS-xxxx`。
 *
 * 前缀是本地时间，所以目录名按字典序排就是按时间排——列表不用读进每个
 * run.yml 才能排序。后缀防同一秒内跑两次撞车。
 */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${randomUUID().slice(0, 4)}`;
}

/** 交付物的第一段，用作列表里的一句话摘要。 */
export function previewOf(output: string, max = 80): string {
  const line = output
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export async function saveRun(
  appsDir: string,
  slug: string,
  record: RunRecord,
  output: string,
): Promise<void> {
  const dir = join(runsDir(appsDir, slug), record.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.yml"), dump(record, { lineWidth: -1, noRefs: true }), "utf-8");
  await writeFile(join(dir, "output.md"), output, "utf-8");
}

/** 历史产出，新的在前。读不出来的目录跳过，不让一条坏记录挡住整个列表。 */
export async function listRuns(appsDir: string, slug: string): Promise<RunSummary[]> {
  let names: string[];
  try {
    names = (await readdir(runsDir(appsDir, slug), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const id of names) {
    const one = await readRun(appsDir, slug, id);
    if (one) out.push({ ...one.record, preview: previewOf(one.output) });
  }
  return out;
}

export async function readRun(
  appsDir: string,
  slug: string,
  id: string,
): Promise<{ record: RunRecord; output: string } | null> {
  // id 直接进路径，必须挡住穿越。只允许我们自己生成的形状。
  if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/u.test(id)) return null;
  const dir = join(runsDir(appsDir, slug), id);
  try {
    const meta = load(await readFile(join(dir, "run.yml"), "utf-8"));
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
    const output = await readFile(join(dir, "output.md"), "utf-8").catch(() => "");
    return { record: meta as RunRecord, output };
  } catch {
    return null;
  }
}

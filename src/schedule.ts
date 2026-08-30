import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dump, load } from "js-yaml";

/**
 * 定时 —— 兑现访谈里「每周固定跑一次」那类承诺的那块（此前它只被编译进
 * persona 的一句话，没有任何东西真的让它到点跑）。
 *
 * DSH 自带的 dsh-schedule 直接用不了：session-local、最小间隔 300 秒、明确
 * 不做日历规则、只在原 session 活着时触发。job 模式要的是「万象活着就到点
 * 跑一次全新会话」——所以自己写，但抄它两条被实践检验过的策略：
 *   1. 补偿只补最新一次（latest-only catch-up），绝不重放积压；
 *   2. 状态落盘（这里是每个应用一份 schedule.yml），timer 只是可丢弃的投影。
 *
 * 定时是**运行期设置**，不进 AppSpec：spec 是冻结的规格（它是个什么应用），
 * 「几点跑」是用户随时会拧的旋钮。AppSpec 里的 delivery.trigger 表达的是
 * 访谈时的意图，这里才是兑现处。
 */

export interface ScheduleSpec {
  enabled: boolean;
  /** 频率：每小时 / 每天 / 每周。 */
  every: "hour" | "day" | "week";
  /** day/week：几点跑，"HH:MM"（本地时区）。 */
  at?: string;
  /** week：周几跑，0=周日 … 6=周六。 */
  weekday?: number;
  /** 上次定时触发的时刻（ISO）。手动跑不算。 */
  lastRunAt?: string;
}

const AT_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/u;

/** 校验。返回 null 合法，否则给用户看的原因。 */
export function validateSchedule(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return "缺少定时描述";
  const s = spec as Record<string, unknown>;
  if (typeof s.enabled !== "boolean") return "enabled 得是布尔";
  if (s.every !== "hour" && s.every !== "day" && s.every !== "week") {
    return "频率只支持 hour / day / week";
  }
  if (s.every !== "hour") {
    if (typeof s.at !== "string" || !AT_RE.test(s.at)) return "时间得写成 HH:MM";
  }
  if (s.every === "week") {
    if (typeof s.weekday !== "number" || !Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6) {
      return "周几得是 0（周日）到 6（周六）";
    }
  }
  return null;
}

/**
 * 下一次应触发的时刻（本地时区）。
 *
 * 纯函数：`from` 显式传入。hour = 下一个整点；day = 下一个 at；
 * week = 下一个 weekday 的 at。恰好等于 from 的时刻算「已到」，返回它本身。
 */
export function nextRunAt(spec: ScheduleSpec, from: Date): Date {
  if (spec.every === "hour") {
    const next = new Date(from);
    next.setMinutes(0, 0, 0);
    if (next.getTime() < from.getTime()) next.setHours(next.getHours() + 1);
    return next;
  }
  const [h, m] = (spec.at ?? "09:00").split(":").map(Number);
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  if (spec.every === "day") {
    if (next.getTime() < from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }
  // week
  const wd = spec.weekday ?? 1;
  let delta = (wd - next.getDay() + 7) % 7;
  if (delta === 0 && next.getTime() < from.getTime()) delta = 7;
  next.setDate(next.getDate() + delta);
  return next;
}

/**
 * 现在该不该跑。
 *
 * 判据：从「上次定时触发」（没有就从 anchor——通常是启动时刻的前一个周期起点）
 * 算出的下一次触发点已经过去。补偿是 latest-only：宕机跨过了三个周期，
 * 也只补一次。
 */
export function isDue(spec: ScheduleSpec, now: Date, bootAt: Date): boolean {
  if (!spec.enabled) return false;
  // 坏的 lastRunAt 回落到 bootAt——别让一个解析不了的时间戳把定时静默弄死。
  let anchor = bootAt;
  if (spec.lastRunAt) {
    const parsed = new Date(spec.lastRunAt);
    if (!Number.isNaN(parsed.getTime())) anchor = parsed;
  }
  if (Number.isNaN(anchor.getTime())) return false;
  // 从 anchor 往后一毫秒起算，避免同一时刻反复触发。
  const next = nextRunAt(spec, new Date(anchor.getTime() + 1));
  return next.getTime() <= now.getTime();
}

function scheduleFile(appsDir: string, slug: string): string {
  return join(appsDir, slug, "schedule.yml");
}

export async function readSchedule(appsDir: string, slug: string): Promise<ScheduleSpec | null> {
  try {
    const parsed = load(await readFile(scheduleFile(appsDir, slug), "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return validateSchedule(parsed) === null ? (parsed as ScheduleSpec) : null;
  } catch {
    return null;
  }
}

export async function writeSchedule(
  appsDir: string,
  slug: string,
  spec: ScheduleSpec,
): Promise<void> {
  const invalid = validateSchedule(spec);
  if (invalid) throw new Error(invalid);
  await mkdir(join(appsDir, slug), { recursive: true });
  await writeFile(scheduleFile(appsDir, slug), dump(spec, { lineWidth: -1, noRefs: true }), "utf-8");
}

/** 记下这次定时触发（写 lastRunAt）。 */
export async function markScheduleRun(appsDir: string, slug: string, at: Date): Promise<void> {
  const spec = await readSchedule(appsDir, slug);
  if (!spec) return;
  spec.lastRunAt = at.toISOString();
  await writeSchedule(appsDir, slug, spec);
}

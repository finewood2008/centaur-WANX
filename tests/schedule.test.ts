import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDue,
  markScheduleRun,
  nextRunAt,
  readSchedule,
  validateSchedule,
  writeSchedule,
  type ScheduleSpec,
} from "../src/schedule";

// 本地时区构造，避免测试机时区影响断言语义
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe("validateSchedule", () => {
  it("三种频率各自的必填", () => {
    expect(validateSchedule({ enabled: true, every: "hour" })).toBeNull();
    expect(validateSchedule({ enabled: true, every: "day", at: "09:30" })).toBeNull();
    expect(validateSchedule({ enabled: true, every: "week", at: "09:30", weekday: 1 })).toBeNull();
    expect(validateSchedule({ enabled: true, every: "day" })).toContain("HH:MM");
    expect(validateSchedule({ enabled: true, every: "week", at: "09:30", weekday: 9 })).toContain("周几");
    expect(validateSchedule({ enabled: true, every: "月" })).toContain("频率");
  });
});

describe("nextRunAt", () => {
  it("hour：下一个整点；恰在整点上就是当下", () => {
    expect(nextRunAt({ enabled: true, every: "hour" }, at(2026, 8, 30, 10, 20))).toEqual(at(2026, 8, 30, 11, 0));
    expect(nextRunAt({ enabled: true, every: "hour" }, at(2026, 8, 30, 11, 0))).toEqual(at(2026, 8, 30, 11, 0));
  });

  it("day：今天的 at 没过就今天，过了就明天", () => {
    const spec: ScheduleSpec = { enabled: true, every: "day", at: "09:00" };
    expect(nextRunAt(spec, at(2026, 8, 30, 8, 0))).toEqual(at(2026, 8, 30, 9, 0));
    expect(nextRunAt(spec, at(2026, 8, 30, 9, 30))).toEqual(at(2026, 8, 31, 9, 0));
  });

  it("week：找下一个指定 weekday 的 at", () => {
    // 2026-08-30 是周日(0)
    const spec: ScheduleSpec = { enabled: true, every: "week", at: "09:00", weekday: 1 };
    expect(nextRunAt(spec, at(2026, 8, 30, 12, 0))).toEqual(at(2026, 8, 31, 9, 0)); // 周一
    // 就在周一但已过点 → 下周一
    expect(nextRunAt(spec, at(2026, 8, 31, 10, 0))).toEqual(at(2026, 9, 7, 9, 0));
  });
});

describe("isDue —— 补偿是 latest-only", () => {
  const spec: ScheduleSpec = { enabled: true, every: "day", at: "09:00" };

  it("没到点不触发", () => {
    const boot = at(2026, 8, 30, 8, 0);
    expect(isDue(spec, at(2026, 8, 30, 8, 30), boot)).toBe(false);
  });

  it("过了点触发；关掉就永不触发", () => {
    const boot = at(2026, 8, 30, 8, 0);
    expect(isDue(spec, at(2026, 8, 30, 9, 1), boot)).toBe(true);
    expect(isDue({ ...spec, enabled: false }, at(2026, 8, 30, 9, 1), boot)).toBe(false);
  });

  it("跑过之后当天不再触发，次日再触发", () => {
    const boot = at(2026, 8, 29, 8, 0);
    const ran = { ...spec, lastRunAt: at(2026, 8, 30, 9, 0).toISOString() };
    expect(isDue(ran, at(2026, 8, 30, 15, 0), boot)).toBe(false);
    expect(isDue(ran, at(2026, 8, 31, 9, 1), boot)).toBe(true);
  });

  it("宕机跨过三天，也只算「到点了」一次（latest-only 由调用方跑一次后写 lastRunAt 实现）", () => {
    const boot = at(2026, 8, 30, 12, 0); // 刚启动
    const ran = { ...spec, lastRunAt: at(2026, 8, 26, 9, 0).toISOString() };
    expect(isDue(ran, at(2026, 8, 30, 12, 0), boot)).toBe(true);
    // 跑一次之后（lastRunAt 更新到今天）就安静了
    const after = { ...spec, lastRunAt: at(2026, 8, 30, 12, 0).toISOString() };
    expect(isDue(after, at(2026, 8, 30, 15, 0), boot)).toBe(false);
  });

  it("坏掉的 lastRunAt 回落到 bootAt，不静默弄死定时", () => {
    const boot = at(2026, 8, 30, 8, 0);
    const broken = { ...spec, lastRunAt: "不是时间" };
    // 回落 bootAt：09:00 过后照常触发，而不是永远 false
    expect(isDue(broken, at(2026, 8, 30, 9, 1), boot)).toBe(true);
    expect(isDue(broken, at(2026, 8, 30, 8, 30), boot)).toBe(false);
  });

  it("刚开启（lastRunAt 设成此刻）不立即误跑，下个周期才触发", () => {
    const boot = at(2026, 8, 20, 8, 0); // 服务已开很久
    // 服务端 handleSaveSchedule 在开启时把 lastRunAt 设成 now，模拟之
    const nowEnable = at(2026, 8, 30, 15, 0);
    const justEnabled = { ...spec, lastRunAt: nowEnable.toISOString() };
    // 15:00 开启「每天 09:00」，当天不该再跑（今天 09:00 已过且锚在 15:00）
    expect(isDue(justEnabled, at(2026, 8, 30, 15, 1), boot)).toBe(false);
    // 次日 09:00 才跑
    expect(isDue(justEnabled, at(2026, 8, 31, 9, 1), boot)).toBe(true);
  });

  it("从没跑过：以启动时刻为锚——启动前欠的账不补，启动后到点才跑", () => {
    const boot = at(2026, 8, 30, 10, 0); // 今天 09:00 已经过了
    expect(isDue(spec, at(2026, 8, 30, 10, 5), boot)).toBe(false); // 不补启动前的
    expect(isDue(spec, at(2026, 8, 31, 9, 1), boot)).toBe(true); // 明天到点照跑
  });
});

describe("落盘 round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wanx-sched-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("写进去读回来；markScheduleRun 记下 lastRunAt", async () => {
    const spec: ScheduleSpec = { enabled: true, every: "day", at: "09:00" };
    await writeSchedule(dir, "app-x", spec);
    expect(await readSchedule(dir, "app-x")).toMatchObject(spec);

    const t = at(2026, 8, 30, 9, 0);
    await markScheduleRun(dir, "app-x", t);
    expect((await readSchedule(dir, "app-x"))?.lastRunAt).toBe(t.toISOString());
  });

  it("没有文件返回 null；非法内容当没有", async () => {
    expect(await readSchedule(dir, "app-x")).toBeNull();
  });

  it("非法 spec 拒绝写", async () => {
    await expect(
      writeSchedule(dir, "app-x", { enabled: true, every: "day" } as ScheduleSpec),
    ).rejects.toThrow(/HH:MM/);
  });
});

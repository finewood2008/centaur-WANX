import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRuns,
  newRunId,
  previewOf,
  readRun,
  runsDir,
  saveRun,
  workspaceDir,
  type RunRecord,
} from "../src/runs";

let apps: string;
beforeEach(() => {
  apps = mkdtempSync(join(tmpdir(), "wanx-runs-"));
});
afterEach(() => {
  rmSync(apps, { recursive: true, force: true });
});

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: newRunId(),
  status: "ok",
  task: "按你的工作手册跑一遍",
  startedAt: "2026-08-30T03:00:00.000Z",
  ms: 8700,
  trigger: "manual",
  ...over,
});

describe("newRunId", () => {
  it("形如 YYYYMMDD-HHMMSS-xxxx", () => {
    expect(newRunId(new Date(2026, 7, 30, 3, 28, 5))).toMatch(/^20260830-032805-[0-9a-f]{4}$/u);
  });

  it("同一秒内两次不撞", () => {
    const at = new Date(2026, 7, 30, 3, 28, 5);
    expect(newRunId(at)).not.toBe(newRunId(at));
  });

  it("按时间排序 == 按字典序排序（列表不用读进每个 run.yml）", () => {
    const early = newRunId(new Date(2026, 7, 30, 3, 0, 0));
    const late = newRunId(new Date(2026, 7, 30, 4, 0, 0));
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe("previewOf", () => {
  it("取第一段非空文本", () => {
    expect(previewOf("\n\n今天有三件事要跟进\n后面还有很多")).toBe("今天有三件事要跟进");
  });

  it("削掉 markdown 标题符号", () => {
    expect(previewOf("## 本周小结\n正文")).toBe("本周小结");
  });

  it("过长截断并加省略号", () => {
    expect(previewOf("啊".repeat(200), 10)).toBe(`${"啊".repeat(10)}…`);
  });

  it("空交付物给空串，不炸", () => {
    expect(previewOf("")).toBe("");
  });
});

describe("saveRun / readRun", () => {
  it("存进去能读回来", async () => {
    const r = record();
    await saveRun(apps, "app-x", r, "# 结果\n\n三条待跟进");
    const back = await readRun(apps, "app-x", r.id);
    expect(back?.record).toEqual(r);
    expect(back?.output).toContain("三条待跟进");
  });

  it("manualVersion 可选字段 round-trip（调教循环记「这次用的第几版手册」）", async () => {
    const r = { ...record(), manualVersion: 3 };
    await saveRun(apps, "app-x", r, "x");
    expect((await readRun(apps, "app-x", r.id))?.record.manualVersion).toBe(3);
    // 老记录没有该字段照样读
    const legacy = record();
    await saveRun(apps, "app-x", legacy, "y");
    expect((await readRun(apps, "app-x", legacy.id))?.record.manualVersion).toBeUndefined();
  });

  it("落在 <app>/runs/<id>/ 下", async () => {
    const r = record();
    await saveRun(apps, "app-x", r, "x");
    expect(runsDir(apps, "app-x")).toBe(join(apps, "app-x", "runs"));
  });

  it("不存在的 id 返回 null 而不是抛", async () => {
    expect(await readRun(apps, "app-x", "20260830-030000-abcd")).toBeNull();
  });

  it("id 形状不对就拒绝——它直接进路径，必须挡住穿越", async () => {
    for (const bad of ["../../etc/passwd", "..", "abc", "20260830-030000-ZZZZ", ""]) {
      expect(await readRun(apps, "app-x", bad)).toBeNull();
    }
  });

  it("run.yml 坏了当作没有，不让一条坏记录抛出去", async () => {
    const r = record();
    await saveRun(apps, "app-x", r, "x");
    writeFileSync(join(runsDir(apps, "app-x"), r.id, "run.yml"), "{ 这不是 YAML: [", "utf-8");
    expect(await readRun(apps, "app-x", r.id)).toBeNull();
  });
});

describe("listRuns", () => {
  it("没有 runs 目录时返回空数组", async () => {
    expect(await listRuns(apps, "app-x")).toEqual([]);
  });

  it("新的在前", async () => {
    const a = record({ id: newRunId(new Date(2026, 7, 30, 1, 0, 0)) });
    const b = record({ id: newRunId(new Date(2026, 7, 30, 2, 0, 0)) });
    await saveRun(apps, "app-x", a, "早的");
    await saveRun(apps, "app-x", b, "晚的");
    expect((await listRuns(apps, "app-x")).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("带一句话摘要，但不驮全文", async () => {
    const r = record();
    await saveRun(apps, "app-x", r, "# 本周小结\n\n正文很长".padEnd(500, "啊"));
    const [one] = await listRuns(apps, "app-x");
    expect(one.preview).toBe("本周小结");
    expect(JSON.stringify(one)).not.toContain("啊啊啊");
  });

  it("失败的记录也在列表里——用户该看得见上次没跑成", async () => {
    await saveRun(apps, "app-x", record({ status: "failed", error: "连不上模型服务" }), "");
    const [one] = await listRuns(apps, "app-x");
    expect(one.status).toBe("failed");
    expect(one.error).toBe("连不上模型服务");
  });

  it("坏掉的那个目录跳过，不挡住其他记录", async () => {
    const good = record();
    await saveRun(apps, "app-x", good, "好的");
    mkdirSync(join(runsDir(apps, "app-x"), "20260830-999999-zzzz"), { recursive: true });
    expect((await listRuns(apps, "app-x")).map((r) => r.id)).toEqual([good.id]);
  });
});

describe("workspaceDir", () => {
  it("是 <app>/workspace —— 技能装它下面的 .dsh/skills", () => {
    expect(workspaceDir(apps, "app-x")).toBe(join(apps, "app-x", "workspace"));
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { FakeLLMClient } from "../src/definer/llm";
import { validateAppSpec } from "../src/appspec/validate";
import { listRevisions } from "../src/revisions";
import {
  applyRevision,
  applyRollback,
  clampError,
  normalizeSlice,
  reviseManual,
  TUNE_LIMITS,
} from "../src/tuning";

const SPEC = validateAppSpec({
  schema_version: "1.0",
  name: "会议待办整理助手",
  description: "把会议记录整理成一份带负责人和截止时间的待办清单,聊完就有结果。",
  goal: "把会议记录整理成待办清单",
  domain: "personal_assistant",
  persona_note: "语气要干脆",
  memory_binding: { read: ["*"], write: [], retrieval: "semantic" },
  capabilities: ["summarize", "extract"],
  delivery: { form: "一份待办清单", trigger: "manual", output: "memory" },
  workflow: { steps: ["读会议记录", "提取行动项", "整理成清单"] },
  boundaries: ["不要编造没提到的事"],
  params: [],
});
if (!SPEC.ok) throw new Error("测试夹具不合法");
const spec = SPEC.value;

const good = JSON.stringify({
  applicable: true,
  steps: ["读会议记录", "先列出风险项", "提取行动项", "整理成清单"],
  boundaries: ["不要编造没提到的事"],
  note: "在第二步前加了「先列风险项」",
});

describe("reviseManual —— 修订环", () => {
  it("合法 JSON 一次过", async () => {
    const r = await reviseManual(spec, "先列风险项", new FakeLLMClient([good]));
    expect(r.ok).toBe(true);
    if (r.ok && r.slice) expect(r.slice.steps).toContain("先列出风险项");
  });

  it("markdown 围栏包着也能提取", async () => {
    const r = await reviseManual(spec, "x", new FakeLLMClient(["```json\n" + good + "\n```"]));
    expect(r.ok && r.applicable).toBe(true);
  });

  it("超钳制(13 条 steps)→ 喂错重试成功", async () => {
    const fat = JSON.stringify({
      applicable: true,
      steps: Array.from({ length: TUNE_LIMITS.maxSteps + 1 }, (_, i) => `第${i}步`),
      boundaries: [],
      note: "太多了",
    });
    const r = await reviseManual(spec, "x", new FakeLLMClient([fat, good]));
    expect(r.ok).toBe(true);
  });

  it("持续给不出合法输出 → 失败,错误可读", async () => {
    const r = await reviseManual(spec, "x", new FakeLLMClient(["胡话", "还是胡话", "依旧"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("修订");
  });

  it("applicable:false 直通,不给 slice", async () => {
    const na = JSON.stringify({ applicable: false, steps: [], boundaries: [], note: "定时在定时卡里调" });
    const r = await reviseManual(spec, "以后每周一自动跑", new FakeLLMClient([na]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applicable).toBe(false);
      expect(r.note).toContain("定时");
    }
  });

  it("steps 改空 → 钳制拦下进重试", async () => {
    const empty = JSON.stringify({ applicable: true, steps: [], boundaries: [], note: "清空" });
    const r = await reviseManual(spec, "x", new FakeLLMClient([empty, good]));
    expect(r.ok && r.applicable).toBe(true);
  });

  it("反馈超长直接拒,不烧模型", async () => {
    const r = await reviseManual(spec, "长".repeat(TUNE_LIMITS.maxFeedbackChars + 1), new FakeLLMClient([good]));
    expect(r.ok).toBe(false);
  });
});

describe("normalizeSlice / clampError", () => {
  it("去前导编号、trim、滤空", () => {
    const n = normalizeSlice({ applicable: true, steps: ["1. 读记录 ", "2) 提取", "", "3、整理"], boundaries: [], note: "x" });
    expect(n?.slice.steps).toEqual(["读记录", "提取", "整理"]);
  });

  it("单条超长被钳", () => {
    expect(clampError({ steps: ["长".repeat(TUNE_LIMITS.maxItemChars + 1)], boundaries: [] })).toContain("太长");
  });
});

describe("applyRevision —— 生效物先行,账本殿后", () => {
  let appsDir: string;
  let dshHome: string;
  const slug = "app-fixture01";

  beforeEach(() => {
    appsDir = mkdtempSync(join(tmpdir(), "wanx-tune-apps-"));
    dshHome = mkdtempSync(join(tmpdir(), "wanx-tune-home-"));
    mkdirSync(join(appsDir, slug, "runs", "20260830-120000-abcd"), { recursive: true });
  });

  const newSlice = { steps: ["读会议记录", "先列风险项", "提取行动项"], boundaries: ["不要编造没提到的事"] };

  it("七处落盘齐,内容含新步骤;首次调教补 v0+v1;字段冻结", async () => {
    const applied = await applyRevision(appsDir, dshHome, slug, spec, newSlice, {
      kind: "revise",
      note: "加了风险项",
      feedback: "先列风险项",
      runId: "20260830-120000-abcd",
    });
    expect(applied.version).toBe(1);
    expect(applied.before.steps).toEqual(spec.workflow.steps);
    expect(applied.after.steps).toEqual(newSlice.steps);

    const appYml = load(readFileSync(join(appsDir, slug, "app.yml"), "utf-8")) as any;
    expect(appYml.workflow.steps).toContain("先列风险项");
    // 字段冻结:名字/目标/persona_note 原样保留
    expect(appYml.name).toBe(spec.name);
    expect(appYml.persona_note).toBe("语气要干脆");

    for (const p of [
      join(appsDir, slug, "preset.yml"),
      join(appsDir, slug, "agent.cordis.yml"),
      join(dshHome, ".agent-presets", slug, "preset.yml"),
      join(dshHome, ".agent-presets", slug, "agent.cordis.yml"),
    ]) {
      expect(existsSync(p)).toBe(true);
    }
    // 技能两份(app 目录副本 + workspace 生效副本)都有新步骤
    const skillDirs = [join(appsDir, slug, "skills"), join(appsDir, slug, "workspace", ".dsh", "skills")];
    for (const dir of skillDirs) {
      const files = readFileSync(
        join(dir, readdirOne(dir), "SKILL.md"),
        "utf-8",
      );
      expect(files).toContain("先列风险项");
    }

    const ledger = await listRevisions(appsDir, slug);
    expect(ledger.map((r) => r.version)).toEqual([0, 1]);
    expect(ledger[0].kind).toBe("external");
    expect(ledger[1].feedback).toBe("先列风险项");

    // feedback.yml 落进对应 run 目录
    const fb = load(readFileSync(join(appsDir, slug, "runs", "20260830-120000-abcd", "feedback.yml"), "utf-8")) as any;
    expect(fb.versionAfter).toBe(1);
  });

  it("非法 runId 不写 feedback,主流程不受影响", async () => {
    await applyRevision(appsDir, dshHome, slug, spec, newSlice, {
      kind: "revise",
      note: "x",
      runId: "../../../etc/passwd",
    });
    expect(existsSync(join(appsDir, slug, "runs", "..", "..", "..", "etc"))).toBe(false);
  });

  it("order 从旧 preset.yml 保留", async () => {
    const first = await applyRevision(appsDir, dshHome, slug, spec, newSlice, { kind: "revise", note: "a" });
    void first;
    const preset1 = load(readFileSync(join(appsDir, slug, "preset.yml"), "utf-8")) as any;
    // 再调一次,order 不变
    await applyRevision(appsDir, dshHome, slug, { ...spec, workflow: { steps: newSlice.steps }, boundaries: newSlice.boundaries }, { steps: ["只剩一步"], boundaries: [] }, { kind: "revise", note: "b" });
    const preset2 = load(readFileSync(join(appsDir, slug, "preset.yml"), "utf-8")) as any;
    expect(preset2.order).toBe(preset1.order);
  });

  it("steps 从空到有:手册长出来,preset 挂上 skill 插件行", async () => {
    const bare = { ...spec, workflow: { steps: [] as string[] } };
    await applyRevision(appsDir, dshHome, slug, bare, { steps: ["第一步"], boundaries: [] }, { kind: "revise", note: "长出手册" });
    const cordis = readFileSync(join(dshHome, ".agent-presets", slug, "agent.cordis.yml"), "utf-8");
    expect(cordis).toContain("dsh-skill-filesystem");
  });
});

describe("applyRollback", () => {
  it("落盘内容=目标版切片,账本追加 kind:rollback", async () => {
    const appsDir = mkdtempSync(join(tmpdir(), "wanx-rb-apps-"));
    const dshHome = mkdtempSync(join(tmpdir(), "wanx-rb-home-"));
    const slug = "app-fixture01";
    const v1 = { steps: ["读记录", "先列风险项", "提取"], boundaries: [] };
    await applyRevision(appsDir, dshHome, slug, spec, v1, { kind: "revise", note: "v1" });
    const ledger = await listRevisions(appsDir, slug);
    const target = ledger.find((r) => r.version === 0)!;
    const specNow = { ...spec, workflow: { steps: v1.steps }, boundaries: v1.boundaries };
    const applied = await applyRollback(appsDir, dshHome, slug, specNow, target);
    expect(applied.after.steps).toEqual(spec.workflow.steps);
    const after = await listRevisions(appsDir, slug);
    expect(after[after.length - 1].kind).toBe("rollback");
    const appYml = load(readFileSync(join(appsDir, slug, "app.yml"), "utf-8")) as any;
    expect(appYml.workflow.steps).toEqual(spec.workflow.steps);
  });
});

function readdirOne(dir: string): string {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const entries = readdirSync(dir).filter((n: string) => !n.startsWith("."));
  if (entries.length !== 1) throw new Error(`期望恰好一个条目: ${dir} → ${entries.join(",")}`);
  return entries[0];
}

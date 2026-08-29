import { describe, it, expect } from "vitest";
import { compileSkill, skillName } from "../src/compiler/skill";
import { validateAppSpec } from "../src/appspec/validate";
import type { AppSpec } from "../src/appspec/schema";

function spec(overrides: Record<string, unknown> = {}): AppSpec {
  const r = validateAppSpec({
    schema_version: "1.0",
    name: "客户跟进助手",
    description: "记住每个客户的偏好与承诺，每次对话后自动更新客户档案",
    goal: "不漏掉对客户的承诺",
    domain: "customer_management",
    memory_binding: { read: ["客户档案"], write: ["客户档案"], retrieval: "entity" },
    capabilities: ["search", "summarize"],
    delivery: { form: "一份待办清单", trigger: "conversational", output: "both" },
    workflow: { steps: ["先翻最近的往来", "挑出没兑现的承诺", "按到期时间排序"] },
    boundaries: ["不主动发消息给客户", "不改动报价与金额"],
    ...overrides,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.value;
}

describe("compileSkill", () => {
  it("workflow 为空时返回 null——不生成空技能", () => {
    expect(compileSkill(spec({ workflow: { steps: [] } }))).toBeNull();
  });

  it("路径落在 skills/<name>/SKILL.md", () => {
    const s = compileSkill(spec());
    expect(s?.path).toBe(`skills/${skillName(spec())}/SKILL.md`);
  });

  it("技能名是 kebab-case（DSH 硬要求）", () => {
    expect(skillName(spec())).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
  });

  it("frontmatter 有 name 和 description，且是单行", () => {
    const content = compileSkill(spec())!.content;
    const fm = content.split("---")[1];
    expect(fm).toMatch(/\nname: /u);
    expect(fm).toMatch(/\ndescription: "/u);
    for (const line of fm.trim().split("\n")) {
      expect(line).not.toBe("");
    }
  });

  it("正文按顺序列出步骤与边界", () => {
    const content = compileSkill(spec())!.content;
    expect(content).toContain("## 每次这样做");
    expect(content).toContain("1. 先翻最近的往来");
    expect(content).toContain("3. 按到期时间排序");
    expect(content).toContain("## 不要做");
    expect(content).toContain("- 不主动发消息给客户");
  });

  it("多行 goal 被压成 frontmatter 的单行标量", () => {
    const content = compileSkill(spec({ goal: "第一行\n第二行" }))!.content;
    expect(content).toContain('description: "第一行 第二行"');
  });

  it("步骤自带序号时不会变成「1. 1) …」", () => {
    const content = compileSkill(spec({ workflow: { steps: ["1) 先翻往来", "2、再挑承诺", "3. 排序"] } }))!.content;
    expect(content).toContain("1. 先翻往来");
    expect(content).toContain("2. 再挑承诺");
    expect(content).toContain("3. 排序");
    expect(content).not.toContain("1. 1)");
  });

  it("确定性：同一 AppSpec 永远产出同一内容", () => {
    expect(compileSkill(spec())!.content).toBe(compileSkill(spec())!.content);
  });
});

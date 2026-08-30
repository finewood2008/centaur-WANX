import { describe, it, expect } from "vitest";
import { compile } from "../src/compiler/compile";
import { validateAppSpec } from "../src/appspec/validate";

function compileFrom(raw: unknown) {
  const r = validateAppSpec(raw);
  if (!r.ok) throw new Error("invalid AppSpec: " + r.errors.join("; "));
  return compile(r.value);
}

const valid = {
  schema_version: "1.0",
  name: "客户跟进助手",
  description: "记住每个客户的偏好与承诺，每次对话后自动更新客户档案",
  goal: "维护客户关系、跟进承诺、不遗漏",
  domain: "customer_management",
  memory_binding: {
    read: ["客户档案库", "往来记录库"],
    write: ["客户档案库"],
    retrieval: "entity",
  },
  capabilities: ["search", "summarize", "extract", "compose"],
  delivery: {
    form: "更新客户档案 + 生成待跟进提醒",
    trigger: "conversational",
    output: "both",
  },
};

describe("compile", () => {
  it("确定性：同一输入产出同一结果", () => {
    expect(compileFrom(valid)).toEqual(compileFrom(valid));
  });

  it("preset 元数据正确", () => {
    const pkg = compileFrom(valid);
    expect(pkg.preset.name).toBe("客户跟进助手");
    expect(pkg.preset.description).toBe(valid.description);
    expect(pkg.meta.domain).toBe("customer_management");
  });

  it("persona_note 进 meta——app.yml 是重编译（heal/调教）的输入，漏了它一次 round-trip 就丢", () => {
    const pkg = compileFrom({ ...valid, persona_note: "语气务必干脆" });
    expect((pkg.meta as Record<string, unknown>).persona_note).toBe("语气务必干脆");
    // round-trip：meta 再过一遍校验，persona_note 存活
    const again = validateAppSpec(pkg.meta);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value.persona_note).toBe("语气务必干脆");
    // 没有 persona_note 的不凭空多一个键
    expect("persona_note" in compileFrom(valid).meta).toBe(false);
  });

  it("persona 文本包含名称、目标、描述", () => {
    const pkg = compileFrom(valid);
    const persona = pkg.preset.agentCordis.find((e) => e.id === "persona");
    expect(persona).toBeDefined();
    const text = persona!.config!.text as string;
    expect(text).toContain("客户跟进助手");
    expect(text).toContain("维护客户关系、跟进承诺、不遗漏");
    expect(text).toContain("每次对话后自动更新客户档案");
  });

  it("persona 文本包含记忆绑定信息", () => {
    const pkg = compileFrom(valid);
    const text = pkg.preset.agentCordis.find((e) => e.id === "persona")!.config!.text as string;
    expect(text).toContain("客户档案库");
    expect(text).toContain("往来记录库");
    expect(text).toContain("按实体/人名");
  });

  it("persona 文本包含交付定义", () => {
    const pkg = compileFrom(valid);
    const text = pkg.preset.agentCordis.find((e) => e.id === "persona")!.config!.text as string;
    expect(text).toContain("更新客户档案 + 生成待跟进提醒");
    expect(text).toContain("回复用户并写入记忆库");
  });

  it("记忆工具始终挂载", () => {
    const pkg = compileFrom(valid);
    const memoryTools = pkg.preset.agentCordis.filter((e) => e.id.startsWith("memory-tool-"));
    expect(memoryTools.length).toBeGreaterThan(0);
  });

  it("基线工具集始终在：读写文件、检索、待办、工作指令", () => {
    // web profile 把 host 平面的工具全 disable 了，preset 里没列的助手就真的没有。
    const pkg = compileFrom({ ...valid, capabilities: ["summarize"] });
    const ids = pkg.preset.agentCordis.map((e) => e.id);
    for (const id of ["agent-instructions", "tool-fs", "tool-fs-search", "tool-todo"]) {
      expect(ids).toContain(id);
    }
  });

  it("永远不挂 shell 与编排类工具——助手面向不懂技术的用户", () => {
    const pkg = compileFrom({ ...valid, capabilities: ["search", "browse", "api_call"] });
    const names = pkg.preset.agentCordis.map((e) => e.name).join(" ");
    for (const banned of ["tool-bash", "tool-pwsh", "tool-subagent", "tool-workflow", "tool-ralph"]) {
      expect(names).not.toContain(banned);
    }
  });

  it("capabilities 映射到工具并去重", () => {
    const pkg = compileFrom({ ...valid, capabilities: ["search", "browse"] });
    const webTools = pkg.preset.agentCordis.filter((e) => e.name === "@deepseek-ai/dsh-tool-web");
    expect(webTools.length).toBe(1);
  });

  it("只选 search 时 tool-web 不放开 fetch；选了 browse/api_call 才放开", () => {
    const searchOnly = compileFrom({ ...valid, capabilities: ["search"] });
    const web1 = searchOnly.preset.agentCordis.find((e) => e.id === "tool-web");
    expect((web1?.config as { fetch: boolean }).fetch).toBe(false);

    const withBrowse = compileFrom({ ...valid, capabilities: ["browse"] });
    const web2 = withBrowse.preset.agentCordis.find((e) => e.id === "tool-web");
    expect((web2?.config as { fetch: boolean }).fetch).toBe(true);
  });

  it("summarize/extract/compose 不挂联网工具", () => {
    const pkg = compileFrom({ ...valid, capabilities: ["summarize", "extract", "compose"] });
    expect(pkg.preset.agentCordis.some((e) => e.id === "tool-web")).toBe(false);
  });

  it("order 透传进 preset——DSH 选择器按它排序，调用方传创建时间戳", () => {
    const r = validateAppSpec(valid);
    if (!r.ok) throw new Error("invalid");
    const pkg = compile(r.value, { order: 1756500000 });
    expect(pkg.preset.order).toBe(1756500000);
    // 不传保持 0，编译仍是纯函数
    expect(compile(r.value).preset.order).toBe(0);
  });

  it("有 workflow 才挂技能插件，且产出技能文件", () => {
    const pkg = compileFrom({ ...valid, workflow: { steps: ["先翻最近的往来", "挑出没兑现的承诺"] } });
    const fs = pkg.preset.agentCordis.find((e) => e.id === "skill-filesystem");
    expect(fs).toBeDefined();
    expect(pkg.preset.agentCordis.some((e) => e.id === "tool-skill")).toBe(true);
    expect(pkg.skill?.path).toMatch(/^skills\/.+\/SKILL\.md$/u);
    // 不给 config：DSH 会整个忽略 preset 里给 skill-filesystem 写的配置，
    // 写了等于在产物里留一句不生效的谎。技能靠装进 $DSH_HOME/skills 被发现。
    expect(fs?.config).toBeUndefined();
  });

  it("没有 workflow 就不挂技能插件（不留空挂名）", () => {
    const pkg = compileFrom(valid); // 没给 workflow
    expect(pkg.skill).toBeNull();
    expect(pkg.preset.agentCordis.some((e) => e.id === "skill-filesystem")).toBe(false);
    expect(pkg.preset.agentCordis.some((e) => e.id === "tool-skill")).toBe(false);
  });

  it("domain 不再决定技能挂载", () => {
    const withWorkflow = { ...valid, workflow: { steps: ["一步"] } };
    for (const domain of ["general", "customer_management", "research"]) {
      const pkg = compileFrom({ ...withWorkflow, domain });
      expect(pkg.preset.agentCordis.some((e) => e.id === "tool-skill")).toBe(true);
    }
  });

  it("includeCentaurPlugins=false 过滤占位插件", () => {
    const r = validateAppSpec(valid);
    if (!r.ok) throw new Error("invalid");
    const pkg = compile(r.value, { includeCentaurPlugins: false });
    const names = pkg.preset.agentCordis.map((e) => e.name);
    expect(names.some((n) => n.startsWith("@centaur/"))).toBe(false);
  });
});

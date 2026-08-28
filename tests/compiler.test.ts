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

  it("capabilities 映射到工具并去重", () => {
    const pkg = compileFrom({ ...valid, capabilities: ["search", "browse"] });
    const webTools = pkg.preset.agentCordis.filter((e) => e.name === "@deepseek-ai/dsh-tool-web");
    expect(webTools.length).toBe(1);
  });

  it("summarize/extract/compose 不挂专门工具", () => {
    const pkg = compileFrom({ ...valid, capabilities: ["summarize", "extract", "compose"] });
    const capabilityTools = pkg.preset.agentCordis.filter((e) => e.id.startsWith("capability-tool-"));
    expect(capabilityTools.length).toBe(0);
  });

  it("domain 注入默认技能", () => {
    const pkg = compileFrom(valid); // customer_management
    expect(pkg.preset.agentCordis.some((e) => e.id === "skill-filesystem")).toBe(true);
    expect(pkg.preset.agentCordis.some((e) => e.id === "tool-skill")).toBe(true);
  });

  it("general domain 不注入技能", () => {
    const pkg = compileFrom({ ...valid, domain: "general" });
    expect(pkg.preset.agentCordis.some((e) => e.id === "tool-skill")).toBe(false);
  });

  it("includeCentaurPlugins=false 过滤占位插件", () => {
    const r = validateAppSpec(valid);
    if (!r.ok) throw new Error("invalid");
    const pkg = compile(r.value, { includeCentaurPlugins: false });
    const names = pkg.preset.agentCordis.map((e) => e.name);
    expect(names.some((n) => n.startsWith("@centaur/"))).toBe(false);
  });
});

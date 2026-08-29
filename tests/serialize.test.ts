import { describe, it, expect } from "vitest";
import { load } from "js-yaml";
import { compile } from "../src/compiler/compile";
import { validateAppSpec } from "../src/appspec/validate";
import { serializePreset, serializeAppPackage } from "../src/compiler/serialize";

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

describe("serializePreset", () => {
  it("确定性：同一输入产出同一 YAML", () => {
    const pkg = compileFrom(valid);
    expect(serializePreset(pkg)).toEqual(serializePreset(pkg));
  });

  it("preset.yml 可被 YAML 解析且字段正确", () => {
    const pkg = compileFrom(valid);
    const { presetYml } = serializePreset(pkg);
    const parsed = load(presetYml) as Record<string, unknown>;
    expect(parsed.name).toBe("客户跟进助手");
    expect(parsed.description).toBe(valid.description);
  });

  it("agent.cordis.yml 可被 YAML 解析为插件列表", () => {
    const pkg = compileFrom(valid);
    const { agentCordisYml } = serializePreset(pkg);
    const parsed = load(agentCordisYml) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(pkg.preset.agentCordis.length);
    expect(parsed[0].id).toBe("persona");
  });

  it("round-trip：persona 文本（多行、中文）完整保留", () => {
    const pkg = compileFrom(valid);
    const { agentCordisYml } = serializePreset(pkg);
    const parsed = load(agentCordisYml) as Array<Record<string, unknown>>;
    const persona = parsed.find((e) => e.id === "persona") as {
      config: { text: string };
    };
    expect(persona.config.text).toContain("维护客户关系、跟进承诺、不遗漏");
    expect(persona.config.text).toContain("客户档案库");
    expect(persona.config.text).toContain("回复用户并写入记忆库");
  });

  it("serializeAppPackage 产出四个文件", () => {
    const pkg = compileFrom(valid);
    const files = serializeAppPackage(pkg);
    expect(Object.keys(files).sort()).toEqual(
      ["agent.cordis.yml", "app.yml", "memory-binding.yml", "preset.yml"].sort(),
    );
  });

  it("memory-binding.yml 保留检索策略与库名", () => {
    const pkg = compileFrom(valid);
    const files = serializeAppPackage(pkg);
    const mb = load(files["memory-binding.yml"]) as {
      read: string[];
      write: string[];
      retrieval: string;
    };
    expect(mb.read).toContain("客户档案库");
    expect(mb.retrieval).toBe("entity");
  });

  it("app.yml 包含运行区所需的应用摘要", () => {
    const pkg = compileFrom(valid);
    const files = serializeAppPackage(pkg);
    const meta = load(files["app.yml"]) as {
      goal: string;
      capabilities: string[];
      memory_binding: { read: string[] };
      delivery: { form: string };
    };
    expect(meta.goal).toBe(valid.goal);
    expect(meta.capabilities).toEqual(valid.capabilities);
    expect(meta.memory_binding.read).toEqual(valid.memory_binding.read);
    expect(meta.delivery.form).toBe(valid.delivery.form);
  });
});

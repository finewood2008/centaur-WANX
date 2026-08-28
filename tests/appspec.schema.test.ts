import { describe, it, expect } from "vitest";
import { validateAppSpec } from "../src/appspec/validate";

const validAppSpec = {
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
  params: [
    { name: "followup_frequency", type: "enum", options: ["每日", "每周"], default: "每周" },
  ],
};

describe("validateAppSpec", () => {
  it("接受合法的 AppSpec", () => {
    const r = validateAppSpec(validAppSpec);
    expect(r.ok).toBe(true);
  });

  it("为省略字段填充默认值", () => {
    const minimal = {
      schema_version: "1.0",
      name: "最小应用",
      description: "这是一个用于测试默认值的最小合法描述文本",
      goal: "测试默认值填充",
      memory_binding: { read: ["*"] },
      capabilities: ["search"],
      delivery: { form: "回复用户" },
    };
    const r = validateAppSpec(minimal);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.domain).toBe("general");
      expect(r.value.memory_binding.retrieval).toBe("semantic");
      expect(r.value.memory_binding.write).toEqual([]);
      expect(r.value.delivery.trigger).toBe("conversational");
      expect(r.value.delivery.output).toBe("memory");
      expect(r.value.params).toEqual([]);
    }
  });

  it("拒绝不匹配的 schema_version", () => {
    const r = validateAppSpec({ ...validAppSpec, schema_version: "2.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("schema_version"))).toBe(true);
  });

  it("拒绝过短的 name", () => {
    const r = validateAppSpec({ ...validAppSpec, name: "A" });
    expect(r.ok).toBe(false);
  });

  it("拒绝过短的 description", () => {
    const r = validateAppSpec({ ...validAppSpec, description: "太短" });
    expect(r.ok).toBe(false);
  });

  it("拒绝空 goal", () => {
    const r = validateAppSpec({ ...validAppSpec, goal: "" });
    expect(r.ok).toBe(false);
  });

  it("拒绝空 capabilities", () => {
    const r = validateAppSpec({ ...validAppSpec, capabilities: [] });
    expect(r.ok).toBe(false);
  });

  it("拒绝空 memory_binding.read", () => {
    const r = validateAppSpec({
      ...validAppSpec,
      memory_binding: { ...validAppSpec.memory_binding, read: [] },
    });
    expect(r.ok).toBe(false);
  });

  it("拒绝非法 capability 值", () => {
    const r = validateAppSpec({
      ...validAppSpec,
      capabilities: ["search", "not_a_capability"],
    });
    expect(r.ok).toBe(false);
  });

  it("拒绝 type=enum 缺 options 的参数", () => {
    const r = validateAppSpec({
      ...validAppSpec,
      params: [{ name: "freq", type: "enum" }],
    });
    expect(r.ok).toBe(false);
  });

  it("未知字段被忽略并告警", () => {
    const r = validateAppSpec({ ...validAppSpec, extra_field: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings.some((w) => w.includes("extra_field"))).toBe(true);
      // 未知字段不应出现在规范化结果里
      expect("extra_field" in r.value).toBe(false);
    }
  });
});

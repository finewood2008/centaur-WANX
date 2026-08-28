import { describe, it, expect } from "vitest";
import { defineAppSpec } from "../src/definer/define";
import { FakeLLMClient } from "../src/definer/llm";

const validSpec = {
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
const validJson = JSON.stringify(validSpec);

describe("defineAppSpec", () => {
  it("合法 JSON 直接成功，无修复", async () => {
    const r = await defineAppSpec("帮我跟进客户", new FakeLLMClient([validJson]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("客户跟进助手");
      expect(r.repairs).toBe(0);
    }
  });

  it("markdown 代码块输出也能提取", async () => {
    const r = await defineAppSpec(
      "帮我跟进客户",
      new FakeLLMClient(["```json\n" + validJson + "\n```"]),
    );
    expect(r.ok).toBe(true);
  });

  it("首次非法 → 修复重试成功", async () => {
    const bad = JSON.stringify({ ...validSpec, goal: "" });
    const r = await defineAppSpec("x", new FakeLLMClient([bad, validJson]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.repairs).toBe(1);
  });

  it("持续非法 → 失败", async () => {
    const bad = JSON.stringify({ name: "缺很多字段" });
    const r = await defineAppSpec("x", new FakeLLMClient([bad, bad, bad]));
    expect(r.ok).toBe(false);
  });

  it("非 JSON 输出 → 失败", async () => {
    const r = await defineAppSpec("x", new FakeLLMClient(["这不是JSON", "也不是"]));
    expect(r.ok).toBe(false);
  });
});

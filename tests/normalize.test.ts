import { describe, it, expect } from "vitest";
import { normalizeAppSpec } from "../src/definer/normalize";

function norm(input: Record<string, unknown>): Record<string, unknown> {
  return normalizeAppSpec(input) as Record<string, unknown>;
}

describe("normalizeAppSpec", () => {
  it("capabilities 别名映射回标准枚举", () => {
    const out = norm({
      capabilities: ["fetch_web_content", "parse_rss", "summarize_text", "generate_daily_report"],
    });
    expect(out.capabilities).toEqual(["browse", "summarize", "compose"]);
  });

  it("capabilities 去重", () => {
    const out = norm({ capabilities: ["search", "web_search", "search"] });
    expect(out.capabilities).toEqual(["search"]);
  });

  it("合法枚举原样保留", () => {
    const out = norm({ capabilities: ["search", "browse"] });
    expect(out.capabilities).toEqual(["search", "browse"]);
  });

  it("未知能力保留（交校验器报错）", () => {
    const out = norm({ capabilities: ["totally_unknown_thing"] });
    expect(out.capabilities).toEqual(["totally_unknown_thing"]);
  });

  it("memory_binding.read 缺失补默认 [*]", () => {
    const out = norm({ memory_binding: { write: ["x"] } });
    expect((out.memory_binding as Record<string, unknown>).read).toEqual(["*"]);
  });

  it("delivery.form 缺失用 goal 兜底", () => {
    const out = norm({ goal: "维护客户关系", delivery: {} });
    expect((out.delivery as Record<string, unknown>).form).toContain("维护客户关系");
  });

  it("params 缺 type 推断默认 string", () => {
    const out = norm({ params: [{ name: "客户名", label: "客户姓名" }] });
    expect((out.params as Array<Record<string, unknown>>)[0].type).toBe("string");
  });

  it("params description 映射为 label", () => {
    const out = norm({ params: [{ name: "信息源", description: "关注的信息源列表" }] });
    const p = (out.params as Array<Record<string, unknown>>)[0];
    expect(p.label).toBe("关注的信息源列表");
    expect(p.type).toBe("string");
  });

  it("params type=enum 无 options 降级 string", () => {
    const out = norm({ params: [{ name: "freq", type: "enum" }] });
    expect((out.params as Array<Record<string, unknown>>)[0].type).toBe("string");
  });
});

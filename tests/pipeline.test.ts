import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline } from "../src/pipeline";
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

const EXPECTED_FILES = ["agent.cordis.yml", "app.yml", "memory-binding.yml", "preset.yml"];

describe("runPipeline", () => {
  it("完整链路：定义→编译→序列化", async () => {
    const r = await runPipeline("帮我跟进客户", new FakeLLMClient([validJson]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.appspec.name).toBe("客户跟进助手");
      expect(r.repairs).toBe(0);
      expect(Object.keys(r.files).sort()).toEqual(EXPECTED_FILES.sort());
      expect(r.files["preset.yml"]).toContain("客户跟进助手");
      expect(r.files["agent.cordis.yml"]).toContain("persona");
    }
  });

  it("定义失败 → 返回失败", async () => {
    const r = await runPipeline("x", new FakeLLMClient(["垃圾", "垃圾", "垃圾"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeTruthy();
  });

  it("落盘到目录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wanxiang-pipeline-"));
    const r = await runPipeline("x", new FakeLLMClient([validJson]), { outDir: dir });
    expect(r.ok).toBe(true);

    const preset = await readFile(join(dir, "preset.yml"), "utf-8");
    expect(preset).toContain("客户跟进助手");

    const agent = await readFile(join(dir, "agent.cordis.yml"), "utf-8");
    expect(agent).toContain("persona");

    const mb = await readFile(join(dir, "memory-binding.yml"), "utf-8");
    expect(mb).toContain("entity");
  });
});

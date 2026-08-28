import { describe, it, expect } from "vitest";
import {
  conductDialog,
  generateFromConversation,
  buildInterviewPrompt,
  parseGuideReply,
} from "../src/definer/interviewer";
import { FakeLLMClient } from "../src/definer/llm";

const validSpec = {
  schema_version: "1.0",
  name: "客户跟进助手",
  description: "记住每个客户的偏好与承诺，每次对话后自动更新客户档案",
  goal: "维护客户关系、跟进承诺、不遗漏",
  domain: "customer_management",
  memory_binding: { read: ["客户档案库"], write: ["客户档案库"], retrieval: "entity" },
  capabilities: ["summarize", "extract"],
  delivery: { form: "更新客户档案", trigger: "conversational", output: "both" },
};
const validJson = JSON.stringify(validSpec);

describe("conductDialog", () => {
  it("纯文本回复 → text 无 options（兜底）", async () => {
    const llm = new FakeLLMClient(["这个问题要帮你解决什么？"]);
    const guide = await conductDialog([{ role: "user", content: "创建助手" }], llm);
    expect(guide.text).toContain("问题");
    expect(guide.options).toBeUndefined();
  });

  it("JSON 回复 → text + options", async () => {
    const llm = new FakeLLMClient([
      '{"question":"这个应用主要做什么？","options":["整理资料","跟进客户","写内容"]}',
    ]);
    const guide = await conductDialog([{ role: "user", content: "创建助手" }], llm);
    expect(guide.text).toContain("做什么");
    expect(guide.options).toEqual(["整理资料", "跟进客户", "写内容"]);
  });
});

describe("parseGuideReply", () => {
  it("markdown 包裹的 JSON 也能解析", () => {
    const r = parseGuideReply('```json\n{"question":"q","options":["a","b"]}\n```');
    expect(r.text).toBe("q");
    expect(r.options).toEqual(["a", "b"]);
  });

  it("options 超过 3 个截断到 3", () => {
    const r = parseGuideReply('{"question":"q","options":["a","b","c","d"]}');
    expect(r.options).toEqual(["a", "b", "c"]);
  });

  it("非法 JSON → 纯文本兜底", () => {
    const r = parseGuideReply("这是纯文本回复");
    expect(r.text).toBe("这是纯文本回复");
    expect(r.options).toBeUndefined();
  });

  it("options 空数组 → options undefined（表示可生成）", () => {
    const r = parseGuideReply('{"question":"可以生成了","options":[]}');
    expect(r.text).toBe("可以生成了");
    expect(r.options).toBeUndefined();
  });
});

describe("generateFromConversation", () => {
  it("合法对话 → 生成应用", async () => {
    const llm = new FakeLLMClient([validJson]);
    const r = await generateFromConversation([{ role: "user", content: "跟进客户" }], llm);
    expect(r.done).toBe(true);
    expect(r.app?.name).toBe("客户跟进助手");
  });

  it("生成失败 → done=false 带错误", async () => {
    const llm = new FakeLLMClient(["垃圾", "垃圾", "垃圾"]);
    const r = await generateFromConversation([{ role: "user", content: "x" }], llm);
    expect(r.done).toBe(false);
    expect(r.reply).toContain("生成遇到问题");
  });
});

describe("buildInterviewPrompt", () => {
  it("含系统提示与历史", () => {
    const p = buildInterviewPrompt([{ role: "user", content: "你好" }]);
    expect(p).toContain("应用引导者");
    expect(p).toContain("你好");
  });
});

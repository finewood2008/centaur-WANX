import { describe, it, expect } from "vitest";
import { lastTurnError, lastAssistantText } from "../src/runtime/run-agent";

/** 假 agent：只需要 session.events。 */
const fakeAgent = (events: Array<{ seq: number; type: string; data?: unknown }>) => ({
  session: { events },
});

describe("lastTurnError —— 别把吞掉的 agent 报错当成跑成功", () => {
  it("有 error turn 且在 firstSeq 之后 → 返回错误信息", () => {
    const agent = fakeAgent([
      { seq: 5, type: "turn/end", data: { reason: { kind: "error", error: { message: "no API key", code: "MISSING_CREDENTIAL" } } } },
    ]);
    expect(lastTurnError(agent, 0)).toBe("no API key");
  });

  it("error 只有 code 没有 message 时退回 code", () => {
    const agent = fakeAgent([
      { seq: 5, type: "turn/end", data: { reason: { kind: "error", error: { code: "TRANSPORT" } } } },
    ]);
    expect(lastTurnError(agent, 0)).toBe("TRANSPORT");
  });

  it("成功的 turn → null", () => {
    const agent = fakeAgent([{ seq: 5, type: "turn/end", data: { reason: { kind: "completed" } } }]);
    expect(lastTurnError(agent, 0)).toBeNull();
  });

  it("先失败后成功 → 以最后一次为准，null", () => {
    const agent = fakeAgent([
      { seq: 3, type: "turn/end", data: { reason: { kind: "error", error: { message: "第一次断网" } } } },
      { seq: 7, type: "turn/end", data: { reason: { kind: "completed" } } },
    ]);
    expect(lastTurnError(agent, 0)).toBeNull();
  });

  it("aborted 不算失败（用户主动中止）→ null", () => {
    const agent = fakeAgent([
      { seq: 5, type: "turn/end", data: { reason: { kind: "aborted", reason: { kind: "disposed" } } } },
    ]);
    expect(lastTurnError(agent, 0)).toBeNull();
  });

  it("firstSeq 之前的 error 不算这一次的", () => {
    const agent = fakeAgent([
      { seq: 1, type: "turn/end", data: { reason: { kind: "error", error: { message: "上一次的" } } } },
    ]);
    expect(lastTurnError(agent, 5)).toBeNull();
  });

  it("没有 turn/end → null", () => {
    expect(lastTurnError(fakeAgent([{ seq: 5, type: "assistant/message", data: {} }]), 0)).toBeNull();
  });
});

describe("配合 lastAssistantText —— 空产出 + error turn = 真失败", () => {
  it("有产出即便中途 error 也算成功（text 非空则不看 error）", () => {
    const events = [
      { seq: 3, type: "turn/end", data: { reason: { kind: "error", error: { message: "中途一次失败" } } } },
      { seq: 6, type: "assistant/message", data: { message: { content: [{ type: "text", text: "最终结果" }] } } },
    ];
    const agent = fakeAgent(events);
    expect(lastAssistantText(agent, 0)).toBe("最终结果");
  });

  it("空产出 + error turn：调用方据此判失败", () => {
    const agent = fakeAgent([
      { seq: 4, type: "turn/end", data: { reason: { kind: "error", error: { message: "凭证缺失" } } } },
    ]);
    expect(lastAssistantText(agent, 0)).toBe("");
    expect(lastTurnError(agent, 0)).toBe("凭证缺失");
  });
});

// 白话进度的翻译（原 toRunEvents/STEP_LABEL）已并入对话链路的同一份投影：
// 见 tests/chat-events.test.ts 与 tests/tool-view.test.ts。

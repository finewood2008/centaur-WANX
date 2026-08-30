import { describe, it, expect } from "vitest";
import { projectSessionEvent, type ChatEvent } from "../src/runtime/chat-events";
import type { Presenter } from "../src/runtime/tool-view";

/** 直通呈现器：label 用兜底路径可测，正文原样带出。 */
const passthrough: Presenter = {
  call: (name, args) => ({ label: `L:${name}`, input: args || undefined }),
  result: (_id, data) => ({
    ok: data?.error === undefined,
    text:
      (data?.message?.content?.[0]?.content ?? [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("") || (data?.error ? "失败" : ""),
  }),
};

const proj = (ev: unknown): ChatEvent[] => projectSessionEvent(ev, passthrough);

describe("projectSessionEvent —— 会话事件到对话事件的投影", () => {
  it("turn/start 与 turn/end(completed)", () => {
    expect(proj({ seq: 1, type: "turn/start", data: { turn: 2 } })).toEqual([
      { t: "turn.start", seq: 1, turn: 2 },
    ]);
    expect(proj({ seq: 9, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } }))
      .toEqual([{ t: "turn.end", seq: 9, turn: 2, reason: "completed" }]);
  });

  it("turn/end 的六种 reason 全部认识；aborted 不带 error", () => {
    for (const kind of ["completed", "aborted", "blocked", "max-tokens", "interrupted"]) {
      const [e] = proj({ seq: 1, type: "turn/end", data: { turn: 0, reason: { kind } } });
      expect(e).toMatchObject({ t: "turn.end", reason: kind });
      expect((e as any).error).toBeUndefined();
    }
  });

  it("turn/end(error) 带出错误信息，message 优先于 code", () => {
    const [e] = proj({
      seq: 3,
      type: "turn/end",
      data: { turn: 0, reason: { kind: "error", error: { message: "断网了", code: "NET" } } },
    });
    expect(e).toMatchObject({ reason: "error", error: "断网了" });
    const [e2] = proj({
      seq: 3,
      type: "turn/end",
      data: { turn: 0, reason: { kind: "error", error: { code: "NET" } } },
    });
    expect(e2).toMatchObject({ reason: "error", error: "NET" });
  });

  it("认不出的 reason 归为 completed 而不是崩", () => {
    const [e] = proj({ seq: 1, type: "turn/end", data: { turn: 0, reason: { kind: "novel" } } });
    expect(e).toMatchObject({ reason: "completed" });
  });

  it("user/message：真人 vs 注入靠 source.kind 分流", () => {
    const human = proj({
      seq: 2,
      type: "user/message",
      data: { content: [{ type: "text", text: "你好" }], source: { kind: "user" } },
    });
    expect(human).toEqual([{ t: "user", seq: 2, text: "你好", synthetic: false }]);
    const injected = proj({
      seq: 3,
      type: "user/message",
      data: { content: [{ type: "text", text: "<ctx>" }], source: { kind: "plugin" } },
    });
    expect(injected[0]).toMatchObject({ synthetic: true });
  });

  it("空文本的 user/message 不产事件", () => {
    expect(
      proj({ seq: 2, type: "user/message", data: { content: [{ type: "text", text: "  " }], source: { kind: "user" } } }),
    ).toEqual([]);
  });

  it("assistant/chunk 只认 text-delta；思考过程（reasoning-delta）不进流", () => {
    expect(
      proj({ seq: 4, type: "assistant/chunk", data: { turn: 1, step: 0, chunk: { type: "text-delta", text: "好" } } }),
    ).toEqual([{ t: "delta", turn: 1, step: 0, text: "好" }]);
    expect(
      proj({ seq: 5, type: "assistant/chunk", data: { turn: 1, step: 0, chunk: { type: "reasoning-delta", text: "想" } } }),
    ).toEqual([]);
  });

  it("assistant/message 带出全文与 interrupted 标记", () => {
    const [e] = proj({
      seq: 6,
      type: "assistant/message",
      data: { turn: 1, step: 0, message: { content: [{ type: "text", text: "答案" }] }, interrupted: true },
    });
    expect(e).toEqual({ t: "assistant", seq: 6, turn: 1, step: 0, text: "答案", interrupted: true });
  });

  it("tool/call 走呈现器；tool/result 的 callId 从 ToolResultBlock 里配对", () => {
    const [call] = proj({
      seq: 7,
      type: "tool/call",
      data: { turn: 1, step: 0, callId: "c1", name: "read", arguments: '{"path":"a.md"}' },
    });
    expect(call).toMatchObject({ t: "tool.call", callId: "c1", label: "L:read" });
    const [result] = proj({
      seq: 8,
      type: "tool/result",
      data: {
        turn: 1,
        step: 0,
        message: { content: [{ toolCallId: "c1", content: [{ type: "text", text: "内容" }] }] },
      },
    });
    expect(result).toEqual({ t: "tool.result", seq: 8, callId: "c1", ok: true, text: "内容" });
  });

  it("tool/result 带 error → ok:false", () => {
    const [r] = proj({
      seq: 9,
      type: "tool/result",
      data: {
        message: { content: [{ toolCallId: "c2", content: [] }] },
        error: { name: "E", code: "DENIED" },
      },
    });
    expect(r).toMatchObject({ ok: false });
  });

  it("todo/write 整表带出", () => {
    const [e] = proj({
      seq: 10,
      type: "todo/write",
      data: { todos: [{ content: "第一步", status: "in_progress" }] },
    });
    expect(e).toEqual({ t: "todo", seq: 10, items: [{ content: "第一步", status: "in_progress" }] });
  });

  it("内核内部事件（request/header 等）与垃圾输入 → []", () => {
    expect(proj({ seq: 1, type: "request/header", data: {} })).toEqual([]);
    expect(proj({ seq: 1, type: "session/end-seed", data: {} })).toEqual([]);
    expect(proj(null)).toEqual([]);
    expect(proj("junk")).toEqual([]);
  });
});

import type { Presenter } from "./tool-view";

/**
 * 推给对话界面的事件。这是万象自己的协议——内核的 SessionEvent 是它的
 * 原料，不是它。live 直播与历史回放走**同一个**投影函数，界面才不会出现
 * 「回放长得和当时不一样」。
 */
/** turn/end 的结束方式。aborted 是用户主动停，不是失败。 */
export type TurnEndReason =
  | "completed"
  | "aborted"
  | "blocked"
  | "error"
  | "max-tokens"
  | "interrupted";

const TURN_END_REASONS: readonly TurnEndReason[] = [
  "completed",
  "aborted",
  "blocked",
  "error",
  "max-tokens",
  "interrupted",
];

export type ChatEvent =
  | { t: "turn.start"; seq: number; turn: number }
  | { t: "turn.end"; seq: number; turn: number; reason: TurnEndReason; error?: string }
  | { t: "user"; seq: number; text: string; synthetic: boolean }
  | { t: "delta"; turn: number; step: number; text: string }
  | { t: "assistant"; seq: number; turn: number; step: number; text: string; interrupted: boolean }
  | { t: "tool.call"; seq: number; callId: string; label: string; input?: string }
  | { t: "tool.result"; seq: number; callId: string; ok: boolean; text: string }
  | { t: "todo"; seq: number; items: { content: string; status: string }[] }
  /** 池收掉这条会话时发给在线订阅者的告别帧（不是投影产物）。 */
  | { t: "bye" };

/** 从消息 content blocks 里取纯文本。 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

/**
 * 一条 SessionEvent → 0..n 条 ChatEvent。认不出的返回 []。
 *
 * presenter 注入进来（它有 per-agent 的工具 scope），本函数自身保持纯：
 * 同一串事件 + 同一个 presenter 永远投影出同一串结果，回放才可信。
 */
export function projectSessionEvent(ev: any, present: Presenter): ChatEvent[] {
  if (!ev || typeof ev !== "object") return [];
  const seq = typeof ev.seq === "number" ? ev.seq : 0;
  switch (ev.type) {
    case "turn/start":
      return [{ t: "turn.start", seq, turn: ev.data?.turn ?? 0 }];

    case "turn/end": {
      const r = ev.data?.reason;
      const kind = r?.kind ?? "completed";
      const reason: TurnEndReason = (TURN_END_REASONS as readonly string[]).includes(kind)
        ? (kind as TurnEndReason)
        : "completed";
      const error =
        kind === "error"
          ? (typeof r?.error?.message === "string" && r.error.message !== ""
              ? r.error.message
              : r?.error?.code) ?? "运行时出错"
          : undefined;
      return [
        { t: "turn.end", seq, turn: ev.data?.turn ?? 0, reason, ...(error ? { error } : {}) },
      ];
    }

    case "user/message": {
      // source.kind 区分「人说的」和 inject() 塞的合成上下文——后者不该
      // 冒充用户气泡（界面把 synthetic 的整条藏起来）。
      const synthetic = ev.data?.source?.kind !== "user";
      const text = textOf(ev.data?.content);
      return text.trim() === "" ? [] : [{ t: "user", seq, text, synthetic }];
    }

    case "assistant/chunk": {
      const c = ev.data?.chunk;
      // 思考过程（reasoning-delta）不进对话流：对最终用户是噪音。
      if (!c || c.type !== "text-delta" || typeof c.text !== "string") return [];
      return [{ t: "delta", turn: ev.data.turn, step: ev.data.step, text: c.text }];
    }

    case "assistant/message": {
      const text = textOf(ev.data?.message?.content);
      if (text.trim() === "") return [];
      return [
        {
          t: "assistant",
          seq,
          turn: ev.data.turn,
          step: ev.data.step,
          text,
          interrupted: ev.data.interrupted === true,
        },
      ];
    }

    case "tool/call": {
      const callId = String(ev.data?.callId ?? "");
      const view = present.call(String(ev.data?.name ?? ""), String(ev.data?.arguments ?? ""), callId);
      return [
        {
          t: "tool.call",
          seq,
          callId,
          label: view.label,
          ...(view.input ? { input: view.input } : {}),
        },
      ];
    }

    case "tool/result": {
      // callId 不在顶层——它在模型面消息的 ToolResultBlock 里。
      const callId = String(ev.data?.message?.content?.[0]?.toolCallId ?? "");
      const view = present.result(callId, ev.data);
      return [{ t: "tool.result", seq, callId, ok: view.ok, text: view.text }];
    }

    case "todo/write": {
      const items = Array.isArray(ev.data?.todos)
        ? ev.data.todos
            .filter((x: any) => x && typeof x === "object")
            .map((x: any) => ({
              content: typeof x.content === "string" ? x.content : "",
              status: typeof x.status === "string" ? x.status : "",
            }))
        : [];
      return [{ t: "todo", seq, items }];
    }

    default:
      // request/header、request/context、session/end-seed、approval/*……
      // 都是内核的内部事，不进界面。
      return [];
  }
}

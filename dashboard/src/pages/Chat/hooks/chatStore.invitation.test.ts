import { afterEach, expect, it } from "vitest";
import { removeSession, sendTurn } from "./chatStore";

const SESSION = "test-owned-invitation";

afterEach(() => removeSession(SESSION));

it("sends the invitation as metadata while keeping actual text unchanged", async () => {
  class FakeWebSocket extends EventTarget {
    static instances: FakeWebSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      super();
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(data: string) {
      this.sent.push(data);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
      this.onclose?.();
    }
  }

  const RealWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  try {
    const turn = sendTurn(
      SESSION,
      "那时我刚换团队",
      "own-profile",
      "",
      undefined,
      undefined,
      undefined,
      SESSION,
      undefined,
      ["own-library"],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "own-invitation",
    );
    await Promise.resolve();
    const socket = FakeWebSocket.instances[0];
    const payload = JSON.parse(
      socket.sent.find((row) => row.includes('"user_turn"'))!,
    );
    expect(payload.invitation_id).toBe("own-invitation");
    expect(payload.text).toBe("那时我刚换团队");
    expect(payload.messages).toEqual([
      { role: "user", content: "那时我刚换团队" },
    ]);
    expect(payload.knowledge_base_ids).toEqual(["own-library"]);
    socket.onmessage?.({ data: JSON.stringify({ type: "done" }) });
    await turn;
    socket.close();
  } finally {
    globalThis.WebSocket = RealWebSocket;
  }
});

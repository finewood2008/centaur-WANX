import { workspaceDir } from "../runs";
import {
  CHAT_PREFIX,
  createSession,
  resumeSession,
  type AgentHold,
} from "./agent-session";
import { projectSessionEvent, type ChatEvent } from "./chat-events";
import { makePresenter, type Presenter } from "./tool-view";

/**
 * 长活对话会话池。
 *
 * 「跑一次」是一次性会话，跑完即收；「对话」是长活会话——用户关掉页面
 * 再回来，同一条会话要还热着（或能从日志里复活）。池管三件事：
 *   · 建/复活/复用：同一 sessionId 的第二个订阅者挂到同一个 entry；
 *   · 事件扇出：每个 entry 只挂一份 session/event 订阅，投影后发给 N 个订阅者；
 *   · 回收：没人订阅且闲置超时的 agent 收掉（dispose 是 async，必须 await），
 *     超过上限时 LRU 淘汰。会话日志始终落盘，收掉的随时能复活。
 */

export interface ChatPoolOptions {
  appsDir: string;
  /** 同时活着的对话 agent 上限。超出时淘汰最久没动静的空闲者。 */
  maxLive?: number;
  /** 没人订阅后多久回收。 */
  idleMs?: number;
}

interface Entry {
  sessionId: string;
  slug: string;
  hold: AgentHold;
  present: Presenter;
  subscribers: Set<(e: ChatEvent) => void>;
  offSession?: () => void;
  lastTouched: number;
}

const CHAT_ID_RE = /^wanx-chat-[a-z0-9-]+-[0-9a-f-]{36}$/u;

export class ChatPool {
  private readonly ctx: any;
  private readonly appsDir: string;
  private readonly maxLive: number;
  private readonly idleMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<Entry>>();
  /** 正在 close 的会话：open 必须等它排干——dispose 没完成就 resume 同一
   *  id，内核的持久化守卫会抛「cannot prepare session while it is live」。 */
  private readonly closing = new Map<string, Promise<void>>();

  constructor(ctx: any, opts: ChatPoolOptions) {
    this.ctx = ctx;
    this.appsDir = opts.appsDir;
    this.maxLive = opts.maxLive ?? 4;
    this.idleMs = opts.idleMs ?? 15 * 60_000;
  }

  /** 新开一条对话。 */
  async create(slug: string): Promise<Entry> {
    const hold = await createSession(this.ctx, {
      slug,
      kind: "chat",
      cwd: workspaceDir(this.appsDir, slug),
    });
    return this.adopt(String(hold.agent.session.id), slug, hold);
  }

  /**
   * 打开一条已有对话：池里热着就直接用，不然从日志里复活。
   * 并发打开同一条时共享同一个复活过程。
   */
  async open(sessionId: string): Promise<Entry> {
    if (!CHAT_ID_RE.test(sessionId)) throw new Error("不认识这条对话");
    // 同一条正在收尾？等它收完再复活，别撞进 dispose 的窗口。
    const draining = this.closing.get(sessionId);
    if (draining) await draining.catch(() => {});
    const live = this.entries.get(sessionId);
    if (live) {
      live.lastTouched = Date.now();
      return live;
    }
    const inFlight = this.opening.get(sessionId);
    if (inFlight) return inFlight;
    const p = (async () => {
      const hold = await resumeSession(this.ctx, sessionId);
      return this.adopt(sessionId, hold.presetId, hold);
    })().finally(() => this.opening.delete(sessionId));
    this.opening.set(sessionId, p);
    return p;
  }

  get(sessionId: string): Entry | undefined {
    return this.entries.get(sessionId);
  }

  /** 订阅一条对话的投影事件流。返回退订函数。 */
  subscribe(sessionId: string, fn: (e: ChatEvent) => void): () => void {
    const entry = this.entries.get(sessionId);
    if (!entry) throw new Error("这条对话不在线");
    entry.subscribers.add(fn);
    entry.lastTouched = Date.now();
    return () => {
      entry.subscribers.delete(fn);
      entry.lastTouched = Date.now();
    };
  }

  /** 发一句话。助手正说着就插话（steer），闲着就开新一轮（followup）。
   *  不在线就先复活——用户的话不该因为池的生命周期而丢。 */
  async say(sessionId: string, text: string): Promise<void> {
    const entry = this.entries.get(sessionId) ?? (await this.open(sessionId));
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const msg = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" },
    });
    const agent = entry.hold.agent;
    if (agent.status === "running") agent.steer(msg);
    else agent.followup(msg);
    entry.lastTouched = Date.now();
  }

  /** 停下当前这轮。界面靠 turn/end 的 reason=aborted 收尾——那不是失败。 */
  stop(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    try {
      entry.hold.agent.cancel({ kind: "user" });
    } catch {
      /* 已经停了就算了 */
    }
  }

  /** 收掉一条会话（日志保留，随时能再 open）。并发 close 共享同一次收尾。 */
  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      await this.closing.get(sessionId)?.catch(() => {});
      return;
    }
    const done = (async () => {
      this.entries.delete(sessionId);
      // 先告诉在线订阅者「这条要下线了」：server 端收到 bye 会结束 SSE，
      // 前端要么停下要么重连复活——总之不是永久静默地挂着。
      for (const fn of entry.subscribers) {
        try {
          fn({ t: "bye" });
        } catch {
          /* 订阅者坏了也得继续收 */
        }
      }
      entry.subscribers.clear();
      entry.offSession?.();
      try {
        await this.ctx.get("sessions").flush(entry.hold.agent.session);
      } catch {
        /* flush 失败不挡 dispose */
      }
      try {
        await entry.hold.dispose();
      } catch {
        /* dispose 抛错不外泄 */
      }
    })();
    this.closing.set(sessionId, done);
    try {
      await done;
    } finally {
      this.closing.delete(sessionId);
    }
  }

  /** 定时清扫：没人看、闲置超时、agent 空闲的收掉。
   *  条件在**每次 close 之前复查**——清扫第 1 条的 await 期间，
   *  第 2 条完全可能刚被订阅或刚开跑。 */
  async sweep(): Promise<void> {
    const candidates = [...this.entries.keys()];
    for (const id of candidates) {
      const e = this.entries.get(id);
      if (!e) continue;
      if (e.subscribers.size > 0) continue;
      if (e.hold.agent.status === "running") continue;
      if (Date.now() - e.lastTouched <= this.idleMs) continue;
      await this.close(id);
    }
  }

  /** 插件卸载（热重组）时整体收掉，不留孤儿 agent。 */
  async closeAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }

  private adopt(sessionId: string, slug: string, hold: AgentHold): Entry {
    const present = makePresenter(this.ctx, hold.agent);
    const entry: Entry = {
      sessionId,
      slug,
      hold,
      present,
      subscribers: new Set(),
      lastTouched: Date.now(),
    };
    try {
      entry.offSession = this.ctx.on("session/event", (session: any, event: any) => {
        if (session?.id !== hold.agent.session.id) return;
        for (const ce of projectSessionEvent(event, present)) {
          for (const fn of entry.subscribers) {
            try {
              fn(ce);
            } catch {
              /* 单个订阅者坏了不影响其他人 */
            }
          }
        }
        // 每轮说完就落盘：用户关掉页面，历史也不丢。
        if (event?.type === "turn/end") {
          void Promise.resolve(this.ctx.get("sessions").flush(hold.agent.session)).catch(() => {});
        }
      });
    } catch {
      /* 订阅不上：live 推送缺席，回放照常 */
    }
    this.entries.set(sessionId, entry);
    void this.evictOverflow(sessionId);
    return entry;
  }

  /**
   * 超上限时 LRU 淘汰空闲无人看的。`keepId` 是**这次刚 adopt 的那条**——
   * 它此刻必然还没被 subscribe（订阅在 open 返回之后），不排除的话池满时
   * 唯一的合法候选就是它自己：新会话建了就被杀，前端重连再建再杀，死循环。
   */
  private async evictOverflow(keepId: string): Promise<void> {
    while (this.entries.size > this.maxLive) {
      let oldest: Entry | undefined;
      for (const e of this.entries.values()) {
        if (e.sessionId === keepId) continue;
        if (e.subscribers.size > 0 || e.hold.agent.status === "running") continue;
        if (!oldest || e.lastTouched < oldest.lastTouched) oldest = e;
      }
      if (!oldest) return; // 其余全在忙——宁可超上限也不掐活人
      await this.close(oldest.sessionId);
    }
  }
}

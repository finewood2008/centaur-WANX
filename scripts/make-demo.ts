/**
 * 走**真实的访谈流程**造一个示例助手，产物固化进 `examples/`。
 *
 * 为什么不手写：示例里的 `prd.md` 带着「由产品经理归纳」「你当时是怎么想的」
 * 这些标记，手写等于伪造一场没发生过的对话。这个脚本真的去跟产品经理聊，
 * 每轮从它给的选项里挑，聊满 9 个槽位再 finalize——出来的文档是真的。
 *
 * 需要服务已经起着，并且配了模型 key。
 *
 * 跑法：
 *   WANXIANG_PORT=8788 npm start                      # 另一个终端
 *   npx tsx scripts/make-demo.ts "帮我把会议记录整理成待办"
 */
const PORT = process.env.WANXIANG_PORT ?? "8788";
const BASE = `http://127.0.0.1:${PORT}`;
const intent = process.argv[2] ?? "帮我把会议记录整理成待办清单，标出谁负责、什么时候要";

/**
 * 「加法型」槽位——选项之间是叠加关系，多选几个只会让文档更厚。
 *
 * `workflow` **不在**这里：实测模型在那一问上给的常是三个互斥的**模式**
 *（「中途不确认一次性输出」/「关键节点暂停确认」/「先出草稿再定稿」），
 * 全勾上会得到一份自相矛盾的工作手册。真人不会那么选，脚本也不该。
 */
const ADDITIVE = new Set(["sources", "actions", "deliverable", "boundaries", "params"]);

/** 加法型槽位取前三条，其余取第一条。 */
function pick(ask: any): { shown: string; forModel: string; value: string | string[] } {
  const opts = ask.options ?? [];
  const many = ask.type === "multi" && ADDITIVE.has(ask.slot);
  const chosen = many ? opts.slice(0, 3) : opts.slice(0, 1);
  return {
    shown: chosen.map((o: any) => o.label).join("、"),
    forModel: chosen.map((o: any) => o.doc || o.label).join("；"),
    value: ask.type === "multi" ? chosen.map((o: any) => o.doc || o.label) : chosen[0].doc || chosen[0].label,
  };
}

/** 读一轮 SSE，返回 done 事件的 payload。 */
async function turn(body: unknown): Promise<any> {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`/api/chat 返回 ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      if (event === "error") throw new Error(payload.error);
      if (event === "done") return payload;
    }
  }
  throw new Error("连接中断了");
}

const messages: Array<{ role: string; content: string }> = [{ role: "user", content: intent }];
let draft: unknown = { slots: {}, derived: {} };
let t = 0;
let answered: unknown = null;

console.log(`意图：${intent}\n`);

for (let round = 0; round < 20; round++) {
  const out = await turn({ messages, draft, turn: t, answered });
  draft = out.draft;
  t = out.turn;
  messages.push({ role: "assistant", content: out.prose });

  const question = (out.prose || "").split("\n").filter((l: string) => l.trim()).pop() ?? "";
  console.log(`第 ${t} 轮  已答 ${out.answered}/9`);
  console.log(`  问：${question.slice(0, 70)}`);

  if (out.done) {
    console.log("\n聊完了，开始组装……");
    break;
  }
  if (!out.ask) throw new Error("这一轮没给选项");

  const choice = pick(out.ask);
  console.log(`  选：${choice.shown}\n`);
  answered = { slot: out.ask.slot, value: choice.value };
  messages.push({ role: "user", content: choice.forModel });
}

const res = await fetch(`${BASE}/api/finalize`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ draft, turns: t }),
});
const app = await res.json();
if (!res.ok || app.ok === false) throw new Error(app.error ?? `finalize 返回 ${res.status}`);

console.log(`\n✓ 造好了：「${app.name}」`);
console.log(`  slug     : ${app.slug}`);
console.log(`  修复次数 : ${app.repairs}`);
console.log(`  有文档   : ${app.hasPrd}`);
console.log(`  落盘     : ${app.dir}`);

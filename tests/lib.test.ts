import { describe, it, expect } from "vitest";
import { esc, extractListItems, extractTables, md, sseFrames } from "../public/static/lib.js";

describe("md —— 助手输出的渲染，安全优先", () => {
  it("代码块整段原样，块内的 ** 与 | 不做行内处理", () => {
    const html = md("```js\nconst a = **不是粗体** | 竖线;\n```");
    expect(html).toContain('<pre><code class="lang-js">');
    expect(html).toContain("**不是粗体** | 竖线");
    expect(html).not.toContain("<b>");
  });

  it("表格", () => {
    const html = md("| 客户 | 状态 |\n|---|---|\n| 张三 | **跟进中** |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>客户</th>");
    expect(html).toContain("<td><b>跟进中</b></td>");
  });

  it("链接白名单：http(s) 与站内路径放行，javascript: 按原文显示", () => {
    expect(md("[官网](https://example.com)")).toContain('href="https://example.com"');
    expect(md("[文档](/wanx/api/apps/x/prd.md)")).toContain('href="/wanx/api/apps/x/prd.md"');
    const evil = md("[点我](javascript:alert(1))");
    expect(evil).not.toContain("href=");
    expect(evil).toContain("[点我](javascript:alert(1))");
  });

  it("伪装成站内路径的外站不放行：//host 与 /\\host", () => {
    expect(md("[a](//phish.example)")).not.toContain("href=");
    expect(md("[a](/\\evil.com)")).not.toContain("href=");
  });

  it("HTML 一律转义，不逃逸", () => {
    const html = md('<img src=x onerror=alert(1)> 与 <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img");
  });

  it("行内 code 里的星号不被吃；正文数字不受占位符影响", () => {
    const html = md("共 3 份，`a*b*c` 与 0 号");
    expect(html).toContain("<code>a*b*c</code>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("共 3 份");
    expect(html).toContain("0 号");
  });

  it("标题 / 列表 / 引用 / 分隔线", () => {
    const html = md("# 标题\n- 一\n- 二\n\n> 引文\n\n---");
    expect(html).toContain("<h3>标题</h3>");
    expect(html).toContain("<ul><li>一</li><li>二</li></ul>".replace("<ul>", "<ul>"));
    expect(html).toContain("<blockquote>引文</blockquote>");
    expect(html).toContain("<hr>");
  });

  it("esc 基本面", () => {
    expect(esc('<a b="c">&')).toBe("&lt;a b=&quot;c&quot;&gt;&amp;");
  });
});

describe("extractListItems —— 工作台清单主区的原料", () => {
  it("三种列表形态与勾选框；代码块里的不算", () => {
    const src = "# 待办\n- [x] 已回访张三\n- [ ] 给李四发合同\n1. 整理台账\n```\n- 这行是代码不是待办\n```\n* 补充记录";
    expect(extractListItems(src)).toEqual([
      { text: "已回访张三", done: true },
      { text: "给李四发合同", done: false },
      { text: "整理台账", done: false },
      { text: "补充记录", done: false },
    ]);
  });

  it("没有清单时返回空数组", () => {
    expect(extractListItems("一段散文而已")).toEqual([]);
  });
});

describe("extractTables —— 工作台表格主区的原料", () => {
  it("提取表头与行", () => {
    const src = "说明\n\n| 客户 | 状态 |\n|---|---|\n| 张三 | 跟进中 |\n| 李四 | 已成交 |\n\n后记";
    expect(extractTables(src)).toEqual([
      { head: ["客户", "状态"], rows: [["张三", "跟进中"], ["李四", "已成交"]] },
    ]);
  });

  it("代码块里的伪表格不算", () => {
    const src = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(extractTables(src)).toEqual([]);
  });
});

/** 把字符串按任意切法喂成 SSE Response。 */
function sseResponse(chunks: string[]): { body: ReadableStream<Uint8Array> } {
  const enc = new TextEncoder();
  return {
    body: new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(enc.encode(chunk));
        c.close();
      },
    }),
  };
}

describe("sseFrames —— 三条流共用的唯一解析", () => {
  it("基本帧与事件名", async () => {
    const frames = [];
    for await (const f of sseFrames(sseResponse(['event: chat\ndata: {"t":"user"}\n\n']))) frames.push(f);
    expect(frames).toEqual([{ event: "chat", data: { t: "user" } }]);
  });

  it("帧跨 chunk 切开也能拼回来", async () => {
    const frames = [];
    for await (const f of sseFrames(sseResponse(['event: chat\nda', 'ta: {"a":1}\n', "\n"]))) frames.push(f);
    expect(frames).toEqual([{ event: "chat", data: { a: 1 } }]);
  });

  it("只剥一个前导空格：载荷首字符的空白活下来", async () => {
    const frames = [];
    for await (const f of sseFrames(sseResponse(['data: {"text":"  两个空格"}\n\n']))) frames.push(f);
    expect(frames[0].data.text).toBe("  两个空格");
  });

  it("注释帧（keepalive）跳过；坏 JSON 跳过不中断", async () => {
    const frames = [];
    const body = ': ping\n\ndata: 不是json\n\nevent: chat\ndata: {"ok":true}\n\n';
    for await (const f of sseFrames(sseResponse([body]))) frames.push(f);
    expect(frames).toEqual([{ event: "chat", data: { ok: true } }]);
  });
});

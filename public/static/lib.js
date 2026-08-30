/**
 * 前端公共件（ES module，vitest 可直接 import 做单测）：
 *   esc        HTML 转义
 *   md         够用的 Markdown 渲染——先 esc 再上正则，链接白名单，绝不逃逸
 *   sseFrames  SSE 帧解析的唯一实现（访谈 / 跑一次 / 对话三条流共用）
 */

export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** 行内标记。code span 先摘出去占位，免得里面的 * _ 被后面的规则啃了。 */
function inline(t) {
  const codes = [];
  let s = esc(t).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\s][^*]*)\*/g, "<i>$1</i>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    // 链接白名单：只放行 http(s) 与真正的站内路径。javascript: 之流按原文
    // 显示；//host（协议相对）和 /\host（浏览器当 //host 解析）不算站内。
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) =>
      /^(https?:\/\/|\/(?![/\\]))/u.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
        : m,
    );
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? "");
}

/**
 * Markdown → HTML。覆盖助手会写的东西：标题、列表、粗斜体、行内代码、
 * 围栏代码块（块内不做任何行内处理）、表格、引用、分隔线、白名单链接。
 * 输入先整体 esc，输出可以直接 innerHTML。
 */
export function md(src) {
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const lines = String(src).split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // 围栏代码块：整段原样（仅 esc），里面的 **、| 都是字面。
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 吃掉收尾的 ```
      const cls = fence[1] ? ` class="lang-${esc(fence[1])}"` : "";
      out.push(`<pre><code${cls}>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // 表格：连续的 | 行，第二行是 |---|:--- 这类分隔。
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s|:-]+\|\s*$/.test(lines[i + 1])) {
      closeList();
      const cells = (row) => row.replace(/^\||\|\s*$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        body.push(cells(lines[i]));
        i += 1;
      }
      out.push(
        '<div class="md-table"><table><thead><tr>' +
          head.map((c) => `<th>${c}</th>`).join("") +
          "</tr></thead><tbody>" +
          body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>",
      );
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (/^(-{3,}|\*{3,})$/.test(line)) {
      closeList();
      out.push("<hr>");
    } else if (h) {
      closeList();
      out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
    } else if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ul[1])}</li>`);
    } else if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ol[1])}</li>`);
    } else if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
    } else if (line === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
    i += 1;
  }
  closeList();
  return out.join("");
}

/**
 * 把一个 fetch Response 的 SSE 体解析成 {event, data} 帧的异步序列。
 *
 * 与服务端的约定：一个事件一行 JSON（载荷里的换行靠 JSON 转义活着）。
 * 按 SSE 规范只剥 data: 后的一个前导空格；多行 data 用 \n 连接——
 * 以前两处手抄的解析对每行 .trim() 再拼接，会吃掉正文的空白。
 * 以 ":" 开头的注释帧（keepalive）直接跳过。
 */
export async function* sseFrames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
      }
      if (data.length === 0) continue;
      let payload;
      try {
        payload = JSON.parse(data.join("\n"));
      } catch {
        continue; // 坏帧跳过，别让一条噪音掐断整条流
      }
      yield { event, data: payload };
    }
  }
}

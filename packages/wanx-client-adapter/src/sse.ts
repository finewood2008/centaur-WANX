import type { ServerEvent } from "./types.js";
/** Decode SSE across byte, UTF-8 and CRLF boundaries. No request replay. */
export async function* parseSSE(chunks: AsyncIterable<Uint8Array>): AsyncIterable<ServerEvent> {
  const decoder = new TextDecoder();
  let buffer = "", data: string[] = [], event = "message", id: string | undefined, retry: number | undefined;
  let first = true;
  function line(value: string): ServerEvent | undefined {
    if (first) { value = value.replace(/^\uFEFF/u, ""); first = false; }
    if (value === "") {
      const result = data.length ? { event, data: data.join("\n"), ...(id !== undefined ? { id } : {}), ...(retry !== undefined ? { retry } : {}) } : undefined;
      data = []; event = "message"; retry = undefined; return result;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /u, "");
    if (field === "data") data.push(content);
    else if (field === "event") event = content;
    else if (field === "id" && !content.includes("\0")) id = content;
    else if (field === "retry" && /^\d+$/u.test(content)) retry = Number(content);
  }
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /[\r\n]/u.exec(buffer); if (!match) break;
      const i = match.index;
      if (buffer[i] === "\r" && i === buffer.length - 1) break;
      const width = buffer[i] === "\r" && buffer[i + 1] === "\n" ? 2 : 1;
      const result = line(buffer.slice(0, i)); buffer = buffer.slice(i + width);
      if (result) yield result;
    }
  }
  buffer += decoder.decode();
  // SSE dispatches only on an empty line; incomplete events at EOF are discarded.
  if (buffer.endsWith("\r")) { const result = line(buffer.slice(0, -1)); if (result) yield result; }
}

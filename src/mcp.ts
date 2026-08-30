import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { dump, load } from "js-yaml";

/**
 * MCP 接入 —— 「给助手接外部能力」。
 *
 * DSH 的 `dsh-mcp-client` 是零代码的生态通道：组合层里一行 insert 就接上一个
 * MCP server，工具自动注册成 `mcp__<server>__<tool>`，断线重连、热替换都是
 * 现成的。万象把这些行写进 wanxiang profile 的用户补丁层
 * （`$DSH_HOME/profiles/wanxiang/cordis.patch.yml`），补丁层被 HMR 盯着——
 * 改完文件即热生效，不用重启。
 *
 * 这一层只管「哪些 server 被声明了」。工具是注册进 host 的全局层的，
 * 接上之后**所有**助手（含细聊）都能用——这正是用户点「接上」时要的效果。
 *
 * 管理约定：万象只动 id 形如 `mcp-<serverName>` 的行，其余补丁条目原样保留。
 * 文件被手工编辑出解析不了的内容（比如 `!!js` 标签）时，拒绝改动并把原因
 * 告诉用户——绝不悄悄改写一份看不懂的文件。
 */

export interface McpServerSpec {
  serverName: string;
  transport: "stdio" | "streamable-http";
  /** stdio：要执行的命令。 */
  command?: string;
  /** stdio：命令参数。 */
  args?: string[];
  /** streamable-http：服务地址。 */
  url?: string;
}

/** server 名进工具名（mcp__<server>__<tool>）也进行 id，两头都要求保守的形状。 */
const SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** 校验一份新 server 声明。返回 null 表示合法，否则是给用户看的中文原因。 */
export function validateMcpSpec(spec: unknown): string | null {
  if (!spec || typeof spec !== "object") return "缺少 server 描述";
  const s = spec as Record<string, unknown>;
  if (typeof s.serverName !== "string" || !SERVER_NAME_RE.test(s.serverName)) {
    return "名称只能用小写字母、数字和连字符，开头是字母或数字，最长 32 位";
  }
  if (s.transport === "stdio") {
    if (typeof s.command !== "string" || s.command.trim() === "") {
      return "stdio 方式需要填要执行的命令";
    }
    if (s.args !== undefined) {
      if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string")) {
        return "参数得是字符串数组";
      }
    }
    return null;
  }
  if (s.transport === "streamable-http") {
    if (typeof s.url !== "string") return "http 方式需要填服务地址";
    try {
      const u = new URL(s.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return "服务地址得是 http(s) 的";
    } catch {
      return "服务地址不是合法的 URL";
    }
    return null;
  }
  return "接入方式只支持 stdio 或 streamable-http";
}

interface PatchEntry {
  [key: string]: unknown;
}

async function readPatchEntries(patchFile: string): Promise<PatchEntry[]> {
  let text: string;
  try {
    text = await readFile(patchFile, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = load(text);
  } catch {
    throw new Error(
      "补丁文件里有万象读不懂的内容（比如手写的 !!js 表达式）。请手工维护它，或先把手写部分挪走。",
    );
  }
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error("补丁文件不是一个列表，万象不敢动它。");
  }
  return parsed as PatchEntry[];
}

function mcpRowId(serverName: string): string {
  return `mcp-${serverName}`;
}

function rowToSpec(row: PatchEntry): McpServerSpec | null {
  const config = row.config as Record<string, unknown> | undefined;
  if (!config || typeof config.serverName !== "string") return null;
  const transport = config.transport === "streamable-http" ? "streamable-http" : "stdio";
  const spec: McpServerSpec = { serverName: config.serverName, transport };
  if (typeof config.command === "string") spec.command = config.command;
  if (Array.isArray(config.args)) spec.args = config.args.filter((a): a is string => typeof a === "string");
  if (typeof config.url === "string") spec.url = config.url;
  return spec;
}

/** 从所有 insert 块里收集万象管理的 mcp-* 行。 */
function collectMcpRows(entries: PatchEntry[]): PatchEntry[] {
  const rows: PatchEntry[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.insert)) continue;
    for (const row of entry.insert as PatchEntry[]) {
      if (typeof row.id === "string" && row.id.startsWith("mcp-")) rows.push(row);
    }
  }
  return rows;
}

/** 把 mcp-* 行从所有 insert 块里剔掉；剔空的 insert 块整个删掉。其余条目原样保留。 */
function withoutMcpRows(entries: PatchEntry[], serverName?: string): PatchEntry[] {
  const out: PatchEntry[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.insert)) {
      out.push(entry);
      continue;
    }
    const kept = (entry.insert as PatchEntry[]).filter((row) => {
      if (typeof row.id !== "string" || !row.id.startsWith("mcp-")) return true;
      if (serverName === undefined) return false;
      return row.id !== mcpRowId(serverName);
    });
    if (kept.length > 0) out.push({ ...entry, insert: kept });
  }
  return out;
}

async function writePatchEntries(patchFile: string, entries: PatchEntry[]): Promise<void> {
  const header =
    "# wanxiang profile 的用户补丁层。\n" +
    "# 「外部能力（MCP）」的行由万象管理（id 形如 mcp-*）；其余条目请随意手写，\n" +
    "# 但注意万象改动此文件时会做一次 YAML round-trip，注释保不住。\n";
  const body = entries.length === 0 ? "[]\n" : dump(entries, { lineWidth: -1, noRefs: true });
  await mkdir(dirname(patchFile), { recursive: true });
  await writeFile(patchFile, header + body, "utf-8");
}

/** 当前声明的 MCP server 列表。 */
export async function listMcpServers(patchFile: string): Promise<McpServerSpec[]> {
  const entries = await readPatchEntries(patchFile);
  return collectMcpRows(entries)
    .map(rowToSpec)
    .filter((s): s is McpServerSpec => s !== null);
}

/** 接上一个 server。重名拒绝。返回改动后的清单。 */
export async function addMcpServer(patchFile: string, spec: McpServerSpec): Promise<McpServerSpec[]> {
  const invalid = validateMcpSpec(spec);
  if (invalid) throw new Error(invalid);

  const entries = await readPatchEntries(patchFile);
  const existing = collectMcpRows(entries).map(rowToSpec);
  if (existing.some((s) => s?.serverName === spec.serverName)) {
    throw new Error(`已经有一个叫「${spec.serverName}」的了，先删掉旧的或换个名字`);
  }

  const config: Record<string, unknown> = {
    serverName: spec.serverName,
    transport: spec.transport,
    // 连不上时别拒绝整棵组合树——断线重连是 dsh-mcp-client 自带的。
    failOnStartupError: false,
  };
  if (spec.transport === "stdio") {
    config.command = spec.command;
    if (spec.args && spec.args.length > 0) config.args = spec.args;
  } else {
    config.url = spec.url;
  }

  const next = [
    ...entries,
    {
      insert: [{ id: mcpRowId(spec.serverName), name: "@deepseek-ai/dsh-mcp-client", config }],
    },
  ];
  await writePatchEntries(patchFile, next);
  return listMcpServers(patchFile);
}

/** 断开一个 server。返回改动后的清单。 */
export async function removeMcpServer(patchFile: string, serverName: string): Promise<McpServerSpec[]> {
  if (!SERVER_NAME_RE.test(serverName)) throw new Error("无效的名称");
  const entries = await readPatchEntries(patchFile);
  const before = collectMcpRows(entries).length;
  const next = withoutMcpRows(entries, serverName);
  if (collectMcpRows(next).length === before) {
    throw new Error(`没有叫「${serverName}」的外部能力`);
  }
  await writePatchEntries(patchFile, next);
  return listMcpServers(patchFile);
}

import type { Capability } from "../appspec/schema";

/**
 * 知君插件（占位，尚未实现）。这些插件名在 DSH 里不存在，
 * 加载会失败。生成「DSH 兼容变体」时统一过滤掉。
 */
export const CENTAUR_PLUGINS = new Set<string>([
  "@centaur/plugin-memory-read",
  "@centaur/plugin-memory-write",
  "@centaur/plugin-notify",
]);

/**
 * 记忆工具插件（由知君插件提供）。
 * 插件名为占位，待知君插件实现时对齐实际包名。
 * 每个应用都长在知君记忆上，故始终挂载。
 */
export const MEMORY_TOOL_PLUGINS = [
  "@centaur/plugin-memory-read",
  "@centaur/plugin-memory-write",
] as const;

/**
 * 基线工具行 —— 每个助手都拿到的最小工具集，从 DSH 的 standard preset 裁下来。
 *
 * 万象跑在 web profile 上，而 web bundle 把 host 平面所有面向模型的工具全部
 * `disabled: true`（挪进 preset 平面）。所以 preset 里没列的工具，助手就真的
 * 没有——`capabilities` 从这里开始才是真话，不再是文档字段。
 *
 * 刻意**不给**的：tool-bash / tool-pwsh（助手面向不懂技术的用户，shell 是它
 * 用不着也不该有的权力面）、subagent / workflow / ralph（编排是万象的活，
 * 不是助手的）、plan-mode（job 模型下没有计划环节）。
 *
 * 这些行都只消费 host 服务（tools / fs / skills 注册表），不发布任何服务，
 * 所以可以裸放，不需要 isolate realm——standard preset 里同样是裸行。
 */
export const BASELINE_TOOL_ROWS = [
  {
    id: "agent-instructions",
    name: "@deepseek-ai/dsh-agent-instructions",
    config: { maxBytes: 65536 },
  },
  { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
  {
    id: "tool-fs-search",
    name: "@deepseek-ai/dsh-tool-fs-search",
    config: { sampleOverCapGlobResults: false },
  },
  {
    id: "tool-todo",
    name: "@deepseek-ai/dsh-tool-todo",
    config: { allowParallelInProgress: true },
  },
] as const;

/**
 * capabilities → tool-web 的配置。
 *
 * search 只要搜索；browse / api_call 需要真的抓取网页，所以打开 fetch。
 * （standard preset 出厂 `fetch: false`——SSRF 顾虑——这里按用户在访谈里
 * 亲口选的能力放开，选了才有。）
 * 三者都没选就不挂 tool-web，返回 null。
 *
 * summarize / extract / compose 是模型自带能力，不挂工具，由 persona 引导。
 * notify 等知君插件实现（见 CENTAUR_PLUGINS）。
 */
export function capabilityWebConfig(
  capabilities: readonly Capability[],
): { fetch: boolean; searchTimeoutMs: number } | null {
  const wantsSearch = capabilities.includes("search");
  const wantsFetch = capabilities.includes("browse") || capabilities.includes("api_call");
  if (!wantsSearch && !wantsFetch) return null;
  return { fetch: wantsFetch, searchTimeoutMs: 60000 };
}

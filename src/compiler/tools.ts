import type { Capability } from "../appspec/schema";

/**
 * 知君插件（占位，尚未实现）。这些插件名在 DSH 里不存在，
 * 加载会失败。M0 阶段生成「DSH 兼容变体」时统一过滤掉。
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
 * capability → 需要挂载的工具插件（DSH 插件名）。
 * summarize / extract / compose 是模型能力，不挂专门工具，由 persona 指令引导。
 */
export const CAPABILITY_TOOL_PLUGINS: Record<Capability, string[]> = {
  search: ["@deepseek-ai/dsh-tool-web"],
  summarize: [],
  extract: [],
  compose: [],
  notify: ["@centaur/plugin-notify"],
  api_call: ["@deepseek-ai/dsh-tool-web"],
  browse: ["@deepseek-ai/dsh-tool-web"],
};

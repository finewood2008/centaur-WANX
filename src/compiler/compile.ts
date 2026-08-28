import type { AppSpec } from "../appspec/schema";
import { buildPersonaText } from "./persona";
import {
  CAPABILITY_TOOL_PLUGINS,
  CENTAUR_PLUGINS,
  DOMAIN_SKILLS,
  MEMORY_TOOL_PLUGINS,
} from "./tools";
import type { AppPackage, PluginEntry } from "./types";

/**
 * 把 AppSpec 确定性编译成应用包（DSH preset）。
 * 纯函数：同一 AppSpec 永远产出同一 AppPackage。
 * includeCentaurPlugins=false 时过滤掉所有 @centaur/* 占位插件（知君插件尚未实现），
 * 生成「DSH 兼容变体」，用于 M0 阶段在真实 DSH 实例里加载运行。
 */
export function compile(
  appspec: AppSpec,
  options: { includeCentaurPlugins?: boolean } = {},
): AppPackage {
  const includeCentaur = options.includeCentaurPlugins ?? true;
  const persona: PluginEntry = {
    id: "persona",
    name: "@deepseek-ai/dsh-persona",
    config: { text: buildPersonaText(appspec) },
  };

  const memoryTools: PluginEntry[] = MEMORY_TOOL_PLUGINS.map((name, i) => ({
    id: `memory-tool-${i}`,
    name,
  }));

  const toolNames = uniqueSorted(
    appspec.capabilities.flatMap((c) => CAPABILITY_TOOL_PLUGINS[c]),
  );
  const capabilityTools: PluginEntry[] = toolNames.map((name, i) => ({
    id: `capability-tool-${i}`,
    name,
  }));

  const skills = DOMAIN_SKILLS[appspec.domain];
  const skillPlugins: PluginEntry[] =
    skills.length > 0
      ? [
          {
            id: "skill-filesystem",
            name: "@deepseek-ai/dsh-skill-filesystem",
            config: { customSkillDirs: [] },
          },
          { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
        ]
      : [];

  const agentCordis: PluginEntry[] = [
    persona,
    ...memoryTools,
    ...capabilityTools,
    ...skillPlugins,
  ].filter((e) => includeCentaur || !CENTAUR_PLUGINS.has(e.name));

  return {
    preset: {
      name: appspec.name,
      description: appspec.description,
      order: 0,
      agentCordis,
    },
    memoryBinding: {
      read: [...appspec.memory_binding.read],
      write: [...appspec.memory_binding.write],
      retrieval: appspec.memory_binding.retrieval,
    },
    meta: {
      name: appspec.name,
      description: appspec.description,
      schema_version: appspec.schema_version,
      domain: appspec.domain,
    },
  };
}

function uniqueSorted(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

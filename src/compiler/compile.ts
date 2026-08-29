import type { AppSpec } from "../appspec/schema";
import { buildPersonaText } from "./persona";
import { CAPABILITY_TOOL_PLUGINS, CENTAUR_PLUGINS, MEMORY_TOOL_PLUGINS } from "./tools";
import { compileSkill } from "./skill";
import type { AppPackage, PluginEntry } from "./types";

export interface CompileOptions {
  /** false 时过滤掉所有 @centaur/* 占位插件（知君插件尚未实现），生成 DSH 兼容变体。 */
  includeCentaurPlugins?: boolean;
  /** 保留给调用方，当前编译不再依赖它（技能装载走 $DSH_HOME/skills）。 */
  appsDir?: string;
}

/**
 * 把 AppSpec 确定性编译成应用包（DSH preset ＋ 技能文件）。
 * 同一 AppSpec ＋ 同一 appsDir 永远产出同一 AppPackage。
 */
export function compile(appspec: AppSpec, options: CompileOptions = {}): AppPackage {
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

  const toolNames = uniqueSorted(appspec.capabilities.flatMap((c) => CAPABILITY_TOOL_PLUGINS[c]));
  const capabilityTools: PluginEntry[] = toolNames.map((name, i) => ({
    id: `capability-tool-${i}`,
    name,
  }));

  // 技能插件的挂载条件是「生成了工作流程」，不是过去那张挂名的 DOMAIN_SKILLS 表。
  // 挂载条件写错，SKILL.md 会被生成出来却从不加载——整个「自动开发」静默失效。
  //
  // 不带 config：实测 DSH 会**整个忽略** preset 里给 skill-filesystem 写的 config
  // （`includeDefaultRoots: false` 写了也不生效，`customSkillDirs` 从不被扫描）。
  // 内置的 standard preset 同样是空配置。技能靠装进 $DSH_HOME/skills 被发现，
  // 由 server 的 installApp 负责——见那里的注释。
  const skill = compileSkill(appspec);
  const skillPlugins: PluginEntry[] = skill
    ? [
        { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
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
    skill,
    meta: {
      name: appspec.name,
      description: appspec.description,
      schema_version: appspec.schema_version,
      domain: appspec.domain,
      goal: appspec.goal,
      capabilities: [...appspec.capabilities],
      memory_binding: {
        read: [...appspec.memory_binding.read],
        write: [...appspec.memory_binding.write],
        retrieval: appspec.memory_binding.retrieval,
      },
      delivery: { ...appspec.delivery },
      workflow: { steps: [...appspec.workflow.steps] },
      boundaries: [...appspec.boundaries],
      params: appspec.params.map((param) => ({
        ...param,
        options: param.options ? [...param.options] : undefined,
      })),
    },
  };
}

function uniqueSorted(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

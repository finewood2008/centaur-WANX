import type { AppSpec } from "../appspec/schema";
import { buildPersonaText } from "./persona";
import {
  BASELINE_TOOL_ROWS,
  capabilityWebConfig,
  CENTAUR_PLUGINS,
  MEMORY_TOOL_PLUGINS,
} from "./tools";
import { compileSkill } from "./skill";
import type { AppPackage, PluginEntry } from "./types";

export interface CompileOptions {
  /** false 时过滤掉所有 @centaur/* 占位插件（知君插件尚未实现），生成 DSH 兼容变体。 */
  includeCentaurPlugins?: boolean;
  /**
   * preset 在 DSH 选择器里的排序值（越小越靠前）。编译保持纯函数——调用方传
   * 创建时刻的时间戳进来；不传就是 0。全部写 0 的话，DSH 的 roster 会退回按
   * 目录名（哈希 slug）排序，对用户是乱序。
   */
  order?: number;
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

  // 基线工具集：文件读写与检索、待办、工作手册。没有它们，web profile 下的
  // 助手连自己资料夹里的东西都读不了（host 平面的工具在 web bundle 里全被
  // disabled，preset 说什么它才有什么）。
  const baseline: PluginEntry[] = BASELINE_TOOL_ROWS.map((row) => ({
    id: row.id,
    name: row.name,
    ...("config" in row && row.config ? { config: { ...row.config } } : {}),
  }));

  // capabilities 里点了联网类能力才挂 tool-web；browse/api_call 额外放开 fetch。
  const webConfig = capabilityWebConfig(appspec.capabilities);
  const capabilityTools: PluginEntry[] = webConfig
    ? [{ id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: webConfig }]
    : [];

  // 技能插件的挂载条件是「生成了工作流程」，不是过去那张挂名的 DOMAIN_SKILLS 表。
  // 挂载条件写错，SKILL.md 会被生成出来却从不加载——整个「自动开发」静默失效。
  //
  // 不带 config：实测内核会**整个忽略** preset 里给 skill-filesystem 写的 config
  // （`includeDefaultRoots: false` 写了也不生效，`customSkillDirs` 从不被扫描）。
  // 内置的 standard preset 同样是空配置。技能靠装进**应用自己 workspace 的
  // `.dsh/skills/`** 被发现（findProjectRoot(cwd) 那条根），由 server 的
  // installApp 负责——见那里的注释；共享根 $DSH_HOME/skills 刻意保持空。
  const skill = compileSkill(appspec);
  const skillPlugins: PluginEntry[] = skill
    ? [
        { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
        { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
      ]
    : [];

  const agentCordis: PluginEntry[] = [
    persona,
    ...baseline,
    ...memoryTools,
    ...capabilityTools,
    ...skillPlugins,
  ].filter((e) => includeCentaur || !CENTAUR_PLUGINS.has(e.name));

  return {
    preset: {
      name: appspec.name,
      description: appspec.description,
      order: options.order ?? 0,
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
      // persona_note 必须进 meta：app.yml 是重编译（heal / 调教）的输入，
      // 漏了它，第一次 round-trip 就会把创建时编进 persona 的那句静默抹掉。
      ...(appspec.persona_note ? { persona_note: appspec.persona_note } : {}),
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


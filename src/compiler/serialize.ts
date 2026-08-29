import { dump } from "js-yaml";
import type { AppPackage } from "./types";

export interface SerializedPreset {
  presetYml: string;
  agentCordisYml: string;
}

/**
 * 把 AppPackage 序列化成 DSH preset 的两个文件内容。
 * 确定性：同一 AppPackage 永远生成同一 YAML。
 */
export function serializePreset(pkg: AppPackage): SerializedPreset {
  const presetYml = dump(
    {
      name: pkg.preset.name,
      description: pkg.preset.description,
      order: pkg.preset.order,
    },
    { lineWidth: -1, noRefs: true },
  );

  const agentCordisYml = dump(pkg.preset.agentCordis, {
    lineWidth: -1,
    noRefs: true,
  });

  return { presetYml, agentCordisYml };
}

/**
 * 把 AppPackage 序列化成应用包的全部文件内容（含记忆绑定与元数据）。
 * 返回文件名 → 文件内容 的映射。
 */
export function serializeAppPackage(pkg: AppPackage): Record<string, string> {
  const { presetYml, agentCordisYml } = serializePreset(pkg);
  const files: Record<string, string> = {
    "preset.yml": presetYml,
    "agent.cordis.yml": agentCordisYml,
    "memory-binding.yml": dump(pkg.memoryBinding, { lineWidth: -1, noRefs: true }),
    "app.yml": dump(pkg.meta, { lineWidth: -1, noRefs: true }),
  };
  // 技能文件的键带子目录，writeAppPackage 会按需建目录。
  if (pkg.skill) files[pkg.skill.path] = pkg.skill.content;
  return files;
}

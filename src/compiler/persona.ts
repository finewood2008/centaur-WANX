import type { AppSpec } from "../appspec/schema";

const RETRIEVAL_LABEL: Record<string, string> = {
  semantic: "语义检索",
  recent: "最近优先",
  entity: "按实体/人名",
  keyword: "关键词",
};

const TRIGGER_LABEL: Record<string, string> = {
  manual: "手动触发",
  conversational: "对话触发",
};

const OUTPUT_LABEL: Record<string, string> = {
  memory: "写入记忆库",
  chat: "仅回复用户",
  both: "回复用户并写入记忆库",
};

/**
 * 从 AppSpec 生成 persona 文本。
 * 确定性模板填充——同一 AppSpec 永远生成同一文本，非 LLM。
 */
export function buildPersonaText(appspec: AppSpec): string {
  const L: string[] = [];
  L.push(`你是「${appspec.name}」，${appspec.description}`);
  L.push("");
  L.push(`你的目标：${appspec.goal}`);

  if (appspec.persona_note) {
    L.push("");
    L.push(`额外要求：${appspec.persona_note}`);
  }

  L.push("");
  L.push("记忆：");
  L.push(`- 可读记忆库：${appspec.memory_binding.read.join("、")}`);
  if (appspec.memory_binding.write.length > 0) {
    L.push(`- 可写记忆库：${appspec.memory_binding.write.join("、")}`);
  }
  L.push(`- 检索策略：${RETRIEVAL_LABEL[appspec.memory_binding.retrieval]}`);

  // 记忆库现在没有真的后端，persona 里那几个库名只是用户的说法。
  // 不说清楚这一点，助手会真的去满文件系统找一个叫「work_logs」的东西——
  // 实测一次运行为此空转 80 秒，最后交回一份空清单。
  L.push("");
  L.push("资料在哪：");
  L.push("- 你能看的东西全在当前工作目录里，用文件工具去看。");
  L.push("- 目录里没有的，就是没有。不要去别的地方翻，也不要凭空编。");
  L.push("- 找不到资料时，直接说清楚缺什么、该把东西放哪，别交一份空的东西回去。");

  L.push("");
  L.push("交付：");
  L.push(`- 交付物形式：${appspec.delivery.form}`);
  // output 说要写记忆，但没有绑定任何可写库时，按「仅回复」渲染。
  // 否则会产出一段自相矛盾的指令：让它写入，却没说写哪，也没挂写工具。
  const canWrite = appspec.memory_binding.write.length > 0;
  const output = !canWrite && appspec.delivery.output !== "chat" ? "chat" : appspec.delivery.output;
  L.push(`- 产出去向：${OUTPUT_LABEL[output]}`);
  L.push(`- 触发方式：${TRIGGER_LABEL[appspec.delivery.trigger]}`);

  if (appspec.boundaries.length > 0) {
    L.push("");
    L.push("边界（这些事不许做，没有例外）：");
    for (const b of appspec.boundaries) {
      L.push(`- ${b}`);
    }
  }

  if (appspec.workflow.steps.length > 0) {
    L.push("");
    L.push("你有一份工作手册，干活前先按它的步骤走。");
  }

  if (appspec.params.length > 0) {
    L.push("");
    L.push("用户参数：");
    for (const p of appspec.params) {
      const label = p.label ?? p.name;
      if (p.type === "enum" && p.options) {
        L.push(`- ${label}：可选 [${p.options.join("、")}]${p.default != null ? `，默认 ${p.default}` : ""}`);
      } else {
        L.push(`- ${label}：${p.default ?? "未设置"}`);
      }
    }
  }

  return L.join("\n");
}

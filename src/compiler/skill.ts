import type { AppSpec } from "../appspec/schema";
import { slugFromName } from "../appspec/slug";

/**
 * 技能包在应用目录下的相对位置。安装时由 installApp 复制到应用 workspace 的
 * `.dsh/skills/` 下（preset 的 customSkillDirs 实测不生效，别指望它）。
 */
export const SKILLS_SUBDIR = "skills";

/**
 * `whenToUse` 是**模型选技能时读的判据**，不是日程表。
 * 写成「每次对话结束时」这类时间条件，用户开口问一句别的，模型就判定不适用、
 * 不加载手册——助手于是退回到只有人格提示词的状态。所以这里描述「这事归它管」。
 */
function whenToUseText(appspec: AppSpec): string {
  return `处理与「${appspec.name}」有关的任何请求时；该助手负责：${appspec.goal}`;
}

/** 技能目录名 ＝ `<slug>-workflow`。slug 已是 kebab-case，拼接后依然合法。 */
export function skillName(appspec: AppSpec): string {
  return `${slugFromName(appspec.name)}-workflow`;
}

/**
 * 把 AppSpec 的 workflow / boundaries / params 编译成一个 DSH 技能文件。
 *
 * 这是「自动开发」的实质：没有它，生成的助手只是一段人格提示词；有了它，
 * 助手每次干活都按用户定义的步骤走。格式依据
 * `@deepseek-ai/dsh-skill-filesystem`：目录 bundle `<name>/SKILL.md`，
 * frontmatter 必填 name（kebab-case）与 description，可选 whenToUse。
 *
 * workflow.steps 为空时返回 null——没有步骤就不该挂一个空技能。
 *
 * 注意：验收标准（PRD §11）**不进这里**。那是产品经理归纳的散文，
 * 让它变成助手的运行指令等于把用户没细看过的句子塞进工作手册。
 */
export function compileSkill(appspec: AppSpec): { path: string; content: string } | null {
  const steps = appspec.workflow.steps;
  if (steps.length === 0) return null;

  const name = skillName(appspec);
  const lines: string[] = [
    "---",
    `name: ${name}`,
    `description: ${yamlOneLine(appspec.goal)}`,
    `whenToUse: ${yamlOneLine(whenToUseText(appspec))}`,
    "---",
    "",
    `# 「${appspec.name}」的工作手册`,
    "",
    "## 每次这样做",
    "",
    ...steps.map((s, i) => `${i + 1}. ${stripLeadingNumber(s)}`),
  ];

  if (appspec.boundaries.length > 0) {
    lines.push("", "## 不要做", "", ...appspec.boundaries.map((b) => `- ${b}`));
  }

  if (appspec.params.length > 0) {
    lines.push("", "## 可调的", "");
    for (const p of appspec.params) {
      const label = p.label ?? p.name;
      const value = p.default === undefined || p.default === null ? "未设置" : String(p.default);
      lines.push(`- ${label}：${value}`);
    }
  }

  lines.push("");
  return { path: `${SKILLS_SUBDIR}/${name}/SKILL.md`, content: lines.join("\n") };
}

/**
 * 步骤自带序号时削掉。模型和保底选项都爱写成「1) 先干这个」，
 * 再套一层编号就成了「1. 1) 先干这个」。
 */
function stripLeadingNumber(step: string): string {
  return step.replace(/^\s*\d+\s*[).、.]\s*/u, "").trim();
}

/** frontmatter 的单行标量：压掉换行，必要时加引号转义。 */
function yamlOneLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return `"${flat.replace(/"/gu, '\\"')}"`;
}

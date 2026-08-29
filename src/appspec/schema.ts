import { z } from "zod";

/** 领域标签，用于模板匹配与默认能力注入 */
export const Domain = z.enum([
  "customer_management",
  "research",
  "content",
  "archive",
  "personal_assistant",
  "general",
]);
export type Domain = z.infer<typeof Domain>;

/** 检索策略（主策略声明） */
export const RetrievalStrategy = z.enum(["semantic", "recent", "entity", "keyword"]);
export type RetrievalStrategy = z.infer<typeof RetrievalStrategy>;

/** 能力需求（声明式枚举） */
export const Capability = z.enum([
  "search",
  "summarize",
  "extract",
  "compose",
  "notify",
  "api_call",
  "browse",
]);
export type Capability = z.infer<typeof Capability>;

/** 触发方式 */
export const Trigger = z.enum(["manual", "conversational"]);
export type Trigger = z.infer<typeof Trigger>;

/** 产出去向 */
export const OutputTarget = z.enum(["memory", "chat", "both"]);
export type OutputTarget = z.infer<typeof OutputTarget>;

/** 参数类型 */
export const ParamType = z.enum(["string", "enum", "number", "boolean", "date", "list"]);
export type ParamType = z.infer<typeof ParamType>;

/** 用户可调参数 */
export const AppParam = z
  .object({
    name: z.string().min(1, "参数名不能为空"),
    type: ParamType,
    label: z.string().optional(),
    options: z.array(z.string()).optional(),
    default: z.unknown().optional(),
    required: z.boolean().optional().default(false),
  })
  .superRefine((p, ctx) => {
    if (p.type === "enum" && (!p.options || p.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "type=enum 时必须提供非空 options",
      });
    }
  });

/** 记忆绑定 */
export const MemoryBinding = z.object({
  read: z.array(z.string()).min(1, "read 至少绑定一个记忆库"),
  write: z.array(z.string()).optional().default([]),
  retrieval: RetrievalStrategy.optional().default("semantic"),
});

/** 工作流程：助手每次干活的步骤。编译成 DSH 的 SKILL.md。 */
export const Workflow = z.object({
  steps: z.array(z.string().min(1)).optional().default([]),
});

/** 交付定义 */
export const Delivery = z.object({
  form: z.string().min(1, "交付物形式不能为空"),
  trigger: Trigger.optional().default("conversational"),
  output: OutputTarget.optional().default("memory"),
});

/**
 * AppSpec —— 万象唯一事实源（v1.0 冻结）
 * 声明式：只声明「这是个什么应用」，不写「怎么做」。
 * 未知字段：默认 strip（忽略），由 validate 层检测并告警。
 */
export const AppSpecSchema = z.object({
  schema_version: z.literal("1.0"),
  name: z.string().min(2, "name 至少 2 字符").max(30, "name 最多 30 字符"),
  description: z.string().min(20, "description 至少 20 字符").max(200, "description 最多 200 字符"),
  goal: z.string().min(1, "goal 不能为空"),
  domain: Domain.optional().default("general"),
  persona_note: z.string().optional(),
  memory_binding: MemoryBinding,
  capabilities: z.array(Capability).min(1, "capabilities 至少声明一项能力"),
  delivery: Delivery,
  /** 每次干活的步骤。非空时编译出 SKILL.md 并挂载技能插件。 */
  workflow: Workflow.optional().default({ steps: [] }),
  /** 明确不许做的事。进 persona 的硬约束段。 */
  boundaries: z.array(z.string().min(1)).optional().default([]),
  params: z.array(AppParam).optional().default([]),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;

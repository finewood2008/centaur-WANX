/** 首次定义用的 prompt：意图 → AppSpec JSON。 */
export function buildDefinePrompt(intent: string): string {
  return [
    "你是应用定义器。把用户的意图转换成应用定义（AppSpec）的 JSON 对象。",
    "",
    "字段与约束（标「必填」的字段必须出现）：",
    '- schema_version: 固定为 "1.0"',
    "- name: 应用名（2-30 字符）",
    "- description: 一句话描述（20-200 字符）",
    "- goal: 应用目标（一句话）",
    "- domain: 领域标签，可选 customer_management / research / content / archive / personal_assistant / general",
    "- persona_note: 额外要求（可选）",
    '- memory_binding（必填对象）: read=要读的记忆库名数组（必填，至少一个，可用 "*" 表示全部），write=要写的记忆库名数组（可选），retrieval=检索策略 semantic/recent/entity/keyword',
    "- capabilities（必填，至少一个）: 只能从枚举值选择，禁止自创——search=搜索/联网查找，summarize=总结，extract=抽取结构化信息，compose=撰写/生成文档，notify=通知提醒，api_call=调用外部API，browse=浏览/抓取网页。把具体动作映射到枚举：抓取网页/读RSS→browse，写报告/生成简报→compose，总结→summarize，提取→extract，搜索→search",
    "- delivery（必填对象）: form=交付物形式一句话（必填），trigger=manual/conversational，output=memory/chat/both",
    "- workflow（必填对象）: steps=助手每次干活的步骤数组，3-6 步，每步一句祈使句，按执行顺序排。这些步骤会变成它真正的工作手册，要具体可执行，不要写「理解用户需求」这类空话",
    "- boundaries（必填数组）: 明确不许做的事，2-4 条。优先写涉及对外发送、金钱条款、不确定信息写入的红线",
    "- params: 用户参数数组（可选）",
    "",
    "只输出 JSON 对象，不要其他文字，不要 markdown 代码块。",
    "",
    `用户意图：${intent}`,
  ].join("\n");
}

/** 修复重试用的 prompt：把校验错误反馈给模型。 */
export function buildRepairPrompt(intent: string, error: string): string {
  return [
    "你上次输出的 AppSpec JSON 校验失败，请修正后重新输出。",
    "",
    `校验错误：${error}`,
    "",
    "修正提示：",
    "- capabilities 只能使用枚举值 search/summarize/extract/compose/notify/api_call/browse，把具体动作映射到最接近的枚举（抓取网页→browse，写报告→compose，总结→summarize，提取→extract，搜索→search）",
    "- memory_binding.read、delivery.form、workflow.steps、boundaries 都是必填的，不要遗漏",
    "- workflow.steps 至少 3 步，每步是具体动作；boundaries 至少 2 条",
    "- delivery.output 若为 memory 或 both，memory_binding.write 必须非空（要写记忆就得说清写进哪个库）",
    "",
    "只输出修正后的 JSON 对象，不要其他文字。",
    "",
    `用户意图：${intent}`,
  ].join("\n");
}

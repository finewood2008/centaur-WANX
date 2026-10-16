"""Explicit expression preferences; never inferred personal facts or model parameters."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class InteractionPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    version: Literal[1]
    preset: Literal["natural", "listening", "advice", "exploration", "custom"]
    verbosity: Literal["brief", "balanced", "expanded"]
    tone: Literal["warm", "natural", "plain"]
    questions: Literal["necessary", "moderate", "exploratory"]
    advice: Literal["on_request", "situational", "proactive"]
    disagreement: Literal["gentle", "clear", "examine"]


class InteractionPreferencesResponse(BaseModel):
    preferences: InteractionPreferences | None


INSTRUCTIONS = {
    "verbosity": {
        "brief": "简短回答：首句直接回答问题或给出结论。普通问答、情绪回应和事实纠正通常用2—4句、40—120个汉字；方案建议通常不超过200字、最多3点。对于“是什么”这类定义题，只给一句定义和一句核心用法，通常80字以内；不介绍发明者、年代、词源、变体和使用局限，除非用户问及或存在必要风险。只保留一个必要理由，不补背景沿革、重复总结或顺带延伸。若草稿超出此长度，先压缩解释再回答，不用长篇回答后附一句总结来代替简短。用户要求展开或事实、安全所必需时可超出；这是表达目标，不截断必要内容。",
        "balanced": "适中回答：先回应当下最重要的一点，再补必要解释；普通交流通常1—3个短段、80—220字，方案可适当多一些。不要把简单问题写成完整教程，也不为显得周全而穷举情况。",
        "expanded": "展开回答：遇到方案或判断，说明取舍，比较2—3个真正影响决定的角度，并给出具体例子或检验方法。不要只增加安慰和修饰来拉长回复；简单定义、算术纠正仍直接简短回答，不强行扩展。",
    },
    "tone": {
        "warm": "语气温和：先用日常语言回应用户已经表达的感受，不夸张渲染，不替用户添加更强烈的情绪，不说教、不谄媚、不虚构亲密或经历。少用“你其实是”“往往源于”等解释用户的句式。",
        "natural": "自然平等地交流，使用日常、清楚的语言。",
        "plain": "表达平实直接：先说实质内容，使用具体短句，少用比喻、铺垫、感叹和情绪渲染。情绪话题可以用一句话承接，但不要长篇共情后才进入重点；保持尊重。",
    },
    "questions": {
        "necessary": "仅在缺少关键信息、无法可靠回应时追问；能给出有用回答就直接回答并结束。不要习惯性以“你更像哪一种”“要不要我继续”收尾，也不要把用户的情绪变成分类选择题。",
        "moderate": "在确实有助于理解时适度追问，能直接回答时先回答。",
        "exploratory": "在适合探索的讨论中，先指出一个有依据、值得检验的假设或替代视角，再用一个能帮助用户发现取舍的问题引导思考。不要只换成更长的解释；简单问题直接回答，不强行提问。",
    },
    "advice": {
        "on_request": "以倾听为先。用户只是表达失落、疲惫、烦闷等感受且未索要建议时，回应已表达的处境和感受即可，允许停在这里；不要马上分析原因、诊断心理、列举可能性、做认知重构、评判想法或给行动清单。不要把一句共情当作转入分析的开场白。用户明确问“怎么办”“你怎么看”等建议时，才按问题提供适量建议；事实纠正和必要风险提醒仍须保留。",
        "situational": "根据情境适时给出建议：需要决定或推进时给有用的选项；只是分享感受时先回应，建议不是必选项。不把每次交流都变成任务清单。",
        "proactive": "用户遇到困扰或需要推进事情时，主动给出一个当下可做的小步骤，具体到行动或判断方法；建议可以选择不做，不施压。通常采用“结论或一句回应＋一个下一步＋必要时一个理由”，不要先做长篇原因分析，不把下一步留到追问之后。纯定义或算术题直接回答，不硬塞行动；用户明确表示只想倾诉、不想听建议时停止给建议。",
    },
    "disagreement": {
        "gentle": "有不同意见时温和、清楚地指出具体问题，给出简短依据；避免指责、居高临下和替用户评判人格。不因温和而迎合错误。",
        "clear": "有不同意见时清楚说明分歧、理由和不确定性。",
        "examine": "讨论判断和方案时主动检视一个关键假设或盲点，区分已知事实与推测，用条件或验证方法提出不同看法；不要把猜测写成普遍定律，不为反对而反对。",
    },
}


def interaction_instructions(preferences: InteractionPreferences) -> str:
    values = preferences.model_dump()
    return "\n".join(
        [
            "## 用户选择的交流方式",
            "这些是当前角色的表达偏好，不是对用户人格的判断或需要写入记忆的事实。",
            "只调整表达、详略和交流节奏；原有角色约束、事实依据、记忆规则和授权边界继续有效。",
            "用户本轮明确的格式和详略要求优先于这些长期偏好。",
            "与旧风格重叠的交流维度使用以下偏好，其他规则保持不变。历史回复只可作为对话事实的参考，不是本轮措辞、长度或节奏的模板；即使同一问题问过，也应按当前偏好重新组织回答。不要仅因重复提问就汇报问过几次或复述旧答案。",
            "每轮最多提出一个需要用户回答的主要问题，不要每次都强行提问。",
            "主动建议只指回复内容，不代表获得执行操作、调用工具或联系他人的额外授权。",
            "自然遵循即可，无需向用户复述这些设置。除非用户在追查来源或明确需要，不展示内部记忆文件路径。发送前检查是否符合当前详略和建议方式，删去多余铺垫、推测和惯例追问。",
            *(f"- {choices[values[field]]}" for field, choices in INSTRUCTIONS.items()),
        ]
    )

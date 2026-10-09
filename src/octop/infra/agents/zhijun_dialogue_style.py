"""Use WANX's MBTI behavior catalogue as an optional Zhijun expression layer."""

from octop.infra.agents.persona import get_profile, resolve_persona_code


def dialogue_system_prompt(
    base: str | None, *, persona_mbti: str | None, config: dict[str, object]
) -> str | None:
    code = resolve_persona_code(persona_mbti=persona_mbti, config=config)
    profile = get_profile(code) if code else None
    if profile is None:
        return base
    behavior = profile.behavior
    section = (
        f"## 知君的对话风格：{profile.code} · {profile.name_zh}\n\n"
        "以下是用户选择的知君表达方式，不是对用户人格的判断。"
        "只调整表达、交流节奏与组织方式；仍遵守知君原有的陪伴、记忆、依据与核对规则。"
        "风格与这些规则冲突时，以原有规则为准。自然使用这些特点，无需在回答中自报 MBTI。"
        "每轮仍只提出一个需要用户回答的问题。\n\n"
        f"- 回答方式：{behavior.answer_style_zh or behavior.answer_style}\n"
        f"- 日常交谈：{behavior.casual_chat_zh or behavior.casual_chat}\n"
        f"- 不同意见：{behavior.conflict_zh or behavior.conflict}\n"
        f"- 探索想法：{behavior.creativity_zh or behavior.creativity}\n"
        f"- 情绪回应：{behavior.emotion_zh or behavior.emotion}\n"
        f"- 讨论计划：{behavior.planning_zh or behavior.planning}"
    )
    return f"{base}\n\n{section}" if base else section

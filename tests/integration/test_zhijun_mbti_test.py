"""Zhijun uses WANX's native questionnaire and scoring without automatic apply."""

from typing import Any

from tests.integration.test_zhijun_dialogue_style import profile


async def test_native_questionnaire_and_readonly_scoring_are_shared(env_with_provider: Any) -> None:
    client, server, auth, aid = await profile(env_with_provider)
    questions = await client.get("/api/mbti/test/questions", headers=auth)
    assert questions.status_code == 200, questions.text
    native = await client.get("/api/mbti/test/questions", headers=env_with_provider[2])
    assert questions.json() == native.json()
    assert len(questions.json()) == 28
    before = server.app_runtime.agent_registry.get_row(aid)
    answers = {str(q["id"]): "A" if q["a_pole"] in "INFJ" else "B" for q in questions.json()}
    result = await client.post(
        "/api/mbti/test/submit",
        headers=auth,
        json={"answers": answers, "auto_apply": False, "language": "zh"},
    )
    assert result.status_code == 200, result.text
    assert result.json()["code"] == "INFJ"
    assert result.json()["applied"] is False
    assert result.json()["profile"]["code"] == "INFJ"
    native_result = await client.post(
        "/api/mbti/test/submit",
        headers=env_with_provider[2],
        json={"answers": answers, "auto_apply": False},
    )
    assert result.json() == native_result.json()
    after = server.app_runtime.agent_registry.get_row(aid)
    assert (after.config_json, after.persona_mbti, after.system_prompt) == (
        before.config_json,
        before.persona_mbti,
        before.system_prompt,
    )
    assert (await client.get("/api/mbti/current", headers=auth)).json() == {
        "code": "",
        "configured": False,
    }
    assert (
        await client.post("/api/mbti/test/submit", headers=auth, json={"answers": {"1": "A"}})
    ).status_code == 400
    assert server.app_runtime.agent_registry.get_row(aid).persona_mbti is None

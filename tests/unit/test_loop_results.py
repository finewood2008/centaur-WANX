"""Regression coverage for real streamed tool narration and final JSON."""

import json

import pytest
from pydantic import ValidationError

from octop.infra.loops.results import parse_round_decision


@pytest.mark.parametrize(
    "template",
    [
        "{}",
        "```json\n{}\n```",
        "I'll start by locating the files.\n```json\n{}\n```",
        'Reading source {{"file": "notes.md"}}.\n```JSON\n{}\n```',
    ],
)
def test_final_result_survives_native_tool_narration(template):
    decision = parse_round_decision(
        template.format(
            json.dumps(
                {
                    "outcome": "needs_input",
                    "summary": "Read three sources",
                    "evidence": ["notes.md"],
                    "question": "Which focus?",
                    "choices": ["Usage", "Principles"],
                }
            )
        )
    )
    assert decision.outcome == "needs_input"
    assert decision.evidence == ["notes.md"]
    assert decision.choices == ["Usage", "Principles"]


@pytest.mark.parametrize(
    "reply",
    [
        '{"outcome":"complete","summary":"Done"}\n[model_call_failed]',
        'Reading sources. {"outcome":"complete","summary":"Done",',
        'Reading sources. {"outcome":"complete","summary":"Done","evidence":[{"url":"x"}]}',
        '```json\n{"outcome":"complete","summary":"Done","skip_human":true}\n```',
        '```json\n{"outer":{"outcome":"complete","summary":"Done"}\n```',
        "```json```",
    ],
)
def test_invalid_or_superseded_result_is_not_accepted(reply):
    with pytest.raises(ValidationError):
        parse_round_decision(reply)


def test_reader_report_keeps_full_content_and_sources():
    payload = {
        "outcome": "complete",
        "summary": "三条资料已整理",
        "report": {
            "title": "每日资料摘要",
            "overview": "优先关注本地存储与批量处理",
            "highlights": ["批量导入优先读取文件"],
            "sections": [
                {
                    "title": "数据导入",
                    "body": "正文" * 800,
                    "sources": ["https://example.com/source"],
                }
            ],
            "limitations": ["仅涵盖所给资料"],
        },
    }
    result = parse_round_decision(json.dumps(payload))
    assert result.report.sections[0].body == "正文" * 800
    assert result.report.sections[0].sources == ["https://example.com/source"]
    assert result.report.limitations == ["仅涵盖所给资料"]
    payload["report"]["sections"] = []
    with pytest.raises(ValidationError):
        parse_round_decision(json.dumps(payload))

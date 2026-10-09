"""Displayable owner context keeps actual content and native attribution."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from octop.infra.applications.context import (
    _knowledge_excerpts,
    _memory_content,
    _memory_title,
    owned_zhijun_context,
)
from octop.infra.knowledge.citations import citations_from_ranked
from octop.infra.knowledge.retrieve import _format_context


@pytest.mark.parametrize(
    ("path", "method", "value", "expected"),
    [
        (
            "atom/internal.md",
            "get_atom",
            {"assertion": "我每周能投入两小时。"},
            "我每周能投入两小时。",
        ),
        (
            "raw/2026-10-02/internal.md",
            "get_raw",
            {"content": "原话与标点不变。"},
            "原话与标点不变。",
        ),
        (
            "page/internal.md",
            "get_entity_page",
            {"summary_markdown": "## 目标\n先验证旧课"},
            "## 目标\n先验证旧课",
        ),
    ],
)
def test_native_content_does_not_show_record_envelope(path, method, value, expected):
    memory = SimpleNamespace(**{method: Mock(return_value=SimpleNamespace(**value))})
    assert _memory_content(memory, {"content": "id: internal\nentity_id: hidden"}, path) == expected
    getattr(memory, method).assert_called_once_with("internal")


@pytest.mark.parametrize("locale", ["zh", "en"])
def test_native_knowledge_quotes_stay_with_their_own_document(locale):
    base = SimpleNamespace(id="kb-private", name="我的课程资料")
    first = SimpleNamespace(id="doc-first", filename="首期反馈.md", path="first")
    second = SimpleNamespace(id="doc-second", filename="课程计划.md", path="second")
    ranked = [
        (base, SimpleNamespace(ordinal=0, text="十位老学员的反馈。\n\n两人希望少讲术语。"), first),
        (base, SimpleNamespace(ordinal=3, text="每周只办一场。"), second),
        (base, SimpleNamespace(ordinal=5, text="三位愿意参加第二期。"), first),
    ]
    text = _format_context(ranked, char_budget=8000, locale=locale)
    excerpts = _knowledge_excerpts(text, list(citations_from_ranked(ranked)), locale)
    assert (
        excerpts["doc-first"] == "十位老学员的反馈。\n\n两人希望少讲术语。\n\n三位愿意参加第二期。"
    )
    assert excerpts["doc-second"] == "每周只办一场。"
    assert "octop-kb-citations" not in "".join(excerpts.values())


async def test_context_returns_plain_native_content_and_preserves_provenance(monkeypatch):
    path = "atom/00000000-0000-0000-0000-000000000001.md"
    memory = SimpleNamespace(
        get_atom=Mock(
            return_value=SimpleNamespace(
                assertion="用户每周只有两小时。", candidate_id="candidate", quote_event_id=""
            )
        ),
        get_candidate=Mock(return_value=None),
    )
    service = SimpleNamespace(
        search=Mock(return_value={"hits": [{"path": path}]}),
        get=Mock(return_value={"content": "id: internal\nraw_event_ids: [hidden]"}),
    )
    repos = SimpleNamespace(
        knowledge_repo=SimpleNamespace(list_visible=Mock(return_value=[])),
        thread_repo=SimpleNamespace(list_by_agent_user=Mock(return_value=[])),
    )
    registry = SimpleNamespace(
        get_application_profile=Mock(
            return_value=SimpleNamespace(agent_id="own", user_id=7, application_id="zhijun")
        ),
        get_agent=Mock(
            return_value=SimpleNamespace(
                _memory_runtime=SimpleNamespace(memory=memory, service=service)
            )
        ),
        _repos=repos,
        _paths=None,
        _config=None,
    )
    monkeypatch.setattr(
        "octop.infra.applications.context.read_personal_ontology",
        AsyncMock(return_value=SimpleNamespace(claims=[])),
    )
    monkeypatch.setattr(
        "octop.infra.applications.context.retrieve_context", AsyncMock(return_value="")
    )
    result = await owned_zhijun_context(registry, 7, "两小时", excluded=[], locale="zh")
    assert result.sources[0].id == "memory:" + path
    assert result.sources[0].text == "用户每周只有两小时。"
    assert result.sources[0].title == "知君记忆"
    assert result.sources[0].provenance == "inference"
    assert "AI 推测" in result.text
    assert "raw_event_ids" not in result.text and path not in result.text
    excluded = await owned_zhijun_context(
        registry, 7, "两小时", excluded=["memory:" + path], locale="zh"
    )
    assert excluded.sources == []


def test_knowledge_budget_does_not_claim_unreturned_content():
    base = SimpleNamespace(id="kb", name="资料")
    documents = [SimpleNamespace(id=str(i), filename=f"文件{i}.md", path="") for i in range(2)]
    ranked = [(base, SimpleNamespace(ordinal=0, text="内容" * 200), doc) for doc in documents]
    text = _format_context(ranked, char_budget=60, locale="zh")
    marker = text.split("<!--octop-kb-citations:", 1)[1].removesuffix("-->")
    excerpts = _knowledge_excerpts(text, json.loads(marker), "zh")
    assert excerpts.get("0")
    assert "1" not in excerpts


@pytest.mark.parametrize("owner", [7, 8])
def test_memory_origin_uses_only_the_owners_original_conversation_title(owner):
    memory = SimpleNamespace(
        get_atom=Mock(return_value=SimpleNamespace(quote_event_id="raw-id")),
        get_raw=Mock(return_value=SimpleNamespace(thread_id="original-thread")),
    )
    repo = SimpleNamespace(
        get=Mock(
            return_value=SimpleNamespace(agent_id="own", user_id=owner, title="学院的市场运营")
        )
    )
    title = _memory_title(memory, "atom/private-id.md", repo, "own", 7, "知君记忆")
    assert title == ("学院的市场运营" if owner == 7 else "知君记忆")

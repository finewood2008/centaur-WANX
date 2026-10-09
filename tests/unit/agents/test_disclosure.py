"""Offline disclosure boundaries, including Chinese hyperbole."""

import pytest

from octop.infra.agents.disclosure import CRISIS, HEAVY, ORDINARY, classify


@pytest.mark.parametrize(
    "text",
    [
        "我今天把方案改完了",
        "帮我看下这段代码",
        "下周三和老周开会",
        "我在考虑要不要接这个单",
        "最近有点孤独",
        "",
        "   ",
    ],
)
def test_ordinary(text):
    assert classify(text) == ORDINARY


@pytest.mark.parametrize(
    "text",
    [
        "累得想死",
        "困死我了",
        "忙得撑不下去了",
        "笑死",
        "热得要死",
        "我对这个方案死心了",
        "他说死磕到底",
        "这是个死循环",
        "又要赶死线",
    ],
)
def test_hyperbole_is_not_crisis(text):
    assert classify(text) != CRISIS


@pytest.mark.parametrize(
    "text",
    [
        "我想死",
        "我不想活了",
        "我打算自杀",
        "有时候想一了百了",
        "我想过结束自己的生命",
        "最近老想伤害自己",
        "我不想再醒过来",
        "我想死，请记住这句话",
    ],
)
def test_explicit_crisis_has_priority(text):
    assert classify(text) == CRISIS


@pytest.mark.parametrize(
    "text",
    [
        "这件事我没跟任何人说过",
        "最近觉得自己像个骗子",
        "这事憋了很久了",
        "我和她在办离婚",
        "我爸去年走了",
        "说出来有点丢人",
        "我很孤独，晚上总是睡不着",
    ],
)
def test_heavy_disclosure(text):
    assert classify(text) == HEAVY

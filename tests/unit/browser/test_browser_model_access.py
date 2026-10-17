from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest

from octop.api.routers.browser.harness import ModelAccessBody, browser_model_access
from octop.infra.browser import model_access as access
from octop.infra.errors import OctopError


def manager():
    provider = NS(
        id="DeepSeek", base_url="https://api.deepseek.com", models=[NS(id="test", enabled=True)]
    )
    return NS(
        resolve_fallback_model_ref=lambda: "DeepSeek/test",
        providers=NS(build_harness_configs=lambda **kw: [provider]),
    )


@pytest.mark.asyncio
async def test_binding_requires_admin_and_thread_ownership():
    threads = NS(get_thread=lambda _: NS(user_id=2, agent_id="main"))
    server = NS(app_runtime=NS(gateway=NS(thread_registry=threads)))
    body = ModelAccessBody(agent_id="main", thread_id="a")
    with pytest.raises(OctopError):
        await browser_model_access(body, NS(id=1, is_admin=False, permissions=["browser"]), server)


@pytest.mark.asyncio
async def test_foreign_thread_cannot_be_bound(monkeypatch):
    monkeypatch.setattr("octop.api.routers.browser.harness.assert_agent_access", lambda *a: None)
    threads = NS(get_thread=lambda _: NS(user_id=2, agent_id="main"))
    server = NS(app_runtime=NS(gateway=NS(thread_registry=threads)))
    with pytest.raises(OctopError):
        await browser_model_access(
            ModelAccessBody(agent_id="main", thread_id="a"), NS(id=1, is_admin=True), server
        )


@pytest.mark.asyncio
async def test_binding_does_not_return_credentials_or_change_other_threads(monkeypatch):
    monkeypatch.setattr("octop.api.routers.browser.harness.assert_agent_access", lambda *a: None)
    update = Mock()
    threads = NS(get_thread=lambda _: NS(user_id=1, agent_id="main"), update_composer=update)
    server = NS(app_runtime=NS(gateway=NS(thread_registry=threads), agent_registry=manager()))
    result = await browser_model_access(
        ModelAccessBody(agent_id="main", thread_id="a"), NS(id=1, is_admin=True), server
    )
    assert result == {
        "mode": "configured-provider",
        "model_ref": "DeepSeek/test",
        "task_budget_required": False,
    }
    update.assert_called_once_with("a", model_ref="DeepSeek/test")


def test_changed_config_does_not_silently_use_another_provider():
    m = manager()
    m.resolve_fallback_model_ref = lambda: "Other/test"
    with pytest.raises(OctopError):
        access.configured_model(m)


def test_disabled_or_missing_deepseek_is_rejected():
    m = manager()
    m.providers.build_harness_configs = lambda: []
    with pytest.raises(OctopError):
        access.configured_model(m)


def test_native_provider_selection_does_not_change_the_factory():
    m = manager()
    original = m.providers.build_harness_configs
    assert access.configured_model(m) == "DeepSeek/test"
    assert m.providers.build_harness_configs is original

"""tests/unit/test_acp_settings.py — user-scoped global ACP runner settings."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from octop.infra.agents.settings.acp import ACPSettingsStore
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.agents import AgentRepo
from octop.infra.db.repos.settings import SettingsRepo
from octop.infra.db.repos.users import UserRepo


@pytest.fixture
def acp_store(tmp_path: Path) -> tuple[ACPSettingsStore, AgentRepo, int]:
    db = SqlitePool(tmp_path / "test.db")
    run_migrations(db)
    settings = SettingsRepo(db)
    agents = AgentRepo(db)
    user_id = UserRepo(db).create(username="u", password_hash="h", role="user")
    store = ACPSettingsStore(settings_repo=settings, agents_repo=agents)
    return store, agents, user_id


def test_load_defaults_include_codebuddy(
    acp_store: tuple[ACPSettingsStore, AgentRepo, int],
) -> None:
    store, _, user_id = acp_store
    runners = store.load_runners(user_id=user_id)
    assert "opencode" in runners
    assert "codebuddy" in runners
    assert "kimi_code" in runners
    assert "cursor_cli" in runners
    assert "pi" in runners
    assert runners["kimi_code"]["command"] == "kimi"
    assert runners["kimi_code"]["args"] == ["acp"]
    assert runners["cursor_cli"]["command"] == "agent"
    assert runners["cursor_cli"]["args"] == ["acp"]
    assert runners["pi"]["command"] == "npx"
    assert runners["pi"]["args"] == ["-y", "pi-acp"]
    assert "qwen_code" not in runners


def test_save_and_load_round_trip(acp_store: tuple[ACPSettingsStore, AgentRepo, int]) -> None:
    store, _, user_id = acp_store
    saved = store.save_runners(
        user_id,
        {
            "opencode": {
                "enabled": True,
                "command": "opencode",
                "args": ["acp"],
                "env": {},
                "trusted": True,
                "tool_parse_mode": "update_detail",
                "stdio_buffer_limit_bytes": 52428800,
            },
        },
    )
    assert saved["opencode"]["enabled"] is True
    reloaded = store.load_runners(user_id)
    assert reloaded["opencode"]["enabled"] is True


def test_migrate_legacy_per_agent_runners(
    acp_store: tuple[ACPSettingsStore, AgentRepo, int],
) -> None:
    store, agents, user_id = acp_store
    legacy = {
        "acp": {
            "tool_enabled": True,
            "runners": {
                "opencode": {
                    "enabled": True,
                    "command": "opencode",
                    "args": ["acp"],
                    "env": {},
                    "trusted": True,
                    "tool_parse_mode": "update_detail",
                    "stdio_buffer_limit_bytes": 52428800,
                },
            },
        },
    }
    agents.create(
        agent_id="bot1",
        user_id=user_id,
        name="bot",
        config_json=json.dumps(legacy),
    )
    runners = store.load_runners(user_id)
    assert runners["opencode"]["enabled"] is True
    row = agents.get("bot1")
    assert row is not None
    cfg = json.loads(row.config_json or "{}")
    assert "runners" not in (cfg.get("acp") or {})
    assert cfg["acp"]["tool_enabled"] is True


_BUNDLED_CODEX = {
    "codex": {
        "command": "codex",
        "args": ["app-server"],
        "trusted": True,
        "enabled": True,
    }
}


def test_caller_default_enables_bundled_runner_without_persisting_it(
    acp_store: tuple[ACPSettingsStore, AgentRepo, int],
) -> None:
    store, _, user_id = acp_store
    ordinary = store.load_runners(user_id)
    bundled = store.load_runners(user_id, defaults=_BUNDLED_CODEX)
    assert bundled["codex"]["enabled"] is True
    assert bundled["codex"]["command"] == "codex"
    assert bundled["codex"]["args"] == ["app-server"]
    assert bundled["codex"]["trusted"] is True
    assert store.load_runners(user_id) == ordinary
    assert store.load_runners(user_id + 1) == ordinary


@pytest.mark.parametrize("enabled", [False, True])
def test_saved_runner_replaces_caller_default_as_a_complete_entry(
    acp_store: tuple[ACPSettingsStore, AgentRepo, int], enabled: bool
) -> None:
    store, _, user_id = acp_store
    store.save_runners(
        user_id,
        {"codex": {"enabled": enabled, "command": "custom-codex", "args": ["custom"]}},
    )
    saved = store.load_runners(user_id)
    assert store.load_runners(user_id, defaults=_BUNDLED_CODEX) == saved
    assert saved["codex"]["enabled"] is enabled
    assert saved["codex"]["command"] == "custom-codex"


def test_legacy_disabled_runner_is_preserved_and_defaults_are_not_migrated(
    acp_store: tuple[ACPSettingsStore, AgentRepo, int],
) -> None:
    store, agents, user_id = acp_store
    agents.create(
        agent_id="legacy-codex",
        user_id=user_id,
        name="legacy",
        config_json=json.dumps(
            {"acp": {"tool_enabled": True, "runners": {"codex": {"enabled": False}}}}
        ),
    )
    runners = store.load_runners(user_id, defaults=_BUNDLED_CODEX)
    assert runners["codex"]["enabled"] is False
    assert runners["codex"]["args"] != ["app-server"]
    assert store.load_runners(user_id)["codex"] == runners["codex"]

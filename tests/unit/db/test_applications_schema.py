"""Existing native rows and foreign keys survive opening product scopes."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from octop.infra.db import migrate
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool


def test_applied_v21_upgrade_preserves_private_profile_and_child_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pool = SqlitePool(tmp_path / "product-upgrade.db")
    discover = migrate._discover
    with monkeypatch.context() as previous_version:
        previous_version.setattr(
            migrate,
            "_discover",
            lambda dialect="sqlite": [
                (number, path) for number, path in discover(dialect) if number <= 21
            ],
        )
        run_migrations(pool)
    with pool.connect() as conn:
        conn.execute(
            "INSERT INTO users(username,password_hash,role,created_at) VALUES ('owner','x','user',1)"
        )
        user_id = conn.execute("SELECT id FROM users").fetchone()[0]
        conn.execute(
            "INSERT INTO agents(agent_id,user_id,name,application_id,created_at,updated_at) VALUES ('personal',?,'Private','zhijun',1,1)",
            (user_id,),
        )
        conn.execute(
            "INSERT INTO knowledge_bases(knowledge_base_id,owner_user_id,name,application_id,created_at,updated_at) VALUES ('SOURCE',?,'Personal library','zhijun',1,1)",
            (user_id,),
        )
        conn.execute(
            "INSERT INTO knowledge_documents(document_id,kb_id,path,filename,content_type,byte_size,created_at,updated_at) VALUES ('doc','SOURCE','source.md','source.md','text/markdown',1,1,1)"
        )
    run_migrations(pool)
    run_migrations(pool)
    with pool.connect() as conn:
        assert (
            conn.execute(
                "SELECT application_id FROM agents WHERE agent_id = 'personal'"
            ).fetchone()[0]
            == "zhijun"
        )
        assert (
            conn.execute(
                "SELECT application_id FROM knowledge_bases WHERE knowledge_base_id = 'SOURCE'"
            ).fetchone()[0]
            == "zhijun"
        )
        assert conn.execute("SELECT document_id FROM knowledge_documents").fetchone()[0] == "doc"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 23
        conn.execute(
            "INSERT INTO agents(agent_id,user_id,name,application_id,is_application_profile,created_at,updated_at) VALUES ('future',?,'Future','future.product',1,1,1)",
            (user_id,),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO agents(agent_id,user_id,name,application_id,is_application_profile,created_at,updated_at) VALUES ('duplicate',?,'Second','future.product',1,1,1)",
                (user_id,),
            )
        conn.execute(
            "INSERT INTO agents(agent_id,user_id,name,application_id,created_at,updated_at) VALUES ('member',?,'Member','future.product',1,1)",
            (user_id,),
        )
        conn.execute(
            "INSERT INTO knowledge_bases(knowledge_base_id,owner_user_id,name,application_id,created_at,updated_at) VALUES ('FUTURE',?,'Future library','future.product',1,1)",
            (user_id,),
        )
    pool.close()

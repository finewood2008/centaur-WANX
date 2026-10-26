from pathlib import Path

import pytest

from octop.infra.db import migrate
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.local_data_principals import LocalDataPrincipalRepo

# The device branch used 031 before master assigned 031 to assistant knowledge.
# Keep the historical DDL independent of the repaired migration under test.
_DEVICE_V31 = """
ALTER TABLE users ADD COLUMN local_data_marker TEXT;
CREATE UNIQUE INDEX idx_users_local_data_marker ON users(local_data_marker);
CREATE TABLE local_data_principals (
    namespace TEXT PRIMARY KEY,
    box_key_thumbprint TEXT NOT NULL,
    ownership_epoch INTEGER NOT NULL,
    principal_id TEXT NOT NULL,
    native_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    identity_marker TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    UNIQUE(box_key_thumbprint, ownership_epoch, principal_id)
);
UPDATE _schema_version SET version = 31;
"""
_MERGED_TABLES = {
    "local_data_principals",
    "assistant_knowledge_access",
    "assistant_knowledge_access_audit",
    "assistant_conversations",
    "assistant_conversation_versions",
}


def _assert_merged_schema(db: SqlitePool) -> None:
    with db.connect() as conn:
        assert conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 33
        names = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        }
        assert names >= _MERGED_TABLES
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_fresh_database_contains_both_branches_and_is_idempotent(tmp_path: Path) -> None:
    db = SqlitePool(tmp_path / "fresh.sqlite")
    try:
        migrate.run_migrations(db)
        principal = LocalDataPrincipalRepo(db).resolve("a" * 43, "b" * 43, 1, "owner")
        migrate.run_migrations(db)
        _assert_merged_schema(db)
        assert LocalDataPrincipalRepo(db).resolve("a" * 43, "b" * 43, 1, "owner") == principal
        with db.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM local_data_principals").fetchone()[0] == 1
    finally:
        db.close()


@pytest.mark.parametrize("legacy_branch", ["device-v31", "master-v32"])
def test_each_existing_branch_upgrades_without_losing_identity_or_assistant_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, legacy_branch: str
) -> None:
    original = migrate._MIGRATIONS_DIR
    v30 = tmp_path / "v30-migrations"
    v30.mkdir()
    for file in original.iterdir():
        if file.name[:3].isdigit() and int(file.name[:3]) <= 30:
            (v30 / file.name).write_bytes(file.read_bytes())
    db = SqlitePool(tmp_path / "legacy.sqlite")
    try:
        with monkeypatch.context() as patch:
            patch.setattr(migrate, "_MIGRATIONS_DIR", v30)
            migrate.run_migrations(db)
        with db.connect() as conn:
            conn.execute(
                "INSERT INTO users(username,password_hash,role,created_at) "
                "VALUES ('existing','synthetic-hash','admin',123)"
            )
            business_user = conn.execute(
                "SELECT id FROM users WHERE username='existing'"
            ).fetchone()[0]
            if legacy_branch == "device-v31":
                conn.executescript(_DEVICE_V31)
                assert conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 31
            else:
                for name in ("031_assistant_knowledge.sql", "032_assistant_conversations.sql"):
                    conn.executescript((original / name).read_text(encoding="utf-8"))
                conn.execute(
                    "INSERT INTO assistant_knowledge_access "
                    "(box_id,warehouse_id,audience,members_json,revision,updated_by,updated_at) "
                    "VALUES ('box','warehouse','selected','[7]',5,?,123)",
                    (business_user,),
                )
                conn.execute(
                    "INSERT INTO assistant_conversations "
                    "(id,user_id,agent_id,active_thread_id,context_json,revision,updated_at) "
                    "VALUES ('conversation',?,'assistant','thread','{}',8,456)",
                    (business_user,),
                )
                assert conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 32
        principal = None
        if legacy_branch == "device-v31":
            principal = LocalDataPrincipalRepo(db).resolve("a" * 43, "b" * 43, 1, "owner")
        for _ in range(2):
            migrate.run_migrations(db)
            _assert_merged_schema(db)
            with db.connect() as conn:
                user = conn.execute("SELECT * FROM users WHERE id=?", (business_user,)).fetchone()
                assert (
                    user["username"],
                    user["password_hash"],
                    user["role"],
                    user["created_at"],
                ) == (
                    "existing",
                    "synthetic-hash",
                    "admin",
                    123,
                )
                assert user["local_data_marker"] is None
                if legacy_branch == "master-v32":
                    assert tuple(
                        conn.execute(
                            "SELECT audience,members_json,revision,updated_by,updated_at "
                            "FROM assistant_knowledge_access WHERE box_id='box' AND warehouse_id='warehouse'"
                        ).fetchone()
                    ) == ("selected", "[7]", 5, business_user, 123)
                    assert tuple(
                        conn.execute(
                            "SELECT user_id,active_thread_id,revision,updated_at "
                            "FROM assistant_conversations WHERE id='conversation'"
                        ).fetchone()
                    ) == (business_user, "thread", 8, 456)
            if principal is not None:
                assert (
                    LocalDataPrincipalRepo(db).resolve("a" * 43, "b" * 43, 1, "owner") == principal
                )
    finally:
        db.close()


def test_merged_migration_numbers_are_unique_and_both_dialects_have_the_same_schema() -> None:
    for dialect in ("sqlite", "postgresql"):
        discovered = migrate._discover(dialect)
        assert [version for version, _ in discovered] == list(range(1, 34))
        assert discovered[-1][1].name.startswith("033_local_data_principals.")
    sql = (migrate._MIGRATIONS_DIR / "033_local_data_principals.sql").read_text(encoding="utf-8")
    pg = (migrate._MIGRATIONS_DIR / "033_local_data_principals.pg.sql").read_text(encoding="utf-8")
    assert pg.replace("ADD COLUMN IF NOT EXISTS", "ADD COLUMN") == sql
    assert "UPDATE _schema_version SET version = 33;" in sql
    assert "CREATE TABLE IF NOT EXISTS assistant_knowledge_access" in sql
    assert "CREATE TABLE IF NOT EXISTS assistant_knowledge_access_audit" in sql

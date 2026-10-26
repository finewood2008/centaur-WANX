from concurrent.futures import ThreadPoolExecutor

import pytest

from octop.infra.db import migrate
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.local_data_principals import LocalDataPrincipalRepo


def test_version_30_upgrade_preserves_business_identity(tmp_path, monkeypatch):
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    original = migrate._MIGRATIONS_DIR
    for file in original.iterdir():
        if file.name[:3].isdigit() and int(file.name[:3]) <= 30:
            (migrations / file.name).write_bytes(file.read_bytes())
    monkeypatch.setattr(migrate, "_MIGRATIONS_DIR", migrations)
    db = SqlitePool(tmp_path / "db.sqlite")
    migrate.run_migrations(db)
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO users(username,password_hash,role,created_at) VALUES ('existing','synthetic-hash','admin',123)"
        )
        uid = conn.execute("SELECT id FROM users WHERE username='existing'").fetchone()[0]
        assert conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 30
    monkeypatch.setattr(migrate, "_MIGRATIONS_DIR", original)
    migrate.run_migrations(db)
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        assert (row["username"], row["password_hash"], row["role"], row["created_at"]) == (
            "existing",
            "synthetic-hash",
            "admin",
            123,
        )
        assert row["local_data_marker"] is None
        assert conn.execute("SELECT version FROM _schema_version").fetchone()[0] == 32
    local = LocalDataPrincipalRepo(db).resolve("a" * 43, "b" * 43, 1, "principal")
    assert local != uid
    db.close()


@pytest.fixture
def mapped(tmp_path):
    db = SqlitePool(tmp_path / "db.sqlite")
    migrate.run_migrations(db)
    yield db, LocalDataPrincipalRepo(db)
    db.close()


def test_distinct_principals_epochs_and_restart(mapped):
    db, repo = mapped
    first = repo.resolve("a" * 43, "b" * 43, 1, "one")
    assert LocalDataPrincipalRepo(db).resolve("a" * 43, "b" * 43, 1, "one") == first
    assert repo.resolve("c" * 43, "b" * 43, 1, "two") != first
    assert repo.resolve("d" * 43, "b" * 43, 2, "one") != first
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (first,)).fetchone()
    assert row["role"] == "user" and row["password_hash"] is None
    assert row["sso_provider_id"] is None and row["sso_subject"] is None


@pytest.mark.parametrize(
    "field,value",
    [
        ("role", "admin"),
        ("password_hash", "synthetic"),
        ("disabled", 1),
        ("local_data_marker", "replaced"),
        ("sso_subject", "cloud-sub"),
    ],
)
def test_mutated_native_identity_is_not_adopted(mapped, field, value):
    db, repo = mapped
    uid = repo.resolve("a" * 43, "b" * 43, 1, "one")
    with db.transaction() as conn:
        conn.execute(f"UPDATE users SET {field}=? WHERE id=?", (value, uid))
    with pytest.raises(ValueError):
        repo.resolve("a" * 43, "b" * 43, 1, "one")


def test_existing_username_is_not_auto_linked(mapped):
    db, repo = mapped
    with db.transaction() as conn:
        conn.execute(
            "INSERT INTO users(username,role,created_at) VALUES (?,'user',1)",
            ("local_" + "a" * 43,),
        )
    with pytest.raises(ValueError):
        repo.resolve("a" * 43, "b" * 43, 1, "one")
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM local_data_principals").fetchone()[0] == 0


def test_concurrent_independent_repositories_publish_one_identity(mapped):
    db, _ = mapped
    with ThreadPoolExecutor(max_workers=2) as pool:
        values = list(
            pool.map(
                lambda _: LocalDataPrincipalRepo(db).resolve("a" * 43, "b" * 43, 1, "one"), range(2)
            )
        )
    assert values[0] == values[1]
    with db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM local_data_principals").fetchone()[0] == 1

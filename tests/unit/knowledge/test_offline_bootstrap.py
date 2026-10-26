"""Offline first-install boundary with real SQLite and Octop domain/probe paths."""

import os
import sqlite3
from contextlib import closing
from types import SimpleNamespace

import pytest

from octop.infra.knowledge import offline_bootstrap as kb
from octop.infra.knowledge.offline_bootstrap import KnowledgeBootstrapError

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="Offline deployment requires private POSIX files and locks"
)


@pytest.fixture
def offline(tmp_path, monkeypatch):
    from octop.infra.agents.providers import onnx_service
    from octop.infra.knowledge import gate

    for name in ("URL", "DRIVER", "SQLITE_PATH", "HOST", "PORT", "NAME", "USER", "PASSWORD"):
        monkeypatch.delenv("OCTOP_DATABASE_" + name, raising=False)
    tmp_path.chmod(0o700)
    marker = tmp_path / kb.PENDING_FILE
    marker.write_bytes(b"")
    marker.chmod(0o600)
    db = sqlite3.connect(tmp_path / "octop.db")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.commit()
    db.close()
    (tmp_path / "octop.db").chmod(0o600)
    calls = []
    state = {"fail": False}

    class LocalModel:
        def embed(self, texts):
            calls.append(
                (list(texts), os.environ.get("OCTOP_HOME"), os.environ.get("HF_HUB_OFFLINE"))
            )
            if state["fail"]:
                raise RuntimeError("private synthetic model failure")
            return [[0.25, 0.5, 0.75] for _ in texts]

    monkeypatch.setattr(onnx_service, "local_embedding_deps_available", lambda: True)
    monkeypatch.setattr(
        onnx_service, "is_model_downloaded", lambda model: model == kb.DEFAULT_MODEL
    )
    monkeypatch.setattr(onnx_service, "assert_catalog_model", lambda model: model)
    monkeypatch.setattr(onnx_service, "_build_text_embedding", lambda model: LocalModel())
    monkeypatch.setattr(gate, "local_embedding_deps_available", lambda: True)
    monkeypatch.setattr(gate, "is_model_downloaded", lambda model: model == kb.DEFAULT_MODEL)
    import httpx

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda *args, **kwargs: pytest.fail("offline must never instantiate HTTP client"),
    )
    return SimpleNamespace(root=tmp_path, marker=marker, calls=calls, state=state)


def settings(root):
    with closing(sqlite3.connect(root / "octop.db")) as db:
        return dict(db.execute("SELECT key,value FROM settings").fetchall())


def set_value(root, key, value):
    with closing(sqlite3.connect(root / "octop.db")) as db:
        db.execute("INSERT INTO settings(key,value) VALUES(?,?)", (key, value))
        db.commit()


async def test_real_domain_and_real_probe_commit_default_once_without_http(offline):
    set_value(offline.root, "knowledge_ocr_enabled", "false")
    set_value(offline.root, "knowledge_chunk_size", "456")
    assert await kb.bootstrap_offline(offline.root, local_required=True)
    actual = settings(offline.root)
    assert actual["knowledge_bases_enabled"] == "true"
    assert actual["knowledge_embedding_model"] == kb.DEFAULT_MODEL
    assert actual["knowledge_embedding_backend"] == "onnx"
    assert actual["knowledge_ocr_enabled"] == "false" and actual["knowledge_chunk_size"] == "456"
    assert len(offline.calls) == 1 and offline.calls[0][1:] == (str(offline.root), "1")
    assert not offline.marker.exists()
    assert not await kb.bootstrap_offline(offline.root, local_required=True)
    assert len(offline.calls) == 1


@pytest.mark.parametrize(
    "key,value",
    [
        ("knowledge_bases_enabled", "false"),
        ("knowledge_bases_enabled", "true"),
        ("knowledge_embedding_backend", "remote"),
        ("knowledge_embedding_model", "other"),
    ],
)
async def test_explicit_existing_configuration_never_overwritten_even_with_stale_marker(
    offline, key, value
):
    set_value(offline.root, key, value)
    assert not await kb.bootstrap_offline(offline.root, local_required=True)
    assert (
        settings(offline.root) == {key: value} and not offline.calls and not offline.marker.exists()
    )


async def test_probe_failure_retains_marker_and_leaves_settings_untouched(offline):
    offline.state["fail"] = True
    with pytest.raises(KnowledgeBootstrapError, match="MODEL_NOT_READY"):
        await kb.bootstrap_offline(offline.root, local_required=True)
    assert offline.marker.exists() and settings(offline.root) == {}
    offline.state["fail"] = False
    assert await kb.bootstrap_offline(offline.root, local_required=True)


async def test_failed_capability_verification_rolls_back_all_domain_writes(offline, monkeypatch):
    from octop.infra.knowledge import gate

    monkeypatch.setattr(gate, "get_capability", lambda *args, **kwargs: {"usable": False})
    with pytest.raises(KnowledgeBootstrapError, match="ENABLE_FAILED"):
        await kb.bootstrap_offline(offline.root, local_required=True)
    assert settings(offline.root) == {} and offline.marker.exists()


async def test_open_native_connection_prevents_offline_initializer(offline):
    active = sqlite3.connect(offline.root / "octop.db")
    active.execute("PRAGMA journal_mode=WAL")
    active.execute("SELECT * FROM settings").fetchall()
    try:
        with pytest.raises(KnowledgeBootstrapError, match="OFFLINE_BUSY"):
            await kb.bootstrap_offline(offline.root, local_required=True)
        assert not offline.calls
    finally:
        active.close()
    assert await kb.bootstrap_offline(offline.root, local_required=True)


async def test_exclusive_lock_prevents_new_native_connection_during_probe(offline, monkeypatch):
    from octop.infra.agents.providers import onnx_service

    original = onnx_service._build_text_embedding

    def build(model):
        other = sqlite3.connect(offline.root / "octop.db", timeout=0)
        try:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                other.execute("SELECT * FROM settings").fetchall()
        finally:
            other.close()
        return original(model)

    monkeypatch.setattr(onnx_service, "_build_text_embedding", build)
    assert await kb.bootstrap_offline(offline.root, local_required=True)


@pytest.mark.parametrize("invalid", ["public", "symlink", "hardlink", "bad-content", "public-root"])
async def test_marker_boundary_rejects_before_probe_or_db_write(offline, invalid):
    if invalid == "public":
        offline.marker.chmod(0o644)
    if invalid == "symlink":
        offline.marker.unlink()
        offline.marker.symlink_to(offline.root / "octop.db")
    if invalid == "hardlink":
        os.link(offline.marker, offline.root / "copy")
    if invalid == "bad-content":
        offline.marker.write_text("arbitrary command")
    if invalid == "public-root":
        offline.root.chmod(0o777)
    with pytest.raises(KnowledgeBootstrapError, match="PENDING_INVALID"):
        await kb.bootstrap_offline(offline.root, local_required=True)
    assert not offline.calls and settings(offline.root) == {}


async def test_marker_inode_replaced_during_probe_never_commits_or_consumes_new_file(
    offline, monkeypatch
):
    from octop.infra.agents.providers import onnx_service

    original = onnx_service._build_text_embedding

    def build(model):
        offline.marker.unlink()
        offline.marker.write_text("pending")
        offline.marker.chmod(0o600)
        return original(model)

    monkeypatch.setattr(onnx_service, "_build_text_embedding", build)
    with pytest.raises(KnowledgeBootstrapError, match="PENDING_INVALID"):
        await kb.bootstrap_offline(offline.root, local_required=True)
    assert offline.marker.read_text() == "pending" and settings(offline.root) == {}


async def test_external_database_configuration_and_missing_runtime_fail_closed(
    offline, monkeypatch
):
    monkeypatch.setenv("OCTOP_DATABASE_URL", "postgresql://synthetic.invalid/not-contacted")
    with pytest.raises(KnowledgeBootstrapError, match="DATABASE_INVALID"):
        await kb.bootstrap_offline(offline.root, local_required=True)
    monkeypatch.delenv("OCTOP_DATABASE_URL")
    from octop.infra.agents.providers import onnx_service

    monkeypatch.setattr(onnx_service, "local_embedding_deps_available", lambda: False)
    with pytest.raises(KnowledgeBootstrapError, match="RUNTIME_MISSING"):
        await kb.bootstrap_offline(offline.root, local_required=True)
    assert not offline.calls and settings(offline.root) == {}


async def test_upgrade_without_marker_does_not_inspect_db_or_model(tmp_path):
    assert not await kb.bootstrap_offline(tmp_path, local_required=True)
    assert list(tmp_path.iterdir()) == []


def test_required_cli_never_uses_legacy_http_path(tmp_path, capsys):
    assert kb.main(["--root", str(tmp_path), "--offline", "--local-required"]) == 0
    assert capsys.readouterr().out == "WANX_KNOWLEDGE_UNCHANGED\n"
    with pytest.raises(SystemExit) as refused:
        kb.main(["--root", str(tmp_path), "--base-url", "http://127.0.0.1", "--local-required"])
    assert refused.value.code == 2
    assert "unrecognized arguments" in capsys.readouterr().err
    assert kb.main(["--root", str(tmp_path), "--offline"]) == 1
    assert capsys.readouterr().err == "WANX_KNOWLEDGE_OFFLINE_REQUIRED\n"

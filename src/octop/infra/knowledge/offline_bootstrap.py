"""Fixed first-install knowledge defaults before the native service starts.

This is an offline deployment operation, never an HTTP authentication exception.
The model name matches the explicitly provisioned WANX knowledge bundle.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sqlite3
import stat
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

PENDING_FILE = ".wanx-knowledge-pending"
DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"


class KnowledgeBootstrapError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


_KNOWLEDGE_KEYS = (
    "knowledge_bases_enabled",
    "knowledge_embedding_backend",
    "knowledge_embedding_model",
    "knowledge_embedding_provider_id",
)


def _private_file(info: os.stat_result) -> bool:
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.geteuid()
        and stat.S_IMODE(info.st_mode) & 0o077 == 0
        and info.st_nlink == 1
    )


class _TransactionPool:
    """Let existing repositories participate in one caller-owned transaction."""

    dialect = "sqlite"

    def __init__(self, connection: sqlite3.Connection) -> None:
        self.connection = connection

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        yield self.connection

    transaction = connect

    def close(self) -> None:
        # The caller owns the connection and transaction lifetime.
        pass


@contextmanager
def _offline_environment(root: Path) -> Iterator[None]:
    # This is a pre-server CLI, never an HTTP-accessible mode. The local model
    # probe shares Octop's domain implementation but cannot select another home
    # or fall back to a remote model download.
    values = {"OCTOP_HOME": str(root), "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"}
    before = {name: os.environ.get(name) for name in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for name, value in before.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


async def bootstrap_offline(
    root: Path, *, local_required: bool, probe_timeout: float = 180
) -> bool:
    """Fixed first-install operation, before any native service starts.

    A private marker is necessary but not sufficient: an exclusive SQLite
    lifetime lock rejects an already-open native DB and prevents another native
    process opening it during the probe/commit. No credentials, API login, user
    mapping or server auth exemption is involved. Existing explicit settings,
    including disabled, are left unchanged even with a stale pending marker.
    """
    if not local_required:
        raise KnowledgeBootstrapError("WANX_KNOWLEDGE_OFFLINE_REQUIRED")
    pending = root / PENDING_FILE
    try:
        marker = pending.lstat()
    except FileNotFoundError:
        return False
    if os.name != "posix" or not _private_file(marker):
        raise KnowledgeBootstrapError("WANX_KNOWLEDGE_PENDING_INVALID")
    root_info = root.lstat()
    if (
        not stat.S_ISDIR(root_info.st_mode)
        or root_info.st_uid != os.geteuid()
        or stat.S_IMODE(root_info.st_mode) & 0o022
    ):
        raise KnowledgeBootstrapError("WANX_KNOWLEDGE_PENDING_INVALID")
    root = root.absolute()
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    marker_fd = None
    db = None
    try:
        import fcntl

        marker_fd = os.open(PENDING_FILE, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        opened = os.fstat(marker_fd)
        if not _private_file(opened) or (marker.st_dev, marker.st_ino) != (
            opened.st_dev,
            opened.st_ino,
        ):
            raise KnowledgeBootstrapError("WANX_KNOWLEDGE_PENDING_INVALID")
        try:
            fcntl.flock(marker_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise KnowledgeBootstrapError("WANX_KNOWLEDGE_OFFLINE_BUSY") from None
        if os.read(marker_fd, 32) not in (b"", b"pending"):
            raise KnowledgeBootstrapError("WANX_KNOWLEDGE_PENDING_INVALID")

        def check_marker() -> None:
            current = os.stat(PENDING_FILE, dir_fd=directory, follow_symlinks=False)
            if not _private_file(current) or (current.st_dev, current.st_ino) != (
                opened.st_dev,
                opened.st_ino,
            ):
                raise KnowledgeBootstrapError("WANX_KNOWLEDGE_PENDING_INVALID")

        # Import only after marker checks; upgrades without it never initialize
        # native services, inspect config or read a model/credential directory.
        from octop.config import database_env_configured, load_config
        from octop.infra.agents.providers import onnx_service
        from octop.infra.db.factory import resolve_sqlite_db_path
        from octop.infra.db.pool import SqlitePool
        from octop.infra.db.services import RepoBundle
        from octop.infra.knowledge.gate import get_capability, set_feature_enabled
        from octop.infra.utils.paths import PathLayout

        paths = PathLayout(root)
        config = load_config(paths.config)
        db_path = root / "octop.db"
        if (
            database_env_configured()
            or not config.database.is_sqlite
            or resolve_sqlite_db_path(config, paths) != db_path
        ):
            raise KnowledgeBootstrapError("WANX_KNOWLEDGE_OFFLINE_DATABASE_INVALID")
        db_info = db_path.lstat()
        if not _private_file(db_info):
            raise KnowledgeBootstrapError("WANX_KNOWLEDGE_OFFLINE_DATABASE_INVALID")
        db = SqlitePool(db_path)
        try:
            with db.connect() as connection:
                connection.execute("PRAGMA busy_timeout=0")
                connection.execute("PRAGMA locking_mode=EXCLUSIVE")
                connection.execute("BEGIN EXCLUSIVE")
                connection.execute("COMMIT")
        except sqlite3.OperationalError:
            raise KnowledgeBootstrapError("WANX_KNOWLEDGE_OFFLINE_BUSY") from None
        # EXCLUSIVE locking mode retains the OS lock across transaction commits
        # until db.close(). Existing WAL readers also prevent its acquisition.
        repos = RepoBundle.from_pool(db)
        configured = any(repos.settings_repo.get(key) is not None for key in _KNOWLEDGE_KEYS)
        if not configured:
            with _offline_environment(root):
                if not onnx_service.local_embedding_deps_available():
                    raise KnowledgeBootstrapError("WANX_KNOWLEDGE_RUNTIME_MISSING")
                # The dependency check prevents probe_local_model's optional
                # installer path. Probe itself must actually embed on-device.
                try:
                    async with asyncio.timeout(probe_timeout):
                        probe = await onnx_service.probe_local_model(DEFAULT_MODEL)
                except TimeoutError:
                    raise KnowledgeBootstrapError("WANX_KNOWLEDGE_MODEL_NOT_READY") from None
                if (
                    probe.get("ok") is not True
                    or type(probe.get("dim")) is not int
                    or probe["dim"] <= 0
                ):
                    raise KnowledgeBootstrapError("WANX_KNOWLEDGE_MODEL_NOT_READY")
                check_marker()
                # Domain validation and all setting writes are one real commit.
                # OCR/retrieval/index settings and existing principals are untouched.
                with db.transaction() as connection:
                    transactional = RepoBundle.from_pool(_TransactionPool(connection))
                    set_feature_enabled(
                        transactional.settings_repo.get,
                        transactional.settings_repo.set,
                        enabled=True,
                        backend="onnx",
                        model=DEFAULT_MODEL,
                        provider_repo=transactional.provider_repo,
                    )
                    capability = get_capability(
                        transactional.settings_repo.get, transactional.provider_repo
                    )
                    if not all(
                        capability.get(key) is True
                        for key in ("feature_enabled", "prerequisites_ok", "usable")
                    ):
                        raise KnowledgeBootstrapError("WANX_KNOWLEDGE_ENABLE_FAILED")
                    check_marker()
        check_marker()
        os.unlink(PENDING_FILE, dir_fd=directory)
        os.fsync(directory)
        return not configured
    finally:
        if db is not None:
            db.close()
        if marker_fd is not None:
            os.close(marker_fd)
        os.close(directory)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--offline", action="store_true", help="Explicit offline deployment mode")
    parser.add_argument("--local-required", action="store_true")
    args = parser.parse_args(argv)
    try:
        enabled = asyncio.run(bootstrap_offline(args.root, local_required=args.local_required))
    except KnowledgeBootstrapError as exc:
        print(exc.code, file=sys.stderr)
        return 1
    except Exception:
        print("WANX_KNOWLEDGE_BOOTSTRAP_FAILED", file=sys.stderr)
        return 1
    print("WANX_KNOWLEDGE_ENABLED" if enabled else "WANX_KNOWLEDGE_UNCHANGED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

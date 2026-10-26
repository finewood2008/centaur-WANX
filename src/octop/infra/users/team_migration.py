"""Explicit offline business-data reassignment; never an authentication migration.

The OS controller owns writer exclusion and fresh ledger authorization. This
module inventories every database/owned tree before any mutation, stages copies,
and leaves the controller frozen after any failure. It never adopts a user row.

Authorization linearizes at sole-authority consumption before services resume.
All native readers/writers remain stopped during filesystem changes. A fresh
check immediately precedes each short rename, but it is not a cross-process
atomic lock: revocation can race that small window and leave invisible changed
bytes. Such a failure must block consumption and automatic service recovery;
it must never be reported as a completed or newly accessible migration.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
from collections.abc import Callable, Iterator, Mapping
from contextlib import closing, contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Protocol


class MigrationError(ValueError):
    """A fixed machine-readable preflight/publication failure."""


BUSINESS = {
    "agents": "user_id",
    "applications": "created_by",
    "cron_jobs": "user_id",
    "dialogue_sessions": "user_id",
    "knowledge_bases": "owner_user_id",
    "loop_channel_bindings": "user_id",
    "loops": "user_id",
    "published_experts": "created_by",
    "sessions": "user_id",
    "skill_packages": "created_by",
    "threads": "user_id",
    "usage_log": "user_id",
    **{
        f"self_model_{name}": "subject_user_id"
        for name in ("claims", "events", "jobs", "settings", "sources")
    },
}
# These continue to identify the disabled source account. No credential,
# permission, credit balance or external-account identity is inherited.
SECURITY = {
    "application_access": ("user_id",),
    "connector_oauth_states": ("user_id",),
    "credit_box_scheduler": ("user_id",),
    "credit_meter_tasks": ("local_user_id",),
    "local_data_principals": ("native_user_id",),
    "sso_login_states": ("user_id",),
    "user_invites": ("created_by", "used_by_user_id"),
    "user_policies": ("user_id",),
    "user_sso_identities": ("user_id",),
}
RECONNECT = {"channels": "user_id", "connectors": "user_id"}
IDENTITY_COLUMNS = frozenset(
    {
        "user_id",
        "owner_user_id",
        "subject_user_id",
        "local_user_id",
        "created_by",
        "used_by_user_id",
        "native_user_id",
    }
)
STUDIO_TABLES = frozenset(
    {"projects", "operations", "records", "usage", "task_events", "team_publications"}
)
IDENTITY_KEYS = frozenset(
    {
        "user_id",
        "userId",
        "owner_user_id",
        "ownerUserId",
        "subject_user_id",
        "local_user_id",
        "owner",
    }
)


def _need(ok: object, code: str) -> None:
    if not ok:
        raise MigrationError(code)


def _canonical(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()


def _digest(raw: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")


def _regular(path: Path) -> None:
    for parent in path.parents:
        _need(not parent.is_symlink(), "MIGRATION_UNSAFE_FILE")
    info = path.lstat()
    _need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "MIGRATION_UNSAFE_FILE")


@contextmanager
def _connect(path: Path) -> Iterator[sqlite3.Connection]:
    _regular(path)
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            _regular(sidecar)
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    try:
        yield db
    finally:
        db.close()


def _tables(db: sqlite3.Connection) -> dict[str, list[str]]:
    return {
        row[0]: [col[1] for col in db.execute('PRAGMA table_info("' + row[0] + '")')]
        for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    }


def _database_digest(db: sqlite3.Connection) -> str:
    # Query the committed SQLite snapshot, including WAL, one row at a time.
    # Do not serialize a potentially multi-GB database into process memory.
    digest = hashlib.sha256()

    def record(value: Any) -> None:
        raw = _canonical(value)
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)

    for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"):
        record(list(row))
    for table, columns in _tables(db).items():
        _need(
            re.fullmatch(r"[A-Za-z0-9_]+", table)
            and all(re.fullmatch(r"[A-Za-z0-9_]+", c) for c in columns),
            "MIGRATION_SCHEMA_UNSUPPORTED",
        )
        primary = sorted((r[5], r[1]) for r in db.execute(f'PRAGMA table_info("{table}")') if r[5])
        order = ",".join('"' + name + '"' for _, name in primary) if primary else "rowid"
        record([table, columns])
        for row in db.execute(f'SELECT * FROM "{table}" ORDER BY {order}'):
            record(
                [
                    {"blobBytes": len(value), "sha256": _digest(value)}
                    if isinstance(value, bytes)
                    else value
                    for value in row
                ]
            )
    return base64.urlsafe_b64encode(digest.digest()).decode().rstrip("=")


def _file_digest(path: Path) -> str:
    _regular(path)
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    return base64.urlsafe_b64encode(hasher.digest()).decode().rstrip("=")


def _tree(path: Path) -> list[dict[str, Any]]:
    for parent in path.parents:
        _need(not parent.is_symlink(), "MIGRATION_UNSAFE_FILE")
    if not path.exists():
        _need(not path.is_symlink(), "MIGRATION_UNSAFE_FILE")
        return []
    _need(path.is_dir() and not path.is_symlink(), "MIGRATION_UNSAFE_FILE")
    result = []
    for child in sorted(path.rglob("*")):
        _need(not child.is_symlink(), "MIGRATION_UNSAFE_FILE")
        if child.is_dir():
            continue
        _regular(child)
        result.append(
            {
                "path": child.relative_to(path).as_posix(),
                "bytes": child.stat().st_size,
                "sha256": _file_digest(child),
            }
        )
    return result


@dataclass(frozen=True)
class MigrationIdentity:
    box_id: str
    box_key_thumbprint: str
    ownership_epoch: int
    principal_id: str
    membership_id: str
    source_user_id: int
    target_user_id: int
    target_namespace: str

    def validate(self) -> None:
        _need(
            type(self.source_user_id) is int
            and self.source_user_id > 0
            and type(self.target_user_id) is int
            and self.target_user_id > 0
            and self.source_user_id != self.target_user_id,
            "MIGRATION_IDENTITY_INVALID",
        )
        _need(
            type(self.ownership_epoch) is int and self.ownership_epoch > 0,
            "MIGRATION_IDENTITY_INVALID",
        )
        for value in (self.box_id, self.principal_id):
            _need(
                isinstance(value, str)
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", value),
                "MIGRATION_IDENTITY_INVALID",
            )
        for value in (self.box_key_thumbprint, self.target_namespace, self.membership_id):
            _need(
                isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", value),
                "MIGRATION_IDENTITY_INVALID",
            )
            decoded = base64.urlsafe_b64decode(value + "=")
            _need(
                len(decoded) == 32
                and base64.urlsafe_b64encode(decoded).decode().rstrip("=") == value,
                "MIGRATION_IDENTITY_INVALID",
            )
        body = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.principal",
            "boxKeyThumbprint": self.box_key_thumbprint,
            "ownershipEpoch": self.ownership_epoch,
            "principalId": self.principal_id,
        }
        _need(_digest(_canonical(body)) == self.target_namespace, "MIGRATION_IDENTITY_INVALID")


@dataclass(frozen=True)
class MigrationPaths:
    home: Path
    clipboard: Path
    journal: Path
    semantica: Path

    def validate(self) -> None:
        for path in (self.home, self.clipboard, self.journal, self.semantica):
            _need(path.is_absolute(), "MIGRATION_PATH_INVALID")
            for parent in (path, *path.parents):
                _need(not parent.is_symlink(), "MIGRATION_UNSAFE_FILE")
        _need(self.home != self.clipboard and self.journal != self.home, "MIGRATION_PATH_INVALID")


class MigrationControl(Protocol):
    """Implemented by fixed root-only OS control, never renderer/user input."""

    def freeze(self, request_id: str, plan: Mapping[str, Any]) -> Mapping[str, Any]: ...
    def check(
        self, request_id: str, plan: Mapping[str, Any], receipt: Mapping[str, Any]
    ) -> None: ...
    def complete(
        self, request_id: str, plan: Mapping[str, Any], receipt: Mapping[str, Any]
    ) -> None: ...


def _count(db: sqlite3.Connection, table: str, column: str, uid: int) -> int:
    return int(
        db.execute(f'SELECT COUNT(*) FROM "{table}" WHERE "{column}"=?', (uid,)).fetchone()[0]
    )


def _identity_rows(
    db: sqlite3.Connection, identity: MigrationIdentity
) -> tuple[dict[str, Any], dict[str, Any]]:
    source = db.execute("SELECT * FROM users WHERE id=?", (identity.source_user_id,)).fetchone()
    target = db.execute("SELECT * FROM users WHERE id=?", (identity.target_user_id,)).fetchone()
    _need(
        source is not None and source["disabled"] == 1 and not source["local_data_marker"],
        "MIGRATION_SOURCE_MUST_BE_DISABLED_LEGACY",
    )
    _need(
        target is not None
        and target["username"] == "local_" + identity.target_namespace
        and target["role"] == "user"
        and target["password_hash"] is None
        and target["sso_provider_id"] is None
        and target["sso_subject"] is None
        and target["permissions"] in (None, "[]")
        and target["disabled"] == 0
        and target["local_data_marker"],
        "MIGRATION_TARGET_INVALID",
    )
    _need(
        isinstance(source["username"], str)
        and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", source["username"])
        and source["username"] not in {".", ".."},
        "MIGRATION_UNSAFE_RESOURCE_ID",
    )
    _need(
        not db.execute(
            "SELECT 1 FROM user_sso_identities WHERE user_id=?", (identity.target_user_id,)
        ).fetchone(),
        "MIGRATION_TARGET_INVALID",
    )
    mapping = db.execute(
        "SELECT * FROM local_data_principals WHERE namespace=?", (identity.target_namespace,)
    ).fetchone()
    _need(
        mapping is not None
        and mapping["native_user_id"] == identity.target_user_id
        and mapping["box_key_thumbprint"] == identity.box_key_thumbprint
        and mapping["ownership_epoch"] == identity.ownership_epoch
        and mapping["principal_id"] == identity.principal_id
        and mapping["identity_marker"] == target["local_data_marker"],
        "MIGRATION_TARGET_INVALID",
    )
    return dict(source), dict(target)


def _session_key(value: str, source: int, target: int) -> str:
    parts = value.split(":", 3)
    if len(parts) == 4 and parts[1] in {"dashboard", "cli"} and parts[2] == str(source):
        parts[2] = str(target)
        return ":".join(parts)
    return value


def _identity_selector(value: Any, source: int) -> bool:
    if isinstance(value, dict):
        return any(
            (key in IDENTITY_KEYS and item in (source, str(source), "wanx:" + str(source)))
            or _identity_selector(item, source)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_identity_selector(item, source) for item in value)
    return False


def _credential_selector(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            (
                re.search(
                    r"(?:password|secret|token|api[_-]?key|authorization|credential)", key, re.I
                )
                and item not in (None, "", [], {})
            )
            or _credential_selector(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_credential_selector(item) for item in value)
    return False


def _owned_moves(paths: MigrationPaths, identity: MigrationIdentity) -> list[dict[str, Any]]:
    source, target = str(identity.source_user_id), str(identity.target_user_id)
    old_clip = hashlib.sha256(source.encode()).hexdigest()
    new_clip = hashlib.sha256(
        ("centuarai.local-data.clipboard.v1:" + identity.target_namespace).encode()
    ).hexdigest()
    moves: list[dict[str, Any]] = [
        {
            "root": "home",
            "source": ".wanx-personal-space/" + source,
            "target": ".wanx-personal-space/" + target,
        },
        {"root": "clipboard", "source": old_clip, "target": new_clip},
    ]
    for extension in ("png", "jpg", "jpeg", "webp", "gif"):
        path = "avatars/users/" + source + "." + extension
        if (paths.home / path).exists():
            moves.append(
                {
                    "root": "home",
                    "source": path,
                    "target": "avatars/users/" + target + "." + extension,
                    "file": True,
                }
            )
    return moves


def build_plan(paths: MigrationPaths, identity: MigrationIdentity) -> dict[str, Any]:
    """Read-only, content-digested preview. No source values/credentials leave it."""
    paths.validate()
    identity.validate()
    blockers: list[str] = []
    references: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    databases: list[dict[str, Any]] = []
    owned_trees: list[dict[str, Any]] = []
    studio_sessions = 0
    semantica_inventory: dict[str, Any] = {
        "databasePresent": False,
        "sourceWarehouses": [],
        "unmappedDocuments": 0,
    }
    with _connect(paths.home / "octop.db") as db:
        schema = _tables(db)
        _need(
            db.execute("SELECT version FROM _schema_version").fetchone()[0] in (31, 32, 33, 34)
            and "local_data_principals" in schema
            and "local_data_marker" in schema.get("users", []),
            "MIGRATION_SCHEMA_UNSUPPORTED",
        )
        source, target = _identity_rows(db, identity)
        for table, columns in schema.items():
            _need(re.fullmatch(r"[A-Za-z0-9_]+", table), "MIGRATION_SCHEMA_UNSUPPORTED")
            foreign_user_columns = {
                row[3]
                for row in db.execute(f'PRAGMA foreign_key_list("{table}")')
                if row[2] == "users"
            }
            for column in (set(columns) & IDENTITY_COLUMNS) | foreign_user_columns:
                count = _count(db, table, column, identity.source_user_id)
                if BUSINESS.get(table) == column:
                    if _count(db, table, column, identity.target_user_id):
                        blockers.append("target-not-empty:" + table)
                    references.append({"table": table, "column": column, "count": count})
                    # Structured runtime selectors are distinct from user
                    # message text. Unknown embedded identity/credential
                    # semantics require review instead of global substitution.
                    for json_column in set(columns) & {
                        "config_json",
                        "agent_template_json",
                        "resource_requirements_json",
                        "channel_metadata",
                        "payload",
                        "artifacts",
                        "definition_json",
                    }:
                        for row in db.execute(
                            f'SELECT "{json_column}" FROM "{table}" WHERE "{column}"=?',
                            (identity.source_user_id,),
                        ):
                            if not row[0]:
                                continue
                            try:
                                value = json.loads(row[0])
                            except (ValueError, TypeError):
                                blockers.append(
                                    "structured-business-format-review:" + table + "." + json_column
                                )
                                continue
                            if _identity_selector(value, identity.source_user_id):
                                blockers.append(
                                    "embedded-identity-review:" + table + "." + json_column
                                )
                            if json_column != "payload" and _credential_selector(value):
                                blockers.append(
                                    "embedded-credential-review:" + table + "." + json_column
                                )
                elif column in SECURITY.get(table, ()):
                    excluded.append(
                        {
                            "table": table,
                            "column": column,
                            "count": count,
                            "reason": "authentication-or-authority",
                        }
                    )
                elif count or _count(db, table, column, identity.target_user_id):
                    blockers.append(
                        (
                            "assistant-state-review:"
                            if table
                            in {
                                "assistant_conversations",
                                "assistant_knowledge_access",
                                "assistant_knowledge_access_audit",
                            }
                            else "reconnect-required:"
                            if table in RECONNECT
                            else "unknown-identity-reference:"
                        )
                        + table
                        + "."
                        + column
                    )
        # Assistant history, source metadata and revocable grants form one owner
        # context. Do not move its agent/threads while leaving that state behind,
        # or reassign a cloud knowledge permission to the new local identity.
        if "assistant_knowledge_access" in schema:
            for row in db.execute("SELECT members_json FROM assistant_knowledge_access"):
                try:
                    members = json.loads(row[0])
                    _need(isinstance(members, list), "MIGRATION_SCHEMA_UNSUPPORTED")
                except (ValueError, TypeError):
                    blockers.append(
                        "assistant-state-review:assistant_knowledge_access.members_json"
                    )
                    continue
                if identity.source_user_id in members or identity.target_user_id in members:
                    blockers.append(
                        "assistant-state-review:assistant_knowledge_access.members_json"
                    )
        for account in (source, target):
            try:
                preferences = json.loads(account["preferences_json"] or "{}")
                _need(isinstance(preferences, dict), "MIGRATION_SCHEMA_UNSUPPORTED")
            except (ValueError, TypeError):
                blockers.append("assistant-state-review:users.preferences_json")
                preferences = {}
            if any(
                preferences.get(key)
                for key in (
                    "wanx_assistant_agent_id",
                    "wanx_assistant_history_v1",
                    "wanx_assistant_recent_conversation",
                )
            ):
                blockers.append("assistant-state-review:users.preferences_json")
            for family in ("space-grants", "knowledge-grants", "knowledge-sources"):
                relative = f".wanx-assistant/{family}/{account['id']}"
                files = _tree(paths.home / relative)
                if files:
                    owned_trees.append({"path": relative, "files": files})
                    blockers.append("assistant-state-review:" + family)
        agents = db.execute(
            "SELECT agent_id,config_json,mcp_servers FROM agents WHERE user_id=?",
            (identity.source_user_id,),
        ).fetchall()
        for agent in agents:
            agent_id = agent["agent_id"]
            _need(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", agent_id), "MIGRATION_UNSAFE_RESOURCE_ID")
            config = json.loads(agent["config_json"] or "{}")
            if (
                config.get("backend")
                or config.get("storage")
                or config.get("workspace")
                or config.get("workspace_dir")
                or config.get("env")
                or agent["mcp_servers"] not in (None, "", "[]", "{}")
            ):
                blockers.append("agent-storage-or-connector-review:" + agent_id)
            tree = _tree(paths.home / "agents" / agent_id)
            for item in tree:
                parts = item["path"].split("/")
                if (
                    ".octop-auth" in parts
                    or "auth" in parts
                    or ".env" in parts
                    or "credentials.json" in parts
                    or item["path"].endswith((".sqlite", ".sqlite3", ".db"))
                ):
                    blockers.append("agent-private-runtime-review:" + agent_id + "/" + item["path"])
            owned_trees.append({"path": "agents/" + agent_id, "files": tree})
        for table, identifier_column, root_name in (
            ("knowledge_bases", "knowledge_base_id", "knowledge"),
            ("skill_packages", "skill_package_id", "skill-packages"),
            ("published_experts", "published_expert_id", "published_experts"),
        ):
            owner_column = BUSINESS[table]
            for row in db.execute(
                f'SELECT "{identifier_column}" FROM "{table}" WHERE "{owner_column}"=?',
                (identity.source_user_id,),
            ):
                identifier = row[0]
                _need(
                    re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier),
                    "MIGRATION_UNSAFE_RESOURCE_ID",
                )
                path = root_name + "/" + identifier
                owned_trees.append({"path": path, "files": _tree(paths.home / path)})
        # Deployments have no user FK themselves, but contain the owned app's
        # executable resource bindings and secret references. They are part of
        # the plan and cannot bypass the explicit reconnection requirement.
        for row in db.execute(
            "SELECT d.* FROM application_deployments d JOIN applications a "
            "ON a.application_id=d.application_id WHERE a.created_by=?",
            (identity.source_user_id,),
        ):
            for column in ("resource_bindings_json", "configuration_json"):
                try:
                    config = json.loads(row[column])
                except (ValueError, TypeError):
                    blockers.append("application-configuration-review:" + row["application_id"])
                    continue
                if _identity_selector(config, identity.source_user_id) or _credential_selector(
                    config
                ):
                    blockers.append("application-configuration-review:" + row["application_id"])
                if (
                    column == "configuration_json"
                    and isinstance(config, dict)
                    and config.get("studio_team_data")
                ):
                    blockers.append("application-knowledge-reapproval:" + row["application_id"])
        # User-specific legacy configuration can contain credentials, absolute
        # paths and provider keys. It must be reviewed, not recursively copied.
        legacy_user = paths.home / "users" / source["username"]
        if _tree(legacy_user):
            blockers.append("legacy-user-directory-review")
        databases.append({"root": "home", "path": "octop.db", "sha256": _database_digest(db)})
    moves = _owned_moves(paths, identity)
    for move in moves:
        root = paths.home if move["root"] == "home" else paths.clipboard
        source_path, target_path = root / move["source"], root / move["target"]
        files = (
            [{"path": "", "bytes": source_path.stat().st_size, "sha256": _file_digest(source_path)}]
            if move.get("file")
            else _tree(source_path)
        )
        if target_path.exists():
            blockers.append("target-directory-exists:" + move["root"] + "/" + move["target"])
        move["present"] = source_path.exists()
        owned_trees.append({"path": move["root"] + "/" + move["source"], "files": files})
        if move["root"] == "home" and source_path.exists() and not move.get("file"):
            with _connect(source_path / "index.sqlite3") as db:
                # SpaceLinks and connections are durable bearer capabilities,
                # not ordinary files. Even historical token/ACL tables need an
                # explicit reconnect/reset review before a whole-tree move.
                for table in (
                    "agent_links",
                    "space_connections",
                    "space_grants",
                    "agent_uploads",
                    "space_sync_tasks",
                    "space_sync_uploads",
                    "space_sync_file_ops",
                ):
                    if (
                        table in _tables(db)
                        and db.execute(f'SELECT 1 FROM "{table}" LIMIT 1').fetchone()
                    ):
                        blockers.append("personal-space-authority-reconnect:" + table)
                for table in ("space_storage", "object_locations"):
                    if (
                        table in _tables(db)
                        and db.execute(f'SELECT 1 FROM "{table}" LIMIT 1').fetchone()
                    ):
                        blockers.append("external-space-storage-review:" + table)
                if (
                    "uploads" in _tables(db)
                    and db.execute(
                        "SELECT 1 FROM uploads WHERE state<>'complete' LIMIT 1"
                    ).fetchone()
                ):
                    blockers.append("unfinished-personal-space-upload")
    studio = paths.home / ".wanx-app-studio" / "studio.sqlite"
    if studio.exists():
        with _connect(studio) as db:
            for table, columns in _tables(db).items():
                if "owner" in columns:
                    count = int(
                        db.execute(
                            f'SELECT COUNT(*) FROM "{table}" WHERE owner=?',
                            ("wanx:" + str(identity.source_user_id),),
                        ).fetchone()[0]
                    )
                    if table not in STUDIO_TABLES and count:
                        blockers.append("unknown-studio-owner-reference:" + table)
                    references.append(
                        {"table": "studio." + table, "column": "owner", "count": count}
                    )
                    if db.execute(
                        f'SELECT 1 FROM "{table}" WHERE owner=? LIMIT 1',
                        ("wanx:" + str(identity.target_user_id),),
                    ).fetchone():
                        blockers.append("target-studio-not-empty:" + table)
            if "projects" in _tables(db):
                for row in db.execute(
                    "SELECT id,body FROM projects WHERE owner=?",
                    ("wanx:" + str(identity.source_user_id),),
                ):
                    project = json.loads(row["body"])
                    _need(
                        type(project) is dict
                        and project.get("owner") == "wanx:" + str(identity.source_user_id),
                        "MIGRATION_STUDIO_FORMAT_UNSUPPORTED",
                    )
                    tasks = project.get("tasks", [])
                    _need(
                        type(tasks) is list and all(type(task) is dict for task in tasks),
                        "MIGRATION_STUDIO_FORMAT_UNSUPPORTED",
                    )
                    for task in tasks:
                        if task.get("state") not in {
                            "completed",
                            "succeeded",
                            "failed",
                            "cancelled",
                            "interrupted",
                        }:
                            blockers.append("unfinished-studio-task:" + row["id"])
                        studio_sessions += int(bool(task.get("sessionId")))
                        task_id = task.get("id")
                        _need(
                            type(task_id) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id),
                            "MIGRATION_UNSAFE_RESOURCE_ID",
                        )
                        relative = ".wanx-app-studio/tasks/" + task_id
                        tree = _tree(paths.home / relative)
                        if any(item["path"] != "sources.json" for item in tree):
                            blockers.append("studio-task-runtime-review:" + task_id)
                        owned_trees.append({"path": relative, "files": tree})
                    preparation = project.get("preparation", {})
                    if isinstance(preparation, dict) and (
                        preparation.get("currentProbe", {}).get("state") == "running"
                        or preparation.get("interview", {}).get("state") in {"running", "queued"}
                    ):
                        blockers.append("unfinished-studio-preparation:" + row["id"])
            databases.append(
                {
                    "root": "home",
                    "path": ".wanx-app-studio/studio.sqlite",
                    "sha256": _database_digest(db),
                }
            )
    semantica_db = paths.semantica / "app.sqlite3"
    if semantica_db.exists() or semantica_db.is_symlink():
        with _connect(semantica_db) as db:
            tables = _tables(db)
            semantica_inventory["databasePresent"] = True
            semantica_inventory["sha256"] = _database_digest(db)
            if "xingtu_warehouses" in tables:
                for row in db.execute(
                    "SELECT id,owner,workspace_id FROM xingtu_warehouses WHERE state<>'deleted'"
                ):
                    try:
                        owner = json.loads(row["owner"])
                    except ValueError:
                        blockers.append("semantica-owner-format-review")
                        continue
                    if (
                        isinstance(owner, list)
                        and len(owner) == 3
                        and isinstance(owner[2], str)
                        and owner[2].endswith(":" + str(identity.source_user_id))
                    ):
                        semantica_inventory["sourceWarehouses"].append(
                            {"warehouseId": row["id"], "workspaceId": row["workspace_id"]}
                        )
                if semantica_inventory["sourceWarehouses"]:
                    blockers.append("semantica-legacy-ownership-review")
            if "documents" in tables:
                if "xingtu_warehouses" in tables:
                    query = "SELECT COUNT(*) FROM documents d WHERE NOT EXISTS(SELECT 1 FROM xingtu_warehouses w WHERE w.workspace_id=d.workspace_id)"
                else:
                    query = "SELECT COUNT(*) FROM documents"
                semantica_inventory["unmappedDocuments"] = db.execute(query).fetchone()[0]
                if semantica_inventory["unmappedDocuments"]:
                    blockers.append("semantica-unregistered-workspace-review")
    plan: dict[str, Any] = {
        "schemaVersion": 1,
        "purpose": "centuarai.team-business-migration",
        "identity": asdict(identity),
        "databases": databases,
        "references": sorted(references, key=lambda x: (x["table"], x["column"])),
        "excluded": sorted(excluded, key=lambda x: (x["table"], x["column"])),
        "trees": owned_trees,
        "moves": moves,
        "semanticaInventory": semantica_inventory,
        "blockers": sorted(set(blockers)),
        "credentialsTransferred": False,
        "permissionsInherited": False,
        "sourceAccountRemainsDisabled": True,
        "companyPublicationRequiresReview": True,
        "studioEngineRequiresReconfiguration": True,
        "studioWorkerSessionsDiscarded": studio_sessions,
        "publicationSemantics": "offline-until-authority-consumption",
        "diskChangesBeforeConsumption": True,
        "automaticResumeRequiresCurrentAuthority": True,
    }
    return {**plan, "planDigest": _digest(_canonical(plan))}


def validate_plan(plan: Mapping[str, Any]) -> None:
    _need(
        type(plan) is dict
        and plan.get("schemaVersion") == 1
        and plan.get("purpose") == "centuarai.team-business-migration",
        "MIGRATION_PLAN_INVALID",
    )
    _need(
        plan.get("planDigest")
        == _digest(_canonical({k: v for k, v in plan.items() if k != "planDigest"})),
        "MIGRATION_PLAN_CHANGED",
    )
    _need(
        plan.get("blockers") == []
        and plan.get("credentialsTransferred") is False
        and plan.get("permissionsInherited") is False
        and plan.get("sourceAccountRemainsDisabled") is True,
        "MIGRATION_PREFLIGHT_BLOCKED",
    )
    _need(
        plan.get("publicationSemantics") == "offline-until-authority-consumption"
        and plan.get("diskChangesBeforeConsumption") is True
        and plan.get("automaticResumeRequiresCurrentAuthority") is True,
        "MIGRATION_PLAN_INVALID",
    )


def _write_json(path: Path, value: Any) -> None:
    # A power loss before rename must not leave a fixed .new name that prevents
    # every future resume. Only complete, atomically renamed journals are read.
    temporary = path.with_name("." + path.name + "." + secrets.token_hex(16) + ".new")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(_canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _rewrite_project(value: Any, old: str, new: str) -> Any:
    # Only the Store's top-level project identity and native worker resume
    # handles are structural authority. User records/source/message objects
    # may also contain a field named owner and must remain byte-equivalent.
    _need(type(value) is dict and value.get("owner") == old, "MIGRATION_STUDIO_FORMAT_UNSUPPORTED")
    value["owner"] = new
    for task in value.get("tasks", []):
        task.pop("sessionId", None)
    return value


def _publish_database(
    directory: Path,
    index: int,
    database: dict[str, Any],
    destination: Path,
    expected: str,
    *,
    publication_check: Callable[[], None],
) -> None:
    staged = directory / (str(index) + ".sqlite")
    intent_path = directory / (str(index) + ".publish.json")
    if not intent_path.exists():
        _need(staged.exists() and _file_digest(staged) == expected, "MIGRATION_STAGE_CHANGED")
        with _connect(destination) as db:
            _need(_database_digest(db) == database["sha256"], "MIGRATION_SOURCE_CHANGED")
        files = {}
        for suffix in ("", "-wal", "-journal"):
            path = Path(str(destination) + suffix)
            files[suffix] = _file_digest(path) if path.exists() else None
        # Persist before removing any sidecar. A crash between WAL removal and
        # DB rename resumes from these exact original bytes, never from a
        # misleading SQLite view that has lost its committed WAL rows.
        _write_json(
            intent_path,
            {"sourceDigest": database["sha256"], "targetDigest": expected, "files": files},
        )
    _regular(intent_path)
    intent = json.loads(intent_path.read_bytes())
    _need(
        intent["sourceDigest"] == database["sha256"] and intent["targetDigest"] == expected,
        "MIGRATION_JOURNAL_CONFLICT",
    )
    if staged.exists():
        _need(
            _file_digest(staged) == expected and _file_digest(destination) == intent["files"][""],
            "MIGRATION_SOURCE_CHANGED",
        )
        original = directory / (str(index) + ".original")
        if not original.exists() or _file_digest(original) != intent["files"][""]:
            # A partial backup never occupies the authoritative recovery name.
            # Retry can also repair a legacy interrupted .original, but only
            # while the live source still matches the sealed original intent.
            temporary = original.with_name(original.name + "." + secrets.token_hex(16) + ".new")
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "wb") as output, destination.open("rb") as input_stream:
                    shutil.copyfileobj(input_stream, output, 1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
                _need(_file_digest(temporary) == intent["files"][""], "MIGRATION_SOURCE_CHANGED")
                os.replace(temporary, original)
                _sync_directory(directory)
            finally:
                temporary.unlink(missing_ok=True)
        _need(_file_digest(original) == intent["files"][""], "MIGRATION_JOURNAL_CONFLICT")
        publication_check()
        for suffix in ("-wal", "-journal", "-shm"):
            sidecar, archived = Path(str(destination) + suffix), directory / (str(index) + suffix)
            if sidecar.exists():
                _regular(sidecar)
                if suffix != "-shm":
                    _need(
                        _file_digest(sidecar) == intent["files"][suffix], "MIGRATION_SOURCE_CHANGED"
                    )
                _need(not archived.exists(), "MIGRATION_JOURNAL_CONFLICT")
                publication_check()
                os.replace(sidecar, archived)
                _sync_directory(directory)
                _sync_directory(destination.parent)
            if suffix != "-shm" and intent["files"][suffix] is not None:
                _need(
                    archived.exists() and _file_digest(archived) == intent["files"][suffix],
                    "MIGRATION_JOURNAL_CONFLICT",
                )
        info = destination.stat()
        os.chmod(staged, 0o600)
        if os.name == "posix":
            os.chown(staged, info.st_uid, info.st_gid)
        publication_check()
        os.replace(staged, destination)
    _need(_file_digest(destination) == expected, "MIGRATION_PUBLISH_INCOMPLETE")
    directory_fd = os.open(destination.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _transform(db: sqlite3.Connection, identity: MigrationIdentity, *, studio: bool) -> None:
    source, target = identity.source_user_id, identity.target_user_id
    schema = _tables(db)
    if studio:
        old, new = "wanx:" + str(source), "wanx:" + str(target)
        for table in STUDIO_TABLES & schema.keys():
            columns = schema[table]
            if table == "projects" and "body" in columns:
                column = "body"
                for row in db.execute(
                    f'SELECT rowid,"{column}" FROM "{table}" WHERE owner=?', (old,)
                ).fetchall():
                    if row[1]:
                        transformed = _rewrite_project(json.loads(row[1]), old, new)
                        db.execute(
                            f'UPDATE "{table}" SET "{column}"=? WHERE rowid=?',
                            (_canonical(transformed).decode(), row[0]),
                        )
            db.execute(f'UPDATE "{table}" SET owner=? WHERE owner=?', (new, old))
        return
    _identity_rows(db, identity)
    for table, column in BUSINESS.items():
        if table not in schema:
            continue
        if "session_key" in schema[table]:
            for row in db.execute(
                f'SELECT rowid,session_key FROM "{table}" WHERE "{column}"=?', (source,)
            ).fetchall():
                db.execute(
                    f'UPDATE "{table}" SET session_key=? WHERE rowid=?',
                    (_session_key(row[1], source, target), row[0]),
                )
        if table == "sessions":
            db.execute(
                "UPDATE sessions SET channel_subject_id=? WHERE user_id=? AND channel_type IN ('dashboard','cli') AND channel_subject_id=?",
                (str(target), source, str(source)),
            )
        db.execute(f'UPDATE "{table}" SET "{column}"=? WHERE "{column}"=?', (target, source))
    # Legacy boolean sharing is not a new team's ACL. Preserve resources while
    # requiring an explicit resource grant to publish them to the team.
    db.execute("UPDATE agents SET is_shared=0 WHERE user_id=?", (target,))
    db.execute("UPDATE knowledge_bases SET shared=0 WHERE owner_user_id=?", (target,))
    _need(not db.execute("PRAGMA foreign_key_check").fetchone(), "MIGRATION_REFERENCE_INVALID")


def apply_plan(
    paths: MigrationPaths, plan: dict[str, Any], request_id: str, control: MigrationControl
) -> dict[str, Any]:
    """Restartable publication. Any exception deliberately leaves writers frozen."""
    paths.validate()
    validate_plan(plan)
    _need(re.fullmatch(r"[A-Za-z0-9_-]{43}", request_id), "MIGRATION_REQUEST_INVALID")
    identity = MigrationIdentity(**plan["identity"])
    identity.validate()
    paths.journal.mkdir(mode=0o700, parents=True, exist_ok=True)
    _need(paths.journal.stat().st_mode & 0o077 == 0, "MIGRATION_UNSAFE_JOURNAL")
    directory = paths.journal / plan["planDigest"]
    directory.mkdir(mode=0o700, exist_ok=True)
    journal_path = directory / "journal.json"
    receipt = control.freeze(request_id, plan)
    if journal_path.exists():
        _regular(journal_path)
        journal = json.loads(journal_path.read_bytes())
        _need(
            journal["planDigest"] == plan["planDigest"] and journal["requestId"] == request_id,
            "MIGRATION_JOURNAL_CONFLICT",
        )
        if journal["phase"] == "complete":
            control.complete(request_id, plan, receipt)
            return {
                "planDigest": plan["planDigest"],
                "phase": "complete",
                "sourceUserId": identity.source_user_id,
                "targetUserId": identity.target_user_id,
                "credentialsTransferred": False,
            }
    else:
        control.check(request_id, plan, receipt)
        _need(build_plan(paths, identity) == plan, "MIGRATION_SOURCE_CHANGED")
        journal = {
            "schemaVersion": 1,
            "boxId": identity.box_id,
            "ownershipEpoch": identity.ownership_epoch,
            "principalId": identity.principal_id,
            "targetNamespace": identity.target_namespace,
            "planDigest": plan["planDigest"],
            "requestId": request_id,
            "phase": "staging",
            "published": [],
            "staged": {},
        }
        _write_json(journal_path, journal)
    control.check(request_id, plan, receipt)
    if journal["phase"] == "staging":
        for index, database in enumerate(plan["databases"]):
            staged = directory / (str(index) + ".sqlite")
            if staged.exists():
                staged.unlink()
            with _connect(paths.home / database["path"]) as source:
                _need(_database_digest(source) == database["sha256"], "MIGRATION_SOURCE_CHANGED")
                fd = os.open(staged, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
                with closing(sqlite3.connect(staged)) as target:
                    source.backup(target)
                    target.row_factory = sqlite3.Row
                    target.execute("PRAGMA journal_mode=DELETE")
                    _transform(target, identity, studio=index != 0)
                    _need(
                        target.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                        "MIGRATION_REFERENCE_INVALID",
                    )
                    target.commit()
            journal["staged"][str(index)] = _file_digest(staged)
        journal["phase"] = "publishing"
        _write_json(journal_path, journal)
    for index, database in enumerate(plan["databases"]):
        control.check(request_id, plan, receipt)
        destination = paths.home / database["path"]
        expected = journal["staged"][str(index)]
        if index in journal["published"]:
            _need(_file_digest(destination) == expected, "MIGRATION_PUBLISHED_DATA_CHANGED")
            continue
        _publish_database(
            directory,
            index,
            database,
            destination,
            expected,
            publication_check=lambda: control.check(request_id, plan, receipt),
        )
        journal["published"].append(index)
        _write_json(journal_path, journal)
    for move in plan["moves"]:
        control.check(request_id, plan, receipt)
        if not move["present"]:
            continue
        root = paths.home if move["root"] == "home" else paths.clipboard
        source, target = root / move["source"], root / move["target"]
        expected = next(
            tree["files"]
            for tree in plan["trees"]
            if tree["path"] == move["root"] + "/" + move["source"]
        )
        if source.exists():
            actual = (
                [{"path": "", "bytes": source.stat().st_size, "sha256": _file_digest(source)}]
                if move.get("file")
                else _tree(source)
            )
            _need(not target.exists() and actual == expected, "MIGRATION_SOURCE_CHANGED")
            control.check(request_id, plan, receipt)
            os.rename(source, target)
            for parent in {source.parent, target.parent}:
                descriptor = os.open(parent, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        actual = (
            [{"path": "", "bytes": target.stat().st_size, "sha256": _file_digest(target)}]
            if move.get("file")
            else _tree(target)
        )
        _need(actual == expected, "MIGRATION_PUBLISH_INCOMPLETE")
    for tree in plan["trees"]:
        if not tree["path"].startswith(("home/", "clipboard/")):
            _need(
                _tree(paths.home / tree["path"]) == tree["files"],
                "MIGRATION_PUBLISHED_DATA_CHANGED",
            )
    control.check(request_id, plan, receipt)
    with _connect(paths.home / "octop.db") as db:
        _identity_rows(db, identity)
        for reference in plan["references"]:
            if not reference["table"].startswith("studio."):
                _need(
                    _count(db, reference["table"], reference["column"], identity.source_user_id)
                    == 0
                    and _count(db, reference["table"], reference["column"], identity.target_user_id)
                    == reference["count"],
                    "MIGRATION_REFERENCE_INVALID",
                )
        _need(not db.execute("PRAGMA foreign_key_check").fetchone(), "MIGRATION_REFERENCE_INVALID")
    if len(plan["databases"]) > 1:
        with _connect(paths.home / ".wanx-app-studio/studio.sqlite") as db:
            for reference in plan["references"]:
                if reference["table"].startswith("studio."):
                    table = reference["table"].removeprefix("studio.")
                    old = "wanx:" + str(identity.source_user_id)
                    new = "wanx:" + str(identity.target_user_id)
                    _need(
                        db.execute(
                            f'SELECT COUNT(*) FROM "{table}" WHERE owner=?', (old,)
                        ).fetchone()[0]
                        == 0
                        and db.execute(
                            f'SELECT COUNT(*) FROM "{table}" WHERE owner=?', (new,)
                        ).fetchone()[0]
                        == reference["count"],
                        "MIGRATION_REFERENCE_INVALID",
                    )
    journal["phase"] = "complete"
    _write_json(journal_path, journal)
    control.complete(request_id, plan, receipt)
    return {
        "planDigest": plan["planDigest"],
        "phase": "complete",
        "sourceUserId": identity.source_user_id,
        "targetUserId": identity.target_user_id,
        "credentialsTransferred": False,
    }

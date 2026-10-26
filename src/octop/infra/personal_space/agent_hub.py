"""Private Agent connections, company archives and operation-scoped file grants.

Public personal-space contracts and legacy capabilities are intentionally unchanged.
Every registry transaction fences revocation through the underlying file transaction.
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import hashlib
import hmac
import json
import re
import sqlite3
import time
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, cast

from .links import SpaceLinks
from .service import CHUNK_SIZE, SpaceError, _safe_file
from .workspaces import Workspaces

READS = {"describe", "stat", "list", "read", "write-status"}
WRITES = {"mkdir", "begin-write", "write-chunk", "commit-write", "cancel-write"}
KINDS = {"codex", "claude", "openclaw", "mcp"}
CATEGORIES = {"conversation", "context", "project_memory", "user_memory"}


def checksum(value: str | bytes) -> str:
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def label(value: str) -> str:
    return re.sub(r'[\x00-\x1f/\\:*?"<>|]', "_", value).strip(" .")[:55] or "未命名"


class AgentHub:
    def __init__(self, home: Path, actor: int, member: str, *, admin: bool = False):
        self.home, self.actor, self.member, self.admin = home, actor, member, admin
        self._stores: dict[str, Workspaces] = {}
        self.directory = home / ".wanx-agent-hub"
        self.directory.mkdir(mode=0o700, exist_ok=True)
        if self.directory.is_symlink():
            raise SpaceError("SPACE_UNSAFE_STORAGE", 409)
        self.database = self.directory / "index.sqlite3"
        with self.db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS agents (
                    id TEXT PRIMARY KEY, actor INTEGER NOT NULL, member TEXT NOT NULL,
                    machine TEXT NOT NULL, kind TEXT NOT NULL, profile TEXT NOT NULL,
                    name TEXT NOT NULL, destination TEXT NOT NULL, credential TEXT NOT NULL,
                    disconnected INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
                    collection TEXT NOT NULL DEFAULT '{}', last_seen REAL, created REAL NOT NULL,
                    UNIQUE(actor,machine,kind,profile,destination)
                );
                CREATE TABLE IF NOT EXISTS grants (
                    id TEXT PRIMARY KEY, agent TEXT NOT NULL, domain TEXT NOT NULL,
                    root TEXT NOT NULL, permission TEXT NOT NULL, revoked REAL, created REAL NOT NULL
                );
            """)

    @contextlib.contextmanager
    def db(self) -> Iterator[sqlite3.Connection]:
        _safe_file(self.database, missing=True)
        for suffix in ("-wal", "-shm", "-journal"):
            _safe_file(Path(str(self.database) + suffix), missing=True)
        db = sqlite3.connect(self.database, timeout=20)
        db.row_factory = sqlite3.Row
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def storage(self, domain: str) -> Workspaces:
        if domain not in {"company", "personal"}:
            raise SpaceError("AGENT_DOMAIN_INVALID")
        if domain not in self._stores:
            store = (
                Workspaces(self.home / ".wanx-team-space", self.actor, namespace="company")
                if domain == "company"
                else Workspaces(self.home / ".wanx-personal-space", self.actor)
            )
            with store._db() as db:
                db.executescript("""
                    CREATE TABLE IF NOT EXISTS hub_archive_folders (
                        domain TEXT NOT NULL, identity TEXT NOT NULL, entry TEXT NOT NULL,
                        PRIMARY KEY(domain,identity)
                    );
                    CREATE TABLE IF NOT EXISTS hub_records (
                        id TEXT PRIMARY KEY, agent TEXT NOT NULL, event TEXT NOT NULL,
                        project TEXT NOT NULL, category TEXT NOT NULL, fingerprint TEXT NOT NULL,
                        entry TEXT NOT NULL, metadata TEXT NOT NULL, created REAL NOT NULL,
                        UNIQUE(agent,event)
                    );
                    CREATE INDEX IF NOT EXISTS hub_archive_project ON hub_records(agent,project,created);
                    CREATE TABLE IF NOT EXISTS hub_archived_projects (
                        agent TEXT NOT NULL, project TEXT NOT NULL, hidden INTEGER NOT NULL,
                        PRIMARY KEY(agent,project)
                    );
                """)
            self._stores[domain] = store
        return self._stores[domain]

    def agent(self, db: sqlite3.Connection, aid: str, *, owner: bool = True) -> sqlite3.Row:
        row = db.execute("SELECT * FROM agents WHERE id=?", (aid,)).fetchone()
        if row is None or (
            row["actor"] != self.actor and (owner or row["destination"] != "company")
        ):
            raise SpaceError("AGENT_NOT_FOUND", 404)
        return cast(sqlite3.Row, row)

    @staticmethod
    def public(row: sqlite3.Row) -> dict[str, Any]:
        value = dict(row)
        value.pop("credential", None)
        value["collection"] = json.loads(row["collection"])
        return value

    def listing(self) -> dict[str, Any]:
        with self.db() as db:
            return {
                "agents": [
                    self.public(r)
                    for r in db.execute(
                        "SELECT * FROM agents WHERE actor=? ORDER BY created,id", (self.actor,)
                    )
                ],
                "actor": self.actor,
                "member": self.member,
                "admin": self.admin,
            }

    def register(self, body: dict[str, Any]) -> dict[str, Any]:
        if body["kind"] not in KINDS or body["destination"] not in {"personal", "company"}:
            raise SpaceError("AGENT_INPUT_INVALID")
        key = (self.actor, body["machine"], body["kind"], body["profile"], body["destination"])
        with self.db() as db:
            row = db.execute(
                "SELECT * FROM agents WHERE actor=? AND machine=? AND kind=? AND profile=? AND destination=?",
                key,
            ).fetchone()
            if row:
                if row["disconnected"]:
                    db.execute(
                        "UPDATE agents SET credential=?,disconnected=0,collection='{}',last_seen=NULL,revision=revision+1 WHERE id=?",
                        (checksum(body["credential"]), row["id"]),
                    )
                    return self.public(self.agent(db, row["id"]))
                if not hmac.compare_digest(row["credential"], checksum(body["credential"])):
                    raise SpaceError("AGENT_CREDENTIAL_CHANGED", 409)
                if row["disconnected"]:
                    raise SpaceError("AGENT_DISCONNECTED", 403)
                return self.public(row)
            aid = uuid.uuid4().hex
            db.execute(
                "INSERT INTO agents(id,actor,member,machine,kind,profile,name,destination,credential,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    aid,
                    self.actor,
                    self.member,
                    body["machine"],
                    body["kind"],
                    body["profile"],
                    body["name"],
                    body["destination"],
                    checksum(body["credential"]),
                    time.time(),
                ),
            )
            return self.public(self.agent(db, aid))

    def configure(self, aid: str, body: dict[str, Any]) -> dict[str, Any]:
        with self.db() as db:
            agent = self.agent(db, aid)
            if agent["disconnected"]:
                raise SpaceError("AGENT_DISCONNECTED", 403)
            if body["expected"] != agent["revision"]:
                raise SpaceError("AGENT_CONFIG_CHANGED", 409)
            db.execute(
                "UPDATE agents SET collection=?,revision=revision+1 WHERE id=?",
                (json.dumps(body["collection"], ensure_ascii=False), aid),
            )
            return self.public(self.agent(db, aid))

    def disconnect(self, aid: str) -> dict[str, Any]:
        with self.db() as db:
            self.agent(db, aid)
            db.execute(
                "UPDATE agents SET disconnected=1,collection='{}',revision=revision+1 WHERE id=?",
                (aid,),
            )
            db.execute(
                "UPDATE grants SET revoked=? WHERE agent=? AND revoked IS NULL", (time.time(), aid)
            )
            return {"disconnected": True, "archivesRetained": True}

    def _folder(
        self,
        db: sqlite3.Connection,
        store: SpaceLinks,
        domain: str,
        identity: str,
        parent: str,
        name: str,
    ) -> str:
        with store._db() as files:
            found = files.execute(
                "SELECT entry FROM hub_archive_folders WHERE domain=? AND identity=?",
                (domain, identity),
            ).fetchone()
        if found:
            with store._db() as files:
                store._entry(files, found[0])
            return str(found[0])
        entry = store.mkdir(parent, label(name))["id"]
        with store._db() as files:
            files.execute(
                "INSERT INTO hub_archive_folders VALUES(?,?,?)", (domain, identity, entry)
            )
        return str(entry)

    def _project_folder(
        self, db: sqlite3.Connection, agent: sqlite3.Row, project: dict[str, Any]
    ) -> tuple[Workspaces, str]:
        domain = agent["destination"]
        store = self.storage(domain)
        prefix = "company" if domain == "company" else "personal:" + str(self.actor)
        root = self._folder(db, store, domain, prefix, "", "Agent资料")
        member = self._folder(
            db, store, domain, prefix + ":member:" + str(agent["actor"]), root, agent["member"]
        )
        source = self._folder(db, store, domain, agent["id"], member, agent["name"])
        folder = self._folder(
            db, store, domain, agent["id"] + ":" + project["id"], source, project["name"]
        )
        return store, folder

    def ingest(self, aid: str, records: list[dict[str, Any]]) -> dict[str, Any]:
        if not 1 <= len(records) <= 50:
            raise SpaceError("AGENT_BATCH_INVALID")
        with self.db() as db:
            agent = self.agent(db, aid)
            config = json.loads(agent["collection"])
            if agent["disconnected"] or not config.get("enabled"):
                raise SpaceError("AGENT_COLLECTION_PAUSED", 403)
            projects = {p["id"]: p for p in config.get("projects", [])}
            if config.get("userMemory"):
                projects["global"] = {"id": "global", "name": "已授权的全局用户记忆"}
            store = self.storage(agent["destination"])
            with store._db() as archive:
                return self._ingest_records(db, archive, store, agent, projects, config, records)

    def _ingest_records(
        self,
        db: sqlite3.Connection,
        archive: sqlite3.Connection,
        store: Workspaces,
        agent: sqlite3.Row,
        projects: dict[str, Any],
        config: dict[str, Any],
        records: list[dict[str, Any]],
    ) -> dict[str, Any]:
        saved = []
        aid = agent["id"]
        for record in records:
            project = projects.get(record["project"])
            if archive.execute(
                "SELECT 1 FROM hub_archived_projects WHERE agent=? AND project=? AND hidden=1",
                (aid, record["project"]),
            ).fetchone():
                raise SpaceError("AGENT_ARCHIVE_PAUSED", 403)
            category = record["category"]
            if (
                not project
                or category not in CATEGORIES
                or (category == "user_memory" and not config.get("userMemory"))
            ):
                raise SpaceError("AGENT_COLLECTION_SCOPE", 403)
            if category == "conversation" and not project.get("conversations", True):
                raise SpaceError("AGENT_COLLECTION_SCOPE", 403)
            if category != "conversation" and not project.get("memory", True):
                raise SpaceError("AGENT_COLLECTION_SCOPE", 403)
            encoded = json.dumps(record, ensure_ascii=False, sort_keys=True).encode()
            if len(encoded) > 768 * 1024:
                raise SpaceError("AGENT_RECORD_TOO_LARGE", 413)
            # A log rotation may change its file/offset without changing the message.
            fingerprint = checksum(
                json.dumps(
                    {k: v for k, v in record.items() if k != "origin"},
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
            previous = archive.execute(
                "SELECT * FROM hub_records WHERE agent=? AND event=?", (aid, record["id"])
            ).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise SpaceError("AGENT_RECORD_CONFLICT", 409)
                saved.append(previous["id"])
                continue
            store, parent = self._project_folder(db, agent, project)
            parent = self._folder(
                db,
                store,
                agent["destination"],
                aid + ":" + project["id"] + ":" + category,
                parent,
                "对话记录" if category == "conversation" else "记忆与上下文",
            )
            rid = checksum(aid + ":" + record["id"])[:32]
            store.upload_create(
                parent,
                label(record.get("title") or category) + "-" + rid[:8] + ".json",
                len(encoded),
                rid,
            )
            status = store.upload_status(rid)
            if status["state"] != "complete":
                offset = status["offset"]
                if offset < len(encoded):
                    chunk = encoded[offset:]
                    store.upload_chunk(rid, offset, chunk, checksum(chunk))
                store.upload_complete(rid, checksum(encoded))
            metadata = {k: v for k, v in record.items() if k != "text"}
            metadata["preview"] = record["text"][:160]
            metadata["projectName"] = project["name"]
            archive.execute(
                "INSERT INTO hub_records VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    rid,
                    aid,
                    record["id"],
                    project["id"],
                    category,
                    fingerprint,
                    rid,
                    json.dumps(metadata, ensure_ascii=False),
                    time.time(),
                ),
            )
            saved.append(rid)
        return {"saved": saved}

    def archives(self, destination: str) -> dict[str, Any]:
        store = self.storage(destination)
        with self.db() as db, store._db() as files:
            sources = []
            for summary in files.execute(
                "SELECT agent,COUNT(*) count FROM hub_records GROUP BY agent"
            ):
                try:
                    row = self.agent(db, summary["agent"], owner=False)
                except SpaceError:
                    continue
                if row["destination"] != destination:
                    continue
                projects = []
                for p in files.execute(
                    "SELECT project,COUNT(*) count,MAX(created) updated FROM hub_records WHERE agent=? GROUP BY project",
                    (row["id"],),
                ):
                    hidden = bool(
                        files.execute(
                            "SELECT 1 FROM hub_archived_projects WHERE agent=? AND project=? AND hidden=1",
                            (row["id"], p["project"]),
                        ).fetchone()
                    )
                    if hidden and not self.admin:
                        continue
                    folder = files.execute(
                        "SELECT entry FROM hub_archive_folders WHERE domain=? AND identity=?",
                        (destination, row["id"] + ":" + p["project"]),
                    ).fetchone()
                    meta = files.execute(
                        "SELECT metadata FROM hub_records WHERE agent=? AND project=? ORDER BY created DESC LIMIT 1",
                        (row["id"], p["project"]),
                    ).fetchone()
                    projects.append(
                        {
                            **dict(p),
                            "name": json.loads(meta[0])["projectName"],
                            "root": folder[0] if folder else None,
                            "hidden": hidden,
                        }
                    )
                if not projects:
                    continue
                sources.append(
                    {
                        "id": row["id"],
                        "name": row["name"],
                        "member": row["member"],
                        "actor": row["actor"],
                        "kind": row["kind"],
                        "count": summary["count"],
                        "projects": projects,
                    }
                )
            return {"destination": destination, "sources": sources}

    def records(self, aid: str, project: str, offset: int = 0) -> dict[str, Any]:
        with self.db() as db:
            agent = self.agent(db, aid, owner=False)
            with self.storage(agent["destination"])._db() as files:
                if (
                    files.execute(
                        "SELECT 1 FROM hub_archived_projects WHERE agent=? AND project=? AND hidden=1",
                        (aid, project),
                    ).fetchone()
                    and not self.admin
                ):
                    raise SpaceError("AGENT_NOT_FOUND", 404)
                items = files.execute(
                    "SELECT * FROM hub_records WHERE agent=? AND project=? ORDER BY created,id LIMIT 51 OFFSET ?",
                    (aid, project, offset),
                ).fetchall()
                return {
                    "source": {
                        "member": agent["member"],
                        "name": agent["name"],
                        "destination": agent["destination"],
                    },
                    "items": [
                        {"recordId": r["id"], "created": r["created"], **json.loads(r["metadata"])}
                        for r in items[:50]
                    ],
                    "next": offset + 50 if len(items) > 50 else None,
                }

    def record(self, rid: str) -> dict[str, Any]:
        with self.db() as db:
            for domain in ["personal", "company"]:
                store = self.storage(domain)
                with store._db() as files:
                    row = files.execute("SELECT * FROM hub_records WHERE id=?", (rid,)).fetchone()
                    if row is None:
                        continue
                    self.agent(db, row["agent"], owner=False)
                    if (
                        files.execute(
                            "SELECT 1 FROM hub_archived_projects WHERE agent=? AND project=? AND hidden=1",
                            (row["agent"], row["project"]),
                        ).fetchone()
                        and not self.admin
                    ):
                        raise SpaceError("AGENT_RECORD_NOT_FOUND", 404)
                    content, _ = store.read_chunk(row["entry"], 0, CHUNK_SIZE)
                    return cast(dict[str, Any], json.loads(content))
            raise SpaceError("AGENT_RECORD_NOT_FOUND", 404)

    def browse(self, domain: str, parent: str = "") -> dict[str, Any]:
        return self.storage(domain).listing(parent)

    def archive_action(self, aid: str, project: str, hidden: bool) -> dict[str, Any]:
        with self.db() as db:
            agent = self.agent(db, aid, owner=False)
            if agent["destination"] == "company" and not self.admin:
                raise SpaceError("AGENT_ADMIN_REQUIRED", 403)
            store = self.storage(agent["destination"])
            with store._db() as files:
                if not files.execute(
                    "SELECT 1 FROM hub_records WHERE agent=? AND project=?", (aid, project)
                ).fetchone():
                    raise SpaceError("AGENT_NOT_FOUND", 404)
                folder = files.execute(
                    "SELECT entry FROM hub_archive_folders WHERE domain=? AND identity=?",
                    (agent["destination"], aid + ":" + project),
                ).fetchone()
                current = files.execute(
                    "SELECT hidden FROM hub_archived_projects WHERE agent=? AND project=?",
                    (aid, project),
                ).fetchone()
                if bool(current and current[0]) != hidden:
                    if hidden:
                        store.trash(folder[0])
                    else:
                        store.restore(folder[0])
                files.execute(
                    "INSERT OR REPLACE INTO hub_archived_projects VALUES(?,?,?)",
                    (aid, project, int(hidden)),
                )
            return {"hidden": hidden, "contentRetained": True}

    def grant(self, aid: str, domain: str, root: str, permission: str) -> dict[str, Any]:
        if permission not in {"read", "write"}:
            raise SpaceError("AGENT_PERMISSION_INVALID")
        if domain == "company" and permission == "write" and not self.admin:
            raise SpaceError("AGENT_ADMIN_REQUIRED", 403)
        with self.db() as db:
            agent = self.agent(db, aid)
            if agent["disconnected"]:
                raise SpaceError("AGENT_DISCONNECTED", 403)
            store = self.storage(domain)
            with store._db() as files:
                entry = store._entry(files, root)
                if permission == "read":
                    for prior in db.execute(
                        "SELECT id,root FROM grants WHERE agent=? AND domain=? AND permission='write' AND revoked IS NULL",
                        (aid, domain),
                    ).fetchall():
                        overlaps = False
                        for ancestor, target in [(prior["root"], root), (root, prior["root"])]:
                            try:
                                store._within(files, ancestor, target)
                                overlaps = True
                            except SpaceError:
                                pass
                        if overlaps:
                            db.execute(
                                "UPDATE grants SET revoked=? WHERE id=?", (time.time(), prior["id"])
                            )
                if permission == "write" and entry["kind"] != "folder":
                    raise SpaceError("AGENT_OUTPUT_FOLDER_REQUIRED")
                if permission == "write":
                    # Collected records are immutable archives, including the user's own.
                    protected = [
                        r[0]
                        for r in files.execute(
                            "SELECT entry FROM hub_archive_folders WHERE domain=? AND identity LIKE ?",
                            (
                                domain,
                                "company%"
                                if domain == "company"
                                else "personal:" + str(self.actor) + "%",
                            ),
                        )
                    ]
                    for item in protected:
                        try:
                            store._within(files, item, root)
                        except SpaceError:
                            continue
                        raise SpaceError("AGENT_ARCHIVE_READ_ONLY", 403)
                previous = db.execute(
                    "SELECT id,permission FROM grants WHERE agent=? AND domain=? AND root=? AND revoked IS NULL",
                    (aid, domain, root),
                ).fetchall()
                if len(previous) == 1 and previous[0]["permission"] == permission:
                    gid = previous[0]["id"]
                else:
                    db.execute(
                        "UPDATE grants SET revoked=? WHERE agent=? AND domain=? AND root=? AND revoked IS NULL",
                        (time.time(), aid, domain, root),
                    )
                    gid = uuid.uuid4().hex
                    db.execute(
                        "INSERT INTO grants VALUES(?,?,?,?,?,NULL,?)",
                        (gid, aid, domain, root, permission, time.time()),
                    )
                return {
                    "id": gid,
                    "domain": domain,
                    "root": root,
                    "permission": permission,
                    "name": entry["name"],
                    "kind": entry["kind"],
                }

    def revoke(self, aid: str, gid: str) -> dict[str, Any]:
        with self.db() as db:
            self.agent(db, aid)
            db.execute(
                "UPDATE grants SET revoked=? WHERE id=? AND agent=?", (time.time(), gid, aid)
            )
            return {"revoked": True}

    def migrate_legacy(self, aid: str, kind: str, legacy: str) -> dict[str, Any]:
        with self.db() as db:
            agent = self.agent(db, aid)
            if agent["disconnected"]:
                raise SpaceError("AGENT_DISCONNECTED", 403)
            store = self.storage("personal")
            # Legacy personal data stays personal. Publish new policy and revoke the
            # old credentials under both locks, before either interface can resume.
            with store._db() as files:
                roots = []
                if kind == "link":
                    row = files.execute(
                        "SELECT root FROM agent_links WHERE id=? AND revoked IS NULL", (legacy,)
                    ).fetchone()
                    if not row:
                        raise SpaceError("SPACE_NOT_FOUND", 404)
                    roots.append(row["root"])
                elif kind == "connection":
                    # Initialize legacy tables before opening their shared transaction.
                    old = store
                    row = files.execute(
                        "SELECT space_id FROM space_connections WHERE id=? AND state!='disconnected'",
                        (legacy,),
                    ).fetchone()
                    if not row:
                        raise SpaceError("SPACE_NOT_FOUND", 404)
                    roots.append(old._space(files, row["space_id"])["root"])
                    roots.extend(
                        r[0]
                        for r in files.execute(
                            "SELECT root FROM space_grants WHERE connection=? AND revoked IS NULL",
                            (legacy,),
                        )
                    )
                else:
                    raise SpaceError("AGENT_INPUT_INVALID")
                grants = []
                for root in dict.fromkeys(roots):
                    store._entry(files, root)
                    db.execute(
                        "UPDATE grants SET revoked=? WHERE agent=? AND domain='personal' AND root=? AND revoked IS NULL",
                        (time.time(), aid, root),
                    )
                    gid = uuid.uuid4().hex
                    db.execute(
                        "INSERT INTO grants VALUES(?,?,'personal',?,'read',NULL,?)",
                        (gid, aid, root, time.time()),
                    )
                    grants.append(gid)
                if kind == "link":
                    store.revoke(legacy)
                else:
                    old.connection_action(legacy, "disconnect")
                return {
                    "migrated": True,
                    "permission": "read",
                    "grants": grants,
                    "legacyRevoked": True,
                }

    def _grants(self, db: sqlite3.Connection, aid: str) -> list[dict[str, Any]]:
        result = []
        for row in db.execute(
            "SELECT * FROM grants WHERE agent=? AND revoked IS NULL ORDER BY created,id", (aid,)
        ):
            store = self.storage(row["domain"])
            try:
                with store._db() as files:
                    entry = store._entry(files, row["root"])
                result.append({**dict(row), "name": entry["name"], "kind": entry["kind"]})
            except SpaceError:
                result.append({**dict(row), "name": "资源暂不可用", "unavailable": True})
            if row["domain"] == "company" and row["permission"] == "write" and not self.admin:
                result[-1]["permission"] = "read"
                result[-1]["roleLimited"] = True
        return result

    def invoke(
        self,
        aid: str,
        credential: str,
        body: dict[str, Any],
        *,
        verify: Callable[[sqlite3.Connection], Any] | None = None,
    ) -> Any:
        with self.db() as db:
            agent = self.agent(db, aid)
            if verify is not None:
                verify(db)
            if agent["disconnected"] or not hmac.compare_digest(
                agent["credential"], checksum(credential)
            ):
                raise SpaceError("AGENT_ACCESS_DENIED", 403)
            if body["action"] == "access":
                db.execute("UPDATE agents SET last_seen=? WHERE id=?", (time.time(), aid))
                return {
                    "agent": agent["name"],
                    "grants": self._grants(db, aid),
                    "destructiveOperations": False,
                }
            grant = db.execute(
                "SELECT * FROM grants WHERE id=? AND agent=? AND revoked IS NULL",
                (body.get("grant_id", ""), aid),
            ).fetchone()
            if grant is None:
                raise SpaceError("AGENT_GRANT_DENIED", 403)
            action = body["action"]
            if grant["domain"] == "company" and action in WRITES and not self.admin:
                raise SpaceError("AGENT_ADMIN_REQUIRED", 403)
            if action not in READS and (grant["permission"] != "write" or action not in WRITES):
                raise SpaceError("AGENT_READ_ONLY", 403)
            store = self.storage(grant["domain"])
            with store._db() as files:
                # Normalize private MCP input here. Older deployed SpaceLinks
                # versions expose _execute but not the newer _creation_target.
                target = body.get("target", "")
                parent = body.get("parent")
                if action == "mkdir" and parent is not None:
                    if target and target != parent:
                        raise SpaceError("SPACE_INVALID_DESTINATION")
                    target = parent
                target = target or grant["root"]
                if action in WRITES:
                    for folder in files.execute(
                        "SELECT entry FROM hub_archive_folders WHERE domain=?", (grant["domain"],)
                    ):
                        try:
                            store._within(files, folder[0], target)
                        except SpaceError:
                            continue
                        raise SpaceError("AGENT_ARCHIVE_READ_ONLY", 403)
                try:
                    data = base64.b64decode(body.get("data", ""), validate=True)
                except (binascii.Error, ValueError) as error:
                    raise SpaceError("AGENT_INPUT_INVALID") from error
                result = store._execute(
                    files,
                    grant["id"],
                    grant["root"],
                    action,
                    target,
                    body.get("parent"),
                    body.get("name", ""),
                    body.get("expected"),
                    body.get("upload_id", ""),
                    body.get("size", 0),
                    body.get("offset", 0),
                    body.get("length", 200),
                    body.get("digest", ""),
                    data,
                )
                store._record(files, grant["id"], action, target, agent["name"], "ok")
                if action == "read":
                    content, info = result
                    return {
                        "data": base64.b64encode(content).decode(),
                        "encoding": "base64",
                        "size": len(content),
                        "version": info["version"],
                        "digest": info["digest"],
                        "chunkDigest": checksum(content),
                    }
                return result

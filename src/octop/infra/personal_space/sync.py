"""Identity-scoped task handoffs. Content is data, never executable instructions."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
import uuid
from typing import Any, cast

from .links import SpaceLinks
from .service import SpaceError
from .storage import bind_object

CATEGORIES = ("context", "progress", "outcome", "project_memory", "user_memory")
DEFAULT_SYNC = dict.fromkeys(CATEGORIES, False) | dict.fromkeys(CATEGORIES[:3], True)
SYNC_ACTIONS = {"sync-status", "task-begin", "task-checkpoint", "task-finish", "task-records"}
MUTATIONS = {"mkdir", "move", "trash", "restore", "restore-version", "commit-write"}


def policy_value(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {*CATEGORIES, "project_scope"}:
        raise SpaceError("SPACE_SYNC_POLICY_INVALID")
    if any(type(value.get(k, False)) is not bool for k in CATEGORIES):
        raise SpaceError("SPACE_SYNC_POLICY_INVALID")
    scope = value.get("project_scope", "")
    if not isinstance(scope, str) or len(scope) > 240:
        raise SpaceError("SPACE_SYNC_POLICY_INVALID")
    if value.get("project_memory") and not scope.strip():
        raise SpaceError("SPACE_SYNC_PROJECT_REQUIRED")
    return {k: value.get(k, False) for k in CATEGORIES} | {"project_scope": scope.strip()}


class SpaceSync(SpaceLinks):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        with self._db() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS space_sync_policies (
                    connection TEXT PRIMARY KEY, policy TEXT NOT NULL, revision INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS space_sync_tasks (
                    id TEXT PRIMARY KEY, connection TEXT NOT NULL, space_id TEXT NOT NULL,
                    title TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
                    created REAL NOT NULL, modified REAL NOT NULL, policy_revision INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS space_sync_records (
                    id TEXT PRIMARY KEY, connection TEXT NOT NULL, task TEXT NOT NULL,
                    space_id TEXT NOT NULL, action TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    blob TEXT NOT NULL, size INTEGER NOT NULL, digest TEXT NOT NULL,
                    created REAL NOT NULL, version INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS space_sync_task_records ON space_sync_records(task,version);
                CREATE TABLE IF NOT EXISTS space_sync_uploads (
                    upload TEXT PRIMARY KEY, task TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS space_sync_file_ops (
                    connection TEXT NOT NULL, id TEXT NOT NULL, task TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, result TEXT NOT NULL,
                    PRIMARY KEY(connection,id)
                );
            """)

    def sync_policy(self, connection: str) -> dict[str, Any]:
        with self._db() as db:
            row = db.execute(
                "SELECT * FROM space_sync_policies WHERE connection=?", (connection,)
            ).fetchone()
            return {
                "revision": row["revision"] if row else 0,
                "options": json.loads(row["policy"]) if row else policy_value({}),
                "configured": bool(row),
            }

    def set_sync_policy(
        self, connection: str, value: dict[str, Any], expected: int
    ) -> dict[str, Any]:
        options = policy_value(value)
        with self._db() as db:
            if not db.execute(
                "SELECT 1 FROM space_connections WHERE id=?", (connection,)
            ).fetchone():
                raise SpaceError("SPACE_NOT_FOUND", 404)
            current = self.sync_policy(connection)
            if current["revision"] != expected:
                raise SpaceError("SPACE_SYNC_POLICY_CHANGED", 409)
            db.execute(
                "INSERT OR REPLACE INTO space_sync_policies VALUES(?,?,?)",
                (connection, json.dumps(options), expected + 1),
            )
            return self.sync_policy(connection)

    def _sync_task(self, db: sqlite3.Connection, connection: Any, task_id: str) -> sqlite3.Row:
        row = db.execute(
            "SELECT * FROM space_sync_tasks WHERE id=? AND connection=? AND space_id=?",
            (task_id, connection["id"], connection["space_id"]),
        ).fetchone()
        if row is None:
            raise SpaceError("SPACE_LINK_SCOPE", 403)
        return cast(sqlite3.Row, row)

    def sync_status(self, connection_id: str) -> dict[str, Any]:
        with self._db() as db:
            connection = db.execute(
                "SELECT * FROM space_connections WHERE id=?", (connection_id,)
            ).fetchone()
            if connection is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            tasks = [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM space_sync_tasks WHERE connection=? AND space_id=? ORDER BY modified DESC,id LIMIT 50",
                    (connection_id, connection["space_id"]),
                )
            ]
            for task in tasks:
                last = db.execute(
                    "SELECT * FROM space_sync_records WHERE task=? ORDER BY version DESC LIMIT 1",
                    (task["id"],),
                ).fetchone()
                categories = self._sync_payload(last).get("categories", {}) if last else {}
                task["categories"] = {
                    key: {"status": value["status"], "reason": value.get("reason", "")[:500]}
                    for key, value in categories.items()
                }
                task["record_count"] = db.execute(
                    "SELECT COUNT(*) FROM space_sync_records WHERE task=?", (task["id"],)
                ).fetchone()[0]
            return {
                "policy": self.sync_policy(connection_id),
                "connection_state": connection["state"],
                "tasks": tasks,
                "bytes": db.execute(
                    "SELECT COALESCE(SUM(size),0) FROM space_sync_records WHERE connection=? AND space_id=?",
                    (connection_id, connection["space_id"]),
                ).fetchone()[0],
            }

    def _sync_payload(self, record: Any) -> dict[str, Any]:
        with self._open(record["blob"]) as handle:
            raw = handle.read(262145)
        if len(raw) != record["size"] or hashlib.sha256(raw).hexdigest() != record["digest"]:
            raise SpaceError("SPACE_CHUNK_INVALID", 409)
        result: dict[str, Any] = json.loads(raw)
        return result

    def sync_records(self, connection_id: str, task_id: str, offset: int = 0) -> dict[str, Any]:
        with self._db() as db:
            connection = db.execute(
                "SELECT * FROM space_connections WHERE id=?", (connection_id,)
            ).fetchone()
            if connection is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            task = self._sync_task(db, connection, task_id)
            rows = db.execute(
                "SELECT * FROM space_sync_records WHERE task=? ORDER BY version LIMIT 20 OFFSET ?",
                (task_id, max(0, offset)),
            ).fetchall()
            return {
                "task": dict(task),
                "items": [
                    {k: r[k] for k in ("id", "action", "created", "version", "size", "digest")}
                    | {"content": self._sync_payload(r)}
                    for r in rows
                ],
                "next_offset": offset + len(rows) if len(rows) == 20 else None,
            }

    def delete_sync_task(self, connection_id: str, task_id: str) -> dict[str, Any]:
        with self._db() as db:
            connection = db.execute(
                "SELECT * FROM space_connections WHERE id=?", (connection_id,)
            ).fetchone()
            if connection is None:
                raise SpaceError("SPACE_NOT_FOUND", 404)
            self._sync_task(db, connection, task_id)
            db.execute(
                "INSERT OR IGNORE INTO retired_blobs SELECT blob FROM space_sync_records WHERE task=?",
                (task_id,),
            )
            db.execute("DELETE FROM space_sync_records WHERE task=?", (task_id,))
            db.execute("DELETE FROM space_sync_tasks WHERE id=?", (task_id,))
            db.execute("DELETE FROM space_sync_uploads WHERE task=?", (task_id,))
            db.execute("DELETE FROM space_sync_file_ops WHERE task=?", (task_id,))
        with self._db() as db:
            self._collect(db)
        return {"ok": True}

    def _sync_categories(self, value: Any, policy: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict) or set(value) - set(CATEGORIES):
            raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
        for category, item in value.items():
            if not policy[category]:
                raise SpaceError("SPACE_SYNC_CATEGORY_DISABLED", 403)
            if not isinstance(item, dict) or set(item) - {"status", "summary", "reason", "sources"}:
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
            if not isinstance(item.get("status"), str) or item["status"] not in {
                "provided",
                "empty",
                "unsupported",
                "denied",
            }:
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
            if any(not isinstance(item.get(k, ""), str) for k in ("summary", "reason")):
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
            if item["status"] == "provided" and not item.get("summary", "").strip():
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
            if item["status"] != "provided" and (item.get("summary") or item.get("sources")):
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
            if item["status"] in {"unsupported", "denied"} and not item.get("reason", "").strip():
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
            sources = item.get("sources", [])
            if (
                not isinstance(sources, list)
                or len(sources) > 30
                or any(not isinstance(s, str) or len(s) > 2048 for s in sources)
            ):
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
        return value

    def _sync_execute(
        self, db: sqlite3.Connection, connection: Any, action: str, **args: Any
    ) -> Any:
        if action == "sync-status":
            return self.sync_status(connection["id"])
        if action == "task-records":
            return self.sync_records(
                connection["id"], args.get("task_id", ""), args.get("offset", 0)
            )
        request_id, task_id = args.get("request_id", ""), args.get("task_id", "")
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 100:
            raise SpaceError("SPACE_SYNC_REQUEST_REQUIRED")
        event: dict[str, Any] = {
            "task_id": args.get("task_id", ""),
            "title": args.get("title", ""),
            "policy_revision": args.get("policy_revision"),
            "expected": args.get("expected"),
            "categories": args.get("categories", {}),
            "action": action,
        }
        try:
            serialized = json.dumps(
                event, sort_keys=True, ensure_ascii=False, allow_nan=False
            ).encode()
        except (ValueError, TypeError) as error:
            raise SpaceError("SPACE_SYNC_CONTENT_INVALID") from error
        if len(serialized) > 262144:
            raise SpaceError("SPACE_REQUEST_TOO_LARGE", 413)
        fingerprint = hashlib.sha256(serialized).hexdigest()
        # Acknowledgement loss must replay the original result before checking a now-old version.
        previous = db.execute(
            "SELECT * FROM space_sync_records WHERE id=?", (request_id,)
        ).fetchone()
        if previous:
            if (
                previous["connection"] != connection["id"]
                or previous["space_id"] != connection["space_id"]
            ):
                raise SpaceError("SPACE_LINK_SCOPE", 403)
            if previous["fingerprint"] != fingerprint:
                raise SpaceError("SPACE_SYNC_REQUEST_CONFLICT", 409)
            return {
                "task_id": previous["task"],
                "version": previous["version"],
                "request_id": request_id,
                "saved": True,
            }
        policy = self.sync_policy(connection["id"])
        if event["policy_revision"] != policy["revision"]:
            raise SpaceError("SPACE_SYNC_POLICY_CHANGED", 409)
        if not any(policy["options"][k] for k in CATEGORIES):
            raise SpaceError("SPACE_SYNC_DISABLED", 403)
        categories = self._sync_categories(event["categories"], policy["options"])
        title = event["title"]
        if action == "task-begin":
            if task_id or not isinstance(title, str) or not title.strip() or len(title) > 240:
                raise SpaceError("SPACE_SYNC_CONTENT_INVALID")
            if (
                policy["options"]["context"]
                and categories.get("context", {}).get("status") != "provided"
            ):
                raise SpaceError("SPACE_CONTEXT_REQUIRED", 409)
            task_id, version = uuid.uuid4().hex, 1
            db.execute(
                "INSERT INTO space_sync_tasks VALUES(?,?,?,?,'active',?,?,?,?)",
                (
                    task_id,
                    connection["id"],
                    connection["space_id"],
                    title.strip(),
                    version,
                    time.time(),
                    time.time(),
                    policy["revision"],
                ),
            )
            merged = categories
        else:
            task = self._sync_task(db, connection, task_id)
            if task["state"] != "active" or event["expected"] != task["version"]:
                raise SpaceError("SPACE_VERSION_CONFLICT", 409)
            last = db.execute(
                "SELECT * FROM space_sync_records WHERE task=? ORDER BY version DESC LIMIT 1",
                (task_id,),
            ).fetchone()
            merged = self._sync_payload(last)["categories"] | categories
            if (
                action == "task-finish"
                and policy["options"]["outcome"]
                and categories.get("outcome", {}).get("status") != "provided"
            ):
                raise SpaceError("SPACE_OUTCOME_REQUIRED", 409)
            version = task["version"] + 1
            db.execute(
                "UPDATE space_sync_tasks SET state=?,version=?,modified=?,policy_revision=? WHERE id=?",
                (
                    "finished" if action == "task-finish" else "active",
                    version,
                    time.time(),
                    policy["revision"],
                    task_id,
                ),
            )
        # Full snapshots support resumption; delta is retained for an accurate history.
        payload = json.dumps(
            {
                "categories": merged,
                "submitted": categories,
                "observed_operation": args.get("observed_operation"),
            },
            ensure_ascii=False,
        ).encode()
        if len(payload) > 262144:
            raise SpaceError("SPACE_REQUEST_TOO_LARGE", 413)
        blob, digest = uuid.uuid4().hex, hashlib.sha256(payload).hexdigest()
        bind_object(self, db, blob, connection["space_id"])
        try:
            with self._open(blob, write=True) as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            db.execute(
                "INSERT INTO space_sync_records VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    request_id,
                    connection["id"],
                    task_id,
                    connection["space_id"],
                    action,
                    fingerprint,
                    blob,
                    len(payload),
                    digest,
                    time.time(),
                    version,
                ),
            )
        except BaseException:
            self._object(blob).unlink(missing_ok=True)
            raise
        return {"task_id": task_id, "version": version, "request_id": request_id, "saved": True}

    def _check_sync_file(
        self, db: sqlite3.Connection, connection: Any, action: str, args: dict[str, Any]
    ) -> Any:
        policy = self.sync_policy(connection["id"])
        options = policy["options"]
        if not any(options[k] for k in CATEGORIES):
            return None
        task_id = args.get("task_id", "")
        if not task_id:
            raise SpaceError("SPACE_CONTEXT_REQUIRED", 409)
        task = self._sync_task(db, connection, task_id)
        if args.get("policy_revision") != policy["revision"]:
            raise SpaceError("SPACE_SYNC_POLICY_CHANGED", 409)
        last = db.execute(
            "SELECT * FROM space_sync_records WHERE task=? ORDER BY version DESC LIMIT 1",
            (task_id,),
        ).fetchone()
        categories = self._sync_payload(last)["categories"]
        if options["context"] and categories.get("context", {}).get("status") != "provided":
            raise SpaceError("SPACE_CONTEXT_REQUIRED", 409)
        if task["state"] != "active":
            raise SpaceError("SPACE_SYNC_TASK_FINISHED", 409)
        if (
            action in MUTATIONS
            and options["progress"]
            and not str(args.get("progress", "")).strip()
        ):
            raise SpaceError("SPACE_PROGRESS_REQUIRED", 409)
        upload_id = args.get("upload_id", "")
        if action in {"write-chunk", "commit-write", "write-status", "cancel-write"}:
            bound = db.execute(
                "SELECT task FROM space_sync_uploads WHERE upload=?", (upload_id,)
            ).fetchone()
            if bound is None or bound["task"] != task_id:
                raise SpaceError("SPACE_LINK_SCOPE", 403)
        return task

    def _sync_file_key(self, action: str, args: dict[str, Any]) -> str:
        return str(
            args.get("operation_id")
            or ("file:" + args["upload_id"] if action == "commit-write" else "")
        )

    def _sync_file_fingerprint(self, action: str, args: dict[str, Any]) -> str:
        values = {k: v for k, v in args.items() if k != "data"} | {"action": action}
        return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()

    def _sync_file_replay(
        self, db: sqlite3.Connection, connection: Any, task: Any, action: str, args: dict[str, Any]
    ) -> Any:
        if task is None or action not in MUTATIONS:
            return None
        key = self._sync_file_key(action, args)
        if not key or len(key) > 100:
            raise SpaceError("SPACE_SYNC_REQUEST_REQUIRED")
        row = db.execute(
            "SELECT * FROM space_sync_file_ops WHERE connection=? AND id=?",
            (connection["id"], key),
        ).fetchone()
        if row:
            if row["task"] != task["id"] or row["fingerprint"] != self._sync_file_fingerprint(
                action, args
            ):
                raise SpaceError("SPACE_SYNC_REQUEST_CONFLICT", 409)
            return json.loads(row["result"])
        return None

    def _record_sync_file(
        self,
        db: sqlite3.Connection,
        connection: Any,
        task: Any,
        action: str,
        args: dict[str, Any],
        result: Any,
    ) -> None:
        if task is None:
            return
        if action == "begin-write":
            db.execute(
                "INSERT OR IGNORE INTO space_sync_uploads VALUES(?,?)",
                (args["upload_id"], task["id"]),
            )
        if action not in MUTATIONS:
            return
        key = self._sync_file_key(action, args)
        db.execute(
            "INSERT INTO space_sync_file_ops VALUES(?,?,?,?,?)",
            (
                connection["id"],
                key,
                task["id"],
                self._sync_file_fingerprint(action, args),
                json.dumps(result),
            ),
        )
        if self.sync_policy(connection["id"])["options"]["progress"]:
            self._sync_execute(
                db,
                connection,
                "task-checkpoint",
                task_id=task["id"],
                request_id="op:" + key,
                expected=task["version"],
                policy_revision=args["policy_revision"],
                observed_operation={
                    "action": action,
                    "target": result.get("id", args.get("target", "")),
                    "result": "ok",
                },
                categories={
                    "progress": {
                        "status": "provided",
                        "summary": args["progress"],
                        "sources": ["wanx-operation:" + key],
                    }
                },
            )

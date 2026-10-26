"""Transactional, box-bound team warehouse access for the assistant."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from octop.infra.db.pool import DatabasePool


class KnowledgeAccessConflict(Exception):
    pass


class KnowledgeAccessRepo:
    def __init__(self, db: DatabasePool):
        self.db = db

    @staticmethod
    def decode(row: Any) -> dict[str, Any]:
        return {
            "audience": row["audience"] if row else "none",
            "members": json.loads(row["members_json"]) if row else [],
            "revision": row["revision"] if row else 0,
            "updated_by": row["updated_by"] if row else None,
            "updated_at": row["updated_at"] if row else None,
        }

    def get(self, box: str, warehouse: str) -> dict[str, Any]:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM assistant_knowledge_access WHERE box_id=? AND warehouse_id=?",
                (box, warehouse),
            ).fetchone()
        return self.decode(row)

    def allowed(self, box: str, warehouse: str, user_id: int) -> bool:
        rule = self.get(box, warehouse)
        return bool(
            rule["audience"] == "all"
            or rule["audience"] == "selected"
            and user_id in rule["members"]
        )

    def warehouses(self, box: str, user_id: int) -> list[str]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT warehouse_id,audience,members_json FROM assistant_knowledge_access "
                "WHERE box_id=? ORDER BY warehouse_id",
                (box,),
            ).fetchall()
        return [
            r["warehouse_id"]
            for r in rows
            if r["audience"] == "all"
            or r["audience"] == "selected"
            and user_id in json.loads(r["members_json"])
        ]

    def set(
        self, box: str, warehouse: str, actor: int, audience: str, members: list[int], revision: int
    ) -> dict[str, Any]:
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM assistant_knowledge_access WHERE box_id=? AND warehouse_id=?",
                (box, warehouse),
            ).fetchone()
            before = self.decode(row)
            if revision != before["revision"]:
                raise KnowledgeAccessConflict()
            now = int(time.time())
            result = conn.execute(
                "INSERT INTO assistant_knowledge_access "
                "(box_id,warehouse_id,audience,members_json,revision,updated_by,updated_at) "
                "VALUES (?,?,?,?,?,?,?) ON CONFLICT(box_id,warehouse_id) DO UPDATE SET "
                "audience=excluded.audience,members_json=excluded.members_json,"
                "revision=excluded.revision,updated_by=excluded.updated_by,updated_at=excluded.updated_at "
                "WHERE assistant_knowledge_access.revision=?",
                (box, warehouse, audience, json.dumps(members), revision + 1, actor, now, revision),
            )
            if result.rowcount != 1:
                raise KnowledgeAccessConflict()
            after = {
                "audience": audience,
                "members": members,
                "revision": revision + 1,
                "updated_by": actor,
                "updated_at": now,
            }
            conn.execute(
                "INSERT INTO assistant_knowledge_access_audit VALUES (?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex,
                    box,
                    warehouse,
                    actor,
                    json.dumps(before),
                    json.dumps(after),
                    now,
                ),
            )
        return after

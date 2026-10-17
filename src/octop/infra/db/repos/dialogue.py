"""Account/application-scoped dialogue snapshots; SQL only."""

from __future__ import annotations

import json
import time
from typing import Any

from octop.infra.db.pool import DatabasePool


class DialogueRepo:
    def __init__(self, db: DatabasePool) -> None:
        self.db = db

    def get(self, owner: tuple[int, str], session_id: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT payload FROM dialogue_sessions WHERE user_id=? AND application_id=? AND session_id=?",
                (*owner, session_id),
            ).fetchone()
        return json.loads(row["payload"]) if row else None

    def list(self, owner: tuple[int, str]) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT session_id, title, updated_at FROM dialogue_sessions "
                "WHERE user_id=? AND application_id=? ORDER BY updated_at DESC LIMIT 200",
                owner,
            ).fetchall()
        return [dict(row) for row in rows]

    def save(self, owner: tuple[int, str], data: dict[str, Any]) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO dialogue_sessions(session_id,user_id,application_id,title,payload,updated_at) "
                "VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET "
                "payload=excluded.payload, updated_at=excluded.updated_at "
                "WHERE dialogue_sessions.user_id=excluded.user_id "
                "AND dialogue_sessions.application_id=excluded.application_id",
                (
                    data["id"],
                    *owner,
                    data["title"],
                    json.dumps(data, ensure_ascii=False),
                    int(time.time()),
                ),
            )

    def delete(self, owner: tuple[int, str], session_id: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "DELETE FROM dialogue_sessions WHERE user_id=? AND application_id=? AND session_id=?",
                (*owner, session_id),
            )

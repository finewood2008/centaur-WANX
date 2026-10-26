"""SQL-only association of company applications with a local team epoch."""

from __future__ import annotations

from typing import Any

from octop.infra.db.pool import DatabasePool


class TeamApplicationRepo:
    def __init__(self, db: DatabasePool) -> None:
        self._db = db

    def get(self, application_id: str) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM team_applications WHERE application_id = ?", (application_id,)
            ).fetchone()
        return dict(row) if row is not None else None

    def list_for_scope(self, box_id: str, ownership_epoch: int) -> list[dict[str, Any]]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM team_applications WHERE box_id = ? AND ownership_epoch = ? "
                "ORDER BY application_id",
                (box_id, ownership_epoch),
            ).fetchall()
        return [dict(row) for row in rows]

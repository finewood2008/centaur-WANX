"""SQL-only explicit native publication records. ACL lives in the box authority."""

from __future__ import annotations

from typing import Any

from octop.infra.db.repos._base import now_ts


class LocalTeamResourceRepo:
    def __init__(self, db: Any) -> None:
        self._db = db

    def get(self, box_id: str, epoch: int, resource_id: str) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM local_team_resources WHERE box_id=? AND ownership_epoch=? AND resource_id=?",
                (box_id, epoch, resource_id),
            ).fetchone()
            return dict(row) if row else None

    def list(self, box_id: str, epoch: int) -> list[dict[str, Any]]:
        with self._db.connect() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM local_team_resources WHERE box_id=? AND ownership_epoch=? ORDER BY resource_id",
                    (box_id, epoch),
                )
            ]

    def publish(
        self,
        *,
        box_id: str,
        epoch: int,
        resource_id: str,
        kind: str,
        object_id: str,
        owner_user_id: int,
        before_commit: Any,
    ) -> dict[str, Any]:
        with self._db.transaction() as conn:
            if kind in {"agent", "knowledge"}:
                table, key, owner = (
                    ("agents", "agent_id", "user_id")
                    if kind == "agent"
                    else ("knowledge_bases", "knowledge_base_id", "owner_user_id")
                )
                row = conn.execute(
                    f"SELECT {owner},application_id FROM {table} WHERE {key}=?", (object_id,)
                ).fetchone()
                if row is None or row[owner] != owner_user_id or row["application_id"] != "wanx":
                    raise ValueError("resource owner mismatch")
            existing = conn.execute(
                "SELECT * FROM local_team_resources WHERE kind=? AND object_id=?", (kind, object_id)
            ).fetchone()
            if existing and any(
                existing[name] != value
                for name, value in {
                    "box_id": box_id,
                    "ownership_epoch": epoch,
                    "resource_id": resource_id,
                    "owner_user_id": owner_user_id,
                }.items()
            ):
                raise ValueError("resource already belongs to another scope")
            if existing is None:
                conn.execute(
                    "INSERT INTO local_team_resources VALUES (?,?,?,?,?,?,?)",
                    (box_id, epoch, resource_id, kind, object_id, owner_user_id, now_ts()),
                )
            before_commit()
        result = self.get(box_id, epoch, resource_id)
        assert result is not None
        return result

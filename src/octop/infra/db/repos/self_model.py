"""Transactional storage for versioned, human-calibrated personal claims."""

from __future__ import annotations

import builtins
import json
from datetime import UTC, datetime
from typing import Any

from octop.infra.db.pool import DatabasePool
from octop.infra.utils.ulid import new_ulid


def now() -> str:
    return datetime.now(UTC).isoformat()


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class VersionConflict(Exception):
    """The user reviewed an outdated version."""


class SelfModelRepo:
    def __init__(self, db: DatabasePool) -> None:
        self.db = db

    def settings(self, aid: str, uid: int) -> dict[str, Any]:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT enabled, version FROM self_model_settings WHERE agent_id=? AND subject_user_id=?",
                (aid, uid),
            ).fetchone()
        return (
            {"enabled": bool(row[0]), "version": row[1], "guarded": True}
            if row
            else {"enabled": False, "version": 0, "guarded": False}
        )

    def guarded(self, aid: str) -> bool:
        with self.db.connect() as conn:
            return (
                conn.execute(
                    "SELECT 1 FROM self_model_settings WHERE agent_id=?", (aid,)
                ).fetchone()
                is not None
            )

    def enable(self, aid: str, uid: int, enabled: bool, version: int) -> dict[str, Any]:
        with self.db.transaction() as conn:
            if version == 0:
                count = conn.execute(
                    "INSERT INTO self_model_settings VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING",
                    (aid, uid, int(enabled)),
                ).rowcount
            else:
                count = conn.execute(
                    "UPDATE self_model_settings SET enabled=?, version=version+1 WHERE agent_id=? AND subject_user_id=? AND version=?",
                    (int(enabled), aid, uid, version),
                ).rowcount
            if count != 1:
                raise VersionConflict
            self._audit(
                conn, aid, uid, None, "enable" if enabled else "disable", {"version": version + 1}
            )
        return self.settings(aid, uid)

    def list(self, aid: str, uid: int) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT document FROM self_model_claims WHERE agent_id=? AND subject_user_id=? ORDER BY id",
                (aid, uid),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def get(self, aid: str, uid: int, cid: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT document FROM self_model_claims WHERE id=? AND agent_id=? AND subject_user_id=?",
                (cid, aid, uid),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def insert(self, aid: str, uid: int, fingerprint: str, doc: dict[str, Any]) -> bool:
        doc = {
            **doc,
            "id": new_ulid(),
            "version": 1,
            "state": "candidate",
            "rating": None,
            "calibrated_version": None,
            "deferred": False,
            "created_at": now(),
            "updated_at": now(),
        }
        with self.db.transaction() as conn:
            count = conn.execute(
                "INSERT INTO self_model_claims VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                (doc["id"], aid, uid, fingerprint, 1, encode(doc)),
            ).rowcount
            if not count:
                return False
            for evidence in doc["evidence"]:
                conn.execute(
                    "INSERT INTO self_model_evidence VALUES (?, ?, ?)",
                    (doc["id"], evidence["event_id"], encode(evidence)),
                )
            self._audit(conn, aid, uid, doc["id"], "candidate", doc)
        return True

    def revise(
        self, aid: str, uid: int, cid: str, version: int, doc: dict[str, Any], action: str
    ) -> dict[str, Any]:
        updated = {**doc, "version": version + 1, "updated_at": now()}
        with self.db.transaction() as conn:
            old = conn.execute(
                "SELECT document FROM self_model_claims WHERE id=? AND agent_id=? AND subject_user_id=? AND version=?",
                (cid, aid, uid, version),
            ).fetchone()
            if old is None:
                raise VersionConflict
            count = conn.execute(
                "UPDATE self_model_claims SET version=?, document=? WHERE id=? AND agent_id=? AND subject_user_id=? AND version=?",
                (version + 1, encode(updated), cid, aid, uid, version),
            ).rowcount
            if count != 1:
                raise VersionConflict
            self._audit(
                conn, aid, uid, cid, action, {"before": json.loads(old[0]), "after": updated}
            )
        return updated

    def source_hash(self, aid: str, uid: int, sid: str) -> str | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT fingerprint FROM self_model_sources WHERE agent_id=? AND subject_user_id=? AND source_id=?",
                (aid, uid, sid),
            ).fetchone()
        return str(row[0]) if row else None

    def mark_source(self, aid: str, uid: int, sid: str, fingerprint: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO self_model_sources VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, subject_user_id, source_id) DO UPDATE SET fingerprint=excluded.fingerprint",
                (aid, uid, sid, fingerprint),
            )

    def save_job(self, aid: str, uid: int, doc: dict[str, Any]) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO self_model_jobs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
                (doc["id"], aid, uid, encode(doc)),
            )

    def job(self, aid: str, uid: int, jid: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT document FROM self_model_jobs WHERE id=? AND agent_id=? AND subject_user_id=?",
                (jid, aid, uid),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def latest_job(self, aid: str, uid: int) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT document FROM self_model_jobs WHERE agent_id=? AND subject_user_id=? ORDER BY id DESC LIMIT 1",
                (aid, uid),
            ).fetchone()
        return json.loads(row[0]) if row else None

    def history_cutoff(self, aid: str) -> float:
        """Governance changes invalidate older model-facing conversation summaries."""
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT MAX(created_at) FROM self_model_events WHERE agent_id=? AND action NOT IN ('candidate', 'reflection')",
                (aid,),
            ).fetchone()
        return datetime.fromisoformat(row[0]).timestamp() * 1000 if row and row[0] else 0.0

    def retired_text(self, aid: str, uid: int) -> builtins.list[str]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT document FROM self_model_events WHERE agent_id=? AND subject_user_id=?",
                (aid, uid),
            ).fetchall()
        result = []
        for row in rows:
            event = json.loads(row[0])
            before, after = event.get("before"), event.get("after")
            if (
                before
                and after
                and (
                    before["content"] != after["content"]
                    or after["state"] in {"retracted", "rejected", "superseded"}
                )
            ):
                result.append(before["content"])
                result.extend(e["quote"] for e in before["evidence"])
        return result

    def _audit(
        self, conn: Any, aid: str, uid: int, cid: str | None, action: str, doc: dict[str, Any]
    ) -> None:
        conn.execute(
            "INSERT INTO self_model_events VALUES (?, ?, ?, ?, ?, ?, ?)",
            (new_ulid(), aid, uid, cid, action, encode(doc), now()),
        )

    def save_reflection(self, aid: str, uid: int, doc: dict[str, Any]) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO self_model_events VALUES (?, ?, ?, NULL, 'reflection', ?, ?)",
                (doc["id"], aid, uid, encode(doc), now()),
            )

    def reflections(self, aid: str, uid: int, limit: int = 8) -> builtins.list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT document FROM self_model_events WHERE agent_id=? AND subject_user_id=? AND action='reflection' ORDER BY id DESC LIMIT ?",
                (aid, uid, limit),
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def reflection(self, aid: str, uid: int, rid: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT document FROM self_model_events WHERE id=? AND agent_id=? AND subject_user_id=? AND action='reflection'",
                (rid, aid, uid),
            ).fetchone()
        return json.loads(row[0]) if row else None

"""SQL-only persistence, immutable versions and atomic round claims."""

from __future__ import annotations

import builtins
import json
from typing import Any

from octop.infra.db.pool import DatabasePool
from octop.infra.db.repos._base import now_ts


def _loop(row: Any) -> dict[str, Any]:
    return {
        k: row[k]
        for k in list(row.keys())
        if k not in {"id", "agent_id", "definition_json", "progress_json"}
    } | {
        "definition": json.loads(row["definition_json"]),
        "progress": json.loads(row["progress_json"]),
    }


def _round(row: Any) -> dict[str, Any]:
    return {
        k: row[k] for k in list(row.keys()) if k not in {"id", "result_json", "pending_json"}
    } | {
        "trial": bool(row["trial"]),
        "result": json.loads(row["result_json"]),
        "pending": json.loads(row["pending_json"]) if row["pending_json"] else None,
    }


class LoopRepo:
    def __init__(self, db: DatabasePool):
        self._db = db

    def get(self, loop_id: str) -> dict[str, Any] | None:
        with self._db.connect() as c:
            r = c.execute("SELECT * FROM loops WHERE loop_id = ?", (loop_id,)).fetchone()
        return _loop(r) if r else None

    def list(self, user_id: int | None = None) -> builtins.list[dict[str, Any]]:
        with self._db.connect() as c:
            rows = c.execute(
                "SELECT * FROM loops"
                + (" WHERE user_id = ?" if user_id is not None else "")
                + " ORDER BY created_at DESC",
                (user_id,) if user_id is not None else (),
            ).fetchall()
        return [_loop(r) for r in rows]

    def overview(self, user_id: int) -> builtins.list[dict[str, Any]]:
        with self._db.connect() as c:
            rows = c.execute(
                "SELECT r.*, l.definition_json FROM loop_rounds r "
                "JOIN loops l ON l.loop_id=r.loop_id "
                "JOIN agents a ON a.agent_id=l.agent_id "
                "JOIN users u ON u.id=l.user_id "
                "WHERE l.user_id=? AND l.status!='deleted' AND a.user_id=l.user_id "
                "AND a.enabled=1 AND a.application_id='wanx' AND u.disabled=0 "
                "AND r.status='ok' AND r.finished_at IS NOT NULL "
                "ORDER BY r.finished_at DESC, r.id DESC LIMIT 5",
                (user_id,),
            ).fetchall()
        return [_round(row) | {"name": json.loads(row["definition_json"])["name"]} for row in rows]

    def round_by_id(self, loop_id: str, round_id: str) -> dict[str, Any] | None:
        with self._db.connect() as c:
            row = c.execute(
                "SELECT * FROM loop_rounds WHERE loop_id=? AND round_id=?", (loop_id, round_id)
            ).fetchone()
        return _round(row) if row else None

    def managing(self, cron_id: str) -> str | None:
        with self._db.connect() as c:
            r = c.execute(
                "SELECT loop_id FROM loops WHERE source_cron_id = ?", (cron_id,)
            ).fetchone()
        return str(r["loop_id"]) if r else None

    def tested_version(self, loop_id: str, version: int) -> bool:
        with self._db.connect() as c:
            return (
                c.execute(
                    "SELECT 1 FROM loop_rounds WHERE loop_id=? AND version=? AND trial=1 AND status='ok' LIMIT 1",
                    (loop_id, version),
                ).fetchone()
                is not None
            )

    def create(self, loop_id: str, user_id: int, definition: dict[str, Any]) -> None:
        ts, body = now_ts(), json.dumps(definition, ensure_ascii=False)
        with self._db.transaction() as c:
            source = definition.get("source_cron_id")
            if source:
                row = c.execute("SELECT * FROM cron_jobs WHERE cron_id = ?", (source,)).fetchone()
                if (
                    not row
                    or row["agent_id"] != definition["agent_id"]
                    or row["user_id"] != user_id
                    or row["task_type"] != "agent"
                ):
                    raise ValueError("source task is unavailable")
                if c.execute(
                    "SELECT loop_id FROM loops WHERE source_cron_id = ?", (source,)
                ).fetchone():
                    raise ValueError("source task is already managed")
                c.execute("UPDATE cron_jobs SET enabled = 0 WHERE cron_id = ?", (source,))
            c.execute(
                "INSERT INTO loops(loop_id,user_id,agent_id,source_cron_id,definition_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                (loop_id, user_id, definition["agent_id"], source, body, ts, ts),
            )
            c.execute("INSERT INTO loop_versions VALUES(?,?,?,?)", (loop_id, 1, body, ts))
            c.execute("INSERT INTO loop_controls(loop_id) VALUES(?)", (loop_id,))

    def revise(self, loop_id: str, definition: dict[str, Any]) -> None:
        body, ts = json.dumps(definition, ensure_ascii=False), now_ts()
        with self._db.transaction() as c:
            locked = c.execute(
                "UPDATE loops SET updated_at=updated_at WHERE loop_id=? AND status IN ('draft','paused')",
                (loop_id,),
            ).rowcount
            if not locked:
                raise ValueError("pause before revising")
            row = c.execute("SELECT * FROM loops WHERE loop_id = ?", (loop_id,)).fetchone()
            if (
                not row
                or row["status"] not in {"draft", "paused"}
                or row["reason"] == "execution_unknown"
            ):
                raise ValueError("pause before revising")
            if c.execute(
                "SELECT 1 FROM loop_judgments WHERE loop_id=? AND status='pending'", (loop_id,)
            ).fetchone():
                raise ValueError("a human judgment must be resolved first")
            if c.execute(
                "SELECT round_id FROM loop_rounds WHERE loop_id = ? AND status IN ('running','awaiting_approval')",
                (loop_id,),
            ).fetchone():
                raise ValueError("an unfinished round must be resolved first")
            version = row["version"] + 1
            c.execute("INSERT INTO loop_versions VALUES(?,?,?,?)", (loop_id, version, body, ts))
            c.execute(
                "UPDATE loops SET version=?,definition_json=?,reason=NULL,failures=0,updated_at=? WHERE loop_id=?",
                (version, body, ts, loop_id),
            )
            c.execute(
                "INSERT INTO loop_controls(loop_id) VALUES(?) ON CONFLICT(loop_id) DO NOTHING",
                (loop_id,),
            )
            c.execute(
                "UPDATE loop_controls SET checkpoint_index=0 WHERE loop_id=?",
                (loop_id,),
            )

    def update(self, loop_id: str, **fields: Any) -> None:
        allowed = {
            "status",
            "reason",
            "next_run_at",
            "thread_id",
            "failures",
            "round_count",
            "enabled",
            "source_cron_id",
        }
        if "progress" in fields:
            fields["progress_json"] = json.dumps(fields.pop("progress"), ensure_ascii=False)
            allowed.add("progress_json")
        if not fields.keys() <= allowed:
            raise ValueError("invalid loop field")
        fields["updated_at"] = now_ts()
        with self._db.connect() as c:
            c.execute(
                "UPDATE loops SET "
                + ",".join(f"{k}=?" for k in fields)
                + " WHERE loop_id=? AND status!='deleted'",
                (*fields.values(), loop_id),
            )

    def claim(self, loop_id: str, round_id: str, *, trial: bool) -> dict[str, Any] | None:
        with self._db.transaction() as c:
            statuses = "('draft','paused')" if trial else "('scheduled')"
            # Conditional UPDATE serializes claims on PostgreSQL as well as SQLite.
            changed = c.execute(
                "UPDATE loops SET status='running',next_run_at=NULL,round_count=round_count+?,updated_at=? "
                "WHERE loop_id=? AND status IN "
                + statuses
                + " AND (reason IS NULL OR reason != 'execution_unknown') AND NOT EXISTS (SELECT 1 FROM loop_rounds WHERE loop_id=? AND status IN ('running','awaiting_approval')) AND NOT EXISTS (SELECT 1 FROM loop_judgments WHERE loop_id=? AND status='pending')",
                (0 if trial else 1, now_ts(), loop_id, loop_id, loop_id),
            ).rowcount
            if not changed:
                return None
            row = c.execute("SELECT * FROM loops WHERE loop_id=?", (loop_id,)).fetchone()
            c.execute(
                "INSERT INTO loop_rounds(round_id,loop_id,version,number,status,trial,started_at) VALUES(?,?,?,?,?,?,?)",
                (
                    round_id,
                    loop_id,
                    row["version"],
                    row["round_count"],
                    "running",
                    int(trial),
                    now_ts(),
                ),
            )
        return self.get(loop_id)

    def resume_claim(
        self,
        loop_id: str,
        round_id: str,
        checkpoint_id: str = "",
        decisions: builtins.list[dict[str, Any]] | None = None,
    ) -> bool:
        with self._db.transaction() as c:
            c.execute("UPDATE loops SET updated_at=updated_at WHERE loop_id=?", (loop_id,))
            c.execute(
                "UPDATE loop_rounds SET pending_json=pending_json WHERE round_id=?", (round_id,)
            )
            native = c.execute(
                "SELECT pending_json,result_json FROM loop_rounds WHERE round_id=? AND loop_id=? AND status='awaiting_approval'",
                (round_id, loop_id),
            ).fetchone()
            if not native or not native["pending_json"]:
                return False
            pending = json.loads(native["pending_json"])
            if (
                not decisions
                or pending["checkpoint_id"] != checkpoint_id
                or pending.get("expires_at", float("inf")) <= now_ts()
            ):
                return False
            if any(
                int(i) >= len(decisions) or decisions[int(i)] != saved
                for i, saved in pending.get("collected", {}).items()
            ):
                return False
            changed = c.execute(
                "UPDATE loops SET status='running',reason=NULL WHERE loop_id=? AND status='awaiting_approval' "
                "AND EXISTS (SELECT 1 FROM loop_rounds WHERE loop_rounds.loop_id=loops.loop_id AND loop_rounds.version=loops.version AND loop_rounds.round_id=? AND loop_rounds.status='awaiting_approval')",
                (loop_id, round_id),
            ).rowcount
            if changed:
                result = json.loads(native["result_json"])
                owner = c.execute(
                    "SELECT user_id FROM loops WHERE loop_id=?", (loop_id,)
                ).fetchone()
                result.setdefault("approvals", []).append(
                    {
                        "checkpoint_id": checkpoint_id,
                        "decisions": decisions,
                        "user_id": owner["user_id"],
                        "at": now_ts(),
                    }
                )
                c.execute(
                    "UPDATE loop_rounds SET status='running',pending_json=NULL,result_json=? WHERE round_id=? AND loop_id=?",
                    (json.dumps(result, ensure_ascii=False), round_id, loop_id),
                )
        return bool(changed)

    def rounds(
        self, loop_id: str, limit: int = 100, before: str | None = None
    ) -> builtins.list[dict[str, Any]]:
        with self._db.connect() as c:
            rows = c.execute(
                "SELECT * FROM loop_rounds WHERE loop_id=?"
                + (
                    " AND id<(SELECT id FROM loop_rounds WHERE round_id=? AND loop_id=?)"
                    if before
                    else ""
                )
                + " ORDER BY id DESC LIMIT ?",
                (loop_id, before, loop_id, limit) if before else (loop_id, limit),
            ).fetchall()
        return [_round(r) for r in rows]

    def record_tools(self, round_id: str, events: builtins.list[dict[str, Any]]) -> None:
        with self._db.transaction() as c:
            c.execute(
                "UPDATE loop_rounds SET result_json=result_json WHERE round_id=? AND status='running'",
                (round_id,),
            )
            row = c.execute(
                "SELECT result_json FROM loop_rounds WHERE round_id=? AND status='running'",
                (round_id,),
            ).fetchone()
            if not row:
                return
            result = json.loads(row["result_json"])
            result["tools"] = events
            c.execute(
                "UPDATE loop_rounds SET result_json=? WHERE round_id=?",
                (json.dumps(result, ensure_ascii=False), round_id),
            )

    def finish_round(
        self,
        round_id: str,
        status: str,
        result: dict[str, Any],
        pending: dict[str, Any] | None = None,
        *,
        delivery: dict[str, Any] | None = None,
    ) -> None:
        with self._db.transaction() as c:
            c.execute(
                "UPDATE loop_rounds SET status=?,result_json=?,pending_json=?,finished_at=? WHERE round_id=?",
                (
                    status,
                    json.dumps(result, ensure_ascii=False),
                    json.dumps(pending, ensure_ascii=False) if pending else None,
                    None if status in {"running", "awaiting_approval"} else now_ts(),
                    round_id,
                ),
            )

            if delivery is not None:
                c.execute(
                    "INSERT INTO loop_notifications(notification_id,loop_id,binding_id,event_key,message,reference_json,next_at,created_at) SELECT ?,r.loop_id,?,?,?,?,?,? FROM loop_rounds r JOIN loops l ON l.loop_id=r.loop_id WHERE r.round_id=? AND r.version=l.version AND l.status='running' ON CONFLICT(event_key) DO NOTHING",
                    (
                        "delivery-" + round_id,
                        delivery["binding_id"],
                        "delivery:" + round_id,
                        delivery["message"],
                        json.dumps({"delivery_round": round_id}),
                        now_ts(),
                        now_ts(),
                        round_id,
                    ),
                )

    def controls(self, lid: str) -> dict[str, Any]:
        with self._db.connect() as c:
            row = c.execute("SELECT * FROM loop_controls WHERE loop_id=?", (lid,)).fetchone()
        return (
            dict(row) if row else {"checkpoint_index": 0, "review_rounds": 0, "review_seconds": 0}
        )

    def add_budget(self, lid: str, seconds: float, *, completed: bool = True) -> dict[str, Any]:
        with self._db.transaction() as c:
            c.execute(
                "INSERT INTO loop_controls(loop_id) VALUES(?) ON CONFLICT(loop_id) DO NOTHING",
                (lid,),
            )
            c.execute(
                "UPDATE loop_controls SET review_rounds=review_rounds+?,review_seconds=review_seconds+? WHERE loop_id=?",
                (int(completed), seconds, lid),
            )
        return self.controls(lid)

    def judgments(self, lid: str) -> builtins.list[dict[str, Any]]:
        with self._db.connect() as c:
            rows = c.execute(
                "SELECT * FROM loop_judgments WHERE loop_id=? ORDER BY id DESC", (lid,)
            ).fetchall()
        return [
            dict(r)
            | {
                "code": "H" + str(r["id"]),
                "payload": json.loads(r["payload_json"]),
                "decision": json.loads(r["decision_json"]) if r["decision_json"] else None,
            }
            for r in rows
        ]

    def open_judgment(
        self, lid: str, jid: str, rid: str, kind: str, payload: dict[str, Any]
    ) -> bool:
        with self._db.transaction() as c:
            changed = c.execute(
                "UPDATE loops SET status='awaiting_judgment',reason='human_judgment',next_run_at=NULL,updated_at=? WHERE loop_id=? AND status IN ('running','paused','scheduled') AND EXISTS (SELECT 1 FROM loop_rounds WHERE round_id=? AND loop_rounds.loop_id=loops.loop_id AND loop_rounds.version=loops.version) AND NOT EXISTS (SELECT 1 FROM loop_judgments WHERE loop_id=? AND status='pending')",
                (now_ts(), lid, rid, lid),
            ).rowcount
            if not changed:
                return False
            row = c.execute("SELECT version FROM loops WHERE loop_id=?", (lid,)).fetchone()
            progress = {k: payload.get(k, "") for k in ("summary", "next_action", "question")}
            c.execute(
                "UPDATE loops SET progress_json=?, failures=CASE WHEN ?=1 THEN failures ELSE 0 END WHERE loop_id=?",
                (json.dumps(progress, ensure_ascii=False), int("execution_error" in payload), lid),
            )
            c.execute(
                "INSERT INTO loop_judgments(judgment_id,loop_id,version,round_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
                (
                    jid,
                    lid,
                    row["version"],
                    rid,
                    kind,
                    json.dumps(payload, ensure_ascii=False),
                    now_ts(),
                ),
            )
        return True

    def decide_judgment(
        self, lid: str, uid: int, jid: str, action: str, feedback: str, next_at: int | None
    ) -> bool:
        with self._db.transaction() as c:
            changed = c.execute(
                "UPDATE loops SET status=?,enabled=?,next_run_at=?,reason=?,updated_at=? WHERE loop_id=? AND user_id=? AND status='awaiting_judgment' AND EXISTS (SELECT 1 FROM loop_judgments WHERE loop_judgments.loop_id=loops.loop_id AND loop_judgments.version=loops.version AND judgment_id=? AND status='pending')",
                (
                    "completed" if action == "complete" else "scheduled" if next_at else "paused",
                    0 if action == "complete" or next_at is None else 1,
                    None if action == "complete" else next_at,
                    "user_accepted"
                    if action == "complete"
                    else "human_continue"
                    if next_at
                    else "round_limit",
                    now_ts(),
                    lid,
                    uid,
                    jid,
                ),
            ).rowcount
            if not changed:
                return False
            row = c.execute(
                "SELECT kind FROM loop_judgments WHERE judgment_id=?", (jid,)
            ).fetchone()
            c.execute(
                "UPDATE loop_judgments SET status='resolved',decision_json=?,resolved_at=? WHERE judgment_id=?",
                (
                    json.dumps(
                        {"action": action, "feedback": feedback, "user_id": uid}, ensure_ascii=False
                    ),
                    now_ts(),
                    jid,
                ),
            )
            c.execute(
                "UPDATE loop_controls SET checkpoint_index=checkpoint_index+?,review_rounds=0,review_seconds=0 WHERE loop_id=?",
                (int(action == "continue" and row["kind"] == "stage"), lid),
            )
            loop = c.execute("SELECT progress_json FROM loops WHERE loop_id=?", (lid,)).fetchone()
            progress = json.loads(loop["progress_json"])
            progress.update(feedback=feedback, human_decision=action)
            c.execute(
                "UPDATE loops SET progress_json=? WHERE loop_id=?",
                (json.dumps(progress, ensure_ascii=False), lid),
            )
        return True

    def cancel_judgments(self, lid: str) -> None:
        with self._db.connect() as c:
            c.execute(
                "UPDATE loop_judgments SET status='cancelled',resolved_at=? WHERE loop_id=? AND status='pending'",
                (now_ts(), lid),
            )

    def binding_create(self, data: dict[str, Any]) -> None:
        with self._db.transaction() as c:
            c.execute(
                "UPDATE loop_channel_bindings SET status='revoked' WHERE user_id=? AND channel_id=? AND status IN ('awaiting_message','awaiting_confirmation')",
                (data["user_id"], data["channel_id"]),
            )
            c.execute(
                "INSERT INTO loop_channel_bindings(binding_id,user_id,agent_id,channel_id,fingerprint,challenge_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
                tuple(
                    data[k]
                    for k in (
                        "binding_id",
                        "user_id",
                        "agent_id",
                        "channel_id",
                        "fingerprint",
                        "challenge_hash",
                        "expires_at",
                        "created_at",
                    )
                ),
            )

    def bindings(self, uid: int | None = None) -> builtins.list[dict[str, Any]]:
        with self._db.connect() as c:
            rows = c.execute(
                "SELECT * FROM loop_channel_bindings"
                + (" WHERE user_id=?" if uid is not None else ""),
                (uid,) if uid is not None else (),
            ).fetchall()
        return [dict(r) for r in rows]

    def binding_refresh_transport(self, bid: str, uid: int, fingerprint: str) -> None:
        with self._db.transaction() as c:
            changed = c.execute(
                "UPDATE loop_channel_bindings SET status='active',fingerprint=?,routing_json='{}' WHERE binding_id=? AND user_id=? AND status IN ('active','invalid') AND confirmed_at IS NOT NULL",
                (fingerprint, bid, uid),
            ).rowcount
            if changed:
                c.execute(
                    "UPDATE loop_channel_bindings SET status='revoked' WHERE user_id=? AND channel_id=(SELECT channel_id FROM loop_channel_bindings WHERE binding_id=?) AND status IN ('awaiting_message','awaiting_confirmation')",
                    (uid, bid),
                )

    def binding_reuse(
        self, bid: str, uid: int, aid: str, cid: str, fingerprint: str, source_id: str
    ) -> bool:
        with self._db.transaction() as c:
            changed = c.execute(
                "INSERT INTO loop_channel_bindings(binding_id,user_id,agent_id,channel_id,fingerprint,challenge_hash,expires_at,created_at,confirmed_at,status,subject_id,display_name,routing_json) SELECT ?,user_id,?,?,?,'',0,?,?,'active',subject_id,display_name,'{}' FROM loop_channel_bindings WHERE binding_id=? AND user_id=? AND status='active' AND subject_id IS NOT NULL",
                (bid, aid, cid, fingerprint, now_ts(), now_ts(), source_id, uid),
            ).rowcount
            if changed:
                c.execute(
                    "UPDATE loop_channel_bindings SET status='revoked' WHERE user_id=? AND channel_id=? AND status IN ('awaiting_message','awaiting_confirmation')",
                    (uid, cid),
                )
            return bool(changed)

    def binding_receive(
        self, bid: str, subject: str, name: str, routing: dict[str, Any], activate: bool = False
    ) -> bool:
        with self._db.transaction() as c:
            c.execute(
                "UPDATE channels SET enabled=enabled WHERE channel_id=(SELECT channel_id FROM loop_channel_bindings WHERE binding_id=?)",
                (bid,),
            )
            changed = c.execute(
                "UPDATE loop_channel_bindings SET status=?,confirmed_at=?,subject_id=?,display_name=?,routing_json=? WHERE binding_id=? AND status='awaiting_message' AND expires_at>?",
                (
                    "active" if activate else "awaiting_confirmation",
                    now_ts() if activate else None,
                    subject,
                    name,
                    json.dumps(routing, ensure_ascii=False),
                    bid,
                    now_ts(),
                ),
            ).rowcount
            if changed and activate:
                c.execute(
                    "UPDATE loop_channel_bindings SET status='revoked' WHERE channel_id=(SELECT channel_id FROM loop_channel_bindings WHERE binding_id=?) AND binding_id<>? AND status='active'",
                    (bid, bid),
                )
            return bool(changed)

    def binding_confirm(self, bid: str, uid: int) -> bool:
        with self._db.transaction() as c:
            # Serialize account changes for the channel on both database backends.
            c.execute(
                "UPDATE channels SET enabled=enabled WHERE channel_id=(SELECT channel_id FROM loop_channel_bindings WHERE binding_id=? AND user_id=?)",
                (bid, uid),
            )
            row = c.execute(
                "SELECT * FROM loop_channel_bindings WHERE binding_id=? AND user_id=?", (bid, uid)
            ).fetchone()
            if row and row["status"] == "active":
                return True
            if not row or row["status"] != "awaiting_confirmation" or row["expires_at"] <= now_ts():
                return False
            c.execute(
                "UPDATE loop_channel_bindings SET status='revoked' WHERE user_id=? AND channel_id=? AND status='active'",
                (uid, row["channel_id"]),
            )
            routing = json.loads(row["routing_json"])
            routing.pop("_loop_pairing_preview", None)
            c.execute(
                "UPDATE loop_channel_bindings SET status='active',confirmed_at=?,routing_json=? WHERE binding_id=?",
                (now_ts(), json.dumps(routing, ensure_ascii=False), bid),
            )
        return True

    def binding_revoke(self, bid: str, uid: int) -> None:
        with self._db.connect() as c:
            c.execute(
                "UPDATE loop_channel_bindings SET status='revoked' WHERE binding_id=? AND user_id=?",
                (bid, uid),
            )

    def notify(
        self,
        nid: str,
        lid: str,
        bid: str,
        key: str,
        message: str,
        reference: dict[str, Any] | None = None,
    ) -> None:
        with self._db.connect() as c:
            c.execute(
                "INSERT INTO loop_notifications(notification_id,loop_id,binding_id,event_key,message,reference_json,next_at,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_key) DO NOTHING",
                (nid, lid, bid, key, message, json.dumps(reference or {}), now_ts(), now_ts()),
            )

    def notifications(
        self, lid: str | None = None, *, due: bool = False
    ) -> builtins.list[dict[str, Any]]:
        where = (
            " WHERE loop_id=?" if lid else " WHERE status='queued' AND next_at<=?" if due else ""
        )
        args = (lid,) if lid else (now_ts(),) if due else ()
        with self._db.connect() as c:
            rows = c.execute(
                "SELECT * FROM loop_notifications" + where + " ORDER BY created_at DESC LIMIT 100",
                args,
            ).fetchall()
        return [dict(r) for r in rows]

    def notification_claim(self, nid: str) -> bool:
        with self._db.connect() as c:
            return bool(
                c.execute(
                    "UPDATE loop_notifications SET status='sending',attempts=attempts+1 WHERE notification_id=? AND status='queued'",
                    (nid,),
                ).rowcount
            )

    def notification_finish(
        self, nid: str, status: str, error: str | None = None, delay: int = 0
    ) -> None:
        with self._db.connect() as c:
            c.execute(
                "UPDATE loop_notifications SET status=?,error=?,next_at=?,sent_at=? WHERE notification_id=?",
                (status, error, now_ts() + delay, now_ts() if status == "sent" else None, nid),
            )

    def recover_notifications(self) -> None:
        with self._db.connect() as c:
            c.execute(
                "UPDATE loop_notifications SET status='uncertain',error='delivery_interrupted' WHERE status='sending'"
            )

    def collect_approval(
        self, rid: str, checkpoint_id: str, index: int, decision: dict[str, Any]
    ) -> dict[str, Any] | None:
        with self._db.transaction() as c:
            c.execute(
                "UPDATE loop_rounds SET pending_json=pending_json WHERE round_id=? AND status='awaiting_approval'",
                (rid,),
            )
            row = c.execute(
                "SELECT pending_json FROM loop_rounds WHERE round_id=? AND status='awaiting_approval'",
                (rid,),
            ).fetchone()
            if not row or not row["pending_json"]:
                return None
            pending = json.loads(row["pending_json"])
            if (
                pending["checkpoint_id"] != checkpoint_id
                or pending.get("expires_at", 0) <= now_ts()
            ):
                return None
            collected = pending.setdefault("collected", {})
            if str(index) in collected and collected[str(index)] != decision:
                return None
            collected[str(index)] = decision
            c.execute(
                "UPDATE loop_rounds SET pending_json=? WHERE round_id=? AND status='awaiting_approval'",
                (json.dumps(pending, ensure_ascii=False), rid),
            )
            return dict(pending)

    def transition(self, lid: str, version: int, statuses: tuple[str, ...], **fields: Any) -> bool:
        allowed = {"status", "enabled", "reason", "next_run_at", "failures"}
        if "progress" in fields:
            fields["progress_json"] = json.dumps(fields.pop("progress"), ensure_ascii=False)
            allowed.add("progress_json")
        if not fields.keys() <= allowed:
            raise ValueError("invalid transition")
        fields["updated_at"] = now_ts()
        extra = (
            " AND (reason IS NULL OR reason != 'execution_unknown') AND NOT EXISTS (SELECT 1 FROM loop_judgments WHERE loop_judgments.loop_id=loops.loop_id AND status='pending') AND NOT EXISTS (SELECT 1 FROM loop_rounds WHERE loop_rounds.loop_id=loops.loop_id AND status IN ('running','awaiting_approval'))"
            if fields.get("status") == "scheduled"
            else ""
        )
        with self._db.connect() as c:
            return bool(
                c.execute(
                    "UPDATE loops SET "
                    + ",".join(f"{k}=?" for k in fields)
                    + " WHERE loop_id=? AND version=? AND status IN ("
                    + ",".join("?" for _ in statuses)
                    + ")"
                    + extra,
                    (*fields.values(), lid, version, *statuses),
                ).rowcount
            )

    def pause(self, lid: str) -> None:
        with self._db.connect() as c:
            c.execute(
                "UPDATE loops SET status=CASE WHEN status IN ('awaiting_approval','awaiting_judgment','completed','stopped') THEN status ELSE 'paused' END, enabled=0, next_run_at=NULL, reason=CASE WHEN reason='execution_unknown' THEN reason ELSE 'user_paused' END WHERE loop_id=? AND status!='deleted'",
                (lid,),
            )

    def trash(self, lid: str) -> bool:
        with self._db.transaction() as c:
            changed = c.execute(
                "UPDATE loops SET status='deleted', enabled=0, next_run_at=NULL, reason='user_deleted', updated_at=? WHERE loop_id=? AND status='stopped' AND NOT EXISTS (SELECT 1 FROM loop_rounds WHERE loop_id=? AND status IN ('running','awaiting_approval'))",
                (now_ts(), lid, lid),
            ).rowcount
            if changed:
                c.execute(
                    "UPDATE loop_notifications SET status='cancelled',error='task_deleted' WHERE loop_id=? AND status='queued'",
                    (lid,),
                )
            return bool(changed)

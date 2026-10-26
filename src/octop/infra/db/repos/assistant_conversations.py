"""Conversation-specific sources and immutable native-thread versions."""

from __future__ import annotations

import json
import time
from typing import Any

from octop.infra.db.pool import DatabasePool


class ConversationConflict(Exception):
    pass


class AssistantConversationRepo:
    def __init__(self, db: DatabasePool):
        self.db = db

    def root(self, thread_id: str) -> str:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT conversation_id FROM assistant_conversation_versions WHERE thread_id=?",
                (thread_id,),
            ).fetchone()
        return str(row["conversation_id"]) if row else thread_id

    def get(self, cid: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM assistant_conversations WHERE id=?", (cid,)
            ).fetchone()
            if row is None:
                return None
            versions = conn.execute(
                "SELECT * FROM assistant_conversation_versions WHERE conversation_id=? ORDER BY created_at,thread_id",
                (cid,),
            ).fetchall()
        return {
            **dict(row),
            "context": json.loads(row["context_json"]),
            "versions": [dict(v) for v in versions],
        }

    def save(
        self,
        cid: str,
        user_id: int,
        agent_id: str,
        revision: int,
        *,
        context: dict[str, Any] | None = None,
        active: str | None = None,
        version: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time_ns()
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO assistant_conversations(id,user_id,agent_id,active_thread_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
                (cid, user_id, agent_id, cid, now),
            )
            conn.execute(
                "INSERT INTO assistant_conversation_versions(thread_id,conversation_id,kind,created_at) VALUES(?,?,?,?) ON CONFLICT(thread_id) DO NOTHING",
                (cid, cid, "original", now),
            )
            row = conn.execute(
                "SELECT * FROM assistant_conversations WHERE id=?", (cid,)
            ).fetchone()
            if (
                row["user_id"] != user_id
                or row["agent_id"] != agent_id
                or row["revision"] != revision
            ):
                raise ConversationConflict()
            if version:
                conn.execute(
                    "INSERT INTO assistant_conversation_versions(thread_id,conversation_id,parent_thread_id,target_message_id,kind,created_at) VALUES(?,?,?,?,?,?)",
                    (
                        version["thread_id"],
                        cid,
                        version["parent_thread_id"],
                        version["target_message_id"],
                        version["kind"],
                        now,
                    ),
                )
            selected = active or row["active_thread_id"]
            belongs = conn.execute(
                "SELECT 1 FROM assistant_conversation_versions WHERE conversation_id=? AND thread_id=?",
                (cid, selected),
            ).fetchone()
            if belongs is None:
                raise ConversationConflict()
            result = conn.execute(
                "UPDATE assistant_conversations SET context_json=?,active_thread_id=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
                (
                    json.dumps(context if context is not None else json.loads(row["context_json"])),
                    selected,
                    now,
                    cid,
                    revision,
                ),
            )
            if result.rowcount != 1:
                raise ConversationConflict()
        value = self.get(cid)
        assert value is not None
        return value

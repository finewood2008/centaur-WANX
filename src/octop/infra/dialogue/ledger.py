"""Durable platform reservations. Stores accounting metadata, never chat text."""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from octop.infra.dialogue.contracts import DialogueError


class Ledger:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS calls (account TEXT, request_id TEXT, fingerprint TEXT, "
                "model TEXT, reserved INTEGER, charged INTEGER DEFAULT 0, state TEXT, "
                "created_at INTEGER, input_tokens INTEGER, output_tokens INTEGER, "
                "PRIMARY KEY(account,request_id))"
            )
            # Single-worker service: a restart must not erase uncertain upstream charges.
            conn.execute("UPDATE calls SET state='pending' WHERE state='running'")
        path.chmod(0o600)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    @staticmethod
    def _totals(conn: sqlite3.Connection, account: str | None) -> dict[str, int]:
        where, args = ("WHERE account=?", (account,)) if account else ("", ())
        row = conn.execute(
            "SELECT COALESCE(SUM(charged),0) spent, "
            "COALESCE(SUM(CASE WHEN state IN ('running','pending') THEN reserved ELSE 0 END),0) held, "
            "COALESCE(SUM(CASE WHEN state='running' THEN 1 ELSE 0 END),0) active, "
            "COALESCE(SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END),0) pending FROM calls "
            + where,
            args,
        ).fetchone()
        return dict(row)

    def quota(self, account: str, budget: int) -> dict[str, int]:
        with self.connect() as conn:
            totals = self._totals(conn, account)
        return {
            **totals,
            "budget": budget,
            "remaining": max(0, budget - totals["spent"] - totals["held"]),
        }

    def reserve(
        self,
        *,
        account: str,
        request_id: str,
        fingerprint: str,
        model: str,
        amount: int,
        budget: int,
        total_budget: int,
        concurrency: int,
        total_concurrency: int,
    ) -> None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            previous = conn.execute(
                "SELECT fingerprint FROM calls WHERE account=? AND request_id=?",
                (account, request_id),
            ).fetchone()
            if previous:
                raise DialogueError(
                    "REQUEST_ALREADY_ACCEPTED"
                    if previous["fingerprint"] == fingerprint
                    else "IDEMPOTENCY_CONFLICT",
                    409,
                )
            user, total = self._totals(conn, account), self._totals(conn, None)
            if user["active"] >= concurrency or total["active"] >= total_concurrency:
                raise DialogueError("CONCURRENCY_LIMIT", 429)
            if (
                amount > budget - user["spent"] - user["held"]
                or amount > total_budget - total["spent"] - total["held"]
            ):
                raise DialogueError("QUOTA_EXHAUSTED", 402)
            conn.execute(
                "INSERT INTO calls(account,request_id,fingerprint,model,reserved,state,created_at) VALUES(?,?,?,?,?,'running',?)",
                (account, request_id, fingerprint, model, amount, int(time.time())),
            )

    def settle(
        self,
        account: str,
        request_id: str,
        *,
        charge: int | None,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
    ) -> str:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT reserved,state FROM calls WHERE account=? AND request_id=?",
                (account, request_id),
            ).fetchone()
            if not row:
                return "pending"
            if row["state"] != "running":
                return str(row["state"])
            # Invalid/oversized usage is held for reconciliation, never silently capped.
            pending = charge is None or charge < 0 or charge > row["reserved"]
            conn.execute(
                "UPDATE calls SET state=?,charged=?,input_tokens=?,output_tokens=? WHERE account=? AND request_id=?",
                (
                    "pending" if pending else "settled",
                    0 if pending else charge,
                    input_tokens,
                    output_tokens,
                    account,
                    request_id,
                ),
            )
            return "pending" if pending else "settled"

    def reconcile(self, account: str, request_id: str, charge: int) -> None:
        """Operator-only offline reconciliation, after checking the supplier invoice."""
        if charge < 0:
            raise ValueError("negative charge")
        with self.connect() as conn:
            result = conn.execute(
                "UPDATE calls SET state='settled',charged=? WHERE account=? AND request_id=? AND state='pending'",
                (charge, account, request_id),
            )
            if result.rowcount != 1:
                raise ValueError("pending request not found")

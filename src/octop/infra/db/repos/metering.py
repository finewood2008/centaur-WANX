"""Persistence for shadow tasks, independent from the spendable credit ledger."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from octop.infra.db.pool import DatabasePool


class MeterTransaction:
    def __init__(self, conn: Any) -> None:
        self.conn = conn

    def task(self, task_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM credit_meter_tasks WHERE id=?", (task_id,)
        ).fetchone()
        return dict(row) if row else None

    def gateway_task(self, task_id: str) -> bool:
        return bool(
            self.conn.execute(
                "SELECT 1 FROM credit_gateway_tasks WHERE task_id=?", (task_id,)
            ).fetchone()
        )

    def existing(self, account: str, app: str, key: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM credit_meter_tasks WHERE account_key=? AND application_id=? AND task_key=?",
            (account, app, key),
        ).fetchone()
        return dict(row) if row else None

    def insert_task(self, values: dict[str, Any]) -> None:
        keys = list(values)
        self.conn.execute(
            f"INSERT INTO credit_meter_tasks ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
            tuple(values.values()),
        )

    def update(self, task_id: str, values: dict[str, Any]) -> None:
        self.conn.execute(
            "UPDATE credit_meter_tasks SET " + ",".join(k + "=?" for k in values) + " WHERE id=?",
            (*values.values(), task_id),
        )

    def calls(self, task_id: str) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM credit_meter_calls WHERE task_id=? ORDER BY created_at,id",
                (task_id,),
            ).fetchall()
        ]

    def call(self, call_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM credit_meter_calls WHERE id=?", (call_id,)
        ).fetchone()
        return dict(row) if row else None

    def insert_call(self, values: dict[str, Any]) -> None:
        keys = list(values)
        self.conn.execute(
            f"INSERT INTO credit_meter_calls ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})",
            tuple(values.values()),
        )

    def update_call(self, call_id: str, values: dict[str, Any]) -> None:
        self.conn.execute(
            "UPDATE credit_meter_calls SET " + ",".join(k + "=?" for k in values) + " WHERE id=?",
            (*values.values(), call_id),
        )


class MeterRepo:
    def __init__(self, db: DatabasePool) -> None:
        self.db = db

    @contextmanager
    def transaction(
        self, task_id: str | None = None, *, lock_key: str | None = None
    ) -> Iterator[MeterTransaction]:
        with self.db.transaction() as conn:
            if lock_key and self.db.dialect == "postgresql":
                key = int.from_bytes(
                    hashlib.sha256(lock_key.encode()).digest()[:8], "big", signed=True
                )
                conn.execute("SELECT pg_advisory_xact_lock(?)", (key,))
            if task_id and self.db.dialect == "postgresql":
                conn.execute(
                    "SELECT id FROM credit_meter_tasks WHERE id=? FOR UPDATE", (task_id,)
                ).fetchone()
            yield MeterTransaction(conn)

    def new_session(self, token_hash: str, account: str, app: str, expiry: int) -> None:
        with self.db.transaction() as conn:
            conn.execute("DELETE FROM credit_meter_sessions WHERE expires_at < ?", (expiry - 3600,))
            conn.execute(
                "INSERT INTO credit_meter_sessions VALUES (?,?,?,?)",
                (token_hash, account, app, expiry),
            )

    def session(self, token_hash: str, now: int) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM credit_meter_sessions WHERE token_hash=? AND expires_at>?",
                (token_hash, now),
            ).fetchone()
            return dict(row) if row else None

    def tasks(
        self, account: str | None, limit: int = 50, before: int = 9223372036854775807
    ) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            return [
                dict(r)
                for r in conn.execute(
                    "SELECT * FROM credit_meter_tasks WHERE account_key=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT ?",
                    (account, before, limit),
                ).fetchall()
            ]

    def report_rows(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        with self.db.connect() as conn:
            tasks = [dict(r) for r in conn.execute("SELECT * FROM credit_meter_tasks").fetchall()]
            allocations = [
                dict(r)
                for r in conn.execute(
                    "SELECT a.reservation_id,a.charged,a.refunded,a.amount,f.* FROM credit_allocations a LEFT JOIN credit_lot_finance f ON f.lot_id=a.lot_id"
                ).fetchall()
            ]
            return tasks, allocations

    def stale(self, now: int) -> list[str]:
        with self.db.connect() as conn:
            return [
                r[0]
                for r in conn.execute(
                    "SELECT id FROM credit_meter_tasks WHERE status IN ('active','pending','quoted','authorized','paused') AND created_at<=?",
                    (now - 86400,),
                ).fetchall()
            ]

    def attach_order(
        self, lot_id: str, order_ref: str, funding: str, revenue: int, points: int
    ) -> None:
        """Annotate an existing verified lot. Never creates or grants points."""
        with self.db.transaction() as conn:
            lot = conn.execute(
                "SELECT amount,kind FROM credit_lots WHERE lot_id=?", (lot_id,)
            ).fetchone()
            if not lot or lot["amount"] > points:
                raise ValueError("lot missing or exceeds order entitlement")
            old = conn.execute(
                "SELECT * FROM credit_lot_finance WHERE lot_id=?", (lot_id,)
            ).fetchone()
            values = (lot_id, order_ref, funding, revenue, points)
            if old:
                if (
                    tuple(
                        old[k]
                        for k in (
                            "lot_id",
                            "order_ref",
                            "funding",
                            "net_revenue_nano",
                            "order_points",
                        )
                    )
                    != values
                ):
                    raise ValueError("order metadata is immutable")
                return
            related = conn.execute(
                "SELECT net_revenue_nano,order_points,funding FROM credit_lot_finance WHERE order_ref=?",
                (order_ref,),
            ).fetchall()
            if any(
                tuple(r[k] for k in ("net_revenue_nano", "order_points", "funding"))
                != (revenue, points, funding)
                for r in related
            ):
                raise ValueError("inconsistent order metadata")
            total = conn.execute(
                "SELECT COALESCE(SUM(l.amount),0) FROM credit_lot_finance f JOIN credit_lots l ON l.lot_id=f.lot_id WHERE f.order_ref=?",
                (order_ref,),
            ).fetchone()[0]
            if total + lot["amount"] > points:
                raise ValueError("order entitlement exceeded")
            conn.execute("INSERT INTO credit_lot_finance VALUES (?,?,?,?,?)", values)

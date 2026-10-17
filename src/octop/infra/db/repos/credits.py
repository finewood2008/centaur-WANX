"""SQL access for the central credit ledger. Mutations share an account row lock."""

from __future__ import annotations

import json
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from octop.infra.db.pool import DatabasePool


class CreditTransaction:
    def __init__(self, conn: Any, account_key: str) -> None:
        self.conn = conn
        self.account_key = account_key

    def replay(self, key: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM credit_operations WHERE operation_key = ?", (key,)
        ).fetchone()
        return dict(row) if row else None

    def save_operation(self, key: str, fingerprint: str, result: dict[str, Any]) -> None:
        self.conn.execute(
            "INSERT INTO credit_operations VALUES (?, ?, ?)", (key, fingerprint, json.dumps(result))
        )

    def lots(self) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM credit_lots WHERE account_key = ? "
            "ORDER BY CASE WHEN kind = 'gift' THEN 0 ELSE 1 END, "
            "CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, lot_id",
            (self.account_key,),
        ).fetchall()
        return [dict(r) for r in rows]

    def add_lot(
        self, lot_id: str, kind: str, amount: int, expires_at: int | None, source_ref: str
    ) -> bool:
        return bool(
            self.conn.execute(
                "INSERT INTO credit_lots(lot_id, account_key, kind, amount, available, expires_at, source_ref) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_ref) DO NOTHING",
                (lot_id, self.account_key, kind, amount, amount, expires_at, source_ref),
            ).rowcount
        )

    def change_lot(self, lot_id: str, available: int, held: int) -> None:
        self.conn.execute(
            "UPDATE credit_lots SET available = available + ?, held = held + ? "
            "WHERE lot_id = ? AND account_key = ?",
            (available, held, lot_id, self.account_key),
        )

    def reservations(self) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM credit_reservations WHERE account_key = ? AND status IN ('reserved', 'active')",
                (self.account_key,),
            ).fetchall()
        ]

    def reservation(self, reservation_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT * FROM credit_reservations WHERE account_key = ? AND reservation_id = ?",
            (self.account_key, reservation_id),
        ).fetchone()
        return dict(row) if row else None

    def add_reservation(self, row: dict[str, Any]) -> bool:
        return bool(
            self.conn.execute(
                "INSERT INTO credit_reservations(reservation_id, account_key, application_id, task_id, "
                "description, status, budget, expires_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?) "
                "ON CONFLICT(account_key, application_id, task_id) DO NOTHING",
                (
                    row["reservation_id"],
                    self.account_key,
                    row["application_id"],
                    row["task_id"],
                    row["description"],
                    row["budget"],
                    row["expires_at"],
                ),
            ).rowcount
        )

    def update_reservation(
        self, reservation_id: str, status: str, charged: int, refunded: int
    ) -> None:
        self.conn.execute(
            "UPDATE credit_reservations SET status = ?, charged = ?, refunded = ? "
            "WHERE account_key = ? AND reservation_id = ?",
            (status, charged, refunded, self.account_key, reservation_id),
        )

    def allocate(self, reservation_id: str, lot_id: str, ordinal: int, amount: int) -> None:
        self.conn.execute(
            "INSERT INTO credit_allocations(reservation_id, lot_id, ordinal, amount) VALUES (?, ?, ?, ?)",
            (reservation_id, lot_id, ordinal, amount),
        )

    def allocations(self, reservation_id: str) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self.conn.execute(
                "SELECT a.*, l.expires_at FROM credit_allocations a JOIN credit_lots l ON a.lot_id = l.lot_id "
                "WHERE a.reservation_id = ? AND l.account_key = ? ORDER BY a.ordinal",
                (reservation_id, self.account_key),
            ).fetchall()
        ]

    def update_allocation(
        self, reservation_id: str, lot_id: str, charged: int, refunded: int
    ) -> None:
        self.conn.execute(
            "UPDATE credit_allocations SET charged = ?, refunded = ? WHERE reservation_id = ? AND lot_id = ?",
            (charged, refunded, reservation_id, lot_id),
        )

    def event(
        self,
        *,
        event_id: str,
        kind: str,
        application_id: str | None,
        reservation_id: str | None,
        available_delta: int,
        held_delta: int,
        expired_amount: int,
        actor: str,
        reference: str,
        now: int,
    ) -> dict[str, Any]:
        self.conn.execute(
            "UPDATE credit_accounts SET revision = revision + 1 WHERE account_key = ?",
            (self.account_key,),
        )
        sequence = int(
            self.conn.execute(
                "SELECT revision FROM credit_accounts WHERE account_key = ?", (self.account_key,)
            ).fetchone()[0]
        )
        value = {
            "sequence": sequence,
            "event_id": event_id,
            "kind": kind,
            "application_id": application_id,
            "reservation_id": reservation_id,
            "available_delta": available_delta,
            "held_delta": held_delta,
            "expired_amount": expired_amount,
            "actor": actor,
            "reference": reference,
            "created_at": now,
        }
        self.conn.execute(
            "INSERT INTO credit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (self.account_key, *value.values()),
        )
        return value

    def events(self, after: int, limit: int, application_id: str | None) -> list[dict[str, Any]]:
        clause = " AND application_id = ?" if application_id else ""
        params: list[Any] = [self.account_key, after]
        if application_id:
            params.append(application_id)
        params.append(limit)
        rows = self.conn.execute(
            "SELECT * FROM credit_events WHERE account_key = ? AND sequence > ?"
            + clause
            + " ORDER BY sequence LIMIT ?",
            params,
        ).fetchall()
        return [{k: r[k] for k in dict(r) if k != "account_key"} for r in rows]


class CreditRepo:
    def __init__(self, db: DatabasePool) -> None:
        self.db = db

    @contextmanager
    def transaction(
        self, account_key: str, issuer: str, subject: str
    ) -> Iterator[CreditTransaction]:
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO credit_accounts(account_key, issuer, subject) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
                (account_key, issuer, subject),
            )
            suffix = " FOR UPDATE" if self.db.dialect == "postgresql" else ""
            conn.execute(
                "SELECT account_key FROM credit_accounts WHERE account_key = ?" + suffix,
                (account_key,),
            ).fetchone()
            yield CreditTransaction(conn, account_key)

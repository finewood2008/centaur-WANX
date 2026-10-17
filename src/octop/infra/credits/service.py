"""Account-based credit accounting. No model prices or application tariff rules."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from collections.abc import Callable
from typing import Any, NoReturn, cast

from octop.infra.db.services import SharedServices
from octop.infra.errors import ErrorCode, OctopError

MAX_CREDITS = 9_000_000_000_000


def fail(code: str) -> NoReturn:
    raise OctopError.localized(ErrorCode("CREDITS_" + code))


def amount(value: int, *, zero: bool = False) -> None:
    if type(value) is not int or not (0 if zero else 1) <= value <= MAX_CREDITS:
        fail("INVALID")


def text(value: str, maximum: int = 128) -> None:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value) > maximum
        or any(ord(c) < 32 for c in value)
    ):
        fail("INVALID")


def digest(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


class CreditService:
    def __init__(
        self,
        services: SharedServices,
        issuer: str,
        subject: str,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        text(issuer, 512)
        text(subject, 256)
        self.repo = services.credit_repo
        self.issuer = issuer
        self.subject = subject
        self.key = digest([issuer, subject])
        self.clock = clock

    def _transaction(self) -> Any:
        return self.repo.transaction(self.key, self.issuer, self.subject)

    @staticmethod
    def _event(
        tx: Any,
        kind: str,
        now: int,
        *,
        available: int = 0,
        held: int = 0,
        expired: int = 0,
        actor: str = "system",
        reference: str = "",
        reservation: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            tx.event(
                event_id=uuid.uuid4().hex,
                kind=kind,
                application_id=reservation["application_id"] if reservation else None,
                reservation_id=reservation["reservation_id"] if reservation else None,
                available_delta=available,
                held_delta=held,
                expired_amount=expired,
                actor=actor,
                reference=reference,
                now=now,
            ),
        )

    def _finish(
        self,
        tx: Any,
        row: dict[str, Any],
        charged: int,
        status: str,
        now: int,
        actor: str,
        reference: str,
    ) -> dict[str, Any]:
        remaining = charged
        returned = expired = 0
        for allocation in tx.allocations(row["reservation_id"]):
            used = min(remaining, allocation["amount"])
            remaining -= used
            unused = allocation["amount"] - used
            is_expired = allocation["expires_at"] is not None and allocation["expires_at"] <= now
            available = 0 if is_expired else unused
            expired += unused - available
            returned += available
            tx.change_lot(allocation["lot_id"], available, -allocation["amount"])
            tx.update_allocation(row["reservation_id"], allocation["lot_id"], used, 0)
        tx.update_reservation(row["reservation_id"], status, charged, 0)
        event = self._event(
            tx,
            status,
            now,
            available=returned,
            held=-row["budget"],
            expired=expired,
            actor=actor,
            reference=reference,
            reservation=row,
        )
        return {"reservation": tx.reservation(row["reservation_id"]), "event": event}

    def _expire(self, tx: Any, now: int) -> None:
        for lot in tx.lots():
            if lot["available"] and lot["expires_at"] is not None and lot["expires_at"] <= now:
                tx.change_lot(lot["lot_id"], -lot["available"], 0)
                self._event(
                    tx,
                    "gift_expired",
                    now,
                    available=-lot["available"],
                    expired=lot["available"],
                    reference=lot["lot_id"],
                )
        for row in tx.reservations():
            if row["expires_at"] <= now:
                self._finish(tx, row, 0, "expired", now, "system", "reservation_timeout")

    @staticmethod
    def _balance(tx: Any) -> dict[str, int]:
        result = {"available": 0, "held": 0, "paid_available": 0, "gift_available": 0}
        for lot in tx.lots():
            result["available"] += lot["available"]
            result["held"] += lot["held"]
            result[lot["kind"] + "_available"] += lot["available"]
        return result

    def balance(self) -> dict[str, Any]:
        with self._transaction() as tx:
            self._expire(tx, int(self.clock()))
            return {"account_id": self.subject, **self._balance(tx)}

    def events(
        self, after: int, limit: int, application_id: str | None = None
    ) -> list[dict[str, Any]]:
        with self._transaction() as tx:
            self._expire(tx, int(self.clock()))
            return cast(list[dict[str, Any]], tx.events(after, limit, application_id))

    def reservation(self, reservation_id: str, application_id: str | None = None) -> dict[str, Any]:
        with self._transaction() as tx:
            self._expire(tx, int(self.clock()))
            row = tx.reservation(reservation_id)
            if not row or (application_id and row["application_id"] != application_id):
                fail("NOT_FOUND")
            return dict(row)

    def _operation(
        self,
        scope: str,
        request_id: str,
        payload: dict[str, Any],
        apply: Callable[..., dict[str, Any]],
    ) -> dict[str, Any]:
        text(request_id)
        fingerprint = digest(payload)
        key = digest([self.key, scope, request_id])
        now = int(self.clock())
        with self._transaction() as tx:
            self._expire(tx, now)
            previous = tx.replay(key)
            if previous:
                if previous["fingerprint"] != fingerprint:
                    fail("CONFLICT")
                return dict(json.loads(previous["response_json"]))
            result = apply(tx, now)
            result["balance"] = {"account_id": self.subject, **self._balance(tx)}
            tx.save_operation(key, fingerprint, result)
            return result

    def grant(
        self,
        *,
        request_id: str,
        kind: str,
        credits: int,
        expires_at: int | None,
        source_ref: str,
        reason: str,
        actor: str,
    ) -> dict[str, Any]:
        amount(credits)
        text(source_ref)
        text(reason, 300)
        if kind not in {"paid", "gift"} or (
            expires_at is not None and (type(expires_at) is not int or kind != "gift")
        ):
            fail("INVALID")
        payload = {
            "kind": kind,
            "credits": credits,
            "expires_at": expires_at,
            "source_ref": source_ref,
            "reason": reason,
        }

        def apply(tx: Any, now: int) -> dict[str, Any]:
            if expires_at is not None and expires_at <= now:
                fail("INVALID")
            balance = self._balance(tx)
            if balance["available"] + balance["held"] + credits > MAX_CREDITS:
                fail("INVALID")
            lot_id = uuid.uuid4().hex
            if not tx.add_lot(lot_id, kind, credits, expires_at, source_ref):
                fail("CONFLICT")
            event = self._event(
                tx,
                kind + "_credited",
                now,
                available=credits,
                actor=actor,
                reference=source_ref + ": " + reason,
            )
            return {"lot_id": lot_id, "event": event}

        return self._operation("grant", request_id, payload, apply)

    def reserve(
        self,
        *,
        request_id: str,
        application_id: str,
        task_id: str,
        description: str,
        budget: int,
        ttl_seconds: int,
    ) -> dict[str, Any]:
        amount(budget)
        text(application_id)
        text(task_id)
        text(description, 300)
        if type(ttl_seconds) is not int or not 60 <= ttl_seconds <= 86400:
            fail("INVALID")
        payload = {
            "application_id": application_id,
            "task_id": task_id,
            "description": description,
            "budget": budget,
            "ttl_seconds": ttl_seconds,
        }

        def apply(tx: Any, now: int) -> dict[str, Any]:
            row = {
                "reservation_id": uuid.uuid4().hex,
                "application_id": application_id,
                "task_id": task_id,
                "description": description,
                "budget": budget,
                "expires_at": now + ttl_seconds,
            }
            if not tx.add_reservation(row):
                fail("CONFLICT")
            if self._balance(tx)["available"] < budget:
                fail("INSUFFICIENT")
            remaining = budget
            for ordinal, lot in enumerate(tx.lots()):
                used = min(remaining, lot["available"])
                if used:
                    tx.allocate(row["reservation_id"], lot["lot_id"], ordinal, used)
                    tx.change_lot(lot["lot_id"], -used, used)
                    remaining -= used
                if not remaining:
                    break
            event = self._event(
                tx,
                "reserved",
                now,
                available=-budget,
                held=budget,
                actor="account",
                reference=task_id,
                reservation=row,
            )
            return {"reservation": tx.reservation(row["reservation_id"]), "event": event}

        return self._operation("reserve", request_id, payload, apply)

    def transition(
        self,
        *,
        request_id: str,
        reservation_id: str,
        action: str,
        application_id: str | None,
        credits: int = 0,
        reason: str = "",
    ) -> dict[str, Any]:
        amount(credits, zero=True)
        if action not in {"start", "settle", "release", "refund"}:
            fail("INVALID")
        if action in {"refund", "release"}:
            text(reason, 300)
        if action == "refund" and not credits:
            fail("INVALID")
        payload = {
            "reservation_id": reservation_id,
            "action": action,
            "credits": credits,
            "reason": reason,
        }

        def apply(tx: Any, now: int) -> dict[str, Any]:
            row = tx.reservation(reservation_id)
            if not row or (application_id and row["application_id"] != application_id):
                fail("NOT_FOUND")
            if application_id is None and (action != "release" or row["status"] != "reserved"):
                fail("FORBIDDEN")
            actor = "app:" + application_id if application_id else "account"
            if action == "refund":
                if row["status"] != "settled" or credits > row["charged"] - row["refunded"]:
                    fail("CONFLICT")
                remaining = credits
                restored = expired = 0
                for allocation in tx.allocations(reservation_id):
                    refund = min(remaining, allocation["charged"] - allocation["refunded"])
                    remaining -= refund
                    is_expired = (
                        allocation["expires_at"] is not None and allocation["expires_at"] <= now
                    )
                    available = 0 if is_expired else refund
                    restored += available
                    expired += refund - available
                    tx.change_lot(allocation["lot_id"], available, 0)
                    tx.update_allocation(
                        reservation_id,
                        allocation["lot_id"],
                        allocation["charged"],
                        allocation["refunded"] + refund,
                    )
                tx.update_reservation(
                    reservation_id, "settled", row["charged"], row["refunded"] + credits
                )
                event = self._event(
                    tx,
                    "refunded",
                    now,
                    available=restored,
                    expired=expired,
                    actor=actor,
                    reference=reason,
                    reservation=row,
                )
            elif action == "start":
                if row["status"] != "reserved":
                    fail("CONFLICT")
                tx.update_reservation(reservation_id, "active", 0, 0)
                event = self._event(tx, "started", now, actor=actor, reference="", reservation=row)
            else:
                if row["status"] not in {"reserved", "active"} or credits > row["budget"]:
                    fail("CONFLICT")
                if action == "settle" and row["status"] != "active":
                    fail("CONFLICT")
                return self._finish(
                    tx,
                    row,
                    credits if action == "settle" else 0,
                    "settled" if action == "settle" else "released",
                    now,
                    actor,
                    reason,
                )
            return {"reservation": tx.reservation(reservation_id), "event": event}

        scope = "app:" + application_id if application_id else "account"
        return self._operation(scope, request_id, payload, apply)

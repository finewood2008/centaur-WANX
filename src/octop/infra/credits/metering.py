"""Shadow task lifecycle. No method in this module mutates spendable balances."""

from __future__ import annotations

import hashlib
import json
import secrets
import time
import uuid
from dataclasses import asdict
from fractions import Fraction
from typing import Any

from octop.infra.credits import pricing
from octop.infra.credits.service import fail, text
from octop.infra.db.repos.metering import MeterRepo

PUBLIC = (
    "id",
    "application_id",
    "task_key",
    "tier",
    "status",
    "price_version",
    "created_at",
    "ended_at",
    "simulated_points",
    "pending_calls",
    "mode",
)


class Meter:
    def __init__(self, repo: MeterRepo, clock: Any = time.time) -> None:
        self.repo, self.clock = repo, clock

    def session(self, account: str, application_id: str) -> dict[str, Any]:
        token = secrets.token_urlsafe(48)
        expires = int(self.clock()) + 3600
        self.repo.new_session(
            hashlib.sha256(token.encode()).hexdigest(), account, application_id, expires
        )
        return {"token": token, "expires_at": expires, "mode": "shadow"}

    def identity(self, token: str) -> dict[str, Any] | None:
        if not token or len(token) > 256:
            return None
        row = self.repo.session(hashlib.sha256(token.encode()).hexdigest(), int(self.clock()))
        return {key: row[key] for key in ("account_key", "application_id")} if row else None

    def create_task(
        self,
        account: str | None,
        app: str,
        key: str,
        tier: str = "standard",
        *,
        user_id: int = 0,
    ) -> dict[str, Any]:
        text(key)
        now = int(self.clock())
        with self.repo.transaction(lock_key=f"{account}:{app}:{key}") as tx:
            old = tx.existing(account, app, key) if account else None
            if old:
                if old["tier"] != tier:
                    fail("CONFLICT")
                return old
            row: dict[str, Any] = {
                "id": uuid.uuid4().hex,
                "account_key": account,
                "local_user_id": user_id,
                "application_id": app,
                "task_key": key,
                "tier": tier,
                "budget": 0,
                "price_version": pricing.VERSION,
                "quote_expires_at": now,
                "created_at": now,
            }
            tx.insert_task(row)
            return tx.task(row["id"]) or {}

    def start(self, task_id: str) -> None:
        with self.repo.transaction(task_id) as tx:
            row = tx.task(task_id)
            if tx.gateway_task(task_id):
                fail("FORBIDDEN")
            if not row or row["status"] not in ("quoted", "authorized", "active"):
                fail("CONFLICT")
            tx.update(task_id, {"status": "active"})

    def begin_call(
        self,
        task_id: str,
        call_id: str,
        model: str,
        provider: str,
        max_input: int,
        max_output: int,
        *,
        local: bool = False,
    ) -> bool:
        pricing.nonnegative(max_input)
        pricing.nonnegative(max_output)
        now = int(self.clock())
        card = pricing.rate(model, now, local=local)
        worst = (
            (
                max_input * max(card.uncached, card.cache_write, card.cache_read)
                + max_output * card.output
            )
            if card
            else 0
        )
        with self.repo.transaction(task_id) as tx:
            row = tx.task(task_id)
            if not row or row["status"] != "active":
                fail("CONFLICT")
            if tx.call(call_id):
                fail("CONFLICT")  # never silently execute a supplier call twice
            tx.insert_call(
                {
                    "id": call_id,
                    "task_id": task_id,
                    "model": model,
                    "provider": provider,
                    "price_json": json.dumps(asdict(card)) if card else None,
                    "reserved_cost": worst,
                    "created_at": now,
                }
            )
            tx.update(
                task_id,
                {
                    "reserved_cost": row["reserved_cost"] + worst,
                    "pending_calls": row["pending_calls"] + 1,
                },
            )
            return True

    def finish_call(
        self, task_id: str, call_id: str, usage: dict[str, int] | None, *, failed: bool = False
    ) -> None:
        with self.repo.transaction(task_id) as tx:
            row, call = tx.task(task_id), tx.call(call_id)
            if not row or not call or call["task_id"] != task_id:
                fail("NOT_FOUND")
            if call["status"] not in ("pending", "unverified"):
                # A transport/callback retry must preserve the first accounting result.
                if call["usage_json"] != (
                    json.dumps(usage, sort_keys=True) if usage is not None else None
                ):
                    fail("CONFLICT")
                return
            card = pricing.Rate(**json.loads(call["price_json"])) if call["price_json"] else None
            cost = card.cost(usage) if card and usage is not None else None
            if (
                card
                and card.period != "local"
                and usage
                and usage.get("cache_write_tokens")
                and not card.cache_write
            ):
                cost = None
            known = cost is not None
            tx.update_call(
                call_id,
                {
                    "status": "failed"
                    if failed and known
                    else "recorded"
                    if known
                    else "unverified",
                    "usage_json": json.dumps(usage, sort_keys=True) if usage is not None else None,
                    "cost": cost,
                    "billable": int(not failed),
                    "ended_at": int(self.clock()),
                },
            )
            tx.update(
                task_id,
                {
                    "reserved_cost": row["reserved_cost"]
                    - (call["reserved_cost"] if known and row["status"] != "expired" else 0),
                    "total_cost": row["total_cost"] + (cost or 0),
                    "billable_cost": row["billable_cost"] + ((cost or 0) if not failed else 0),
                    "pending_calls": row["pending_calls"] - int(known),
                },
            )

        # A delayed authoritative usage result can close a pending task. Expired
        # tasks keep their released user charge even when supplier costs arrive late.
        if known and row["status"] == "pending" and row["pending_calls"] == 1:
            self.finish(task_id, row.get("outcome") or "completed")

    def finish(self, task_id: str, outcome: str = "completed") -> dict[str, Any]:
        if outcome not in ("completed", "cancelled", "failed", "expired"):
            fail("INVALID")
        with self.repo.transaction(task_id) as tx:
            row = tx.task(task_id)
            if not row:
                fail("NOT_FOUND")
            if row["ended_at"] is not None:
                return row
            outcome = "expired" if outcome == "expired" else row.get("outcome") or outcome
            charge = 0 if outcome in ("failed", "expired") else pricing.points(row["billable_cost"])
            status = "pending" if row["pending_calls"] and outcome != "expired" else outcome
            tx.update(
                task_id,
                {
                    "status": status,
                    "outcome": outcome,
                    "simulated_points": charge,
                    "ended_at": int(self.clock()) if status != "pending" else None,
                    "reserved_cost": 0 if outcome == "expired" else row["reserved_cost"],
                },
            )
            return tx.task(task_id) or {}

    def expire(self) -> int:
        rows = self.repo.stale(int(self.clock()))
        for task_id in rows:
            self.finish(task_id, "expired")
        return len(rows)

    def view(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            **{key: row[key] for key in PUBLIC},
            "charged": 0,
            "refunded": 0,
            "account_linked": bool(row["account_key"]),
        }

    def report(self) -> dict[str, Any]:
        tasks, allocations = self.repo.report_rows()
        # Revenue remains unknown for legacy lots without verified order metadata.
        revenue = int(
            sum(
                Fraction((r["charged"] - r["refunded"]) * r["net_revenue_nano"], r["order_points"])
                for r in allocations
                if r["funding"] == "paid"
            )
        )
        total = sum(t["total_cost"] for t in tasks)
        groups: dict[tuple[str, str], dict[str, Any]] = {}
        for task in tasks:
            group = groups.setdefault(
                (task["application_id"], task["tier"]),
                {
                    "application_id": task["application_id"],
                    "tier": task["tier"],
                    "tasks": 0,
                    "complete_samples": 0,
                    "cost_nano": 0,
                    "simulated_points": 0,
                    "pending_calls": 0,
                },
            )
            group["tasks"] += 1
            group["complete_samples"] += int(
                task["status"] == "completed"
                and not task["pending_calls"]
                and bool(task["account_key"])
                and task["total_cost"] > 0
            )
            group["cost_nano"] += task["total_cost"]
            group["simulated_points"] += task["simulated_points"]
            group["pending_calls"] += task["pending_calls"]
        for group in groups.values():
            projected_revenue = group["simulated_points"] * pricing.POINT_REVENUE
            group["projected_list_margin_bps"] = (
                10000 - (group["cost_nano"] * 10000 // projected_revenue)
                if projected_revenue
                else None
            )
            group["sample_target_met"] = group["complete_samples"] >= 100
        # Keep missing financial metadata visible; never turn an unknown amount into zero revenue.
        unpriced_allocations = sum(r["funding"] is None for r in allocations)
        return {
            "mode": "shadow",
            "task_count": len(tasks),
            "estimated_cost_nano": total,
            "simulated_points": sum(t["simulated_points"] for t in tasks),
            "unlinked_tasks": sum(not bool(t["account_key"]) for t in tasks),
            "pending_calls": sum(t["pending_calls"] for t in tasks),
            "allocated_revenue_nano": revenue,
            "allocations_missing_order_metadata": unpriced_allocations,
            "applications": list(groups.values()),
            "target_margin_bps": 6500,
            "minimum_margin_bps": 6000,
            "supplier_reconciled": False,
            "report_scope": "all_shadow_tasks_since_installation",
            "non_token_costs_included": False,
            "paid_margin_bps": None,
            "commercial_ready": False,
            "reason": "shadow_only_supplier_reconciliation_required",
        }

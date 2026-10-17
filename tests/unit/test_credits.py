"""Real SQL ledger checks: account identity, allocations, retries and concurrency."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from octop.infra.credits.service import CreditService
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.credits import CreditRepo
from octop.infra.errors import OctopError

ISSUER = "https://accounts.wanx.test"


@pytest.fixture
def ledger(tmp_path):
    pool = SqlitePool(tmp_path / "ledger.sqlite3")
    run_migrations(pool)
    now = [1000]
    services = SimpleNamespace(credit_repo=CreditRepo(pool))
    service = CreditService(services, ISSUER, "wanx-account-1", clock=lambda: now[0])
    yield service, now, services, pool
    pool.close()


def credit(service, credits=100, kind="paid", ref="order:one", expires=None, request="credit-1"):
    return service.grant(
        request_id=request,
        kind=kind,
        credits=credits,
        expires_at=expires,
        source_ref=ref,
        reason="Verified payment" if kind == "paid" else "Box gift",
        actor="admin:1",
    )


def reserve(service, budget=80, task="task-1", app="zhijun", request="reserve-1", ttl=900):
    return service.reserve(
        request_id=request,
        application_id=app,
        task_id=task,
        description="Application-defined task",
        budget=budget,
        ttl_seconds=ttl,
    )


def change(service, rid, action, credits=0, app="zhijun", request=None):
    return service.transition(
        request_id=request or action,
        reservation_id=rid,
        action=action,
        application_id=app,
        credits=credits,
        reason="User requested" if action in {"release", "refund"} else "",
    )


def assert_code(code, callback):
    with pytest.raises(OctopError) as caught:
        callback()
    assert caught.value.code.value == "CREDITS_" + code


def test_paid_gift_allocation_settlement_and_original_lot_refund(ledger):
    service, now, _, pool = ledger
    credit(service)
    credit(service, 50, "gift", "box:one", 1100, "gift-1")
    booked = reserve(service, 80)
    rid = booked["reservation"]["reservation_id"]
    assert booked["balance"]["available"] == 70
    assert booked["balance"]["held"] == 80
    change(service, rid, "start")
    result = change(service, rid, "settle", 60)
    assert result["balance"]["paid_available"] == 90
    assert result["balance"]["gift_available"] == 0
    assert result["balance"]["held"] == 0
    result = change(service, rid, "refund", 60)
    assert result["balance"]["paid_available"] == 100
    assert result["balance"]["gift_available"] == 50
    with pool.connect() as conn:
        assert conn.execute(
            "SELECT SUM(charged), SUM(refunded) FROM credit_allocations"
        ).fetchone()[:] == (60, 60)
    events = service.events(0, 200)
    assert sum(e["available_delta"] for e in events) == service.balance()["available"]
    assert sum(e["held_delta"] for e in events) == 0


def test_expiring_gift_precedes_other_gifts_then_paid(ledger):
    service, _, _, pool = ledger
    credit(service, 100)
    credit(service, 30, "gift", "gift:forever", None, "g1")
    expiring = credit(service, 20, "gift", "gift:soon", 1100, "g2")["lot_id"]
    rid = reserve(service, 10)["reservation"]["reservation_id"]
    with pool.connect() as conn:
        row = conn.execute(
            "SELECT lot_id, amount FROM credit_allocations WHERE reservation_id=?", (rid,)
        ).fetchone()
        assert tuple(row) == (expiring, 10)


def test_retries_are_identical_and_changed_payload_conflicts(ledger):
    service = ledger[0]
    first = credit(service)
    assert credit(service) == first
    assert_code("CONFLICT", lambda: credit(service, 101))
    first = reserve(service)
    assert reserve(service) == first
    assert_code("CONFLICT", lambda: reserve(service, 79))
    rid = first["reservation"]["reservation_id"]
    change(service, rid, "start")
    result = change(service, rid, "settle", 40)
    assert change(service, rid, "settle", 40) == result
    assert_code("CONFLICT", lambda: change(service, rid, "settle", 41))
    refunded = change(service, rid, "refund", 20)
    assert change(service, rid, "refund", 20) == refunded
    assert service.balance()["available"] == 80
    assert_code("CONFLICT", lambda: change(service, rid, "refund", 21, request="another-refund"))


def test_same_source_cannot_credit_second_account_or_different_request(ledger):
    service, now, services, _ = ledger
    credit(service)
    assert_code("CONFLICT", lambda: credit(service, request="other"))
    other = CreditService(services, ISSUER, "wanx-account-2", clock=lambda: now[0])
    assert_code("CONFLICT", lambda: credit(other))
    assert other.balance()["available"] == 0


def test_account_identity_is_subject_not_local_user_or_box(ledger):
    service, now, services, _ = ledger
    credit(service)
    same_account_other_instance = CreditService(
        services, ISSUER, "wanx-account-1", clock=lambda: now[0]
    )
    assert same_account_other_instance.balance()["available"] == 100
    other_issuer = CreditService(
        services, "https://unrelated.test", "wanx-account-1", clock=lambda: now[0]
    )
    assert other_issuer.balance()["available"] == 0


def test_task_id_cannot_create_another_hold(ledger):
    service = ledger[0]
    credit(service, 100)
    reserve(service)
    assert_code("CONFLICT", lambda: reserve(service, request="different-request"))
    assert service.balance()["held"] == 80


def test_cross_account_and_cross_application_cannot_access_hold(ledger):
    service, now, services, _ = ledger
    credit(service)
    rid = reserve(service)["reservation"]["reservation_id"]
    assert_code("NOT_FOUND", lambda: change(service, rid, "start", app="other"))
    other = CreditService(services, ISSUER, "other-account", clock=lambda: now[0])
    assert_code("NOT_FOUND", lambda: other.reservation(rid))
    assert_code("NOT_FOUND", lambda: change(other, rid, "start"))
    assert service.events(0, 100, "other") == []
    assert len(service.events(0, 100, "zhijun")) == 1


def test_no_charge_without_start_and_no_over_budget_or_negative_charge(ledger):
    service = ledger[0]
    credit(service)
    rid = reserve(service)["reservation"]["reservation_id"]
    assert_code("CONFLICT", lambda: change(service, rid, "settle", 1))
    change(service, rid, "start")
    assert_code("CONFLICT", lambda: change(service, rid, "settle", 81))
    assert_code("INVALID", lambda: change(service, rid, "settle", -1))
    assert_code("INVALID", lambda: change(service, rid, "settle", True))
    assert service.balance()["held"] == 80
    change(service, rid, "settle", 0)
    assert service.balance()["available"] == 100


def test_owner_cannot_cancel_active_work_and_terminal_state_cannot_change(ledger):
    service = ledger[0]
    credit(service)
    rid = reserve(service)["reservation"]["reservation_id"]
    change(service, rid, "start")
    assert_code("FORBIDDEN", lambda: change(service, rid, "release", app=None))
    change(service, rid, "release")
    assert_code("CONFLICT", lambda: change(service, rid, "settle", 1))
    assert service.balance()["available"] == 100


def test_owner_can_release_before_work_starts(ledger):
    service = ledger[0]
    credit(service)
    rid = reserve(service)["reservation"]["reservation_id"]
    change(service, rid, "release", app=None)
    assert service.balance()["available"] == 100


def test_expiry_releases_holds_without_reviving_expired_gifts(ledger):
    service, now, _, _ = ledger
    credit(service, 100, "gift", "box:one", 1050)
    rid = reserve(service, 80, ttl=100)["reservation"]["reservation_id"]
    change(service, rid, "start")
    now[0] = 1050
    assert service.balance()["available"] == 0
    assert service.balance()["held"] == 80
    now[0] = 1100
    assert service.balance()["held"] == 0
    assert service.reservation(rid)["status"] == "expired"
    assert_code("CONFLICT", lambda: change(service, rid, "settle", 1))
    assert sum(e["expired_amount"] for e in service.events(0, 100)) == 100


def test_refund_never_converts_expired_gift_to_paid_balance(ledger):
    service, now, _, _ = ledger
    credit(service, 100, "gift", "box:one", 1050)
    rid = reserve(service)["reservation"]["reservation_id"]
    change(service, rid, "start")
    change(service, rid, "settle", 60)
    now[0] = 1100
    result = change(service, rid, "refund", 60)
    assert result["balance"]["available"] == 0
    assert result["event"]["expired_amount"] == 60
    assert result["reservation"]["refunded"] == 60


@pytest.mark.parametrize("credits", [0, -1, True, 1.5, 9_000_000_000_001])
def test_invalid_credit_amount_rejected_without_ledger_change(ledger, credits):
    service = ledger[0]
    assert_code("INVALID", lambda: credit(service, credits))
    assert service.balance()["available"] == 0
    assert service.events(0, 100) == []


def test_paid_balance_cannot_expire_and_expired_gifts_cannot_be_issued(ledger):
    service = ledger[0]
    assert_code("INVALID", lambda: credit(service, expires=1200))
    assert_code("INVALID", lambda: credit(service, kind="gift", expires=1000))


def test_concurrent_connections_cannot_overspend(ledger):
    service, now, _, pool = ledger
    credit(service)
    second = SqlitePool(pool.path)
    other = CreditService(
        SimpleNamespace(credit_repo=CreditRepo(second)),
        ISSUER,
        "wanx-account-1",
        clock=lambda: now[0],
    )

    def attempt(pair):
        index, target = pair
        try:
            reserve(target, 80, task=f"task-{index}", request=f"reserve-{index}")
            return "ok"
        except OctopError as error:
            return error.code.value

    try:
        with ThreadPoolExecutor(2) as executor:
            results = list(executor.map(attempt, enumerate([service, other])))
        assert sorted(results) == ["CREDITS_INSUFFICIENT", "ok"]
        assert service.balance()["available"] == 20
        assert service.balance()["held"] == 80
    finally:
        second.close()


def test_restart_preserves_hold_and_idempotency(ledger):
    service, now, _, pool = ledger
    posted = credit(service)
    hold = reserve(service)
    second = SqlitePool(pool.path)
    try:
        recovered = CreditService(
            SimpleNamespace(credit_repo=CreditRepo(second)),
            ISSUER,
            "wanx-account-1",
            clock=lambda: now[0],
        )
        assert credit(recovered) == posted
        assert reserve(recovered) == hold
        assert recovered.balance()["held"] == 80
    finally:
        second.close()

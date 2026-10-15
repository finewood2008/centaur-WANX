"""Monetary invariants exercised against migrated SQLite, without real grants."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from octop.infra.credits import pricing
from octop.infra.credits.metering import Meter
from octop.infra.credits.runtime import CostCallback, task_scope
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.repos.metering import MeterRepo

APP = "centaurai.wanx.zhijun"
NOW = int(datetime(2026, 10, 15, 10, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp())
USAGE = {
    "uncached_input_tokens": 1000,
    "cache_read_tokens": 2000,
    "output_tokens": 100,
    "reasoning_tokens": 50,
}


@pytest.fixture
def meter(tmp_path):
    pool = SqlitePool(tmp_path / "meter.db")
    run_migrations(pool)
    now = [NOW]
    service = Meter(MeterRepo(pool), clock=lambda: now[0])
    yield service, now, pool
    pool.close()


def task(meter, account="one", key="turn", tier="standard"):
    row = meter.create_task(account, APP, key, tier)
    meter.start(row["id"])
    return row["id"]


def call(meter, tid, cid="call", usage=USAGE, failed=False):
    assert meter.begin_call(tid, cid, "deepseek-v4-flash", "deepseek", 4000, 1000)
    meter.finish_call(tid, cid, usage, failed=failed)


def test_rate_cache_reasoning_alias_peak_and_holidays():
    card = pricing.rate("deepseek-v4-flash", NOW)
    assert card.cost(USAGE) == 2_880_000
    assert card.period == "peak_provisional"
    assert (
        pricing.rate("deepseek-flash", NOW, holidays=frozenset({"2026-10-15"})).cost(USAGE)
        == 1_440_000
    )
    assert pricing.rate("unknown", NOW) is None
    assert pricing.rate("local", NOW, local=True).cost(USAGE) == 0
    assert pricing.points(2_880_000) == 10
    with pytest.raises(ValueError):
        pricing.points(True)


def test_package_full_consumption_stress_floor():
    packages = pricing.catalog()["packages"]
    assert [p["stress_margin_bps"] for p in packages] == [6700, 6700, 6535, 6370]
    assert all(p["allowed"] for p in packages)
    assert pricing.package(95_000_000_000, 100000, 10000)["stress_margin_bps"] == 6178
    assert not pricing.package(90_000_000_000, 100000, 10000)["allowed"]
    assert not pricing.package(100_000_000_000, 100000, 11000)["allowed"]


def test_aggregate_round_once_and_do_not_touch_wallet(meter):
    service, _, pool = meter
    tid = task(service)
    for cid in ("a", "b", "c"):
        call(service, tid, cid, {"uncached_input_tokens": 10})
    row = service.finish(tid)
    assert row["simulated_points"] == 1
    assert row["total_cost"] == 60000
    assert service.view(row)["charged"] == 0
    with pool.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM credit_events").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM credit_lots").fetchone()[0] == 0


def test_retry_cancel_failure_costs_and_idempotent_finish(meter):
    service, _, _ = meter
    tid = task(service)
    call(service, tid, "failed-attempt", failed=True)
    call(service, tid, "success")
    row = service.finish(tid, "cancelled")
    assert row["total_cost"] == 5_760_000
    assert row["billable_cost"] == 2_880_000
    assert row["simulated_points"] == 10
    assert service.finish(tid) == row
    other = task(service, key="failure")
    call(service, other, "failed-task-call")
    assert service.finish(other, "failed")["simulated_points"] == 0
    assert service.report()["estimated_cost_nano"] == 8_640_000


def test_missing_usage_reconciliation_and_24h_release(meter):
    service, now, _ = meter
    tid = task(service)
    call(service, tid, usage=None)
    assert service.finish(tid)["status"] == "pending"
    service.finish_call(tid, "call", USAGE)
    assert service.finish(tid)["simulated_points"] == 10
    other = task(service, key="uncertain")
    call(service, other, "uncertain-call", usage=None)
    service.finish(other)
    now[0] += 86401
    assert service.expire() == 1
    with service.repo.transaction(other) as tx:
        assert tx.task(other)["simulated_points"] == 0
        assert tx.task(other)["status"] == "expired"
        assert tx.calls(other)[0]["status"] == "unverified"
    # Late supplier evidence remains a cost, but cannot revive an expired charge.
    service.finish_call(other, "uncertain-call", USAGE)
    assert service.finish(other)["simulated_points"] == 0


def test_task_identity_and_idempotency_without_budget_authorization(meter):
    service, now, _ = meter
    q = service.create_task("one", APP, "task")
    assert service.create_task("one", APP, "task")["id"] == q["id"]
    assert service.create_task("other", APP, "task")["id"] != q["id"]
    now[0] += 301
    service.start(q["id"])
    session = service.session("one", APP)
    assert service.identity(session["token"])["application_id"] == APP
    assert service.identity("invalid") is None
    now[0] += 3601
    assert service.identity(session["token"]) is None


def test_concurrent_calls_are_recorded_without_budget_gate_or_charge_cap(meter):
    service, _, pool = meter
    tid = task(service)
    # Simulate a migrated task that used to have a 200-point ceiling.
    with service.repo.transaction(tid) as tx:
        tx.update(tid, {"budget": 200})

    def record(index):
        cid = f"call-{index}"
        assert service.begin_call(tid, cid, "deepseek-flash", "ds", 15000, 0)
        service.finish_call(tid, cid, {"uncached_input_tokens": 15000})

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(record, range(4)))
    row = service.finish(tid)
    assert row["simulated_points"] == 400
    assert row["status"] == "completed"
    assert "budget" not in service.view(row)
    assert "would_exceed" not in service.view(row)
    with service.repo.transaction(tid) as tx:
        assert len(tx.calls(tid)) == 4
    with pool.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM credit_events").fetchone()[0] == 0


def test_callback_groups_nested_calls_and_detached_work(meter):
    service, _, _ = meter
    callback = CostCallback(service, "deepseek-flash", "ds", True, APP, 1)
    with task_scope(service, APP, identity={"account_key": "one", "application_id": APP}) as root:
        for _ in range(2):
            rid = uuid4()
            callback.on_chat_model_start(
                {}, [[HumanMessage(content="private message")]], run_id=rid
            )
            result = LLMResult(
                generations=[
                    [
                        ChatGeneration(
                            message=AIMessage(
                                content="private reply",
                                usage_metadata={
                                    "input_tokens": 1000,
                                    "output_tokens": 100,
                                    "total_tokens": 1100,
                                },
                            )
                        )
                    ]
                ]
            )
            callback.on_llm_end(result, run_id=rid)
    with service.repo.transaction(root.id) as tx:
        assert len(tx.calls(root.id)) == 2
        assert tx.task(root.id)["simulated_points"] == 19
        assert "private" not in str(tx.calls(root.id))
    rid = uuid4()
    callback.on_chat_model_start({}, [[HumanMessage(content="background")]], run_id=rid)
    callback.on_llm_error(RuntimeError("network"), run_id=rid)
    assert service.report()["unlinked_tasks"] == 1
    assert service.report()["pending_calls"] == 1
    assert service.report()["commercial_ready"] is False


def test_financial_metadata_allocates_actual_revenue_only_on_consumption(meter):
    from types import SimpleNamespace

    from octop.infra.credits.service import CreditService
    from octop.infra.db.repos.credits import CreditRepo

    service, _, pool = meter
    wallet = CreditService(
        SimpleNamespace(credit_repo=CreditRepo(pool)), "https://test.wanx", "one"
    )
    paid = wallet.grant(
        request_id="order",
        expires_at=None,
        kind="paid",
        credits=100000,
        source_ref="order:one",
        reason="fixture",
        actor="test",
    )
    bonus = wallet.grant(
        request_id="bonus",
        kind="gift",
        credits=10000,
        expires_at=None,
        source_ref="bonus:one",
        reason="fixture",
        actor="test",
    )
    service.repo.attach_order(paid["lot_id"], "order:one", "paid", 100_000_000_000, 110000)
    service.repo.attach_order(bonus["lot_id"], "order:one", "paid", 100_000_000_000, 110000)
    assert service.report()["allocated_revenue_nano"] == 0
    r = wallet.reserve(
        request_id="reserve",
        application_id=APP,
        task_id="test",
        description="fixture",
        budget=11000,
        ttl_seconds=900,
    )["reservation"]["reservation_id"]
    wallet.transition(request_id="start", reservation_id=r, action="start", application_id=APP)
    wallet.transition(
        request_id="settle", reservation_id=r, action="settle", application_id=APP, credits=11000
    )
    assert service.report()["allocated_revenue_nano"] == 10_000_000_000
    wallet.transition(
        request_id="refund",
        reservation_id=r,
        action="refund",
        application_id=APP,
        credits=11000,
        reason="fixture",
    )
    assert service.report()["allocated_revenue_nano"] == 0
    with pytest.raises(ValueError):
        service.repo.attach_order(paid["lot_id"], "order:one", "paid", 95_000_000_000, 110000)


async def test_task_needs_no_quote_and_internal_identity_never_reaches_harness(meter, monkeypatch):
    from types import SimpleNamespace

    from octop.infra.credits.runtime import metered_stream

    service, _, pool = meter
    monkeypatch.setenv("WANX_MODEL_GATEWAY_URL", "http://127.0.0.1:1")

    class Registry:
        _repos = SimpleNamespace(db=pool)

        def get_row(self, agent_id):
            return SimpleNamespace(application_id=APP, user_id=1)

        @metered_stream
        async def stream(self, agent_id, request):
            assert request == {"thread_id": "fixture-thread"}
            yield {"type": "done"}

    request = {
        "thread_id": "fixture-thread",
        "_meter_identity": {"account_key": "one", "application_id": APP},
    }
    assert [c async for c in Registry().stream("agent", request)] == [{"type": "done"}]
    assert service.repo.tasks("one")[0]["status"] == "completed"


def test_recording_failure_does_not_block_or_mask_application_errors(meter, monkeypatch):
    service, _, _ = meter

    def broken(*args, **kwargs):
        raise RuntimeError("statistics unavailable")

    monkeypatch.setattr(service, "create_task", broken)
    with task_scope(service, APP):
        pass
    with pytest.raises(ValueError, match="application failure"), task_scope(service, APP):
        raise ValueError("application failure")
    monkeypatch.undo()
    monkeypatch.setattr(service, "finish", broken)
    with task_scope(service, APP):
        pass
    with pytest.raises(ValueError, match="application failure"), task_scope(service, APP):
        raise ValueError("application failure")

"""Official application tariffs and integer token-cost arithmetic.

Costs use nano-yuan (1 CNY = 10**9 units). No model credentials live here.
The rate card is a dated snapshot, not a claim about supplier reconciliation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

VERSION = "wanx-token-2026-10-15-v1"
NANO_YUAN = 1_000_000_000
POINT_COST = 300_000  # 0.0003 CNY of billable model cost per point
POINT_REVENUE = 1_000_000  # 1 CNY / 1000 points, before order discounts
ALIASES = {"deepseek-v4-flash": "deepseek-flash", "deepseek-v4-flash-vision-exp": "deepseek-flash"}
APPLICATIONS = {
    "zhijun": ("知君", ("standard", "deep")),
    "centaurai.wanx.zhijun": ("知君", ("standard", "deep")),
    "centaurai.wanx.superadvisors": ("超级参谋团", ("standard",)),
    "centaurai.wanx.dialogue": ("众见", ("standard",)),
    "centaurloop": ("半人马环", ("standard",)),
}


def nonnegative(value: int) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("expected nonnegative integer")
    return value


def points(cost_nano: int) -> int:
    return (nonnegative(cost_nano) + POINT_COST - 1) // POINT_COST


@dataclass(frozen=True)
class Rate:
    model: str
    version: str
    # nano-yuan per token; numerically CNY per million tokens * 1000
    uncached: int
    cache_read: int
    cache_write: int
    output: int
    period: str

    def cost(self, usage: dict[str, int]) -> int:
        # reasoning_tokens is a subset of output_tokens, never added again.
        return sum(
            nonnegative(usage.get(key, 0)) * price
            for key, price in (
                ("uncached_input_tokens", self.uncached),
                ("cache_read_tokens", self.cache_read),
                ("cache_write_tokens", self.cache_write),
                ("output_tokens", self.output),
            )
        )


def rate(
    model: str, timestamp: int, *, local: bool = False, holidays: frozenset[str] | None = None
) -> Rate | None:
    canonical = ALIASES.get(model.split("/")[-1], model.split("/")[-1])
    if local:
        return Rate(canonical, VERSION, 0, 0, 0, 0, "local")
    prices = {"deepseek-flash": (2000, 40, 0, 8000), "deepseek-v4-pro": (9000, 300, 0, 27000)}
    if canonical not in prices or timestamp < 1789315200:  # 2026-09-14 UTC
        return None
    dt = datetime.fromtimestamp(timestamp, ZoneInfo("Asia/Shanghai"))
    peak = dt.weekday() < 5 and (9 <= dt.hour < 12 or 14 <= dt.hour < 18)
    # Without a verified holiday calendar, weekday peak is explicitly provisional.
    provisional = peak and holidays is None
    if holidays is not None and dt.date().isoformat() in holidays:
        peak = False
    values = tuple(x if peak else x // 2 for x in prices[canonical])
    return Rate(
        canonical,
        VERSION,
        values[0],
        values[1],
        values[2],
        values[3],
        "peak_provisional" if provisional else "peak" if peak else "off_peak",
    )


def package(
    net_revenue_nano: int, base: int, bonus: int, *, loss_bps: int = 1000
) -> dict[str, Any]:
    for value in (net_revenue_nano, base, bonus, loss_bps):
        nonnegative(value)
    if not net_revenue_nano or not base:
        raise ValueError("empty package")
    cost = (base + bonus) * POINT_COST * (10000 + loss_bps)
    # Compare integers, never binary floating point at the margin boundary.
    allowed = bonus * 10 <= base and cost <= net_revenue_nano * 4000
    return {
        "base": base,
        "bonus": bonus,
        "net_revenue_nano": net_revenue_nano,
        "stress_margin_bps": 10000 - (cost + net_revenue_nano - 1) // net_revenue_nano,
        "allowed": allowed,
    }


def catalog() -> dict[str, Any]:
    return {
        "version": VERSION,
        "mode": "shadow",
        "payment_enabled": False,
        "points_per_yuan": 1000,
        "applications": [
            {"application_id": app, "name": name, "tiers": tiers}
            for app, (name, tiers) in APPLICATIONS.items()
        ],
        "packages": [
            package(yuan * NANO_YUAN, yuan * 1000, bonus)
            for yuan, bonus in ((10, 0), (50, 0), (100, 5000), (300, 30000))
        ],
        "gifts": {"trial": {"points": 1000, "days": 30}, "box": {"points": 100000, "days": 365}},
    }

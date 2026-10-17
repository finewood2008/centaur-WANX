"""Central WANX account ledger. Application services own all pricing decisions."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from octop.api.deps import current_user, get_server
from octop.infra.credits.access import CreditAuthority
from octop.infra.credits.consumer import account_service
from octop.infra.credits.service import MAX_CREDITS, CreditService, fail
from octop.infra.users.identity import User

router = APIRouter()
admin_router = APIRouter()
Identifier = Annotated[
    str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
]
Credits = Annotated[int, Field(strict=True, ge=1, le=MAX_CREDITS)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: Identifier = Field(
        description="Persist and reuse for retry; changed payload under the same ID returns 409."
    )


class Grant(Input):
    user_id: int = Field(
        strict=True,
        gt=0,
        description="Central login user whose verified WANX subject receives the credit. Never used as the ledger account key.",
    )
    kind: Literal["paid", "gift"]
    credits: Credits
    source_ref: Identifier = Field(
        description="Globally unique verified payment order or gift issuance reference, namespaced by source."
    )
    expires_at: int | None = Field(
        default=None,
        strict=True,
        gt=0,
        description="Gift expiry Unix seconds; paid credits cannot expire.",
    )
    reason: str = Field(
        min_length=1,
        max_length=300,
        description="Operator verification or gift reason; no payment secrets.",
    )


class Reserve(Input):
    application_id: Identifier
    task_id: Identifier = Field(
        description="Stable application task ID; a task can have only one reservation for this account."
    )
    description: str = Field(min_length=1, max_length=300)
    budget: Credits = Field(
        description="User-authorized maximum integer credits; never computed from tokens by this service."
    )
    ttl_seconds: int = Field(default=900, strict=True, ge=60, le=86400)


class Start(Input):
    pass


class Settle(Input):
    credits: int = Field(
        strict=True,
        ge=0,
        le=MAX_CREDITS,
        description="Application-calculated final charge, at most the authorized budget.",
    )


class Release(Input):
    reason: str = Field(min_length=1, max_length=300)


class Refund(Release):
    credits: Credits


class Balance(BaseModel):
    account_id: str
    available: int
    held: int
    paid_available: int
    gift_available: int


class Reservation(BaseModel):
    reservation_id: str
    application_id: str
    task_id: str
    description: str
    status: Literal["reserved", "active", "settled", "released", "expired"]
    budget: int
    charged: int
    refunded: int
    expires_at: int


class Event(BaseModel):
    sequence: int
    event_id: str
    kind: str
    application_id: str | None
    reservation_id: str | None
    available_delta: int
    held_delta: int
    expired_amount: int
    actor: str
    reference: str
    created_at: int


class Mutation(BaseModel):
    balance: Balance
    reservation: Reservation | None = None
    event: Event
    lot_id: str | None = None


def authority(request: Request, response: Response) -> CreditAuthority:
    if "access_token" in request.query_params or not request.headers.get(
        "authorization", ""
    ).lower().startswith("bearer "):
        fail("FORBIDDEN")
    response.headers["Cache-Control"] = "no-store"
    return CreditAuthority.configured()


@router.get("/balance", response_model=Balance, summary="Read the verified WANX account balance")
def balance(
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
) -> dict[str, Any]:
    return config.account(server.services, user.id).balance()


@router.get(
    "/transactions",
    response_model=list[Event],
    summary="Read credit events with a stable sequence cursor",
    description="Application sessions see only their own application events. WANX sessions see the account ledger. Expired balances are reconciled before reading.",
)
def transactions(
    after: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
) -> list[dict[str, Any]]:
    app_id = None if user.application_id == "wanx" else user.application_id
    return config.account(server.services, user.id).events(after, limit, app_id)


@router.post(
    "/reservations",
    response_model=Mutation,
    summary="Authorize and reserve a task budget",
    description="WANX-scoped user session only. The client must present the application quote for explicit user approval. Application-scoped sessions cannot authorize their own budgets.",
)
def reserve(
    body: Reserve,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
) -> dict[str, Any]:
    if user.application_id != "wanx":
        fail("FORBIDDEN")
    config.application(server.services, user, body.application_id)
    return config.account(server.services, user.id).reserve(**body.model_dump())


@router.get(
    "/reservations/{reservation_id}",
    response_model=Reservation,
    summary="Recover the authoritative task settlement state",
)
def reservation(
    reservation_id: str,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
) -> dict[str, Any]:
    app_id = None if user.application_id == "wanx" else user.application_id
    return config.account(server.services, user.id).reservation(reservation_id, app_id)


def application_action(
    body: Input,
    reservation_id: str,
    action: str,
    user: User,
    server: Any,
    config: CreditAuthority,
    key: str,
) -> dict[str, Any]:
    config.settlement(server.services, user, user.application_id, key)
    return config.account(server.services, user.id).transition(
        reservation_id=reservation_id,
        action=action,
        application_id=user.application_id,
        **body.model_dump(),
    )


@router.post(
    "/reservations/{reservation_id}/start",
    response_model=Mutation,
    summary="Mark a task active before performing paid work",
    description="Requires the account application JWT and its independent server-side application key. Users cannot directly release active work.",
)
def start(
    reservation_id: str,
    body: Start,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
    key: str = Header("", alias="X-WANX-Application-Key"),
) -> dict[str, Any]:
    return application_action(body, reservation_id, "start", user, server, config, key)


@router.post(
    "/reservations/{reservation_id}/settle",
    response_model=Mutation,
    summary="Settle active work and release the unused budget",
)
def settle(
    reservation_id: str,
    body: Settle,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
    key: str = Header("", alias="X-WANX-Application-Key"),
) -> dict[str, Any]:
    return application_action(body, reservation_id, "settle", user, server, config, key)


@router.post(
    "/reservations/{reservation_id}/release",
    response_model=Mutation,
    summary="Release unspent task credits",
    description="WANX users may release only unstarted reservations. Active work requires the matching application service to stop work and release or settle first.",
)
def release(
    reservation_id: str,
    body: Release,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
    key: str = Header("", alias="X-WANX-Application-Key"),
) -> dict[str, Any]:
    if user.application_id == "wanx":
        return config.account(server.services, user.id).transition(
            reservation_id=reservation_id,
            action="release",
            application_id=None,
            **body.model_dump(),
        )
    return application_action(body, reservation_id, "release", user, server, config, key)


@router.post(
    "/reservations/{reservation_id}/refund",
    response_model=Mutation,
    summary="Refund a settled task to its original credit lots",
    description="Matching application service only. Cumulative refund cannot exceed the charge. Original gift expiration remains unchanged; expired returns are explicit in the ledger.",
)
def refund(
    reservation_id: str,
    body: Refund,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
    key: str = Header("", alias="X-WANX-Application-Key"),
) -> dict[str, Any]:
    return application_action(body, reservation_id, "refund", user, server, config, key)


@admin_router.post(
    "/grants",
    response_model=Mutation,
    summary="Record an operator-verified payment or gift",
    description="Central WANX admin only. This is an audited manual posting API, NOT an online payment callback. Verify payment externally first. Source references are globally unique.",
)
def grant(
    body: Grant,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
    config: CreditAuthority = Depends(authority),
) -> dict[str, Any]:
    if not user.is_admin or user.application_id != "wanx":
        fail("FORBIDDEN")
    return config.account(server.services, body.user_id).grant(
        actor="admin:" + str(user.id), **body.model_dump(exclude={"user_id"})
    )


async def consumer_ledger(
    request: Request, response: Response, server: Any = Depends(get_server)
) -> CreditService:
    if "access_token" in request.query_params:
        fail("FORBIDDEN")
    response.headers["Cache-Control"] = "no-store"
    return await account_service(server.services, request.headers)


@router.get(
    "/account/balance",
    response_model=Balance,
    summary="Read balance using verified Consumer account",
)
def consumer_balance(ledger: CreditService = Depends(consumer_ledger)) -> dict[str, Any]:
    return ledger.balance()


@router.get(
    "/account/transactions",
    response_model=list[Event],
    summary="Read unified Consumer account ledger",
)
def consumer_transactions(
    after: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    ledger: CreditService = Depends(consumer_ledger),
) -> list[dict[str, Any]]:
    return ledger.events(after, limit, None)


@router.get(
    "/account/reservations/{reservation_id}",
    response_model=Reservation,
    summary="Read Consumer account task details",
)
def consumer_reservation(
    reservation_id: str,
    ledger: CreditService = Depends(consumer_ledger),
) -> dict[str, Any]:
    return ledger.reservation(reservation_id)


# Shadow task APIs do not grant, reserve, or debit spendable credits.
from octop.infra.credits import pricing  # noqa: E402
from octop.infra.credits.metering import Meter  # noqa: E402
from octop.infra.db.repos.metering import MeterRepo  # noqa: E402


@router.get("/account/meter-session")
def meter_session(
    application_id: Identifier, ledger: CreditService = Depends(consumer_ledger)
) -> dict[str, Any]:
    if application_id not in pricing.APPLICATIONS:
        fail("INVALID")
    return Meter(MeterRepo(ledger.repo.db)).session(ledger.key, application_id)


@router.get("/account/tasks")
def meter_tasks(ledger: CreditService = Depends(consumer_ledger)) -> list[dict[str, Any]]:
    meter = Meter(MeterRepo(ledger.repo.db))
    meter.expire()
    return [meter.view(row) for row in meter.repo.tasks(ledger.key)]


@router.get("/account/tasks/{task_id}")
def meter_task(
    task_id: Identifier, ledger: CreditService = Depends(consumer_ledger)
) -> dict[str, Any]:
    meter = Meter(MeterRepo(ledger.repo.db))
    with meter.repo.transaction(task_id) as tx:
        row = tx.task(task_id)
        if not row or row["account_key"] != ledger.key:
            fail("NOT_FOUND")
        # No procurement prices, prompt text, provider keys or account identifiers.
        return {**meter.view(row), "call_count": len(tx.calls(task_id))}


@admin_router.get("/token-pricing")
def token_pricing(user: User = Depends(current_user)) -> dict[str, Any]:
    if not user.is_admin or user.application_id != "wanx":
        fail("FORBIDDEN")
    return pricing.catalog()


@admin_router.get("/token-report")
def token_report(
    user: User = Depends(current_user), server: Any = Depends(get_server)
) -> dict[str, Any]:
    if not user.is_admin or user.application_id != "wanx":
        fail("FORBIDDEN")
    meter = Meter(MeterRepo(server.services.db))
    meter.expire()
    return meter.report()


class PackagePreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    net_revenue_fen: int = Field(strict=True, gt=0, le=100_000_000)
    base_points: int = Field(strict=True, gt=0, le=100_000_000)
    bonus_points: int = Field(strict=True, ge=0, le=100_000_000)


@admin_router.post("/token-pricing/preview")
def preview_package(body: PackagePreview, user: User = Depends(current_user)) -> dict[str, Any]:
    if not user.is_admin or user.application_id != "wanx":
        fail("FORBIDDEN")
    return pricing.package(body.net_revenue_fen * 10_000_000, body.base_points, body.bonus_points)


class OrderMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")
    order_ref: Identifier
    funding: Literal["paid", "trial", "box", "campaign"]
    net_revenue_fen: int = Field(strict=True, ge=0, le=100_000_000)
    order_points: int = Field(strict=True, gt=0, le=100_000_000)


@admin_router.post("/lots/{lot_id}/order-metadata")
def attach_order_metadata(
    lot_id: Identifier,
    body: OrderMetadata,
    user: User = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    if not user.is_admin or user.application_id != "wanx":
        fail("FORBIDDEN")
    if (body.funding == "paid") != (body.net_revenue_fen > 0):
        fail("INVALID")
    try:
        MeterRepo(server.services.db).attach_order(
            lot_id,
            body.order_ref,
            body.funding,
            body.net_revenue_fen * 10_000_000,
            body.order_points,
        )
    except ValueError:
        fail("CONFLICT")
    return {"recorded": True, "points_granted": 0}

"""Platform policy and dispatch. One credential maps to one fixed account."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field

from octop.infra.dialogue.contracts import DialogueError, Generation
from octop.infra.dialogue.ledger import Ledger
from octop.infra.dialogue.upstream import SYSTEM, ModelRoute, generate


class Account(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    token_env: str
    region: str
    models: list[str]
    budget: int = Field(ge=0)
    concurrency: int = Field(default=3, ge=1, le=6)
    enabled: bool = True


class GatewayConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    total_budget: int = Field(gt=0)
    total_concurrency: int = Field(default=12, ge=1, le=200)
    models: list[ModelRoute]
    accounts: list[Account]


class GatewayService:
    def __init__(self, config: GatewayConfig, ledger: Ledger, client: httpx.AsyncClient) -> None:
        self.config, self.ledger, self.client = config, ledger, client
        if len({m.id for m in config.models}) != len(config.models) or len(
            {a.id for a in config.accounts}
        ) != len(config.accounts):
            raise ValueError("duplicate model/account id")
        tokens = [os.environ.get(a.token_env, "") for a in config.accounts if a.enabled]
        if any(len(t) < 32 for t in tokens) or len(set(tokens)) != len(tokens):
            raise ValueError("enabled accounts need unique tokens of at least 32 characters")

    def authenticate(self, authorization: str | None) -> Account:
        token = (authorization or "").removeprefix("Bearer ")
        for account in self.config.accounts:
            expected = os.environ.get(account.token_env, "")
            if account.enabled and expected and hmac.compare_digest(token, expected):
                return account
        raise DialogueError("UNAUTHORIZED", 401)

    def models(self, account: Account) -> list[dict[str, Any]]:
        return [m.public() for m in self.config.models if self.available(account, m)]

    def available(self, account: Account, model: ModelRoute) -> bool:
        return bool(
            model.verified
            and model.id in account.models
            and account.region in model.regions
            and os.environ.get(model.key_env)
        )

    async def quota(self, account: Account) -> dict[str, int]:
        return await asyncio.to_thread(self.ledger.quota, account.id, account.budget)

    async def prepare(self, account: Account, body: Generation) -> AsyncIterator[dict[str, Any]]:
        route = next(
            (m for m in self.config.models if m.id == body.model and self.available(account, m)),
            None,
        )
        if route is None:
            raise DialogueError("MODEL_UNAVAILABLE", 403)
        size = sum(len(m.content.encode()) for m in body.messages)
        if size > route.max_input_bytes or body.messages[-1].role != "user":
            raise DialogueError("CONTEXT_LIMIT", 413)
        # UTF-8 byte count plus envelope allowance is a conservative input-token bound.
        reserve = (
            size + len(SYSTEM.encode()) + 64 * (len(body.messages) + 1)
        ) * route.input_units + route.max_output_tokens * route.output_units
        await asyncio.to_thread(
            self.ledger.reserve,
            account=account.id,
            request_id=body.request_id,
            fingerprint=hashlib.sha256(body.model_dump_json().encode()).hexdigest(),
            model=route.id,
            amount=reserve,
            budget=account.budget,
            total_budget=self.config.total_budget,
            concurrency=account.concurrency,
            total_concurrency=self.config.total_concurrency,
        )
        return self._stream(account, route, body)

    async def _stream(
        self, account: Account, route: ModelRoute, body: Generation
    ) -> AsyncIterator[dict[str, Any]]:
        charge: int | None = None
        input_tokens: int | None = None
        output_tokens: int | None = None
        settled = False
        try:
            async with asyncio.timeout(180):
                async for item in generate(route, body, self.client):
                    if item["type"] == "rejected":
                        if item["status"] in {400, 401, 403, 404, 422, 429}:
                            charge = 0
                    elif item["type"] == "usage":
                        input_tokens, output_tokens = item["input_tokens"], item["output_tokens"]
                        if (
                            input_tokens is not None
                            and output_tokens is not None
                            and input_tokens >= 0
                            and output_tokens >= 0
                        ):
                            charge = (
                                input_tokens * route.input_units
                                + output_tokens * route.output_units
                            )
                    else:
                        yield item
            accounting_state = await asyncio.to_thread(
                self.ledger.settle,
                account.id,
                body.request_id,
                charge=charge,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
            settled = True
            quota = await self.quota(account)
            yield {
                "type": "done",
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
                "quota": quota,
                "accounting": "pending" if accounting_state == "pending" else "reported",
            }
        except DialogueError as exc:
            yield {"type": "error", "code": exc.code}
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError):
            yield {"type": "error", "code": "UPSTREAM_UNAVAILABLE"}
        finally:
            if not settled:
                task = asyncio.create_task(
                    asyncio.to_thread(
                        self.ledger.settle,
                        account.id,
                        body.request_id,
                        charge=charge,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                    )
                )
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    await task
                    raise

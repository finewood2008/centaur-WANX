"""Narrow a genuine WANX login to an explicitly granted product scope."""

from __future__ import annotations

import time
from dataclasses import replace
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict

from octop.api.deps import (
    InvalidToken,
    TokenExpired,
    decode_token,
    extract_raw_token,
    get_server,
    resolve_user_from_token,
    sign_token,
)
from octop.api.routers.auth import _user_json
from octop.infra.applications.service import assert_product_login
from octop.infra.errors import ErrorCode, OctopError

router = APIRouter()


class ApplicationExchangeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    application_id: Literal["super-advisory"]


class ApplicationExchangeUser(BaseModel):
    id: int
    username: str
    role: str
    application_id: Literal["super-advisory"]
    display_name: str | None = None
    locale: str
    permissions: list[str]


class ApplicationExchangeResponse(BaseModel):
    access_token: str
    token_type: Literal["Bearer"]
    expires_in: int
    user: ApplicationExchangeUser


@router.post(
    "/application/exchange",
    summary="Exchange a WANX login for an authorized application session",
    response_model=ApplicationExchangeResponse,
)
def exchange_application(
    body: ApplicationExchangeBody,
    request: Request,
    response: Response,
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    # Deliberately require the actual bearer JWT, not cached request identity,
    # request-provided user/role fields, or a URL query credential.
    raw = extract_raw_token(authorization=request.headers.get("authorization"))
    if not raw:
        raise OctopError.localized(ErrorCode.AUTH_FAILED)
    secret = server.services.secret_repo.get("jwt")
    if not secret:
        raise OctopError.localized(ErrorCode.INTERNAL_ERROR)
    try:
        payload = decode_token(secret, raw)
    except TokenExpired as exc:
        raise OctopError.localized(ErrorCode.TOKEN_EXPIRED) from exc
    except (InvalidToken, ValueError, TypeError) as exc:
        raise OctopError.localized(ErrorCode.AUTH_FAILED) from exc
    if payload.get("application_id", "wanx") != "wanx":
        raise OctopError.localized(ErrorCode.FORBIDDEN)
    if type(payload.get("sub")) is not int or type(payload.get("exp")) is not int:
        raise OctopError.localized(ErrorCode.AUTH_FAILED)
    user = resolve_user_from_token(server, raw)
    assert_product_login(server.services, user.id, body.application_id)
    scoped = replace(user, application_id=body.application_id)
    ttl = min(
        int(server.services.config.access_token_ttl_seconds),
        payload["exp"] - int(time.time()),
    )
    if ttl <= 0:
        raise OctopError.localized(ErrorCode.TOKEN_EXPIRED)
    token = sign_token(
        secret,
        sub=scoped.id,
        uname=scoped.username,
        role=scoped.role,
        ttl_seconds=ttl,
        application_id=body.application_id,
    )
    # A second boundary crossing while signing must never extend the parent.
    if decode_token(secret, token)["exp"] > payload["exp"]:
        raise OctopError.localized(ErrorCode.TOKEN_EXPIRED)
    response.headers["Cache-Control"] = "no-store"
    return {
        "access_token": token,
        "token_type": "Bearer",
        "expires_in": ttl,
        "user": _user_json(scoped, locale=scoped.locale),
    }

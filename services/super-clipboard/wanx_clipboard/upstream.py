"""The only storage/auth adapter. No Octop imports, database or object paths."""

from __future__ import annotations

import hashlib
import re
from typing import Any

import httpx

PREFIX = "/api/personal-space"
CHUNK_SIZE = 1024 * 1024


class BusinessError(Exception):
    def __init__(self, code: str, status: int = 400):
        self.code, self.status = code, status
        super().__init__(code)


def valid_id(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch("[a-f0-9]{32}", value):
        raise BusinessError("SPACE_INVALID_ID")
    return value


def validate_name(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or len(value.encode("utf-8")) > 240
        or any(ord(c) < 32 or c in '/\\:*?"<>|' for c in value)
        or value in {".", ".."}
    ):
        raise BusinessError("SPACE_INVALID_NAME")
    return value


class WanxAPI:
    def __init__(self, client: httpx.Client, authorization: str):
        self.client = client
        self.authorization = authorization
        self.renewed = None

    def request(
        self,
        route: str,
        method: str = "GET",
        *,
        body: Any = None,
        data: bytes | None = None,
        token: str = "",
        raw: bool = False,
    ) -> Any:
        headers = {"Authorization": self.authorization}
        if token:
            headers["X-Space-Link"] = token
        if data is not None:
            headers.update(
                {
                    "Content-Type": "application/octet-stream",
                    "X-Content-SHA256": hashlib.sha256(data).hexdigest(),
                }
            )
        try:
            response = self.client.request(method, route, headers=headers, json=body, content=data)
        except httpx.HTTPError as exc:
            raise BusinessError("CLIPBOARD_UPSTREAM_UNAVAILABLE", 503) from exc
        if not 200 <= response.status_code < 300:
            try:
                code = response.json().get("detail", {}).get("code")
            except (ValueError, AttributeError):
                code = None
            raise BusinessError(code or "CLIPBOARD_UPSTREAM_FAILED", response.status_code)
        renewed = response.headers.get("x-octop-access-token")
        if renewed:
            self.renewed = renewed
            self.authorization = "Bearer " + renewed
        return response if raw else (response.json() if response.content else None)

    def owner(self) -> str:
        if not self.authorization.startswith("Bearer "):
            raise BusinessError("ACCOUNT_LOGIN_REQUIRED", 401)
        result = self.request("/api/auth/me")
        return str(result["id"])

    def folder(self) -> str:
        result = self.request(
            PREFIX + "/app-folders",
            "POST",
            body={"application": "wanx.clipboard", "name": "超级剪贴板"},
        )
        return result["id"]

    def metadata(self, item_id: str) -> dict:
        return self.request(PREFIX + "/files/" + valid_id(item_id))

    def upload(
        self, item_id: str, parent: str, name: str, size: int, space_id: str = "personal"
    ) -> dict:
        return self.request(
            PREFIX + "/uploads",
            "POST",
            body={
                "id": valid_id(item_id),
                "parent": parent,
                "name": name,
                "size": size,
                "space_id": space_id,
            },
        )

    def read(self, item_id: str, offset: int, length: int) -> bytes:
        response = self.request(
            PREFIX + f"/files/{valid_id(item_id)}/content?offset={offset}&length={length}", raw=True
        )
        if hashlib.sha256(response.content).hexdigest() != response.headers.get("x-content-sha256"):
            raise BusinessError("SPACE_CHUNK_INVALID", 409)
        return response.content

    def agent(self, token: str, body: dict) -> dict:
        return self.request(PREFIX + "/connection-access", "POST", token=token, body=body)

    def check_agent(self, token: str, args: dict) -> dict:
        if not token:
            raise BusinessError("SPACE_APPROVAL_REQUIRED", 403)
        if args.get("grant_id"):
            raise BusinessError("SPACE_LINK_SCOPE", 403)
        access = self.agent(token, {"action": "access"})
        policy = access.get("sync", {})
        options = policy.get("options", {})
        if any(
            options.get(k)
            for k in ("context", "progress", "outcome", "project_memory", "user_memory")
        ):
            if not args.get("task_id"):
                raise BusinessError("SPACE_CONTEXT_REQUIRED", 409)
            if args.get("policy_revision") != policy["revision"]:
                raise BusinessError("SPACE_SYNC_POLICY_CHANGED", 409)
            # stat is an existing read operation: the WANX server performs the full
            # task/context/active-state check, without opening clipboard scope.
            self.agent(
                token,
                {
                    "action": "stat",
                    "task_id": args["task_id"],
                    "policy_revision": args["policy_revision"],
                },
            )
        return access

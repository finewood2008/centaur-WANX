"""The only storage/auth adapter. No Octop imports, database or object paths."""

from __future__ import annotations

import hashlib
import re
from typing import Any

import httpx

PREFIX = "/api/personal-space"
CHUNK_SIZE = 1024 * 1024
APPLICATION_ID = "wanx.clipboard"


def _child_route_allowed(method: str, route: str, body: Any) -> bool:
    """Small fixed adapter; the runtime additionally restricts object ownership.

    This is deliberately not a general authenticated proxy. Export exceptions
    are authorized by the runtime from the exact admitted parent export body.
    """
    if route == PREFIX + "/app-folders":
        return method == "POST" and body == {
            "application": APPLICATION_ID, "name": "超级剪贴板",
        }
    if route == PREFIX + "/uploads":
        return method == "POST" and isinstance(body, dict) and body.get("space_id") == "personal"
    if route == PREFIX + "/connection-access":
        return method == "POST" and isinstance(body, dict) and body.get("action") in {"access", "stat"}
    item = "[a-f0-9]{32}"
    patterns = {
        "GET": rf"(?:uploads/{item}|files/{item}(?:/content\?offset=[0-9]+&length=[0-9]+)?)",
        "PUT": rf"uploads/{item}\?offset=[0-9]+",
        "POST": rf"uploads/{item}/complete",
        "DELETE": rf"(?:uploads|files|trash)/{item}",
    }
    pattern = patterns.get(method)
    return bool(pattern and re.fullmatch(re.escape(PREFIX) + "/" + pattern, route))


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
    def __init__(self, client: httpx.Client, authorization: str, *, context=None):
        self.client = client
        self.context = context
        self.authorization = "" if context is not None else authorization
        self.renewed = None

    @property
    def local_data(self) -> bool:
        return self.context is not None

    def require_live(self) -> None:
        if self.context is not None:
            self.context.require_live()

    def agent_token(self, presented: str) -> str:
        if self.context is None:
            return presented
        token = self.context.claims["headers"]["spaceLink"]
        if not isinstance(token, str) or not token or token != presented:
            raise BusinessError("SPACE_APPROVAL_REQUIRED", 403)
        return token

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
        self.require_live()
        headers = {} if self.local_data else {"Authorization": self.authorization}
        if token:
            headers["X-Space-Link"] = token
        if data is not None:
            headers.update(
                {
                    "Content-Type": "application/octet-stream",
                    "X-Content-SHA256": hashlib.sha256(data).hexdigest(),
                }
            )
        if self.local_data:
            if not _child_route_allowed(method, route, body):
                raise BusinessError("LOCAL_DATA_SCOPE_DENIED", 403)
            # Build once, then bind the bytes actually transmitted. Do not inherit
            # this shared HTTP client's cookies, auth or mutable default headers.
            request = httpx.Request(
                method, self.client.base_url.join(route), headers=headers, json=body, content=data,
            )
            child_headers = self.context.child_headers(
                audience="octop", method=method, raw_target=request.url.raw_path.decode("ascii"),
                headers=dict(request.headers), body=request.content,
            )
            request.headers = httpx.Headers(child_headers)
        try:
            if self.local_data:
                response = self.client.send(request, auth=None, follow_redirects=False)
            else:
                response = self.client.request(method, route, headers=headers, json=body, content=data)
        except httpx.HTTPError as exc:
            raise BusinessError("CLIPBOARD_UPSTREAM_UNAVAILABLE", 503) from exc
        self.require_live()
        if not 200 <= response.status_code < 300:
            try:
                code = response.json().get("detail", {}).get("code")
            except (ValueError, AttributeError):
                code = None
            raise BusinessError(code or "CLIPBOARD_UPSTREAM_FAILED", response.status_code)
        renewed = response.headers.get("x-octop-access-token")
        if renewed and not self.local_data:
            self.renewed = renewed
            self.authorization = "Bearer " + renewed
        return response if raw else (response.json() if response.content else None)

    def owner(self) -> str:
        if self.context is not None:
            self.require_live()
            # Separate domain from every legacy numeric UID, even if a future
            # identity mapping happens to reuse a former account's native UID.
            return "centuarai.local-data.clipboard.v1:" + self.context.principal_namespace
        if not self.authorization.startswith("Bearer "):
            raise BusinessError("ACCOUNT_LOGIN_REQUIRED", 401)
        result = self.request("/api/auth/me")
        return str(result["id"])

    def folder(self) -> str:
        result = self.request(
            PREFIX + "/app-folders",
            "POST",
            body={"application": APPLICATION_ID, "name": "超级剪贴板"},
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

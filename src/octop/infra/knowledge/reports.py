"""Builder's trusted adapter over existing WANX knowledge ownership semantics.

Bindings are internal settings, never supplied by generated applications. No public
route, request model, or response model is added to the WANX knowledge API.
"""

from __future__ import annotations

import hashlib
import json
import threading
from typing import Any

REPORT_BINDING_PREFIX = "builder.private-report.library."
REPORT_LOCK = threading.RLock()


class PrivateReports:
    def __init__(self, services: Any) -> None:
        from octop.infra.knowledge.service import KnowledgeService

        self.services = services
        self.knowledge = KnowledgeService(services)

    def _binding(self, kb_id: str) -> dict[str, Any] | None:
        raw = self.services.settings_repo.get(REPORT_BINDING_PREFIX + kb_id)
        return json.loads(raw) if raw else None

    def _bases(self, user: Any, app: str, environment: str) -> list[Any]:
        result = []
        for base in self.knowledge.list_visible_bases(
            actor_user_id=user.id, is_admin=user.role == "admin"
        ):
            binding = self._binding(base.id)
            if binding and binding == {
                "app": app,
                "environment": environment,
                "owner": base.owner_user_id,
            }:
                if base.shared:
                    raise PermissionError("report libraries must remain private")
                result.append(base)
        return result

    def _own_base(self, user: Any, app: str, environment: str) -> Any:
        for base in self._bases(user, app, environment):
            if base.owner_user_id == user.id:
                return base
        base = self.knowledge.create_base(
            owner_user_id=user.id,
            name="应用私有报告",
            shared=False,
            default_open=False,
            max_documents=0,
        )
        self.services.settings_repo.set(
            REPORT_BINDING_PREFIX + base.id,
            json.dumps(
                {
                    "app": app,
                    "environment": environment,
                    "owner": user.id,
                }
            ),
        )
        return base

    def _document(self, user: Any, app: str, environment: str, doc_id: str) -> tuple[Any, Any]:
        doc = self.services.knowledge_repo.get_document(doc_id)
        if doc is None:
            raise LookupError("report not found")
        base = next(
            (base for base in self._bases(user, app, environment) if base.id == doc.kb_id), None
        )
        if base is None or doc.is_dir:
            raise PermissionError("report access denied")
        self.knowledge.get_readable_base(
            base.id, actor_user_id=user.id, is_admin=user.role == "admin"
        )
        return base, doc

    def _summary(self, base: Any, doc: Any) -> dict[str, Any]:
        owner = self.services.user_repo.get(base.owner_user_id)
        return {
            "id": doc.id,
            "title": doc.filename,
            "ownerUserId": base.owner_user_id,
            "ownerName": (getattr(owner, "display_name", "") or getattr(owner, "username", "")),
            "contentHash": doc.content_hash,
        }

    def invoke(
        self, user: Any, app: str, environment: str, method: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        # Re-read identity for every call, including runtimes opened before demotion.
        user = self.services.user_repo.get(user.id)
        if user is None or user.disabled:
            raise PermissionError("account unavailable")
        allowed = {
            "context": set(),
            "list": {"offset", "limit"},
            "get": {"id"},
            "save": {"id", "title", "content", "expectedHash", "operationId"},
            "delete": {"id", "expectedHash"},
        }
        if method not in allowed or not isinstance(params, dict) or set(params) - allowed[method]:
            raise ValueError("invalid report input")
        with REPORT_LOCK:
            if method == "context":
                from octop.infra.knowledge.gate import get_capability

                capability = get_capability(
                    self.services.settings_repo.get, self.services.provider_repo
                )
                return {
                    "user": {"id": user.id, "username": user.username, "role": user.role},
                    "visibility": "all" if user.role == "admin" else "own",
                    "writeAvailable": bool(
                        capability["feature_enabled"] and capability["prerequisites_ok"]
                    ),
                }
            if method == "list":
                offset, limit = params.get("offset", 0), params.get("limit", 100)
                if (
                    type(offset) is not int
                    or offset < 0
                    or type(limit) is not int
                    or not 1 <= limit <= 200
                ):
                    raise ValueError("invalid report pagination")
                items = [
                    self._summary(base, doc)
                    for base in self._bases(user, app, environment)
                    for doc in self.knowledge.list_documents(
                        base.id, actor_user_id=user.id, is_admin=user.role == "admin"
                    )
                    if not doc.is_dir
                ]
                items.sort(key=lambda item: item["id"])
                return {"items": items[offset : offset + limit], "total": len(items)}
            if method == "save" and not params.get("id"):
                operation = params.get("operationId")
                title, content = params.get("title"), params.get("content")
                if not isinstance(operation, str) or not 1 <= len(operation) <= 128:
                    raise ValueError("operationId required")
                if (
                    not isinstance(title, str)
                    or not 1 <= len(title) <= 120
                    or not isinstance(content, str)
                    or len(content.encode()) > 262144
                ):
                    raise ValueError("invalid report text")
                key = (
                    "builder.private-report.operation."
                    + hashlib.sha256(
                        json.dumps([app, environment, user.id, operation]).encode()
                    ).hexdigest()
                )
                fingerprint = hashlib.sha256(
                    json.dumps(params, sort_keys=True).encode()
                ).hexdigest()
                previous = self.services.settings_repo.get(key)
                if previous:
                    receipt = json.loads(previous)
                    if receipt["fingerprint"] != fingerprint:
                        raise ValueError("report operation conflict")
                    return self.invoke(user, app, environment, "get", {"id": receipt["id"]})
                base = self._own_base(user, app, environment)
                # Operation-specific path prevents same-title reports colliding.
                doc = self.knowledge.create_text_document(
                    base.id,
                    actor_user_id=user.id,
                    name=title,
                    format="md",
                    content=content,
                    path=hashlib.sha256(operation.encode()).hexdigest()[:24],
                )
                self.services.settings_repo.set(
                    key, json.dumps({"fingerprint": fingerprint, "id": doc.id})
                )
            else:
                doc_id = params.get("id")
                if not isinstance(doc_id, str) or not doc_id:
                    raise ValueError("report id required")
                base, doc = self._document(user, app, environment, doc_id)
                if method in {"save", "delete"}:
                    if base.owner_user_id != user.id:
                        raise PermissionError("only the report author may change it")
                    if params.get("expectedHash") != doc.content_hash:
                        raise ValueError("report changed; reload before saving")
                    if method == "delete":
                        self.knowledge.delete_document(base.id, doc.id, actor_user_id=user.id)
                        return {"deleted": True}
                    content = params.get("content")
                    if not isinstance(content, str) or len(content.encode()) > 262144:
                        raise ValueError("invalid report text")
                    doc = self.knowledge.update_text_document(
                        base.id, doc.id, actor_user_id=user.id, content=content
                    )
            result = self._summary(base, doc)
            result["content"] = self.knowledge.read_text_document(
                base.id, doc.id, actor_user_id=user.id, is_admin=user.role == "admin"
            )["text"]
            return result

"""Private lease client; services never receive a gateway signing key."""

from __future__ import annotations

import hashlib
import secrets
import threading
import time
from types import MappingProxyType

import httpx

from .observations import header_pairs, observed_headers
from .protocol import (
    DataProtocolError,
    canonical,
    digest,
    encode,
    gateway_proof_digest,
    verify_gateway_lease,
    verify_gateway_request,
)

SCOPE_KEY = "centuarai.local_data"


def freeze(value):
    if isinstance(value, dict):
        return MappingProxyType({key: freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(freeze(item) for item in value)
    return value


def get_context(scope):
    value = scope.get(SCOPE_KEY)
    return value if isinstance(value, GateContext) else None


class BrokerClient:
    def __init__(self, config, *, async_transport=None, sync_transport=None):
        self.config = config
        self._tasks_lock = threading.Lock()
        self._task_operations = {}
        headers = {"X-Centuarai-Native-Audience": config.audience}
        limits = httpx.Limits(max_connections=64, max_keepalive_connections=16)
        self.async_client = httpx.AsyncClient(
            transport=async_transport or httpx.AsyncHTTPTransport(uds=config.broker_socket),
            base_url="http://local-data",
            timeout=0.75,
            trust_env=False,
            follow_redirects=False,
            headers=headers,
            limits=limits,
        )
        self.sync_client = httpx.Client(
            transport=sync_transport or httpx.HTTPTransport(uds=config.broker_socket),
            base_url="http://local-data",
            timeout=0.75,
            trust_env=False,
            follow_redirects=False,
            headers=headers,
            limits=limits,
        )

    @staticmethod
    def result(response):
        if response.status_code != 200 or len(response.content) > 65536:
            raise DataProtocolError("LOCAL_DATA_AUTHORITY_UNAVAILABLE")
        return response.text

    async def call(self, operation, body):
        try:
            return self.result(await self.async_client.post("/v1/" + operation, json=body))
        except httpx.HTTPError:
            raise DataProtocolError("LOCAL_DATA_AUTHORITY_UNAVAILABLE") from None

    def call_sync(self, operation, body):
        try:
            return self.result(self.sync_client.post("/v1/" + operation, json=body))
        except httpx.HTTPError:
            raise DataProtocolError("LOCAL_DATA_AUTHORITY_UNAVAILABLE") from None

    async def observe(self, generation, active_operation_ids):
        """Report a native inventory; this receipt grants no data permission."""
        from .protocol import verify_gateway_observation

        with self._tasks_lock:
            tasks = {
                identifier
                for identifier, native_generation in self._task_operations.items()
                if native_generation == generation
            }
        body = {
            "nativeGateGeneration": generation,
            "gateNonce": secrets.token_urlsafe(32),
            "activeOperationIds": sorted(set(active_operation_ids) | tasks),
        }
        proof = await self.call("observe", body)
        receipt = verify_gateway_observation(
            proof, self.config.gateway_key, int(time.time() * 1000)
        )
        if (
            receipt["audience"] != self.config.audience
            or receipt["gatewayId"] != self.config.gateway_id
            or receipt["nativeGateGeneration"] != generation
            or receipt["gateNonce"] != body["gateNonce"]
            or receipt["requestDigest"] != encode(hashlib.sha256(canonical(body)).digest())
        ):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        return receipt["accepted"]

    async def close(self):
        import asyncio

        await self.async_client.aclose()
        await asyncio.to_thread(self.sync_client.close)


class GateContext:
    def __init__(self, config, broker, claims, gateway_proof, generation):
        self.config, self.broker = config, broker
        self.claims = freeze(claims)
        self.principal_namespace = claims["serviceContext"]["principalNamespace"]
        self.native_generation = generation
        self.proof_digest = gateway_proof_digest(gateway_proof)
        self.gateway_proof = gateway_proof
        self._deadline = 0.0
        self._state = "staging"
        self._closed = False
        self._physical_close_uncertain = False
        self._lock = threading.Lock()
        self.staged = None
        self.authorized_resources = ()

    def _body(self):
        return {
            "operationId": self.claims["operationId"],
            "nativeGateGeneration": self.native_generation,
            "gateNonce": secrets.token_urlsafe(32),
        }

    def _accept(self, proof, body, expected):
        now = int(time.time() * 1000)
        lease = verify_gateway_lease(proof, self.config.gateway_key, now)
        return self._accept_payload(lease, body, expected, now)

    def _accept_payload(self, lease, body, expected, now):
        team = self.claims.get("team")
        if (
            lease["schemaVersion"] != self.claims["schemaVersion"]
            or team is not None
            and lease.get("teamDigest") != digest(_thaw(team))
        ):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        for name in (
            "audience",
            "gatewayId",
            "gatewayGeneration",
            "sessionId",
            "operationId",
            "parentOperationId",
            "ownershipEpoch",
            "principalSecurityVersion",
            "bindingId",
            "bindingRevision",
            "principalId",
            "clientId",
            "applicationId",
            "launchId",
            "resourceId",
            "action",
        ):
            if lease[name] != self.claims[name]:
                raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        if (
            lease["nativeGateGeneration"] != self.native_generation
            or lease["gateNonce"] != body["gateNonce"]
            or lease["gatewayProofDigest"] != self.proof_digest
            or lease["state"] not in expected
            or lease["authorizationVersion"] < self.claims["authorizationVersion"]
        ):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        with self._lock:
            if self._closed and lease["state"] != "closed":
                raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED")
            self._deadline = time.monotonic() + max(0, lease["expiresAtMs"] - now) / 1000
            self._state = lease["state"]
        return lease

    def check_cached(self):
        with self._lock:
            if self._closed or self._physical_close_uncertain or time.monotonic() >= self._deadline:
                raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED")

    async def admit(self):
        body = {
            "gatewayProof": self.gateway_proof,
            "nativeGateGeneration": self.native_generation,
            "gateNonce": secrets.token_urlsafe(32),
        }
        self._accept(await self.broker.call("admit", body), body, {"staging"})

    async def activate(self):
        body = {
            **self._body(),
            "bodySha256": self.claims["bodySha256"],
            "bodyBytes": self.claims["bodyBytes"],
        }
        self._accept(await self.broker.call("activate", body), body, {"active"})

    async def check(self):
        self.check_cached()
        body = self._body()
        self._accept(await self.broker.call("check", body), body, {self._state})

    def require_live(self):
        """Synchronous side-effect guard for existing service worker functions."""
        self.check_cached()
        body = self._body()
        self._accept(self.broker.call_sync("check", body), body, {self._state})
        self.check_cached()

    async def authorize_resources(self, grants):
        """Freeze additional application-resource requirements on this request."""
        from .protocol import grants as validate_grants

        self.check_cached()
        validate_grants(grants)
        body = {**self._body(), "grants": grants}
        proof = await self.broker.call("authorize-resources", body)
        return self._accept_resources(proof, body)

    def authorize_resources_sync(self, grants):
        from .protocol import grants as validate_grants

        self.check_cached()
        validate_grants(grants)
        body = {**self._body(), "grants": grants}
        return self._accept_resources(self.broker.call_sync("authorize-resources", body), body)

    def _accept_resources(self, proof, body):
        from .protocol import verify_gateway_resources
        from .team import merge_grants

        now = int(time.time() * 1000)
        lease = verify_gateway_resources(proof, self.config.gateway_key, now)
        if merge_grants(lease["grants"], body["grants"]) != lease["grants"] or lease[
            "requestDigest"
        ] != encode(hashlib.sha256(canonical(body)).digest()):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        self._accept_payload(lease, body, {"active"}, now)
        self.check_cached()
        self.authorized_resources = freeze(
            merge_grants(_thaw(self.authorized_resources), lease["grants"])
        )
        return self.authorized_resources

    async def closed(self, outcome):
        with self._lock:
            if self._physical_close_uncertain:
                raise DataProtocolError("LOCAL_DATA_UNAVAILABLE")
            self._closed = True
        body = {**self._body(), "outcome": outcome}
        self._accept(await self.broker.call("closed", body), body, {"closed"})

    def mark_physical_close_uncertain(self):
        """Monotonic denial of positive cleanup evidence after an undrained worker."""
        with self._lock:
            self._physical_close_uncertain = True

    @property
    def physical_close_uncertain(self):
        with self._lock:
            return self._physical_close_uncertain

    def _members(self, proof, body):
        from .protocol import verify_gateway_members

        now = int(time.time() * 1000)
        lease = verify_gateway_members(proof, self.config.gateway_key, now)
        if lease["requestDigest"] != digest(body):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        self._accept_payload(lease, body, {"active"}, now)
        self.check_cached()
        return freeze(lease["members"])

    async def team_members(self):
        self.check_cached()
        body = self._body()
        return self._members(await self.broker.call("team-members", body), body)

    def team_members_sync(self):
        self.check_cached()
        body = self._body()
        return self._members(self.broker.call_sync("team-members", body), body)

    def _grants(self, proof, body):
        from .protocol import verify_gateway_grants

        now = int(time.time() * 1000)
        lease = verify_gateway_grants(proof, self.config.gateway_key, now)
        if lease["requestDigest"] != digest(body):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        self._accept_payload(lease, body, {"active"}, now)
        self.check_cached()
        return freeze(lease["grants"])

    async def current_grants(self):
        self.check_cached()
        body = self._body()
        return self._grants(await self.broker.call("resource-grants", body), body)

    def current_grants_sync(self):
        self.check_cached()
        body = self._body()
        return self._grants(self.broker.call_sync("resource-grants", body), body)

    async def start_task(self, *, project_id, task_id, purpose):
        from .protocol import verify_gateway_task

        self.check_cached()
        body = {**self._body(), "projectId": project_id, "taskId": task_id, "taskPurpose": purpose}
        proof = await self.broker.call("task-start", body)
        lease = verify_gateway_task(proof, self.config.gateway_key, int(time.time() * 1000))
        if lease["parentRequestId"] != self.claims["operationId"]:
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        for name in ("projectId", "taskId", "taskPurpose"):
            if lease[name] != body[name]:
                raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        claims = _thaw(self.claims)
        claims.update(operationId=lease["operationId"], parentOperationId=None)
        task = GateTaskContext(
            self.config,
            self.broker,
            claims,
            self.gateway_proof,
            self.native_generation,
            task_identity={
                key: lease[key] for key in ("parentRequestId", "projectId", "taskId", "taskPurpose")
            },
        )
        if lease["grants"] != _thaw(self.authorized_resources):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        task.authorized_resources = freeze(lease["grants"])
        task._accept(proof, body, {"active"})
        with self.broker._tasks_lock:
            self.broker._task_operations[task.claims["operationId"]] = self.native_generation
        self.check_cached()
        return task

    async def read_body(self, limit=2 * 1024 * 1024):
        return await self.staged.read(limit) if self.staged else b""

    def child_headers(self, *, audience, method, raw_target, headers, body: bytes):
        self.require_live()
        if not isinstance(body, bytes):
            raise DataProtocolError()
        clean = dict(header_pairs(headers))
        observation = {
            "audience": audience,
            "transport": "http",
            "method": method,
            "rawTarget": raw_target,
            "headers": observed_headers(headers),
            "bodySha256": encode(hashlib.sha256(body).digest()),
            "bodyBytes": len(body),
        }
        request = {
            **observation,
            "parentOperationId": self.claims["operationId"],
            "nativeGateGeneration": self.native_generation,
            "gateNonce": secrets.token_urlsafe(32),
        }
        proof = self.broker.call_sync("child", request)
        child = verify_gateway_request(proof, self.config.gateway_key, int(time.time() * 1000))
        for name, value in observation.items():
            if child[name] != value:
                raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        for name in (
            "sessionId",
            "principalId",
            "clientId",
            "bindingId",
            "bindingRevision",
            "ownershipEpoch",
            "applicationId",
            "launchId",
            "gatewayGeneration",
            "gatewayId",
            "boxId",
            "boxKeyThumbprint",
            "principalSecurityVersion",
        ):
            if child[name] != self.claims[name]:
                raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        if child["parentOperationId"] != self.claims["operationId"]:
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        if child.get("team") != _thaw(self.claims.get("team")):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        clean["x-centuarai-gateway-proof"] = proof
        clean["content-length"] = str(len(body))
        return clean


def _thaw(value):
    if isinstance(value, (dict, MappingProxyType)):
        return {key: _thaw(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_thaw(item) for item in value]
    return value


class GateTaskContext(GateContext):
    """One bounded Studio task; no HTTP/child-hop/session minting authority."""

    def __init__(self, *args, task_identity, **kwargs):
        super().__init__(*args, **kwargs)
        self.task_identity = freeze(task_identity)

    def _accept(self, proof, body, expected):
        from .protocol import verify_gateway_task

        now = int(time.time() * 1000)
        lease = verify_gateway_task(proof, self.config.gateway_key, now)
        if any(lease[key] != value for key, value in self.task_identity.items()) or lease[
            "grants"
        ] != _thaw(self.authorized_resources):
            raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
        return self._accept_payload(lease, body, expected, now)

    async def check(self):
        self.check_cached()
        body = self._body()
        self._accept(await self.broker.call("task-check", body), body, {"active"})

    def require_live(self):
        self.check_cached()
        body = self._body()
        self._accept(self.broker.call_sync("task-check", body), body, {"active"})
        self.check_cached()

    async def closed(self, outcome):
        with self._lock:
            if self._physical_close_uncertain:
                raise DataProtocolError("LOCAL_DATA_UNAVAILABLE")
            self._closed = True
        body = {**self._body(), "outcome": outcome}
        self._accept(await self.broker.call("task-close", body), body, {"closed"})
        with self.broker._tasks_lock:
            self.broker._task_operations.pop(self.claims["operationId"], None)

    def child_headers(self, **kwargs):
        if kwargs.get("audience") != "semantica" or kwargs.get("method") not in {"GET", "POST"}:
            raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")
        return super().child_headers(**kwargs)

    async def start_task(self, **_kwargs):
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")

    async def authorize_resources(self, _grants):
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")

    def authorize_resources_sync(self, _grants):
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")

    async def team_members(self):
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")

    def team_members_sync(self):
        raise DataProtocolError("LOCAL_DATA_SCOPE_DENIED")

    async def current_grants(self):
        self.check_cached()
        return self.authorized_resources

    def current_grants_sync(self):
        self.check_cached()
        return self.authorized_resources

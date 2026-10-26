"""ASGI gate for HTTP and WebSocket: proof, private admission, staging, live lease."""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import time

from .client import SCOPE_KEY, BrokerClient, GateContext
from .observations import observed_headers, one_header, raw_target
from .protocol import DataProtocolError, verify_gateway_request
from .staging import MAX_BODY, StagedBody


class LocalDataGateMiddleware:
    def __init__(self, app, *, config, authorize=None, broker=None):
        self.app, self.config, self.authorize = app, config, authorize
        self.broker = broker or BrokerClient(config)
        self.generation = secrets.token_urlsafe(32)
        self.active = 0
        self.reserved = 0
        self._operations = set()
        self._report_lock = asyncio.Lock()

    async def _report(self):
        # Serialize reports and snapshot after acquiring the lock: an older
        # in-flight inventory must not overwrite a later cleanup observation.
        async with self._report_lock:
            # Inventory is evidence only. A failed report cannot grant a
            # lease or establish closure; the broker expires its observation.
            with contextlib.suppress(Exception):
                await self.broker.observe(self.generation, tuple(self._operations))

    async def _report_periodically(self):
        while True:
            await self._report()
            await asyncio.sleep(0.5)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            observer = None

            async def lifecycle_send(message):
                nonlocal observer
                if message["type"] == "lifespan.startup.complete":
                    await self._report()
                    observer = asyncio.create_task(self._report_periodically())
                await send(message)

            try:
                await self.app(scope, receive, lifecycle_send)
            finally:
                if observer is not None:
                    observer.cancel()
                    await asyncio.gather(observer, return_exceptions=True)
                await self._report()
                await self.broker.close()
            return
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        if (
            scope["type"] == "http"
            and scope.get("method") == "GET"
            and scope.get("raw_path") == b"/__local-trust/health"
            and not scope.get("query_string")
        ):
            # Fixed readiness metadata only. No native route or identity lookup
            # is invoked; the legacy detailed health endpoints remain gated.
            try:
                async with asyncio.timeout(1):
                    message = await receive()
                if message.get("body") or message.get("more_body"):
                    raise ValueError()
            except (TimeoutError, ValueError):
                await send(
                    {
                        "type": "http.response.start",
                        "status": 400,
                        "headers": [(b"cache-control", b"no-store")],
                    }
                )
                await send({"type": "http.response.body", "body": b""})
                return
            raw = json.dumps(
                {
                    "schemaVersion": 1,
                    "gateVersion": 1,
                    "localDataRequired": True,
                    "audience": self.config.audience,
                    "ready": True,
                }
            ).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"cache-control", b"no-store"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": raw})
            return
        context = None
        staging = None
        worker = guard = disconnect = None
        started = False
        finished = False
        reserved = 0
        outcome = "denied"
        handler_started = False
        try:
            proof = one_header(scope.get("headers", []), "x-centuarai-gateway-proof")
            claims = verify_gateway_request(proof, self.config.gateway_key, int(time.time() * 1000))
            if (
                claims["audience"] != self.config.audience
                or claims["gatewayId"] != self.config.gateway_id
                or claims["boxId"] != self.config.box_id
                or claims["boxKeyThumbprint"] != self.config.box_key_thumbprint
                or claims["transport"] != scope["type"]
                or claims["method"] != scope.get("method", "GET")
                or claims["rawTarget"] != raw_target(scope)
                or claims["headers"]
                != observed_headers(
                    scope.get("headers", []), proof_header="x-centuarai-gateway-proof"
                )
            ):
                raise DataProtocolError("LOCAL_DATA_CONTEXT_CHANGED")
            reserved = claims["bodyBytes"]
            if (
                reserved > MAX_BODY
                or self.active >= 128
                or self.reserved + reserved > 512 * 1024 * 1024
            ):
                reserved = 0
                raise DataProtocolError("LOCAL_DATA_CAPACITY")
            self.active += 1
            self.reserved += reserved
            context = GateContext(self.config, self.broker, claims, proof, self.generation)
            await context.admit()
            self._operations.add(claims["operationId"])
            scope[SCOPE_KEY] = context
            scope.setdefault("state", {})["local_data_required"] = True

            async def watch():
                last = time.monotonic()
                while True:
                    await asyncio.sleep(0.2)
                    context.check_cached()
                    if time.monotonic() - last >= 0.5:
                        await context.check()
                        last = time.monotonic()

            async def checked_send(message):
                nonlocal started, finished
                context.check_cached()
                if message["type"] in {"http.response.start", "websocket.accept"}:
                    started = True
                    if message["type"] == "http.response.start":
                        headers = [
                            (k, v)
                            for k, v in message.get("headers", [])
                            if k.lower()
                            not in {b"set-cookie", b"authorization", b"x-octop-access-token"}
                            and not k.lower().startswith(b"x-centuarai-")
                        ]
                        message = {
                            **message,
                            "headers": headers + [(b"cache-control", b"no-store")],
                        }
                if message["type"] == "http.response.body" and not message.get("more_body", False):
                    finished = True
                if message["type"] == "websocket.close":
                    finished = True
                async with asyncio.timeout(15):
                    await send(message)

            async def handle():
                nonlocal staging, disconnect, handler_started
                if scope["type"] == "http":
                    staging = await StagedBody.create(self.config.staging_directory)
                    context.staged = staging
                    await staging.consume(
                        receive,
                        expected_bytes=reserved,
                        expected_digest=claims["bodySha256"],
                        check=context.check_cached,
                    )
                elif reserved:
                    raise DataProtocolError("LOCAL_DATA_BODY_MISMATCH")
                await context.activate()
                if self.authorize:
                    await self.authorize(scope, context)
                context.check_cached()
                if scope["type"] == "http":

                    async def disconnected():
                        while True:
                            if (await receive())["type"] == "http.disconnect":
                                raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED")

                    disconnect = asyncio.create_task(disconnected())
                    iterator = staging.chunks().__aiter__()
                    body_done = False

                    async def replay():
                        nonlocal body_done
                        context.check_cached()
                        if not body_done:
                            try:
                                chunk = await anext(iterator)
                                return {"type": "http.request", "body": chunk, "more_body": True}
                            except StopAsyncIteration:
                                body_done = True
                                return {"type": "http.request", "body": b"", "more_body": False}
                        await disconnect
                        return {"type": "http.disconnect"}

                    handler_started = True
                    app_task = asyncio.create_task(self.app(scope, replay, checked_send))
                    try:
                        done, _ = await asyncio.wait(
                            {app_task, disconnect}, return_when=asyncio.FIRST_COMPLETED
                        )
                        if app_task in done:
                            await app_task
                        else:
                            await disconnect
                    finally:
                        if not app_task.done():
                            app_task.cancel()
                        await asyncio.gather(app_task, return_exceptions=True)
                else:

                    async def checked_receive():
                        message = await receive()
                        context.check_cached()
                        if message["type"] == "websocket.receive":
                            raw = message.get("bytes") or message.get("text", "").encode()
                            if len(raw) > 4 * 1024 * 1024:
                                raise DataProtocolError("LOCAL_DATA_BODY_TOO_LARGE")
                            if message.get("text"):
                                with contextlib.suppress(ValueError):
                                    body = json.loads(message["text"])
                                    if (
                                        isinstance(body, dict)
                                        and body.get("type") == "start"
                                        and body.get("token")
                                    ):
                                        raise DataProtocolError("LOCAL_DATA_FORBIDDEN")
                        return message

                    handler_started = True
                    await self.app(scope, checked_receive, checked_send)

            guard = asyncio.create_task(watch())
            worker = asyncio.create_task(handle())
            done, _ = await asyncio.wait({worker, guard}, return_when=asyncio.FIRST_COMPLETED)
            if guard in done:
                await guard
            await worker
            outcome = "completed"
        except asyncio.CancelledError:
            outcome = "outcome-unknown" if handler_started else "cancelled"
            raise
        except (DataProtocolError, OSError, TimeoutError, ValueError, UnicodeError) as error:
            if handler_started:
                outcome = "outcome-unknown"
            code = error.code if isinstance(error, DataProtocolError) else "LOCAL_DATA_INVALID"
            if scope["type"] == "websocket":
                with contextlib.suppress(Exception):
                    await send({"type": "websocket.close", "code": 4403, "reason": code})
            elif not started:
                raw = json.dumps({"code": code}).encode()
                await send(
                    {
                        "type": "http.response.start",
                        "status": 403,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"cache-control", b"no-store"),
                        ],
                    }
                )
                await send({"type": "http.response.body", "body": raw})
            elif not finished:
                # Let the server abort a partial response; never append a valid
                # terminator that could make a truncated download look complete.
                raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED") from None
        except Exception:
            if handler_started:
                outcome = "outcome-unknown"
            raise
        finally:
            for task in (worker, guard, disconnect):
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(
                *(task for task in (worker, guard, disconnect) if task), return_exceptions=True
            )
            if staging:
                await staging.close()
            if context:
                with contextlib.suppress(DataProtocolError):
                    await context.closed(outcome)
                if not context.physical_close_uncertain:
                    self._operations.discard(claims["operationId"])
                await self._report()
                if not context.physical_close_uncertain:
                    self.active -= 1
                    self.reserved -= reserved

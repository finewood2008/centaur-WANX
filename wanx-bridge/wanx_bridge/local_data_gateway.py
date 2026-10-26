"""Pinned-runtime ASGI data surface: finite control, verified staging, guarded streams."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import ipaddress
import json
import time
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from centuarai_local_data_gate.observations import (
    HEADER_NAMES,
    header_pairs,
    observed_headers,
    one_header,
    raw_target,
)
from centuarai_local_data_gate.staging import CHUNK, StagedBody
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.client import connect as websocket_connect
from websockets.exceptions import ConnectionClosed, WebSocketException

from .local_data_broker import decode_object
from .local_data_protocol import DataProtocolError, decode_request_expectations, fields, need
from .local_data_routes import METADATA_PATHS, validate_staged

PREFIX = "/local-trust/v1/data/"
RESPONSE_HEADERS = frozenset(
    {
        "content-type",
        "content-length",
        "content-encoding",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
        "content-disposition",
        "x-content-sha256",
        "x-file-sha256",
        "x-content-type-options",
    }
)


def _origin(value):
    need(type(value) is str)
    parsed = urlsplit(value)
    try:
        address = ipaddress.ip_address(parsed.hostname)
        port = parsed.port
    except (TypeError, ValueError):
        raise DataProtocolError("LOCAL_DATA_FORBIDDEN") from None
    need(
        parsed.scheme == "http"
        and address.is_loopback
        and port is not None
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and parsed.path in ("", "/")
        and value.rstrip("/") == f"http://{parsed.netloc}",
        "LOCAL_DATA_FORBIDDEN",
    )
    return value.rstrip("/")


class LocalDataGateway:
    def __init__(self, sessions, *, upstreams, staging_directory, authority, metadata_handler=None):
        self.sessions = sessions
        self.staging_directory = Path(staging_directory)
        self.authority = authority
        need(
            type(authority) is str
            and authority
            and authority.isascii()
            and not any(c.isspace() for c in authority)
        )
        need(
            type(upstreams) is dict
            and set(upstreams) <= {"octop", "clipboard", "semantica", "semantica-mcp"}
        )
        self.upstreams = {
            audience: _origin(value["origin"] if type(value) is dict else value)
            for audience, value in upstreams.items()
        }
        self.metadata_handler = metadata_handler
        self.client = httpx.AsyncClient(
            trust_env=False,
            follow_redirects=False,
            headers={"accept-encoding": "identity"},
            timeout=httpx.Timeout(connect=2, read=None, write=15, pool=0.5),
            limits=httpx.Limits(max_connections=128, max_keepalive_connections=16),
        )
        self.operations = {}
        self.control_active = 0
        self.authenticated_control_active = 0
        self.source_budgets = {}
        self.watch = None
        self.closed = False
        self.measurements = {"admitted": 0, "closed": 0, "capacityDenied": 0}

    async def start(self):
        need(not self.closed and self.watch is None)

        async def sweep():
            while True:
                await asyncio.sleep(0.25)
                await self.sessions.sweep()

        self.watch = asyncio.create_task(sweep())
        return self

    async def operation_closed(self, operation, reason):
        current = self.operations.get(operation["operationId"])
        if current is not None:
            current["denied"].set()

    async def close(self):
        self.closed = True
        if self.watch:
            self.watch.cancel()
            await asyncio.gather(self.watch, return_exceptions=True)
            self.watch = None
        for state in tuple(self.operations.values()):
            state["denied"].set()
            state["task"].cancel()
        await asyncio.gather(
            *(value["task"] for value in tuple(self.operations.values())), return_exceptions=True
        )
        await self.client.aclose()

    def _boundary(self, scope):
        need(not self.closed, "LOCAL_DATA_SESSION_CLOSED")
        need(scope.get("scheme") in ("https", "wss"), "LOCAL_DATA_FORBIDDEN")
        headers = header_pairs(scope.get("headers", []))
        need(one_header(headers, "host") == self.authority, "LOCAL_DATA_FORBIDDEN")
        need(
            not any(
                name in {"origin", "referer", "authorization", "cookie"}
                or name.startswith("x-centuarai-")
                and name != "x-centuarai-data-proof"
                for name, _ in headers
            ),
            "LOCAL_DATA_FORBIDDEN",
        )
        return headers

    @staticmethod
    async def _json_reply(send, value, *, status=200, jose=False):
        body = (
            value.encode("ascii")
            if jose
            else json.dumps(value, separators=(",", ":")).encode("utf8")
        )
        need(len(body) <= 1024 * 1024, "LOCAL_DATA_CAPACITY")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/jose" if jose else b"application/json"),
                    (b"cache-control", b"no-store"),
                    (b"connection", b"close"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    async def _control(self, scope, headers, receive, send):
        need(
            scope["type"] == "http" and scope["method"] == "POST" and not scope.get("query_string"),
            "LOCAL_DATA_ROUTE_DENIED",
        )
        endpoint = scope["path"][len(PREFIX) :]
        need(
            endpoint
            in {
                "session-challenge",
                "sessions",
                "heartbeat",
                "close",
                "renewal-challenge",
                "renewals",
            },
            "LOCAL_DATA_ROUTE_DENIED",
        )
        authenticated = endpoint in {"heartbeat", "close", "renewal-challenge", "renewals"}
        need(
            self.authenticated_control_active < 64 if authenticated else self.control_active < 32,
            "LOCAL_DATA_CAPACITY",
        )
        need(
            not any(name == "x-centuarai-data-proof" for name, _ in headers), "LOCAL_DATA_FORBIDDEN"
        )
        observed_headers(headers)
        need(one_header(headers, "content-type") == "application/json")
        length = one_header(headers, "content-length")
        need(
            length.isdecimal() and len(length) <= 5 and 0 < int(length) <= 32768,
            "LOCAL_DATA_CAPACITY",
        )
        if authenticated:
            self.authenticated_control_active += 1
        else:
            self.control_active += 1
        try:
            async with asyncio.timeout(3):
                raw = bytearray()
                while True:
                    message = await receive()
                    need(message["type"] == "http.request", "LOCAL_DATA_SESSION_CLOSED")
                    raw.extend(message.get("body", b""))
                    need(len(raw) <= int(length), "LOCAL_DATA_CAPACITY")
                    if not message.get("more_body", False):
                        break
                need(len(raw) == int(length))
                body = decode_object(raw)
                if endpoint == "session-challenge":
                    result = await self.sessions.challenge(body)
                elif endpoint == "sessions":
                    fields(body, {"accessProof"})
                    result = await self.sessions.create_session(body["accessProof"])
                elif endpoint == "renewal-challenge":
                    fields(body, {"proof"})
                    result = await self.sessions.renewal_challenge(body["proof"])
                elif endpoint == "renewals":
                    fields(body, {"accessProof"})
                    result = await self.sessions.create_session(body["accessProof"], renewal=True)
                elif endpoint in ("heartbeat", "close"):
                    fields(body, {"proof"})
                    result = await (
                        self.sessions.heartbeat(body["proof"])
                        if endpoint == "heartbeat"
                        else self.sessions.close_session(body["proof"])
                    )
                else:
                    raise DataProtocolError("LOCAL_DATA_ROUTE_DENIED")
                await self._json_reply(send, result, jose=True)
        except DataProtocolError:
            if endpoint in {"session-challenge", "sessions"}:
                # Rejected anonymous work never denies a successfully verified
                # Access PoP sharing the same LAN/NAT/relay source address.
                peer = scope.get("client")
                source = str(ipaddress.ip_address(peer[0])) if peer else "local"
                now = time.monotonic()
                self.source_budgets = {
                    key: value for key, value in self.source_budgets.items() if now - value[1] < 30
                }
                need(
                    source in self.source_budgets or len(self.source_budgets) < 128,
                    "LOCAL_DATA_CAPACITY",
                )
                tokens, previous = self.source_budgets.get(source, (32.0, now))
                tokens = min(32.0, tokens + max(0, now - previous) * 4)
                need(tokens >= 1, "LOCAL_DATA_CAPACITY")
                self.source_budgets[source] = (tokens - 1, now)
            raise
        finally:
            if authenticated:
                self.authenticated_control_active -= 1
            else:
                self.control_active -= 1

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    if self.watch is None:
                        await self.start()
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await self.close()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        operation = staging = worker = guard = disconnect = response = None
        started = finished = False
        outcome = "denied"
        try:
            need(scope["type"] in ("http", "websocket"), "LOCAL_DATA_ROUTE_DENIED")
            headers = self._boundary(scope)
            if scope["path"].startswith(PREFIX):
                await self._control(scope, headers, receive, send)
                return
            proof = one_header(headers, "x-centuarai-data-proof")
            observation = {
                "transport": scope["type"],
                "method": scope.get("method", "GET"),
                "rawTarget": raw_target(scope),
                "headers": observed_headers(headers, proof_header="x-centuarai-data-proof"),
                **decode_request_expectations(proof),
            }
            if scope["type"] == "http":
                lengths = [v for k, v in headers if k == "content-length"]
                need(
                    lengths == [str(observation["bodyBytes"])]
                    or not lengths
                    and observation["bodyBytes"] == 0,
                    "LOCAL_DATA_BODY_MISMATCH",
                )
            operation = await self.sessions.admit_request(proof, observation)
            state = {"denied": asyncio.Event(), "task": asyncio.current_task()}
            self.operations[operation["operationId"]] = state
            self.measurements["admitted"] += 1

            def check():
                need(not self.closed and not state["denied"].is_set(), "LOCAL_DATA_SESSION_CLOSED")

            async def watch():
                while True:
                    try:
                        await asyncio.wait_for(state["denied"].wait(), timeout=0.2)
                    except TimeoutError:
                        await self.sessions.assert_live(operation["operationId"])
                    check()

            async def checked_send(message):
                nonlocal started, finished
                check()
                if message["type"] == "http.response.start":
                    message = {
                        **message,
                        "headers": [*message.get("headers", []), (b"connection", b"close")],
                    }
                if message["type"] in ("http.response.start", "websocket.accept"):
                    started = True
                async with asyncio.timeout(15):
                    await send(message)
                if (
                    message["type"] == "http.response.body"
                    and not message.get("more_body", False)
                    or message["type"] == "websocket.close"
                ):
                    finished = True

            async def handle():
                nonlocal staging, disconnect, response, operation
                if scope["type"] == "websocket":
                    message = await receive()
                    need(message["type"] == "websocket.connect")
                    await self.sessions.activate_request(
                        operation["operationId"], observation["bodySha256"], 0
                    )
                    await self._websocket(operation, observation, receive, checked_send, check)
                    return
                staging = await StagedBody.create(self.staging_directory)
                await staging.consume(
                    receive,
                    expected_bytes=observation["bodyBytes"],
                    expected_digest=observation["bodySha256"],
                    check=check,
                )
                if observation["headers"]["contentSha256"] is not None:
                    need(
                        observation["headers"]["contentSha256"] == staging.sha256.hexdigest(),
                        "LOCAL_DATA_BODY_MISMATCH",
                    )
                await validate_staged(self.sessions, operation, staging)
                operation = await self.sessions.activate_request(
                    operation["operationId"], observation["bodySha256"], staging.length
                )

                async def disconnected():
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED")

                disconnect = asyncio.create_task(disconnected())
                target = operation["route"]["upstreamPath"]
                if target in METADATA_PATHS:
                    need(self.metadata_handler is not None, "LOCAL_DATA_ROUTE_DENIED")
                    result = await self.metadata_handler(target)
                    await self.sessions.assert_live(operation["operationId"])
                    await self._json_reply(checked_send, result)
                    return
                origin = self.upstreams.get(operation["route"]["audience"])
                need(origin is not None, "LOCAL_DATA_ROUTE_DENIED")
                hop = {**observation, "rawTarget": target}
                gateway_proof = await self.sessions.gateway_request(operation["operationId"], hop)
                outgoing = {
                    HEADER_NAMES[name]: value
                    for name, value in hop["headers"].items()
                    if value is not None
                }
                outgoing.update(
                    {
                        "content-length": str(staging.length),
                        "x-centuarai-gateway-proof": gateway_proof,
                        "accept-encoding": "identity",
                        "connection": "close",
                    }
                )
                request = self.client.build_request(
                    hop["method"],
                    origin + target,
                    headers=outgoing,
                    content=staging.chunks() if staging.length else b"",
                )
                need(request.url.raw_path.decode("ascii") == target, "LOCAL_DATA_CONTEXT_CHANGED")
                response = await self.client.send(request, stream=True)
                need(
                    response.status_code < 300
                    or response.status_code >= 400
                    or response.status_code == 304,
                    "LOCAL_DATA_ROUTE_DENIED",
                )
                response_headers = [
                    (key, value)
                    for key, value in response.headers.raw
                    if key.decode("ascii").lower() in RESPONSE_HEADERS
                ]
                response_headers.append((b"cache-control", b"no-store"))
                await checked_send(
                    {
                        "type": "http.response.start",
                        "status": response.status_code,
                        "headers": response_headers,
                    }
                )
                total = 0
                stream = (
                    response.headers.get("content-type", "").split(";", 1)[0] == "text/event-stream"
                )
                async for chunk in response.aiter_raw():
                    total += len(chunk)
                    need(stream or total <= 1024**3, "LOCAL_DATA_CAPACITY")
                    for offset in range(0, len(chunk), CHUNK):
                        await checked_send(
                            {
                                "type": "http.response.body",
                                "body": chunk[offset : offset + CHUNK],
                                "more_body": True,
                            }
                        )
                await checked_send({"type": "http.response.body", "body": b"", "more_body": False})

            guard = asyncio.create_task(watch())
            worker = asyncio.create_task(handle())

            # The handle task installs the disconnect monitor only after upload
            # consumption. Watch it separately without racing reads of the body.
            async def monitor_worker():
                while not worker.done():
                    if disconnect is not None and disconnect.done():
                        await disconnect
                    await asyncio.sleep(0.02)
                await worker

            monitored = asyncio.create_task(monitor_worker())
            try:
                done, _ = await asyncio.wait(
                    {monitored, guard}, return_when=asyncio.FIRST_COMPLETED
                )
                if guard in done:
                    await guard
                await monitored
                outcome = "completed"
            finally:
                monitored.cancel()
                await asyncio.gather(monitored, return_exceptions=True)
        except asyncio.CancelledError:
            outcome = "cancelled"
            raise
        except (
            DataProtocolError,
            httpx.HTTPError,
            WebSocketException,
            OSError,
            TimeoutError,
            ValueError,
            UnicodeError,
        ) as error:
            outcome = "outcome-unknown" if started and not finished else "denied"
            code = error.code if isinstance(error, DataProtocolError) else "LOCAL_DATA_UNAVAILABLE"
            if code == "LOCAL_DATA_CAPACITY":
                self.measurements["capacityDenied"] += 1
            if scope["type"] == "websocket":
                with contextlib.suppress(Exception):
                    async with asyncio.timeout(0.5):
                        await send({"type": "websocket.close", "code": 4403, "reason": code})
            elif not started:
                await self._json_reply(send, {"code": code}, status=403)
            elif not finished:
                raise DataProtocolError("LOCAL_DATA_SESSION_CLOSED") from None
        finally:
            for task in (worker, guard, disconnect):
                if task and not task.done():
                    task.cancel()
            await asyncio.gather(
                *(task for task in (worker, guard, disconnect) if task), return_exceptions=True
            )
            if response is not None:
                await response.aclose()
            if staging is not None:
                await staging.close()
            if operation is not None:
                transport_closed = False
                evidence = scope.get("extensions", {}).get("centuarai.local_data.transport")
                if evidence is not None:
                    with contextlib.suppress(Exception):
                        transport_closed = await evidence.close_and_wait() is True
                self.operations.pop(operation["operationId"], None)
                self.measurements["closed"] += 1
                await self.sessions.finish_operation(
                    operation["operationId"], outcome, transport_closed=transport_closed
                )

    async def _websocket(self, operation, observation, receive, send, check):
        route = operation["route"]
        origin = self.upstreams.get(route["audience"])
        need(origin is not None, "LOCAL_DATA_ROUTE_DENIED")
        protocols = observation["headers"]["webSocketProtocol"]
        protocols = [value.strip() for value in protocols.split(",")] if protocols else None
        need(
            protocols is None
            or len(protocols) <= 8
            and all(value and len(value) <= 128 for value in protocols)
        )
        owner = self

        class BoundConnection(ClientConnection):
            async def handshake(self, additional_headers=None, user_agent_header=None):
                request = self.protocol.connect()
                selectors = copy.deepcopy(observation["headers"])
                selectors["webSocketKey"] = request.headers["Sec-WebSocket-Key"]
                selectors["webSocketProtocol"] = request.headers.get("Sec-WebSocket-Protocol")
                hop = {**observation, "rawTarget": route["upstreamPath"], "headers": selectors}
                proof = await owner.sessions.gateway_request(operation["operationId"], hop)
                headers = {
                    HEADER_NAMES[name]: value
                    for name, value in selectors.items()
                    if value is not None and name not in ("webSocketKey", "webSocketProtocol")
                }
                headers["x-centuarai-gateway-proof"] = proof
                await super().handshake(headers, user_agent_header=None)

        async with websocket_connect(
            "ws" + origin[4:] + route["upstreamPath"],
            subprotocols=protocols,
            compression=None,
            proxy=None,
            open_timeout=2,
            close_timeout=0.5,
            max_size=4 * 1024**2,
            max_queue=1,
            write_limit=65536,
            create_connection=BoundConnection,
        ) as upstream:
            check()
            await send({"type": "websocket.accept", "subprotocol": upstream.subprotocol})

            async def inbound():
                while True:
                    message = await receive()
                    check()
                    if message["type"] == "websocket.disconnect":
                        return
                    need(message["type"] == "websocket.receive")
                    data = (
                        message.get("bytes")
                        if message.get("bytes") is not None
                        else message.get("text", "")
                    )
                    need(
                        len(data.encode() if isinstance(data, str) else data) <= 4 * 1024**2,
                        "LOCAL_DATA_CAPACITY",
                    )
                    if isinstance(data, str):
                        with contextlib.suppress(ValueError):
                            value = json.loads(data)
                            need(
                                not (
                                    type(value) is dict
                                    and value.get("type") == "start"
                                    and value.get("token")
                                ),
                                "LOCAL_DATA_FORBIDDEN",
                            )
                    async with asyncio.timeout(15):
                        await upstream.send(data)

            async def outbound():
                async for message in upstream:
                    check()
                    await send(
                        {
                            "type": "websocket.send",
                            "text" if isinstance(message, str) else "bytes": message,
                        }
                    )

            tasks = [asyncio.create_task(inbound()), asyncio.create_task(outbound())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    await task
                await send({"type": "websocket.close", "code": 1000})
            except ConnectionClosed:
                await send({"type": "websocket.close", "code": 1001})
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

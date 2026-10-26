"""Private transport closure evidence for the single HTTPS runtime.

An ASGI response or handler return is not proof that the client connection is
closed. Only the protocol's connection_lost callback supplies that evidence.
"""

from __future__ import annotations

import asyncio

from uvicorn.protocols.http.h11_impl import H11Protocol
from uvicorn.protocols.websockets.websockets_impl import WebSocketProtocol

EXTENSION = "centuarai.local_data.transport"


class LocalDataTransport:
    def __init__(self, protocol):
        self._protocol = protocol
        self._lost = asyncio.Event()

    def connection_lost(self):
        self._lost.set()

    async def close_and_wait(self):
        if self._lost.is_set():
            return True
        transport = self._protocol.transport
        if transport is None:
            return False
        transport.close()
        try:
            async with asyncio.timeout(0.75):
                await self._lost.wait()
        except TimeoutError:
            # A peer that does not complete TLS shutdown cannot keep a revoked
            # stream alive indefinitely. Still require the actual loss callback.
            transport.abort()
            try:
                async with asyncio.timeout(0.25):
                    await self._lost.wait()
            except TimeoutError:
                return False
        return self._lost.is_set()


class _TransportEvidence:
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        evidence = self._local_data_transport = LocalDataTransport(self)
        app = self.app

        async def with_evidence(scope, receive, send):
            scope.setdefault("extensions", {})[EXTENSION] = evidence

            async def explicit_close(message):
                if scope["type"] == "http" and message["type"] == "http.response.start":
                    # The gateway closes this transport after each operation to
                    # establish physical evidence. Advertise that before sending
                    # the body so a client's connection pool cannot race reuse.
                    headers = [
                        (key, value)
                        for key, value in message.get("headers", [])
                        if key.lower() != b"connection"
                    ]
                    message = {**message, "headers": headers + [(b"connection", b"close")]}
                await send(message)

            await app(scope, receive, explicit_close)

        self.app = with_evidence

    def connection_lost(self, exc):
        try:
            super().connection_lost(exc)
        finally:
            self._local_data_transport.connection_lost()


class LocalDataHTTPProtocol(_TransportEvidence, H11Protocol):
    pass


class LocalDataWebSocketProtocol(_TransportEvidence, WebSocketProtocol):
    pass

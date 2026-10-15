"""App-scoped shadow identity; no prices or usage accepted from the caller."""

import logging
from typing import Any

from octop.infra.credits.metering import Meter
from octop.infra.credits.runtime import account_context
from octop.infra.db.repos.metering import MeterRepo


class MeteringIdentity:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        identity = None
        if scope["type"] == "http":
            raw = dict(scope.get("headers", [])).get(b"x-wanx-metering-session", b"")
            server = scope.get("app").state.octop_server
            if raw and getattr(server, "services", None):
                try:
                    identity = Meter(MeterRepo(server.services.db)).identity(
                        raw.decode("ascii", errors="ignore")
                    )
                except Exception:
                    logging.getLogger(__name__).warning("Usage identity unavailable", exc_info=True)
        token = account_context.set(identity)
        try:
            await self.app(scope, receive, send)
        finally:
            account_context.reset(token)

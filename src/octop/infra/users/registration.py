"""Public creation of ordinary shared accounts, without agents or profiles."""

from __future__ import annotations

from typing import TYPE_CHECKING

from octop.infra.db.services import SharedServices
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.users.identity import Role, User
from octop.infra.users.invites import InviteRateLimiter

if TYPE_CHECKING:
    from octop.infra.users.manager import UserManager


class RegistrationService:
    """Use native account/captcha rules and a separate registration burst budget."""

    def __init__(self, manager: UserManager, services: SharedServices) -> None:
        self._manager = manager
        self._services = services
        self._limiter = InviteRateLimiter()

    def replace_services(self, services: SharedServices) -> None:
        self._services = services

    async def create(
        self,
        *,
        username: str,
        password: str,
        captcha_token: str | None,
        client_ip: str,
        locale: str,
    ) -> User:
        from octop.infra.auth.captcha import current_env, ensure_captcha, load_effective

        if self._manager.count() == 0:
            raise OctopError.localized(ErrorCode.SETUP_REQUIRED)
        try:
            self._limiter.check(client_ip)
        except OctopError as exc:
            raise OctopError.localized(ErrorCode.REGISTRATION_RATE_LIMITED) from exc
        cleaned = username.strip()
        if not cleaned or len(cleaned) > 64 or not password or len(password) > 200:
            raise ValueError("invalid registration credentials")
        effective = load_effective(
            self._services.settings_repo, self._services.secret_repo, current_env()
        )
        await ensure_captcha(effective, captcha_token, client_ip)
        return await self._manager.create(
            username=cleaned,
            password=password,
            role=Role.USER,
            permissions=[],
            locale=locale,
        )

"""User identity primitives."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class Role(StrEnum):
    """Built-in role-template public ids (also stored on ``users.role``)."""

    ADMIN = "admin"
    USER = "user"


@dataclass
class User:
    id: int
    username: str
    role: str  # role-template public id: admin | user | custom ULID
    display_name: str | None
    locale: str = "zh"
    permissions: list[str] = field(default_factory=list)
    application_id: str = "wanx"
    local_data: bool = False
    local_team: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)
    local_team_context: Any = field(default=None, repr=False, compare=False)
    local_resource: Mapping[str, Any] | None = field(default=None, repr=False, compare=False)

    @property
    def label(self) -> str:
        return self.display_name or self.username

    @property
    def is_admin(self) -> bool:
        return self.role == Role.ADMIN

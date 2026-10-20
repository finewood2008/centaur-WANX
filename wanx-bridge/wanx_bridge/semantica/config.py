"""Semantica connection settings; no dependency on either backend's internals."""

import os
from urllib.parse import urlsplit

DEFAULT_URL = "http://127.0.0.1:8090"


def configured_origin() -> str:
    return upstream_origin(os.getenv("WANX_BRIDGE_SEMANTICA_URL", DEFAULT_URL))


def upstream_origin(value: str) -> str:
    """Accept a configured HTTP(S) origin, including a separate container/host."""
    try:
        parsed = urlsplit(value)
        if (
            not value
            or any(character.isspace() for character in value)
            or "\\" in value
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or (parsed.port is not None and not 1 <= parsed.port <= 65535)
        ):
            raise ValueError()
    except ValueError as exc:
        raise ValueError(
            "Semantica URL must be an HTTP(S) origin without credentials or a path"
        ) from exc
    return value.rstrip("/")

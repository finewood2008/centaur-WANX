"""HTTP registration for an independently deployed Semantica workbench."""

from .config import DEFAULT_URL, configured_origin, upstream_origin
from .routes import PREFIX, create_router

__all__ = ["DEFAULT_URL", "PREFIX", "configured_origin", "create_router", "upstream_origin"]

"""Reserved service-owned paths are unavailable through generic file tools."""

from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname

from octop.infra.utils.paths import PathLayout


def is_private_storage_path(value: str | Path) -> bool:
    """Generic file access must not bypass an authorized service's data API."""
    text = str(value).replace("\\", "/")
    if text.lower().startswith("file://"):
        uri = urlsplit(text)
        authority = "//" + uri.netloc if uri.netloc and uri.netloc != "localhost" else ""
        text = url2pathname(authority + uri.path)
    else:
        text = unquote(text)
    if ".wanx-personal-space" in text.lower().split("/"):
        return True
    try:
        path = Path(text).expanduser().resolve()
        layout = PathLayout.from_env()
        normalized = path.as_posix().casefold()
        knowledge = layout.knowledge_dir.resolve().as_posix().casefold()
        if normalized == knowledge or normalized.startswith(knowledge + "/"):
            return True
        # Database and configuration copies would bypass document authorization too.
        return normalized in {
            layout.db.resolve().as_posix().casefold(),
            Path(str(layout.db) + "-wal").resolve().as_posix().casefold(),
            Path(str(layout.db) + "-shm").resolve().as_posix().casefold(),
            layout.config.resolve().as_posix().casefold(),
        } or ".wanx-personal-space" in path.as_posix().lower().split("/")
    except (OSError, ValueError, RuntimeError):
        return True


def is_personal_storage_path(value: str | Path) -> bool:
    # Keep the existing callers' contract while protecting native knowledge files.
    return is_private_storage_path(value)


def is_untrusted_workspace(value: str | Path, agent_id: str | None) -> bool:
    """A chosen working directory cannot turn service storage into user files."""
    try:
        workspace = Path(value).expanduser().resolve()
        layout = PathLayout.from_env()
        root = layout.root.resolve()
        if root.is_relative_to(workspace):
            return True
        if workspace.is_relative_to(root):
            return not agent_id or not workspace.is_relative_to(
                layout.agent_workspace(agent_id).resolve()
            )
        return False
    except (OSError, ValueError, RuntimeError):
        return True


def is_relative_file_pattern(pattern: str) -> bool:
    text = pattern.replace("\\", "/")
    return not (
        text.startswith(("/", "~")) or (len(text) > 1 and text[1] == ":") or ".." in text.split("/")
    )

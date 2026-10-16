"""Reserved service-owned paths are unavailable through generic file tools."""

from pathlib import Path
from urllib.parse import unquote


def is_personal_storage_path(value: str | Path) -> bool:
    text = unquote(str(value)).replace("\\", "/").lower()
    if ".wanx-personal-space" in text.split("/"):
        return True
    try:
        return ".wanx-personal-space" in Path(str(value)).resolve().as_posix().lower().split("/")
    except (OSError, ValueError):
        return True

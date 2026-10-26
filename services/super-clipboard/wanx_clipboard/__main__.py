"""Run beside an unmodified WANX core; never receives an Octop data directory."""

import argparse
import os
import stat
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn

from .app import create_app

_STAGING_PARENT = Path("/run/centuarai-local-data")
_SYSTEM_UID = 0


def prepare_native_staging() -> Path:
    """Only the fixed service child may be created; never mkdir a config path."""
    if os.name != "posix":
        raise ValueError("Clipboard native staging requires POSIX")
    for parent in (_STAGING_PARENT, *_STAGING_PARENT.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != _SYSTEM_UID or info.st_mode & 0o022:
            raise ValueError("Clipboard native staging parent is not protected")
    parent_fd = os.open(_STAGING_PARENT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with suppress(FileExistsError):
            os.mkdir("clipboard", mode=0o700, dir_fd=parent_fd)
        child_fd = os.open("clipboard", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            info = os.fstat(child_fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError("Clipboard native staging is not private")
        finally:
            os.close(child_fd)
    finally:
        os.close(parent_fd)
    return _STAGING_PARENT / "clipboard"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True, help="Fixed unchanged WANX HTTP origin")
    parser.add_argument(
        "--data", required=True, type=Path, help="Independent clipboard metadata directory"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    parser.add_argument("--local-data-mode", choices=("legacy", "required"), default="legacy")
    parser.add_argument("--local-data-gate-config", type=Path)
    args = parser.parse_args()
    if args.local_data_mode == "required" and args.local_data_gate_config is None:
        parser.error("required local data mode needs --local-data-gate-config")
    gate_config = args.local_data_gate_config
    if args.local_data_mode == "required":
        from centuarai_local_data_gate import GateConfig

        staging = prepare_native_staging()
        gate_config = GateConfig.load(args.local_data_gate_config, audience="clipboard")
        if gate_config.staging_directory != staging:
            parser.error("clipboard gate must use the fixed native staging directory")
    target_port = urlsplit(args.upstream).port
    if target_port == args.port:
        parser.error("business listener must not proxy to itself")
    # Access logs can contain sensitive resource IDs; product errors use fixed codes.
    uvicorn.run(
        create_app(
            args.data, args.upstream, gate_config=gate_config,
            local_data_required=args.local_data_mode == "required",
        ),
        host=args.host, port=args.port, access_log=False,
    )


if __name__ == "__main__":
    main()

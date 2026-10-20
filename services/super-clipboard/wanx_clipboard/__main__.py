"""Run beside an unmodified WANX core; never receives an Octop data directory."""

import argparse
from pathlib import Path
from urllib.parse import urlsplit

import uvicorn

from .app import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", required=True, help="Fixed unchanged WANX HTTP origin")
    parser.add_argument(
        "--data", required=True, type=Path, help="Independent clipboard metadata directory"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    args = parser.parse_args()
    target_port = urlsplit(args.upstream).port
    if target_port == args.port:
        parser.error("business listener must not proxy to itself")
    # Access logs can contain sensitive resource IDs; product errors use fixed codes.
    uvicorn.run(
        create_app(args.data, args.upstream), host=args.host, port=args.port, access_log=False
    )


if __name__ == "__main__":
    main()

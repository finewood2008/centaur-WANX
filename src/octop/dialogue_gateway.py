"""Platform gateway entry point: python -m octop.dialogue_gateway --config FILE."""

from __future__ import annotations

import argparse
from pathlib import Path

import httpx
import uvicorn

from octop.api.dialogue_gateway import build_gateway
from octop.infra.dialogue.gateway import GatewayConfig, GatewayService
from octop.infra.dialogue.ledger import Ledger


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=28741)
    args = parser.parse_args()
    config = GatewayConfig.model_validate_json(args.config.read_text())
    client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=15), follow_redirects=False)
    service = GatewayService(config, Ledger(args.ledger), client)
    uvicorn.run(build_gateway(service), host=args.host, port=args.port, access_log=False, workers=1)


if __name__ == "__main__":
    main()

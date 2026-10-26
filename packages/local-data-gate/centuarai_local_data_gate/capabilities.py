"""Offline installation check: import the deployed gate and native adapter."""

from __future__ import annotations

import argparse
import importlib
import json
import sys
from importlib.metadata import version

GATE_VERSION = 1


def capabilities(service):
    from . import GateConfig, LocalDataGateMiddleware, load_required_policy

    if (
        not callable(GateConfig.load)
        or not callable(load_required_policy)
        or not callable(LocalDataGateMiddleware)
    ):
        raise ValueError("shared adapter missing")
    modules = {
        "octop": (
            "octop.api.common.local_data",
            ("install", "local_user", "resolve_connection_user"),
        ),
        "semantica": ("app.integration.local_data", ("check_startup_policy", "install_gate")),
        "clipboard": ("wanx_clipboard.app", ("create_app",)),
    }
    name, functions = modules[service]
    adapter = importlib.import_module(name)
    if getattr(adapter, "LOCAL_DATA_GATE_VERSION", None) != GATE_VERSION or not all(
        callable(getattr(adapter, key, None)) for key in functions
    ):
        raise ValueError("native adapter missing")
    if service == "semantica":
        settings = importlib.import_module("app.config").Settings
        if "local_data_gate_mode" not in settings.model_fields:
            raise ValueError("startup configuration missing")
    return {
        "schemaVersion": 1,
        "gateVersion": GATE_VERSION,
        "packageVersion": version("centuarai-local-data-gate"),
        "service": service,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--require-service", required=True, choices=("octop", "semantica", "clipboard")
    )
    args = parser.parse_args()
    try:
        result = capabilities(args.require_service)
    except Exception:
        print("LOCAL_DATA_CAPABILITY_REQUIRED", file=sys.stderr)
        raise SystemExit(1) from None
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()

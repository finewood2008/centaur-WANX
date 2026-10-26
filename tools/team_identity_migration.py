#!/usr/bin/env python3
"""Offline preview and root-authorized publication of a legacy business import.

Preview accepts explicit offline roots; apply always uses the fixed managed OS
roots and independently verifies the committed ledger approval. No password,
cloud bearer, SSO token, arbitrary command or path can authorize publication.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from pathlib import Path

from octop.infra.users.team_migration import (
    MigrationError,
    MigrationIdentity,
    MigrationPaths,
    apply_plan,
    build_plan,
)


def read_object(path: Path, *, private: bool = False) -> dict:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024:
            raise MigrationError("MIGRATION_INPUT_INVALID")
        if private and (info.st_uid != 0 or info.st_mode & 0o077):
            raise MigrationError("MIGRATION_ROOT_OWNED_PLAN_REQUIRED")

        def unique(items):
            result = {}
            for key, value in items:
                if key in result:
                    raise MigrationError("MIGRATION_INPUT_INVALID")
                result[key] = value
            return result

        value = json.loads(stream.read(), object_pairs_hook=unique)
        if type(value) is not dict:
            raise MigrationError("MIGRATION_INPUT_INVALID")
        return value


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    preview = commands.add_parser(
        "dry-run", help="Print a content-digested plan without writing data"
    )
    preview.add_argument("--identity", required=True, type=Path)
    preview.add_argument("--home", required=True, type=Path)
    preview.add_argument("--clipboard", required=True, type=Path)
    preview.add_argument("--journal", required=True, type=Path)
    preview.add_argument("--semantica", required=True, type=Path)
    apply = commands.add_parser("apply", help="Publish only a committed exact ledger-approved plan")
    apply.add_argument("--plan", required=True, type=Path)
    apply.add_argument("--request-id", required=True)
    args = parser.parse_args(argv)
    try:
        if args.operation == "dry-run":
            identity = MigrationIdentity(**read_object(args.identity))
            result = build_plan(
                MigrationPaths(args.home, args.clipboard, args.journal, args.semantica), identity
            )
            print(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2))
            return 2 if result["blockers"] else 0
        if os.name != "posix" or os.geteuid() != 0:
            raise MigrationError("MIGRATION_ROOT_REQUIRED")
        # This module is supplied by the fixed OS installation, never selected
        # via a CLI plugin/module argument or loaded from the plan.
        from deployment.team_identity_migration import MigrationControl

        plan = read_object(args.plan, private=True)
        with MigrationControl() as control:
            result = apply_plan(control.migration_paths(), plan, args.request_id, control)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (MigrationError, ValueError, TypeError) as exc:
        # Fixed errors only; SQL rows, credentials and raw plan values are not
        # interpolated into error output.
        code = str(exc)
        if not code.startswith("MIGRATION_") or not code.replace("_", "").isalnum():
            code = "MIGRATION_INPUT_INVALID"
        print(json.dumps({"code": code}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

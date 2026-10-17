"""Bind one existing WANX user to a platform credential (local administrator)."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from octop.config import load_config
from octop.infra.db.factory import open_database
from octop.infra.db.migrate import run_migrations
from octop.infra.db.services import RepoBundle
from octop.infra.dialogue.contracts import check_url
from octop.infra.utils.paths import PathLayout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--user-id", type=int, required=True)
    parser.add_argument("--gateway", required=True, help="HTTPS base URL ending in /v1")
    parser.add_argument("--token-env", default="WANX_DIALOGUE_ACCOUNT_TOKEN")
    args = parser.parse_args()
    token = os.environ.get(args.token_env, "")
    if len(token) < 32:
        parser.error("the credential environment variable must contain at least 32 characters")
    base = check_url(args.gateway)
    if not base.endswith("/v1"):
        parser.error("gateway must end in /v1")
    paths = PathLayout(args.home)
    db = open_database(load_config(paths.config), paths)
    try:
        run_migrations(db)
        repos = RepoBundle.from_pool(db)
        if repos.user_repo.get(args.user_id) is None:
            parser.error("existing user id required")
        name = f"WANX Dialogue Gateway / user {args.user_id}"
        existing = repos.provider_repo.get_by_name(name)
        extra = json.dumps({"dialogue_gateway": True})
        if existing:
            repos.provider_repo.update(
                existing.id, base_url=base, api_key=token, extra_json=extra, enabled=True
            )
            provider_id = existing.id
        else:
            provider_id = repos.provider_repo.create(
                name=name, kind="openai", base_url=base, api_key=token, extra_json=extra
            )
        repos.settings_repo.set(f"dialogue.provider:dialogue:{args.user_id}", str(provider_id))
        print(f"Bound dialogue gateway to user {args.user_id}; credential not displayed.")
    finally:
        db.close()


if __name__ == "__main__":
    main()

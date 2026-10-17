"""Short-lived server-issued proof of the person identified by a QR provider."""

import hashlib
import json
import secrets
import time
from typing import Any

# Proofs are intentionally ephemeral: after restart fall back to a fresh pairing.
_proofs: dict[str, tuple[int, str, str, str, str, float]] = {}


def _credentials(kind: str, config: dict[str, Any]) -> str:
    keys = ("bot_uin", "token") if kind == "weixin" else ("app_id", "secret")
    return hashlib.sha256(json.dumps([config.get(k) for k in keys]).encode()).hexdigest()


def issue(uid: int, aid: str, kind: str, subject: str, config: dict[str, Any]) -> str:
    for key, row in list(_proofs.items()):
        if row[-1] <= time.time():
            _proofs.pop(key, None)
    token = secrets.token_urlsafe(32)
    _proofs[token] = (uid, aid, kind, subject, _credentials(kind, config), time.time() + 300)
    return token


def consume(token: str, uid: int, aid: str, kind: str, config: dict[str, Any]) -> str | None:
    row = _proofs.get(token)
    if not row or row[-1] <= time.time() or row[:3] != (uid, aid, kind):
        return None
    if row[4] != _credentials(kind, config):
        return None
    _proofs.pop(token, None)
    return row[3]

"""Atomic local-principal mapping. SQL and identity collision checks only."""

from __future__ import annotations

import secrets
import threading
from typing import Any

from octop.infra.db.repos._base import insert_returning_id, now_ts


class LocalDataPrincipalRepo:
    def __init__(self, db: Any) -> None:
        self._db = db
        self._lock = threading.Lock()

    def resolve(
        self, namespace: str, box_key_thumbprint: str, ownership_epoch: int, principal_id: str
    ) -> int:
        username = "local_" + namespace
        with self._lock, self._db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM local_data_principals WHERE namespace = ?", (namespace,)
            ).fetchone()
            if row is None:
                # Never adopt a cloud/operator row, including a colliding name.
                if conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
                    raise ValueError("local principal collision")
                marker = secrets.token_hex(32)
                uid = insert_returning_id(
                    conn,
                    "INSERT INTO users(username,password_hash,role,display_name,locale,"
                    "disabled,created_at,permissions,local_data_marker) VALUES (?,NULL,'user',"
                    "'Local device user','zh',0,?,'[]',?)",
                    (username, now_ts(), marker),
                )
                conn.execute(
                    "INSERT INTO local_data_principals(namespace,box_key_thumbprint,"
                    "ownership_epoch,principal_id,native_user_id,identity_marker,created_at) "
                    "VALUES (?,?,?,?,?,?,?)",
                    (
                        namespace,
                        box_key_thumbprint,
                        ownership_epoch,
                        principal_id,
                        uid,
                        marker,
                        now_ts(),
                    ),
                )
            else:
                if (
                    row["box_key_thumbprint"] != box_key_thumbprint
                    or row["ownership_epoch"] != ownership_epoch
                    or row["principal_id"] != principal_id
                ):
                    raise ValueError("local principal collision")
                uid, marker = row["native_user_id"], row["identity_marker"]
            user = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            if (
                user is None
                or user["username"] != username
                or user["local_data_marker"] != marker
                or user["role"] != "user"
                or user["password_hash"] is not None
                or user["disabled"]
                or user["sso_provider_id"] is not None
                or user["sso_subject"] is not None
            ):
                raise ValueError("local principal identity mismatch")
            if conn.execute(
                "SELECT 1 FROM user_sso_identities WHERE user_id = ?", (uid,)
            ).fetchone():
                raise ValueError("local principal linked externally")
            return int(uid)

    def contains_user(self, user_id: int | None) -> bool:
        if user_id is None:
            return False
        with self._db.connect() as conn:
            return (
                conn.execute(
                    "SELECT 1 FROM local_data_principals WHERE native_user_id=?", (user_id,)
                ).fetchone()
                is not None
            )

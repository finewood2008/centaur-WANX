"""SQL persistence for product definitions, box deployments and client releases."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from octop.infra.db.pool import DatabasePool
from octop.infra.db.repos._base import DbRow, map_rows, now_ts


@dataclass(frozen=True)
class ApplicationRow:
    application_id: str
    name: str
    description: str
    capabilities: list[str]
    agent_template: dict[str, Any]
    resource_requirements: dict[str, Any]
    created_by: int
    created_at: int
    updated_at: int

    @classmethod
    def from_row(cls, row: DbRow) -> ApplicationRow:
        return cls(
            application_id=str(row["application_id"]),
            name=str(row["name"]),
            description=str(row["description"]),
            capabilities=json.loads(row["capabilities_json"]),
            agent_template=json.loads(row["agent_template_json"]),
            resource_requirements=json.loads(row["resource_requirements_json"]),
            created_by=int(row["created_by"]),
            created_at=int(row["created_at"]),
            updated_at=int(row["updated_at"]),
        )


class ApplicationRepo:
    def __init__(self, db: DatabasePool) -> None:
        self._db = db

    def get(self, application_id: str) -> ApplicationRow | None:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM applications WHERE application_id = ?", (application_id,)
            ).fetchone()
        return ApplicationRow.from_row(row) if row else None

    def list_all(self) -> list[ApplicationRow]:
        with self._db.connect() as conn:
            rows = conn.execute("SELECT * FROM applications ORDER BY name").fetchall()
        return map_rows(rows, ApplicationRow)

    def owns_products(self, user_id: int) -> bool:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM applications WHERE created_by = ? LIMIT 1", (user_id,)
            ).fetchone()
        return row is not None

    def create(self, data: dict[str, Any], *, created_by: int) -> ApplicationRow | None:
        ts = now_ts()
        with self._db.transaction() as conn:
            inserted = conn.execute(
                "INSERT INTO applications(application_id, name, description, capabilities_json, "
                "agent_template_json, resource_requirements_json, created_by, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(application_id) DO NOTHING",
                (
                    data["application_id"],
                    data["name"],
                    data["description"],
                    json.dumps(data["capabilities"]),
                    json.dumps(data["agent_template"]),
                    json.dumps(data["resource_requirements"]),
                    created_by,
                    ts,
                    ts,
                ),
            )
            if inserted.rowcount == 0:
                return None
            conn.execute(
                "INSERT INTO application_deployments(application_id, enabled, updated_at) "
                "VALUES (?, 0, ?)",
                (data["application_id"], ts),
            )
        row = self.get(str(data["application_id"]))
        assert row is not None
        return row

    def update(self, application_id: str, data: dict[str, Any]) -> ApplicationRow:
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE applications SET name = ?, description = ?, capabilities_json = ?, "
                "agent_template_json = ?, resource_requirements_json = ?, updated_at = ? "
                "WHERE application_id = ?",
                (
                    data["name"],
                    data["description"],
                    json.dumps(data["capabilities"]),
                    json.dumps(data["agent_template"]),
                    json.dumps(data["resource_requirements"]),
                    now_ts(),
                    application_id,
                ),
            )
        row = self.get(application_id)
        assert row is not None
        return row

    def deployment(self, application_id: str) -> dict[str, Any] | None:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM application_deployments WHERE application_id = ?", (application_id,)
            ).fetchone()
        if row is None:
            return None
        return {
            "application_id": application_id,
            "enabled": bool(row["enabled"]),
            "resource_bindings": json.loads(row["resource_bindings_json"]),
            "configuration": json.loads(row["configuration_json"]),
            "updated_at": int(row["updated_at"]),
        }

    def put_deployment(self, application_id: str, data: dict[str, Any]) -> dict[str, Any]:
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE application_deployments SET enabled = ?, resource_bindings_json = ?, "
                "configuration_json = ?, updated_at = ? WHERE application_id = ?",
                (
                    int(data["enabled"]),
                    json.dumps(data["resource_bindings"]),
                    json.dumps(data["configuration"]),
                    now_ts(),
                    application_id,
                ),
            )
        row = self.deployment(application_id)
        assert row is not None
        return row

    def releases(self, application_id: str) -> list[dict[str, Any]]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT version, platform, arch, url, sha256, min_wanx_version, min_sdk_version, "
                "recommended, created_at FROM application_releases WHERE application_id = ? "
                "ORDER BY created_at DESC, id DESC",
                (application_id,),
            ).fetchall()
        return [{**dict(row), "recommended": bool(row["recommended"])} for row in rows]

    def create_release(self, application_id: str, data: dict[str, Any]) -> bool:
        with self._db.transaction() as conn:
            inserted = conn.execute(
                "INSERT INTO application_releases(application_id, version, platform, arch, url, "
                "sha256, min_wanx_version, min_sdk_version, recommended, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?) "
                "ON CONFLICT(application_id, version, platform, arch) DO NOTHING",
                (
                    application_id,
                    data["version"],
                    data["platform"],
                    data["arch"],
                    data["url"],
                    data["sha256"],
                    data["min_wanx_version"],
                    data["min_sdk_version"],
                    now_ts(),
                ),
            )
        return bool(inserted.rowcount)

    def recommend(self, application_id: str, version: str, platform: str, arch: str) -> None:
        with self._db.transaction() as conn:
            conn.execute(
                "UPDATE application_releases SET recommended = 0 WHERE application_id = ? "
                "AND platform = ? AND arch = ?",
                (application_id, platform, arch),
            )
            conn.execute(
                "UPDATE application_releases SET recommended = 1 WHERE application_id = ? "
                "AND version = ? AND platform = ? AND arch = ?",
                (application_id, version, platform, arch),
            )

    def access(self, application_id: str) -> list[dict[str, Any]]:
        with self._db.connect() as conn:
            rows = conn.execute(
                "SELECT a.user_id, u.username, a.enabled, a.updated_at FROM application_access a "
                "JOIN users u ON u.id = a.user_id WHERE a.application_id = ? ORDER BY u.username",
                (application_id,),
            ).fetchall()
        return [{**dict(row), "enabled": bool(row["enabled"])} for row in rows]

    def user_access(self, application_id: str, user_id: int) -> bool | None:
        with self._db.connect() as conn:
            row = conn.execute(
                "SELECT enabled FROM application_access WHERE application_id = ? AND user_id = ?",
                (application_id, user_id),
            ).fetchone()
        return bool(row["enabled"]) if row is not None else None

    def put_access(self, application_id: str, user_id: int, enabled: bool) -> None:
        with self._db.transaction() as conn:
            conn.execute(
                "INSERT INTO application_access(application_id, user_id, enabled, updated_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(application_id, user_id) DO UPDATE "
                "SET enabled = excluded.enabled, updated_at = excluded.updated_at",
                (application_id, user_id, int(enabled), now_ts()),
            )

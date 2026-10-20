"""Owner-scoped processing configuration and immutable, credential-free job snapshots."""

from __future__ import annotations
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import hmac
import json
import time
import uuid
from urllib.parse import urlsplit
import httpx
from app.db import utc_now
from app.services.warehouses import WarehouseError, owner_of
from app.adapters.inference_control import controlled, send_interruptible

ACTIVE_MODEL_CALL = ContextVar("starklink_model_call", default=None)


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def configuration_signature(config):
    return hashlib.sha256(
        encode(
            [
                config.get("revision", 0),
                *[
                    (config[role].get("id"), config[role].get("revision"))
                    for role in ("extraction", "sensitive")
                ],
            ]
        ).encode()
    ).hexdigest()


class ProcessingModels:
    def __init__(self, state):
        self.state, self.jobs, self.settings = state, state.jobs, state.settings
        self.base = self.settings.wanx_model_url.rstrip("/")
        address = urlsplit(self.base)
        if (
            address.scheme != "http"
            or address.hostname not in {"127.0.0.1", "localhost", "::1"}
            or address.username
            or address.password
            or address.query
            or address.fragment
            or address.path
        ):
            raise ValueError(
                "WANX model relay must be on the connected device loopback"
            )
        legacy = self.legacy()
        with self.jobs.connect() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS xingtu_model_profiles (
                owner TEXT NOT NULL, warehouse_id TEXT NOT NULL, revision INTEGER NOT NULL,
                config_json TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(owner,warehouse_id));
              CREATE TABLE IF NOT EXISTS xingtu_model_checks (
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, warehouse_id TEXT NOT NULL,
                config_json TEXT NOT NULL, expires_at INTEGER NOT NULL);
            """)
            # Upgrade editable profiles only; queued jobs and historical results
            # retain the exact model snapshot captured when they were created.
            for row in db.execute(
                "SELECT * FROM xingtu_model_profiles WHERE config_json IS NOT NULL"
            ).fetchall():
                config = json.loads(row["config_json"])
                if config.get("sensitive_follow") is True and config.get(
                    "sensitive"
                ) == config.get("extraction"):
                    continue
                config.update(
                    sensitive=config["extraction"],
                    sensitive_follow=True,
                    revision=row["revision"] + 1,
                )
                db.execute(
                    "UPDATE xingtu_model_profiles SET config_json=?,revision=?,updated_at=? WHERE owner=? AND warehouse_id=?",
                    (
                        encode(config),
                        config["revision"],
                        utc_now(),
                        row["owner"],
                        row["warehouse_id"],
                    ),
                )
            # SQL captures settings in the same transaction that enqueues a job.
            literal = encode(legacy).replace("'", "''")
            db.executescript(
                "DROP TRIGGER IF EXISTS xingtu_capture_processing;"
                + f"""
              CREATE TRIGGER xingtu_capture_processing AFTER INSERT ON jobs BEGIN
                UPDATE jobs SET metrics_json=json_set(COALESCE(metrics_json,'{{}}'),'$.processing',json(
                  COALESCE(
                    (SELECT p.config_json FROM xingtu_model_profiles p JOIN xingtu_warehouses w
                     ON w.owner=p.owner AND w.id=p.warehouse_id WHERE w.workspace_id=NEW.workspace_id AND w.state='active'),
                    (SELECT p.config_json FROM xingtu_model_profiles p JOIN xingtu_warehouses w
                     ON w.owner=p.owner AND p.warehouse_id='' WHERE w.workspace_id=NEW.workspace_id AND w.state='active'),
                    '{literal}')))
                WHERE id=NEW.id;
              END;
            """
            )

    def legacy(self):
        s = self.settings
        item = {
            "id": "legacy-local",
            "model": s.ollama_model,
            "name": s.ollama_model,
            "provider": "现有本地服务",
            "location": "local",
            "revision": "legacy-local",
            "route": "legacy",
            "available": bool(s.public_status()["llm_configured"]),
        }
        return {
            "revision": 0,
            "source": "legacy",
            "extraction": item,
            "sensitive": item,
            "sensitive_follow": True,
            "checked_at": None,
        }

    def _owner(self, workspace):
        with self.jobs.connect() as db:
            row = db.execute(
                "SELECT * FROM xingtu_warehouses WHERE workspace_id=? AND state='active'",
                (workspace,),
            ).fetchone()
        if not row:
            raise WarehouseError(
                "数据仓已关闭或无权使用模型", 409, "MODEL_WAREHOUSE_UNAVAILABLE"
            )
        return dict(row)

    def relay(self, action, owner, payload=None):
        body = {"action": action, "owner": owner, **(payload or {})}
        raw = encode(body).encode()
        stamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        headers = {
            "content-type": "application/json",
            "x-starklink-time": stamp,
            "x-starklink-nonce": nonce,
        }
        if self.settings.integration_mode == "managed":
            secret = self.settings.integration_service_token.get_secret_value()
            headers["x-starklink-signature"] = hmac.new(
                secret.encode(), stamp.encode() + b"." + nonce.encode() + b"." + raw,
                hashlib.sha256,
            ).hexdigest()
        request = httpx.Request(
            "POST",
            self.base + "/internal/starklink/models",
            headers=headers,
            content=raw,
        )
        try:
            if controlled():
                response = send_interruptible(
                    request, timeout_seconds=self.settings.model_timeout_seconds
                )
            else:
                with httpx.Client(
                    timeout=self.settings.model_timeout_seconds,
                    trust_env=False,
                    follow_redirects=False,
                ) as client:
                    response = client.send(request)
            data = response.json()
            if response.status_code != 200:
                raise WarehouseError(
                    data.get("message") or data.get("code", "MODEL_UNAVAILABLE"),
                    response.status_code,
                    data.get("code", "MODEL_UNAVAILABLE"),
                )
            return data
        except WarehouseError:
            # WarehouseError is a ValueError: preserve an actual relay status
            # so authentication failures do not become retryable 503 errors.
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise WarehouseError(
                "无法连接万象模型服务，请检查连接或升级万象",
                503,
                "MODEL_RELAY_UNAVAILABLE",
            ) from exc

    def catalog(self, scope):
        return self.relay("catalog", owner_of(scope))

    def read(self, scope, warehouse_id=None):
        owner = owner_of(scope)
        if warehouse_id:
            self.state.warehouses._get(scope, warehouse_id)
        with self.jobs.connect() as db:
            rows = {
                r["warehouse_id"]: dict(r)
                for r in db.execute(
                    "SELECT * FROM xingtu_model_profiles WHERE owner=?", (owner,)
                )
            }
        default = rows.get("")
        override = rows.get(warehouse_id) if warehouse_id else None
        selected = override if override and override["config_json"] else default
        config = (
            json.loads(selected["config_json"])
            if selected and selected["config_json"]
            else self.legacy()
        )
        effective = {
            **config,
            "source": "warehouse"
            if selected is override and override
            else "default"
            if selected
            else "legacy",
        }
        effective["signature"] = configuration_signature(effective)
        return {
            "effective": effective,
            "revision": (override if warehouse_id else default or {}).get("revision", 0)
            if (override if warehouse_id else default)
            else 0,
            "default_revision": default["revision"] if default else 0,
            "inherit": bool(
                warehouse_id and not (override and override["config_json"])
            ),
            "device": scope.box_id,
            "warehouse_id": warehouse_id,
            "affected_warehouses": [
                w["name"]
                for w in self.state.warehouses.list(scope)["items"]
                if not rows.get(w["id"], {}).get("config_json")
            ],
            "stages": self.stages(),
        }

    def stages(self):
        s = self.settings
        local = s.public_status()["local_models"]
        return [
            {
                "role": "ocr",
                "name": "RapidOCR",
                "location": "local",
                "available": local.get("ocr", False),
            },
            {
                "role": "asr",
                "name": s.asr_model_dir.name,
                "location": "local",
                "available": local.get("asr", False),
            },
            {
                "role": "embedding",
                "name": s.public_status()["embedding_model"],
                "location": "local" if s.embedding_provider == "local" else "external",
                "available": s.public_status()["embedding_configured"],
            },
        ]

    def check(self, scope, payload):
        owner = owner_of(scope)
        wid = payload.get("warehouse_id") or ""
        if wid:
            self.state.warehouses._get(scope, wid)
        if payload.get("sensitive_follow", True) is not True or payload.get(
            "sensitive"
        ) not in (None, payload["extraction"]):
            raise WarehouseError(
                "知识抽取和脱敏检测必须使用同一个模型，请刷新后统一设置",
                409,
                "MODEL_SHARED_REQUIRED",
            )
        selected = {m["id"]: m for m in self.catalog(scope)["items"]}
        config = {
            "revision": 0,
            "source": "warehouse" if wid else "default",
            "sensitive_follow": True,
            "checked_at": utc_now(),
        }
        for role in ("extraction", "sensitive"):
            key = payload["extraction"]
            item = selected.get(key)
            if not item or not item["available"]:
                raise WarehouseError("所选模型不可用", 409, "MODEL_UNAVAILABLE")
            if item["location"] != "local" and item["revision"] not in payload.get(
                "cloud_confirmations", []
            ):
                raise WarehouseError(
                    "请确认向所选云端服务发送正文片段",
                    409,
                    "MODEL_CLOUD_CONFIRMATION_REQUIRED",
                )
            config[role] = {**item, "route": "wanx"}
        for item in {
            m["id"]: m for m in (config["extraction"], config["sensitive"])
        }.values():
            self.relay("check", owner, {"selection": item})
        identifier = uuid.uuid4().hex
        with self.jobs.connect() as db:
            db.execute(
                "DELETE FROM xingtu_model_checks WHERE expires_at<?",
                (int(time.time()),),
            )
            db.execute(
                "INSERT INTO xingtu_model_checks VALUES (?,?,?,?,?)",
                (identifier, owner, wid, encode(config), int(time.time()) + 600),
            )
        return {"check_id": identifier, "config": config}

    def save(self, scope, payload):
        owner = owner_of(scope)
        wid = payload.get("warehouse_id") or ""
        if wid:
            self.state.warehouses._get(scope, wid)
        inherit = bool(wid and payload.get("inherit"))
        if not inherit:
            with self.jobs.connect() as db:
                checked = db.execute(
                    "SELECT config_json FROM xingtu_model_checks WHERE id=? AND owner=? AND warehouse_id=? AND expires_at>?",
                    (payload.get("check_id"), owner, wid, int(time.time())),
                ).fetchone()
            if not checked:
                raise WarehouseError(
                    "模型检查已过期，请重新检查", 409, "MODEL_CHECK_REQUIRED"
                )
            current = {m["id"]: m for m in self.catalog(scope)["items"]}
            for role in ("extraction", "sensitive"):
                model = json.loads(checked[0])[role]
                if current.get(model["id"], {}).get("revision") != model["revision"]:
                    raise WarehouseError(
                        "模型服务配置已变化，请重新检查并确认",
                        409,
                        "MODEL_CONFIG_CHANGED",
                    )
        with self.jobs.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT * FROM xingtu_model_profiles WHERE owner=? AND warehouse_id=?",
                (owner, wid),
            ).fetchone()
            revision = row["revision"] if row else 0
            if revision != payload["expected_revision"]:
                raise WarehouseError(
                    "模型设置已更新，请刷新后重新选择", 409, "MODEL_CONFIG_CONFLICT"
                )
            config = None
            if not inherit:
                check = db.execute(
                    "SELECT * FROM xingtu_model_checks WHERE id=? AND owner=? AND warehouse_id=? AND expires_at>?",
                    (payload.get("check_id"), owner, wid, int(time.time())),
                ).fetchone()
                if not check:
                    raise WarehouseError(
                        "模型检查已过期，请重新检查", 409, "MODEL_CHECK_REQUIRED"
                    )
                config = json.loads(check["config_json"])
                if config.get("sensitive_follow") is not True or config.get(
                    "sensitive"
                ) != config.get("extraction"):
                    raise WarehouseError(
                        "请刷新后统一检查知识抽取与脱敏模型",
                        409,
                        "MODEL_SHARED_REQUIRED",
                    )
                config["revision"] = revision + 1
            db.execute(
                "INSERT OR REPLACE INTO xingtu_model_profiles VALUES (?,?,?,?,?)",
                (
                    owner,
                    wid,
                    revision + 1,
                    encode(config) if config else None,
                    utc_now(),
                ),
            )
        return self.read(scope, wid or None)

    def effective(self, workspace):
        try:
            row = self._owner(workspace)
        except WarehouseError:
            return self.legacy()
        with self.jobs.connect() as db:
            p = db.execute(
                "SELECT config_json FROM xingtu_model_profiles WHERE owner=? AND warehouse_id IN (?, '') AND config_json IS NOT NULL ORDER BY warehouse_id DESC LIMIT 1",
                (row["owner"], row["id"]),
            ).fetchone()
        return json.loads(p[0]) if p else self.legacy()

    def model_settings(self, snapshot, role):
        item = snapshot[role]
        if item.get("route") != "wanx":
            return self.settings.model_copy(deep=True)
        # This loopback address is a cache identity, never an inference target.
        # Explicit reprocessing gets a fresh detector cache; retries keep it.
        return self.settings.model_copy(
            update={
                "llm_provider": "openai_compatible",
                "openai_model": item["model"],
                "openai_base_url": self.base
                + "/models/"
                + item["revision"]
                + (
                    "/reprocess/" + snapshot["sensitive_cache_epoch"]
                    if role == "sensitive" and snapshot.get("sensitive_cache_epoch")
                    else ""
                ),
                "openai_think": "auto",
            }
        )

    def snapshot(self, job):
        value = job.get("metrics") or json.loads(job.get("metrics_json") or "{}")
        snapshot = value.get("processing")
        if snapshot and snapshot.get("historical"):
            return self.effective(str(job["workspace_id"]))
        return snapshot or self.legacy()

    def authorize(self, scope, payload):
        job = self.jobs.get_job(payload["job_id"])
        warehouse = self._owner(str(job["workspace_id"]))
        if (
            warehouse["owner"] != owner_of(scope)
            or job["status"] != "running"
            or job.get("cancel_requested")
            or job["kind"] not in {"extraction": {"knowledge_extract"}, "sensitive": {"sensitive_scan", "reasoning_detect"}}[payload["purpose"]]
        ):
            raise WarehouseError("处理任务授权已失效", 403, "MODEL_TASK_REVOKED")
        selected = self.snapshot(job)[payload["purpose"]]
        if (
            selected.get("route") != "wanx"
            or selected["id"] != payload["model_id"]
            or selected["revision"] != payload["model_revision"]
        ):
            raise WarehouseError("模型不属于当前任务配置", 403, "MODEL_TASK_REVOKED")
        return {"authorized": True}

    @contextmanager
    def job_context(self, job):
        snapshot = self.snapshot(job)

        def invoke(*, text, schema, purpose):
            selection = snapshot[purpose]
            if selection.get("route") != "wanx":
                return None
            warehouse = self._owner(str(job["workspace_id"]))
            result = self.relay(
                "infer",
                warehouse["owner"],
                {
                    "job_id": job["id"],
                    "warehouse_id": warehouse["id"],
                    "purpose": purpose,
                    "selection": selection,
                    "text": text,
                    "schema": schema,
                },
            )
            call = {
                "purpose": purpose,
                "model": selection["name"],
                "location": selection["location"],
                "usage": result.get("usage"),
                "at": utc_now(),
            }
            with self.jobs.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT metrics_json FROM jobs WHERE id=?", (job["id"],)
                ).fetchone()
                metrics = json.loads(row[0] or "{}")
                metrics["model_calls"] = [*metrics.get("model_calls", []), call][-100:]
                db.execute(
                    "UPDATE jobs SET metrics_json=? WHERE id=?",
                    (encode(metrics), job["id"]),
                )
            return result["text"]

        token = ACTIVE_MODEL_CALL.set(invoke)
        try:
            yield snapshot
        finally:
            ACTIVE_MODEL_CALL.reset(token)

"""Cached integration processing preparation in standalone and managed modes.

Model preparation checks the installed manifest and asset sizes. The managed
entrypoint verifies their complete hashes; delivery qualification exercises the
actual models. This surface does not infer model API availability or quality.
"""
from __future__ import annotations

import json
from pathlib import PurePosixPath
import re
from threading import Event, Lock, Thread
import time

from neo4j import GraphDatabase, Query, READ_ACCESS

from app.adapters.model_api import api_settings
from app.config import PROJECT_ROOT


PROCESSING_CHECKS = ("embedding_prepared", "cloud_configured", "worker_ready",
                     "automatic_pipeline", "graph_ready")


def prepared_model(settings, name: str) -> bool:
    """Stat the selected managed model, never hash or load its weight files."""
    path = settings.embedding_local_path if name == "embedding" else settings.ocr_model_dir
    try:
        manifest_path = PROJECT_ROOT / "models" / "manifest.json"
        if manifest_path.stat().st_size > 1024 * 1024:
            return False
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        record = manifest["models"][name]
        declared = PurePosixPath(record["project_path"])
        if (manifest.get("schema_version") != 1 or declared.is_absolute()
                or ".." in declared.parts or not declared.parts or declared.parts[0] != "models"
                or (PROJECT_ROOT / declared).resolve() != path.resolve()):
            return False
        files = record["files"]
        if not isinstance(files, list) or not 1 <= len(files) <= 256:
            return False
        names = set()
        for item in files:
            relative = PurePosixPath(item["path"])
            if relative.is_absolute() or ".." in relative.parts or not relative.parts:
                return False
            if relative.as_posix() in names:
                return False
            names.add(relative.as_posix())
            target = path / relative
            if (not target.resolve().is_relative_to(path.resolve()) or not target.is_file()
                    or type(item["bytes"]) is not int or item["bytes"] <= 0
                    or target.stat().st_size != item["bytes"]
                    or not isinstance(item["sha256"], str)
                    or re.fullmatch(r"[a-f0-9]{64}", item["sha256"]) is None):
                return False
        required = ({"config.json", "modules.json", "tokenizer.json"} if name == "embedding" else {
            "ch_PP-OCRv4_det_infer.onnx", "ch_ppocr_mobile_v2.0_cls_infer.onnx", "ch_PP-OCRv4_rec_infer.onnx"})
        if not required.issubset(names) or (name == "embedding" and not {
                "model.safetensors", "pytorch_model.bin"}.intersection(names)):
            return False
        actual = {file.relative_to(path).as_posix() for file in path.rglob("*") if file.is_file()}
        return actual == names
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def probe_graph(settings) -> bool:
    """Bounded, authenticated read of one constant; no application graph access."""
    if not settings.public_status()["neo4j_configured"]:
        return False
    with GraphDatabase.driver(settings.neo4j_uri,
            auth=(settings.neo4j_user, settings.neo4j_password.get_secret_value()),
            connection_timeout=1, connection_acquisition_timeout=1,
            max_transaction_retry_time=0) as driver:
        with driver.session(database=settings.neo4j_database, default_access_mode=READ_ACCESS) as session:
            row = session.run(Query("RETURN 1 AS ready", timeout=1)).single()
            return row is not None and row["ready"] == 1


class ManagedProcessingReadiness:
    def __init__(self, state):
        self.state = state
        self._lock, self._stop = Lock(), Event()
        self._thread = None
        self._prepared = self._graph = False
        self._key = None
        self._observed = 0.0

    def _configuration(self):
        settings = self.state.settings
        try:
            api_settings(settings.model_api_config())
            configured = True
        except (ValueError, TypeError):
            configured = False
        # Private comparison only: credentials and endpoints never enter output.
        key = (settings.llm_provider, settings.openai_base_url, settings.openai_model,
            settings.openai_api_key.get_secret_value(), settings.ollama_base_url,
            settings.ollama_model, settings.embedding_provider,
            str(settings.embedding_local_path), settings.embedding_device, str(settings.ocr_model_dir), settings.neo4j_uri,
            settings.neo4j_user, settings.neo4j_password.get_secret_value(), settings.neo4j_database)
        return configured, key

    def refresh(self):
        configured, key = self._configuration()
        prepared = self.state.settings.embedding_provider == "local" and prepared_model(self.state.settings, "embedding")
        graph = False
        # Graph health is independent of selected model preparation/configuration.
        if not self._stop.is_set():
            try:
                graph = probe_graph(self.state.settings) is True
            except Exception:
                # Authentication/transport exception text can contain credentials.
                graph = False
        with self._lock:
            self._key, self._prepared, self._graph = key, bool(prepared), graph
            self._observed = time.monotonic()

    def public(self) -> dict:
        configured, key = self._configuration()
        with self._lock:
            current = (not self._stop.is_set() and self._key == key
                       and time.monotonic() - self._observed <= 15)
            prepared, graph = current and self._prepared, current and self._graph
        # Retain the published check name for either supported model API provider.
        checks = {"embedding_prepared": bool(prepared), "cloud_configured": configured,
            "worker_ready": self.state.worker_enabled is True and self.state.worker.healthy is True,
            "automatic_pipeline": self.state.automatic_pipeline is True, "graph_ready": bool(graph)}
        provider = self.state.documents.ocr_provider
        ocr = (getattr(provider, "_engine", None) is not None
               and getattr(provider, "model_dir", None) == self.state.settings.ocr_model_dir.resolve())
        return {"processing_ready": all(checks.values()), "processing_checks": checks,
                "ocr_ready": bool(current and ocr and prepared_model(self.state.settings, "ocr"))}

    def start(self):
        self._thread = Thread(target=self._run, name="semantica-processing-readiness", daemon=True)
        self._thread.start()

    def _run(self):
        while not self._stop.is_set():
            self.refresh()
            self._stop.wait(5)

    def stop(self):
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)


def processing_capability(state) -> dict:
    readiness = getattr(state, "processing_readiness", None)
    if readiness is None:
        return {"processing_ready": False, "processing_checks": {key: False for key in PROCESSING_CHECKS}, "ocr_ready": False}
    return readiness.public()

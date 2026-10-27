"""Isolated real Semantica HTTP server; the parent owns its actual Unix authority."""

from __future__ import annotations

import asyncio
import json
import socket
import sys
from pathlib import Path
from unittest.mock import patch

import uvicorn
from centuarai_local_data_gate import GateConfig


class DeterministicEmbedding:
    """Only the model calculation is synthetic; Qdrant and index building are real."""

    dimension = 4

    def embed_documents(self, texts):
        return [[1.0, 0.0, 0.0, 0.0] for _ in texts]

    def embed_query(self, text):
        return [1.0, 0.0, 0.0, 0.0]


def build_index(state, document_id):
    state.documents.process_job(state.jobs.claim_next_document_job("integration-fixture"))
    document = state.jobs.get_document(document_id)
    assert document["status"] == "ready", document
    state.search.embedding = DeterministicEmbedding()
    index, job, _ = state.search.start_build(document["workspace_id"])
    claimed = state.search.repository.claim_next("integration-fixture")
    assert claimed["id"] == job["id"]
    state.search.process_job(claimed)
    completed = state.jobs.get_job(job["id"])
    assert completed["status"] == "succeeded", completed
    # Keep the real privacy policy and rule scanner active; no remote LLM is
    # configured for this disposable warehouse's optional semantic detector.
    policy = state.sensitive.policy(document["workspace_id"])
    state.sensitive.save_policy(
        document["workspace_id"],
        expected_revision=policy["revision"],
        enabled=True,
        semantic_enabled=False,
        rules=policy["rules"],
    )
    state.sensitive.schedule_scan(document["workspace_id"])
    scan = state.sensitive.claim_next("integration-fixture")
    assert scan is not None
    state.sensitive.process_job(scan)
    completed_scan = state.jobs.get_job(scan["id"])
    assert completed_scan["status"] == "succeeded", completed_scan
    return {"indexId": index["id"]}


async def main():
    from app import main as application
    from app.config import Settings

    value = json.loads(Path(sys.argv[1]).read_text())
    root = Path(value["root"])
    application.PROJECT_ROOT = root
    config = GateConfig(
        "semantica",
        "gateway:test",
        value["gatewayKey"],
        value["boxId"],
        value["boxKeyThumbprint"],
        value["brokerPath"],
        root / "stage",
    )
    config.staging_directory.mkdir(mode=0o700)
    settings = Settings(
        _env_file=None,
        local_data_gate_mode="required",
        mcp_host="127.0.0.1",
        knowledge_auto_pipeline=False,
        embedding_provider="openai_compatible",
        embedding_base_url="http://127.0.0.1:9",
        embedding_api_key="synthetic-test",
        embedding_model="deterministic-test",
    )
    # Only installation/configuration is synthetic. BrokerClient, native gate,
    # signatures, ledger authorization and all SQLite services stay real.
    with (
        patch("centuarai_local_data_gate.config.load_required_policy", return_value=None),
        patch.object(GateConfig, "load", return_value=config),
        patch.object(application, "get_settings", return_value=settings),
    ):
        app = application.create_app(data_dir=root / "data", start_worker=False)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        service = uvicorn.Server(uvicorn.Config(app, log_level="critical", lifespan="on"))
        task = asyncio.create_task(service.serve(sockets=[listener]))
        try:
            for _ in range(300):
                if service.started:
                    break
                if task.done():
                    await task
                    raise RuntimeError("Semantica exited during startup")
                await asyncio.sleep(0.01)
            assert service.started
            print(json.dumps({"url": f"http://127.0.0.1:{listener.getsockname()[1]}"}), flush=True)
            while True:
                line = await asyncio.to_thread(sys.stdin.readline)
                if not line or line.strip() == "close":
                    break
                command = json.loads(line)
                assert set(command) == {"indexDocument"}
                result = await asyncio.to_thread(build_index, app.state, command["indexDocument"])
                print(json.dumps(result), flush=True)
        finally:
            service.should_exit = True
            try:
                await asyncio.wait_for(asyncio.shield(task), 5)
            except TimeoutError:
                service.force_exit = True
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            listener.close()


if __name__ == "__main__":
    asyncio.run(main())

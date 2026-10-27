"""Native device projection reaches real Codex through a synthetic Responses service."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from octop.config import OctopConfig
from octop.infra.agents.providers.device_projection import DeviceProviderProjection
from octop.infra.db.migrate import run_migrations
from octop.infra.db.pool import SqlitePool
from octop.infra.db.services import build_shared_services
from octop.infra.utils.paths import PathLayout
from tests.support.builder_device_models import SyntheticCatalog, SyntheticResponse

_NATIVE_TURN = """
import {NativeSession} from './codex/native-session.mjs';
import {runtimeEnvironment,runtimeEffort} from './codex/runtime-env.mjs';
const config=JSON.parse(process.env.WANX_CODEX_CONFIG);let text='';
const native=new NativeSession({binary:process.env.WANX_CODEX_PATH,config,
  env:runtimeEnvironment(),onEvent:event=>{if(event.type==='message')text+=event.text}});
process.once('SIGTERM',()=>void native.close().finally(()=>process.exit(1)));
try{
 const session=await native.open({cwd:process.env.FIXTURE_WORKSPACE,
   sessionId:process.env.FIXTURE_THREAD||undefined,scope:'synthetic-device',mcpServers:{}});
 await native.prompt([{type:'text',text:'Reply to this synthetic device test.'}],
   {effort:runtimeEffort(config)});
 process.stdout.write(JSON.stringify({sessionId:session.sessionId,text})+'\\n');
}finally{await native.close()}
"""


@pytest.mark.skipif(os.name != "posix", reason="Box Codex process integration is POSIX-only")
async def test_native_device_models_reach_builder_and_rotate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, repo_root: Path
) -> None:
    studio = repo_root / "wanx-studio"
    node = shutil.which("node")
    if node is None or not (studio / "node_modules" / ".bin" / "codex").is_file():
        pytest.skip("Install wanx-studio npm dependencies for real Codex integration")
    monkeypatch.syspath_prepend(str(repo_root / "wanx-bridge"))
    monkeypatch.setenv("OCTOP_HOME", str(tmp_path / "octop"))
    monkeypatch.setenv("WANX_MODEL_PROVIDERS_ENABLED", "1")
    from wanx_bridge.native_model_service import native_model_service
    from wanx_studio.codex_config import config_fingerprint, runtime_config
    from wanx_studio.wanx import WanxModels

    paths = PathLayout(tmp_path / "octop")
    paths.ensure_root()
    db = SqlitePool(paths.db)
    run_migrations(db)
    services = build_shared_services(db=db, paths=paths, config=OctopConfig())
    changes: list[dict[str, Any]] = []

    async def changed(**event: Any) -> None:
        changes.append(event)

    projection = DeviceProviderProjection(services, on_changed=changed)
    catalog, seen, discovered = SyntheticCatalog(), [], []
    supplier = catalog.value["providers"][0]
    supplier["allowedModels"] = []
    model_ids = ["gpt-5.2"]

    async def synthetic_upstream(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer " + supplier["apiKey"]
        if request.method == "GET":
            assert request.url.path == "/v1/models"
            discovered.append(model_ids.copy())
            return httpx.Response(200, json={"data": [{"id": model} for model in model_ids]})
        body = json.loads(request.content)
        seen.append((request, body))
        assert request.method == "POST" and request.url.path == "/v1/responses"
        assert body["model"] == model_ids[0] and body["stream"]
        text = "synthetic-device-ok-" + str(len(seen))
        item = {
            "type": "message",
            "id": "msg_device_" + str(len(seen)),
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": text, "annotations": []}],
        }
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=SyntheticResponse(len(seen), item, text, body["model"]),
        )

    workspace = tmp_path / "workspace"
    workspace.mkdir()

    async def turn(environment: dict[str, str], thread: str = "") -> dict[str, Any]:
        proc = await asyncio.create_subprocess_exec(
            node,
            "--input-type=module",
            "-e",
            _NATIVE_TURN,
            cwd=studio,
            env={
                "PATH": os.environ.get("PATH", ""),
                "HOME": str(tmp_path),
                **environment,
                "FIXTURE_WORKSPACE": str(workspace),
                "FIXTURE_THREAD": thread,
            },
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), 45)
            assert proc.returncode == 0, stderr.decode()
            return json.loads(stdout)
        finally:
            if proc.returncode is None:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), 5)
                except TimeoutError:
                    proc.kill()
                    await proc.wait()

    try:
        async with native_model_service(
            catalog.config,
            projection,
            port=0,
            catalog=catalog,
            transport=httpx.MockTransport(synthetic_upstream),
        ) as runtime:
            service = SimpleNamespace(
                project_root=studio,
                store=SimpleNamespace(root=tmp_path / "studio"),
                model=WanxModels(services),
            )
            async with asyncio.timeout(5):
                while (before := runtime_config(service=service, owner="wanx:1")) is None:
                    await asyncio.sleep(0.01)
            settings = json.loads(before["WANX_CODEX_CONFIG"])
            assert settings["model"] == "gpt-5.2"
            row = services.provider_repo.get_by_name("admin-managed-qeetoken")
            assert (
                row is not None and row.base_url == runtime.origin + "/model-providers/qeetoken/v1"
            )
            assert before["WANX_CODEX_PROXY_TOKEN"] == row.api_key != supplier["apiKey"]
            assert changes and settings["model_provider"] == "wanx_device"
            first = await turn(before)
            assert first["text"] == "synthetic-device-ok-1"

            change_count = len(changes)
            model_ids[:] = ["gpt-5.4"]
            supplier.update(apiKey="rotated-supplier-secret", configVersion="2")
            async with asyncio.timeout(5):
                while (after := runtime_config(service=service, owner="wanx:1")) is None or (
                    after["WANX_CODEX_PROXY_TOKEN"] == before["WANX_CODEX_PROXY_TOKEN"]
                ):
                    await asyncio.sleep(0.01)
            assert json.loads(after["WANX_CODEX_CONFIG"])["model"] == "gpt-5.4"
            assert config_fingerprint(after) != config_fingerprint(before)
            assert after["CODEX_HOME"] == before["CODEX_HOME"]
            second = await turn(after, first["sessionId"])
            assert second == {"sessionId": first["sessionId"], "text": "synthetic-device-ok-2"}
            assert len(changes) > change_count
            assert len(seen) == 2
            assert discovered[0] == ["gpt-5.2"] and discovered[-1] == ["gpt-5.4"]
            assert all(models in (["gpt-5.2"], ["gpt-5.4"]) for models in discovered)
            assert {"1", "2"}.issubset(catalog.acknowledged_versions)
            assert "synthetic-device-ok-1" in json.dumps(seen[1][1]["input"])
            with db.connect() as connection:
                stored = "\n".join(connection.iterdump())
            assert "supplier-private-key" not in stored and "rotated-supplier-secret" not in stored
        assert runtime.closed and catalog.closed
    finally:
        db.close()

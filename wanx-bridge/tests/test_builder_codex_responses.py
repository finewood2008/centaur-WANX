"""Real bundled Codex against a synthetic Responses service through the real Bridge.

No model is called: only the CLI process and loopback HTTP server are real. The
upstream transport emits fixed SSE fixtures and never opens a network connection.
"""

import asyncio
import contextlib
import json
import os
import shutil
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from test_gateway import live_server
from test_model_provider_runtime import runtime

STUDIO = Path(__file__).resolve().parents[2] / "wanx-studio"
CODEX = STUDIO / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
MODEL = "gpt-5.2"
NEXT_MODEL = "gpt-5.4"


def event(kind, **fields):
    return ("event: " + kind + "\ndata: " + json.dumps({"type": kind, **fields}) + "\n\n").encode()


class SyntheticResponse(httpx.AsyncByteStream):
    def __init__(self, sequence, item, text=None, model=MODEL):
        self.sequence, self.item, self.text, self.model = sequence, item, text, model

    async def __aiter__(self):
        response = {
            "id": f"resp_synthetic_{self.sequence}",
            "object": "response",
            "created_at": 1,
            "status": "in_progress",
            "model": self.model,
            "output": [],
        }
        yield event("response.created", response=response)
        yield event("response.output_item.added", output_index=0, item=self.item)
        if self.text is not None:
            yield event(
                "response.output_text.delta",
                item_id=self.item["id"],
                output_index=0,
                content_index=0,
                delta=self.text,
            )
            # A second separately yielded body verifies incremental SSE handling.
            await asyncio.sleep(0)
            yield event(
                "response.output_text.done",
                item_id=self.item["id"],
                output_index=0,
                content_index=0,
                text=self.text,
            )
        yield event("response.output_item.done", output_index=0, item=self.item)
        yield event(
            "response.completed",
            response={
                **response,
                "status": "completed",
                "output": [self.item],
                "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            },
        )


class AppServer:
    """Small protocol client: tool execution is a fixed, non-I/O test function."""

    def __init__(self, proc):
        self.proc = proc
        self.sequence = 0
        self.pending = {}
        self.notices = asyncio.Queue()
        self.calls = []
        self.reader = asyncio.create_task(self.read())

    async def send(self, message):
        self.proc.stdin.write(json.dumps(message).encode() + b"\n")
        await self.proc.stdin.drain()

    async def read(self):
        while line := await self.proc.stdout.readline():
            message = json.loads(line)
            if "method" in message and "id" in message:
                assert message["method"] == "item/tool/call", message
                self.calls.append(message["params"])
                assert message["params"]["tool"] == "fixture_echo"
                assert message["params"]["arguments"] == {"value": "alpha"}
                await self.send(
                    {
                        "id": message["id"],
                        "result": {
                            "success": True,
                            "contentItems": [{"type": "inputText", "text": "fixture-result-alpha"}],
                        },
                    }
                )
            elif "id" in message:
                self.pending.pop(message["id"]).set_result(message)
            else:
                await self.notices.put(message)

    async def request(self, method, params):
        self.sequence += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.sequence] = future
        await self.send({"id": self.sequence, "method": method, "params": params})
        result = await asyncio.wait_for(future, 20)
        assert "error" not in result, result
        return result["result"]

    async def completed(self, thread_id):
        text = []
        async with asyncio.timeout(30):
            while True:
                if self.reader.done():
                    await self.reader
                    raise AssertionError("Codex closed before completing the turn")
                notice = await self.notices.get()
                params = notice.get("params", {})
                if params.get("threadId") != thread_id:
                    continue
                if notice["method"] == "item/agentMessage/delta":
                    text.append(params["delta"])
                if notice["method"] == "turn/completed":
                    assert params["turn"]["status"] == "completed", params
                    return "".join(text)

    async def close(self):
        self.reader.cancel()
        try:
            with contextlib.suppress(asyncio.CancelledError):
                await self.reader
        finally:
            if self.proc.returncode is None:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), 5)
                except TimeoutError:
                    self.proc.kill()
                    await self.proc.wait()


async def start_app_server(node, settings, state, workspace, token):
    args = [arg for key, value in settings.items() for arg in ("-c", key + "=" + json.dumps(value))]
    proc = await asyncio.create_subprocess_exec(
        node,
        str(CODEX),
        "app-server",
        "--listen",
        "stdio://",
        *args,
        cwd=workspace,
        env={
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(state.parent),
            "CODEX_HOME": str(state),
            "WANX_TEST_PROXY_TOKEN": token,
        },
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    client = AppServer(proc)
    try:
        await client.request(
            "initialize",
            {
                "clientInfo": {"name": "wanx_synthetic_protocol_test", "version": "1.0.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        await client.send({"method": "initialized", "params": {}})
    except BaseException:
        await client.close()
        raise
    return client


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="Box Codex process integration is POSIX-only")
async def test_bundled_codex_responses_tools_and_followup_via_private_proxy(tmp_path):
    node = shutil.which("node")
    if not CODEX.is_file() or node is None:
        pytest.skip("Install wanx-studio npm dependencies to verify its bundled Codex")

    requests = []

    async def synthetic_upstream(request):
        assert request.method == "POST" and request.url.path == "/v1/responses"
        expected_secret = (
            "supplier-secret-never-persist" if len(requests) < 5 else "rotated-supplier-secret"
        )
        assert request.headers["authorization"] == "Bearer " + expected_secret
        assert request.url.host == (
            "models.example.com" if len(requests) < 5 else "rotated.example.com"
        )
        assert request.headers.get("content-encoding") is None
        body = json.loads(request.content)
        requests.append(body)
        assert body["model"] == (MODEL if len(requests) <= 5 else NEXT_MODEL)
        assert body["stream"] is True
        sequence = len(requests)
        if sequence == 1:
            assert any(tool.get("name") == "fixture_echo" for tool in body["tools"])
            item = {
                "type": "function_call",
                "id": "fc_synthetic",
                "call_id": "call_synthetic",
                "name": "fixture_echo",
                "arguments": '{"value":"alpha"}',
                "status": "completed",
            }
            text = None
        else:
            text = {
                2: "synthetic-first-ok",
                3: "synthetic-followup-ok",
                4: "synthetic-compaction-summary",
                5: "synthetic-after-compaction-ok",
                6: "synthetic-after-model-rotation-ok",
            }[sequence]
            item = {
                "type": "message",
                "id": f"msg_synthetic_{sequence}",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=SyntheticResponse(sequence, item, text, body["model"]),
        )

    rt, catalog, _admin = runtime(synthetic_upstream)
    catalog.value["providers"][0]["allowedModels"] = [MODEL]
    app = FastAPI()
    rt.register_routes(app)
    state = tmp_path / "codex-state"
    state.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    client = None
    try:
        async with live_server(app) as origin:
            rt.origin = origin
            await rt.reconcile()
            settings = {
                "model": MODEL,
                "model_provider": "wanx_fixture",
                "model_providers.wanx_fixture": {
                    "name": "Synthetic WANX fixture",
                    "base_url": origin + "/model-providers/primary/v1",
                    "env_key": "WANX_TEST_PROXY_TOKEN",
                    "wire_api": "responses",
                    "requires_openai_auth": False,
                    "supports_websockets": False,
                    "request_max_retries": 0,
                    "stream_max_retries": 0,
                },
                "check_for_update_on_startup": False,
                "web_search": "disabled",
                "features.shell_tool": False,
                "features.unified_exec": False,
                "features.multi_agent": False,
                "features.apps": False,
                "features.plugins": False,
                "features.memories": False,
            }
            # JSON object syntax is not TOML; pass the provider fields individually.
            provider = settings.pop("model_providers.wanx_fixture")
            settings.update({"model_providers.wanx_fixture." + k: v for k, v in provider.items()})
            client = await start_app_server(
                node, settings, state, workspace, rt.entries["primary"]["key"]
            )
            result = await client.request(
                "thread/start",
                {
                    "cwd": str(workspace),
                    "model": MODEL,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "dynamicTools": [
                        {
                            "type": "function",
                            "name": "fixture_echo",
                            "description": "Return a fixed synthetic result; no I/O.",
                            "inputSchema": {
                                "type": "object",
                                "properties": {"value": {"type": "string"}},
                                "required": ["value"],
                                "additionalProperties": False,
                            },
                        }
                    ],
                },
            )
            thread = result["thread"]["id"]
            for prompt, expected in [
                ("Run the synthetic fixture.", "synthetic-first-ok"),
                ("Continue the synthetic fixture.", "synthetic-followup-ok"),
            ]:
                await client.request(
                    "turn/start", {"threadId": thread, "input": [{"type": "text", "text": prompt}]}
                )
                assert await client.completed(thread) == expected

            assert len(client.calls) == 1 and client.calls[0]["callId"] == "call_synthetic"
            assert len(requests) == 3
            for body in requests[1:]:
                output = next(
                    item for item in body["input"] if item["type"] == "function_call_output"
                )
                assert output["call_id"] == "call_synthetic"
                assert "fixture-result-alpha" in json.dumps(output["output"])
            assert "synthetic-first-ok" in json.dumps(requests[2]["input"])
            assert "Continue the synthetic fixture." in json.dumps(requests[2]["input"])

            # Custom providers compact by replaying input through /responses in
            # the pinned CLI; this also guards against a new endpoint dependency.
            await client.request("thread/compact/start", {"threadId": thread})
            await client.completed(thread)
            assert len(requests) == 4
            await client.request(
                "turn/start",
                {"threadId": thread, "input": [{"type": "text", "text": "After compaction."}]},
            )
            assert await client.completed(thread) == "synthetic-after-compaction-ok"
            assert len(requests) == 5
            assert "synthetic-compaction-summary" in json.dumps(requests[4]["input"])
            # A new worker must apply the current device model and proxy route
            # when resuming an existing thread, rather than its saved defaults.
            await client.close()
            client = None
            catalog.value["providers"].append(
                {
                    **catalog.value["providers"][0],
                    "providerId": "rotated",
                    "baseUrl": "https://rotated.example.com/v1",
                    "apiKey": "rotated-supplier-secret",
                    "allowedModels": [NEXT_MODEL],
                }
            )
            await rt.reconcile()
            rotated_provider = {**provider, "base_url": origin + "/model-providers/rotated/v1"}
            settings["model"] = NEXT_MODEL
            settings["model_providers.wanx_fixture.base_url"] = rotated_provider["base_url"]
            client = await start_app_server(
                node, settings, state, workspace, rt.entries["rotated"]["key"]
            )
            resumed = await client.request(
                "thread/resume",
                {
                    "threadId": thread,
                    "cwd": str(workspace),
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "config": {
                        "model": NEXT_MODEL,
                        "model_provider": "wanx_fixture",
                        "model_providers": {"wanx_fixture": rotated_provider},
                    },
                },
            )
            assert resumed["thread"]["id"] == thread
            assert resumed["model"] == NEXT_MODEL
            await client.request(
                "turn/start",
                {
                    "threadId": thread,
                    "input": [{"type": "text", "text": "Continue after model rotation."}],
                },
            )
            assert await client.completed(thread) == "synthetic-after-model-rotation-ok"
            assert len(requests) == 6
            assert "synthetic-compaction-summary" in json.dumps(requests[5]["input"])
            assert "supplier-secret-never-persist" not in json.dumps(requests)
            assert "rotated-supplier-secret" not in json.dumps(requests)
    finally:
        try:
            if client is not None:
                await client.close()
        finally:
            await rt.close()

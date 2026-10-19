"""Unmodified Octop runtime/SDK with ordinary Provider configuration over an explicit stdio HTTP seam for Admin tests.

Run only from the cross-repository disposable fixture. No network connection,
real credential, production gateway or price is configured by this helper.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

import httpx
from octop_harness import HarnessAgentConfig
from octop_harness.config import ModelConfig, ProviderConfig

from octop.infra.agents.runtime_manager import ApplicationHarnessManager

wire_output = sys.stdout


def send(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False), file=wire_output, flush=True)


async def read() -> dict[str, Any]:
    line = await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline)
    if not line:
        raise EOFError("Admin test driver closed its input")
    result: dict[str, Any] = json.loads(line)
    return result


async def run(root: Path) -> None:
    async def transport(self: Any, request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://gateway.test/v1/chat/completions"
        send(
            {
                "fetch": {
                    "url": str(request.url),
                    "method": request.method,
                    "headers": dict(request.headers),
                    "body": request.content.decode(),
                }
            }
        )
        response = await read()
        return httpx.Response(
            response["status"],
            headers=response["headers"],
            content=response["body"],
        )

    original_transport = httpx.AsyncHTTPTransport.handle_async_request
    httpx.AsyncHTTPTransport.handle_async_request = transport
    runtime = ApplicationHarnessManager(
        providers=[
            ProviderConfig(
                id="managed",
                protocol="openai",
                base_url="https://gateway.test/v1",
                api_key="test-gateway-key",
                stream_usage=True,
                models=[ModelConfig(id="chat", max_output_tokens=256)],
            )
        ],
        log_dir=root / "logs",
    )
    try:
        await runtime.acreate_agent(
            HarnessAgentConfig(
                workspace_dir=root / "agent",
                default_model="managed/chat",
                bootstrap_enabled=False,
                memory_enabled=False,
                subagents_auto_load=False,
                team_enabled=False,
                web_search_tools=False,
            ),
            agent_id="sdk-agent",
            metadata={"application_id": "wanx", "user_id": 1},
            init_workspace=False,
        )
        send({"ready": "credit-model-client-1"})
        command = await read()
        request = {
            "messages": "Summarize this synthetic test.",
            "thread_id": "sdk-thread",
            "configurable": {"application_id": "forged", "free": True},
        }
        try:
            if command["operation"] == "call":
                result = await runtime.call("sdk-agent", request)
                text = str(result["messages"][-1].content)
            elif command["operation"] == "stream":
                chunks = [chunk async for chunk in runtime.stream("sdk-agent", request)]
                assert not any(chunk.get("type") == "error" for chunk in chunks)
                text = "".join(
                    str(c.get("content", "")) for c in chunks if c.get("type") == "token"
                )
            else:
                raise ValueError("Unsupported test operation")
            send({"text": text})
        except Exception as exc:
            send(
                {
                    "error": type(exc).__name__,
                }
            )
    finally:
        await runtime.aclose()
        httpx.AsyncHTTPTransport.handle_async_request = original_transport


if __name__ == "__main__":
    logging.basicConfig(level=logging.ERROR, stream=sys.stderr)
    # The parent owns cleanup even when a hung subprocess must be killed.
    directory = Path(sys.argv[1])
    os.environ["OCTOP_HOME"] = str(directory / "home")
    with redirect_stdout(sys.stderr):
        asyncio.run(run(directory))

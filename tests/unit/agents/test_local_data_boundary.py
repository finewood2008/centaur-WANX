from types import SimpleNamespace

import pytest

from octop.infra.agents.middleware.local_data import LocalDataToolBoundary, local_data_live_check


@pytest.mark.parametrize(
    "name",
    [
        "execute",
        "read_file",
        "write_file",
        "browser_use",
        "mcp__files__read",
        "acp_runner",
        "ask_agent",
        "unknown_future_tool",
    ],
)
async def test_resumed_host_or_unknown_tool_never_reaches_handler(name):
    token = local_data_live_check.set(lambda: None)
    called = []

    async def handler(request):
        called.append(request)

    try:
        result = await LocalDataToolBoundary().awrap_tool_call(
            SimpleNamespace(tool_call={"name": name, "id": "old-checkpoint-call", "args": {}}),
            handler,
        )
        assert result.status == "error"
        assert called == []
    finally:
        local_data_live_check.reset(token)


async def test_missing_or_revoked_live_context_denies_even_safe_tool():
    boundary = LocalDataToolBoundary()
    request = SimpleNamespace(tool_call={"name": "current_time", "id": "clock", "args": {}})

    async def handler(_):
        pytest.fail("revoked tool executed")

    with pytest.raises(PermissionError):
        await boundary.awrap_tool_call(request, handler)

    def revoked():
        raise PermissionError("revoked")

    token = local_data_live_check.set(revoked)
    try:
        with pytest.raises(PermissionError):
            await boundary.awrap_tool_call(request, handler)
    finally:
        local_data_live_check.reset(token)


async def test_model_sees_only_reviewed_tool_and_revocation_rechecks_result():
    active = [True]

    def check():
        if not active[0]:
            raise PermissionError("revoked")

    token = local_data_live_check.set(check)

    class Request:
        tools = [SimpleNamespace(name=name) for name in ["current_time", "execute", "mcp_unknown"]]

        def override(self, **kwargs):
            return SimpleNamespace(**kwargs)

    async def handler(request):
        assert [tool.name for tool in request.tools] == ["current_time"]
        active[0] = False
        return "must not publish after revocation"

    try:
        with pytest.raises(PermissionError):
            await LocalDataToolBoundary().awrap_model_call(Request(), handler)
    finally:
        local_data_live_check.reset(token)


async def test_dashboard_queue_retains_guard_without_serializing_authority():
    import asyncio

    from octop_gateway.models import InboundMessage, TextContent

    from octop.infra.gateway.ws.local_data import LocalDataInbound, run_local_turn

    enabled = [True]

    def check():
        if not enabled[0]:
            raise PermissionError("revoked")

    original = InboundMessage(channel_id="test", content=[TextContent(text="hello")])
    message = LocalDataInbound.bind(original, check)
    assert message.model_dump() == original.model_dump()
    assert LocalDataInbound.model_validate(message.model_dump())._live is None
    queue = asyncio.Queue()
    entered = asyncio.Event()
    stopped = asyncio.Event()

    async def model_turn(_):
        assert local_data_live_check.get() is check
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def worker():
        await run_local_turn(await queue.get(), model_turn)

    # Worker starts before the producer and has no inherited request context.
    task = asyncio.create_task(worker())
    queue.put_nowait(message)
    await asyncio.wait_for(entered.wait(), 1)
    enabled[0] = False
    with pytest.raises(PermissionError):
        await asyncio.wait_for(task, 1)
    assert stopped.is_set()


@pytest.mark.parametrize(
    "body",
    [
        {"text": " /shell cat /private"},
        {"mcp_servers": ["host"]},
        {"skills": ["shell"]},
        {"target_agent_ids": ["another-agent"]},
        {"knowledge_base_ids": ["global"]},
        {"hitl_policy": {"mode": "allow_all", "tools": []}},
        {"messages": [{"role": "tool", "content": "untrusted"}]},
        {
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "image_url", "image_url": {"url": "file:///private"}}],
                }
            ]
        },
        {"messages": [{"role": "user", "content": "/cron create"}]},
    ],
)
def test_local_turn_rejects_pre_model_commands_and_external_context(body):
    from octop.infra.gateway.ws.local_data import validate_local_turn

    with pytest.raises(PermissionError):
        validate_local_turn(body)


def test_local_turn_keeps_plain_model_chat_and_explicit_empty_context():
    from octop.infra.gateway.ws.local_data import validate_local_turn

    validate_local_turn(
        {
            "text": "Explain this",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}],
            "skills": [],
            "mcp_servers": [],
            "knowledge_base_ids": [],
            "hitl_policy": {"mode": "ask", "tools": []},
        }
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        {"mcp_servers": ["host"]},
        {"text": "/shell pwd"},
        {
            "messages": [
                {
                    "role": "user",
                    "content": [{"type": "image_url", "image_url": {"url": "file:///private"}}],
                }
            ]
        },
    ],
)
async def test_native_prepare_denies_unsafe_context_before_loading_any_agent(body):
    from types import SimpleNamespace

    from octop.api.routers.chat.models import ChatTurnBody
    from octop.api.routers.chat.turn import prepare_dashboard_turn
    from octop.infra.errors import ErrorCode, OctopError

    with pytest.raises(OctopError) as error:
        await prepare_dashboard_turn(
            object(),
            agent_id="owned",
            user=SimpleNamespace(local_data=True),
            turn=ChatTurnBody(**body),
        )
    assert error.value.code == ErrorCode.FORBIDDEN

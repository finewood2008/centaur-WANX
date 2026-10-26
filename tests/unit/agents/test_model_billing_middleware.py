"""A payment failure cannot succeed by retrying the same model request."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from langchain.agents.middleware import ModelRetryMiddleware
from langchain_core.exceptions import ModelError
from openai import APIStatusError

from octop.i18n.domains.stream import format_stream_error
from octop.infra.agents.middleware.model_billing import ModelBillingErrorMiddleware


def error(status: int) -> APIStatusError:
    return APIStatusError(
        "synthetic provider error",
        response=httpx.Response(status, request=httpx.Request("POST", "https://synthetic.invalid")),
        body=None,
    )


@pytest.mark.parametrize("status,calls", [(402, 1), (429, 3), (503, 3)])
def test_sync_retry_policy_keeps_transient_retries(status: int, calls: int) -> None:
    provider = MagicMock(side_effect=error(status))
    billing = ModelBillingErrorMiddleware()
    retry = ModelRetryMiddleware(initial_delay=0, jitter=False, on_failure="error")
    with pytest.raises(ModelError if status == 402 else APIStatusError) as caught:
        retry.wrap_model_call(None, lambda request: billing.wrap_model_call(request, provider))
    assert provider.call_count == calls
    if status == 402:
        assert "余额" in format_stream_error(caught.value, "zh")


@pytest.mark.asyncio
@pytest.mark.parametrize("status,calls", [(402, 1), (429, 3), (503, 3)])
async def test_async_retry_policy_keeps_transient_retries(status: int, calls: int) -> None:
    provider = AsyncMock(side_effect=error(status))
    billing = ModelBillingErrorMiddleware()
    retry = ModelRetryMiddleware(initial_delay=0, jitter=False, on_failure="error")
    with pytest.raises(ModelError if status == 402 else APIStatusError):
        await retry.awrap_model_call(
            None, lambda request: billing.awrap_model_call(request, provider)
        )
    assert provider.await_count == calls

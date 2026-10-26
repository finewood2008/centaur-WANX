"""Regression for the actual box's older Workspaces implementation."""

import secrets
from uuid import uuid4

from octop.infra.personal_space.links import SpaceLinks
from octop.infra.personal_space.mcp_access import SpaceMcp


def test_memory_write_and_read_without_new_space_private_helper(tmp_path, monkeypatch):
    monkeypatch.delattr(SpaceLinks, "_creation_target")
    service = SpaceMcp(tmp_path, 1, "验证用户")
    key = secrets.token_urlsafe(32)
    aid = service.issue(
        {
            "operation_id": uuid4().hex,
            "credential": key,
            "name": "通用 MCP",
            "destination": "personal",
        }
    )["id"]
    gid = ""
    body = {
        "grant_id": gid,
        "operation_id": uuid4().hex,
        "title": "兼容性回归",
        "source": "合成来源",
        "coverage": "仅合成资料",
        "sections": [{"title": "记忆", "content": "验证旧底座也可保存和读回。"}],
    }
    result = service.archive_memory(aid, key, body)
    assert result["saved"] is True
    assert service.archive_memory(aid, key, body) == result
    assert "验证旧底座" in service.read_text(aid, key, gid, result["file"]["id"])["text"]
    service.revoke_connection(aid)
    import pytest

    from octop.infra.personal_space.service import SpaceError

    with pytest.raises(SpaceError, match="MCP_KEY_REVOKED"):
        service.read_text(aid, key, gid, result["file"]["id"])

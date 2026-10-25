"""Read-only workers must not bootstrap expert and connector management."""

from __future__ import annotations

import subprocess
import sys

import pytest


@pytest.mark.parametrize("worker", ["assistant_knowledge_mcp", "assistant_space_mcp"])
def test_worker_skips_management_dependencies(worker: str) -> None:
    code = f"""
import importlib, sys
importlib.import_module('octop.infra.agents.{worker}')
assert 'octop.infra.agents.experts.catalog' not in sys.modules
assert 'octop.infra.connectors.service' not in sys.modules
"""
    result = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stderr

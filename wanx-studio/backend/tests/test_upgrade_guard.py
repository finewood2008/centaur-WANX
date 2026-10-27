import asyncio
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
from uuid import uuid4

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.local_authority import start_background
from wanx_studio.upgrade_guard import acquire


pytestmark = pytest.mark.skipif(os.name != "posix", reason="Box OTA uses POSIX file locks")


def service(root, authority=None):
    return SimpleNamespace(store=SimpleNamespace(root=root), local_authority=authority)


@pytest.mark.parametrize("purpose", ["build", "interview", "edit"])
async def test_background_work_prevents_upgrade_without_cancelling_task(tmp_path, purpose):
    finish = asyncio.Event()
    task = await start_background(service(tmp_path), "alice", "project", "task", purpose, finish.wait)
    try:
        with pytest.raises(StudioError, match="BUILDER_UPGRADE_BUSY"):
            acquire(tmp_path, exclusive=True)
        assert not task.done()
        finish.set()
        await task
        await asyncio.sleep(0)
        with acquire(tmp_path, exclusive=True):
            pass
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_helper_fences_new_work_and_releases_after_failed_upgrade(tmp_path):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "wanx_studio.upgrade_guard", "--root", str(tmp_path),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
    )
    called = []

    async def factory():
        called.append(True)

    try:
        receipt = json.loads(await asyncio.wait_for(process.stdout.readline(), 5))
        assert receipt == {"schemaVersion": 1, "status": "ready"}
        with pytest.raises(StudioError, match="BUILDER_UPGRADE_BUSY"):
            await start_background(service(tmp_path), "alice", "p", "t", "build", factory)
        assert called == []
        process.stdin.close()
        assert await asyncio.wait_for(process.wait(), 5) == 0
        await (await start_background(service(tmp_path), "alice", "p", "t", "build", factory))
        assert called == [True]
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def test_multiple_tasks_and_cancel_before_start_keep_correct_lock_lifetime(tmp_path):
    finish = asyncio.Event()
    first = await start_background(service(tmp_path), "alice", "p", "a", "edit", finish.wait)
    second = await start_background(service(tmp_path), "alice", "p", "b", "build", finish.wait)
    first.cancel()
    await asyncio.gather(first, return_exceptions=True)
    with pytest.raises(StudioError, match="BUILDER_UPGRADE_BUSY"):
        acquire(tmp_path, exclusive=True)
    second.cancel()
    await asyncio.gather(second, return_exceptions=True)
    with acquire(tmp_path, exclusive=True):
        pass


async def test_failed_authority_preparation_releases_admission(tmp_path):
    async def denied(*_):
        raise StudioError("STUDIO_AUTHORIZATION_EXPIRED", 403)

    async def forbidden():
        raise AssertionError("factory must not run")

    authority = SimpleNamespace(prepare=denied)
    with pytest.raises(StudioError, match="STUDIO_AUTHORIZATION_EXPIRED"):
        await start_background(service(tmp_path, authority), "alice", "p", "t", "build", forbidden)
    with acquire(tmp_path, exclusive=True):
        pass


async def test_cancel_during_threaded_admission_waits_and_reclaims_lock(tmp_path, monkeypatch):
    from wanx_studio import upgrade_guard

    entered, release = threading.Event(), threading.Event()
    original = upgrade_guard.acquire

    def delayed(root):
        lock = original(root)
        entered.set()
        release.wait(5)
        return lock

    async def forbidden():
        raise AssertionError("cancelled admission must never start work")

    monkeypatch.setattr(upgrade_guard, "acquire", delayed)
    admitted = asyncio.create_task(start_background(
        service(tmp_path), "alice", "p", "t", "build", forbidden,
    ))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        admitted.cancel()
        await asyncio.sleep(0)
        admitted.cancel()
        await asyncio.sleep(0)
        assert not admitted.done()
        with pytest.raises(StudioError, match="BUILDER_UPGRADE_BUSY"):
            original(tmp_path, exclusive=True)
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await admitted
        with original(tmp_path, exclusive=True):
            pass
    finally:
        release.set()
        await asyncio.gather(admitted, return_exceptions=True)


def test_lock_rejects_symlink_and_insecure_file_without_modifying_target(tmp_path):
    target = tmp_path / "private"
    target.write_text("preserve")
    lock = tmp_path / "upgrade.lock"
    lock.symlink_to(target)
    with pytest.raises(StudioError, match="BUILDER_UPGRADE_GUARD_UNAVAILABLE"):
        acquire(tmp_path)
    assert target.read_text() == "preserve"
    lock.unlink()
    lock.touch(mode=0o644)
    with pytest.raises(StudioError, match="BUILDER_UPGRADE_GUARD_UNAVAILABLE"):
        acquire(tmp_path)


async def test_refused_build_does_not_leave_queued_task_and_can_be_retried(tmp_path, monkeypatch):
    from wanx_studio.runner import Runner
    from wanx_studio.service import StudioService

    svc = StudioService(tmp_path, Path(__file__).resolve().parents[2])
    svc.runner = Runner(svc)
    svc.model = object()
    try:
        project = svc.store.create("alice", "Upgrade test", "Preserve working build", uuid4().hex)
        project = await svc.runner.example("alice", project["id"], uuid4().hex)
        with acquire(tmp_path, exclusive=True):
            with pytest.raises(StudioError, match="BUILDER_UPGRADE_BUSY"):
                await svc.runner.start("alice", project["id"], {
                    "operationId": uuid4().hex, "solutionHash": project["solutionHash"], "instruction": "",
                })
        failed = svc.store.get("alice", project["id"])["tasks"][-1]
        assert failed["state"] == "failed" and failed["error"] == "BUILDER_UPGRADE_BUSY"
        assert not svc.runner.jobs and not svc.background

        async def unavailable(**_):
            return {"available": False, "code": "SYNTHETIC_PREFLIGHT"}

        monkeypatch.setattr(svc.runner, "preflight", unavailable)
        await svc.runner.start("alice", project["id"], {
            "operationId": uuid4().hex, "solutionHash": project["solutionHash"], "instruction": "",
        })
        await asyncio.gather(*svc.background)
        retried = svc.store.get("alice", project["id"])["tasks"][-1]
        assert retried["id"] != failed["id"]
        assert retried["state"] == "failed" and retried["error"] == "ISOLATION_UNAVAILABLE"
        assert not svc.runner.jobs
    finally:
        await svc.close()

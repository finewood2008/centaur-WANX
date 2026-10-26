"""Native task lifecycle with real coroutine/thread cancellation and strict scope."""

import asyncio
import threading
import os
import signal
import sys
from types import SimpleNamespace

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.local_authority import Actor, LocalStudioAuthority, _actor, to_thread


class Lease:
    def __init__(self):
        self.claims = {
            "resourceId": "team:management",
            "team": {"permissions": ["applications.manage"], "boxId": "box", "ownershipEpoch": 1},
        }
        self.authorized_resources = ()
        self.revoked = False
        self.closed_outcomes = []
        self.started = []
        self.child = None
        self.uncertain = False

    def check_cached(self):
        if self.revoked:
            raise RuntimeError("revoked")

    async def check(self):
        self.check_cached()

    def require_live(self):
        self.check_cached()

    def mark_physical_close_uncertain(self):
        self.uncertain = True
        self.revoked = True

    async def closed(self, outcome):
        self.closed_outcomes.append(outcome)

    async def start_task(self, **identity):
        self.check_cached()
        self.started.append(identity)
        self.child = Lease()
        return self.child


@pytest.fixture
def actor():
    services = SimpleNamespace(
        team_application_repo=SimpleNamespace(get=lambda _: {"box_id": "box", "ownership_epoch": 1})
    )
    authority = LocalStudioAuthority(services, lambda: True)
    lease = Lease()
    state = Actor(authority, SimpleNamespace(id=7), lease)
    token = _actor.set(state)
    try:
        yield authority, lease
    finally:
        _actor.reset(token)


def test_required_context_rejects_plain_user_and_forged_team():
    authority = LocalStudioAuthority(None, lambda: True)
    with pytest.raises(StudioError, match="STUDIO_IDENTITY_FORBIDDEN"):
        authority.enter(
            SimpleNamespace(
                id=7,
                role="admin",
                local_data=True,
                local_team={"permissions": ["applications.manage"]},
            )
        )
    with pytest.raises(StudioError, match="STUDIO_IDENTITY_FORBIDDEN"):
        authority.identity("wanx:7")


def test_app_channel_never_inherits_management_and_cannot_cross_application(actor):
    authority, lease = actor
    app = "ai.wanx.selfmade." + "a" * 32
    lease.claims["resourceId"] = "team:application:" + app
    assert not authority.can_manage("wanx:7")
    authority.application("wanx:7", app)
    with pytest.raises(StudioError, match="TEAM_APPLICATION_UNAVAILABLE"):
        authority.application("wanx:7", "ai.wanx.selfmade." + "b" * 32)
    with pytest.raises(StudioError, match="STUDIO_IDENTITY_FORBIDDEN"):
        authority.application("wanx:8", app)


@pytest.mark.asyncio
async def test_http_closure_does_not_kill_independent_task_but_revoke_drains(actor):
    authority, parent = actor
    started, cleanup = asyncio.Event(), asyncio.Event()
    events = []

    async def worker():
        try:
            started.set()
            await asyncio.Future()
        finally:
            await cleanup.wait()
            events.append("drained")

    task = await authority.spawn("wanx:7", "a" * 32, "b" * 32, "build", worker)
    await started.wait()
    parent.revoked = True
    await asyncio.sleep(0.01)
    assert not task.done()
    parent.child.revoked = True
    await asyncio.sleep(0.3)
    assert not parent.child.closed_outcomes
    cleanup.set()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 2)
    assert events == ["drained"]
    assert parent.child.closed_outcomes == ["denied"]


@pytest.mark.asyncio
async def test_cancelled_native_thread_must_finish_before_closed_ack(actor):
    authority, parent = actor
    started, release = threading.Event(), threading.Event()

    def blocking_write():
        started.set()
        release.wait(3)
        return "written"

    task = await authority.spawn(
        "wanx:7", "a" * 32, "b" * 32, "build", lambda: to_thread(blocking_write)
    )
    try:
        await asyncio.wait_for(asyncio.to_thread(started.wait, 2), 3)
        task.cancel()
        await asyncio.sleep(0.01)
        assert not task.done()
        assert not parent.child.closed_outcomes
    finally:
        release.set()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 3)
    assert parent.child.closed_outcomes == ["cancelled"]


@pytest.mark.asyncio
async def test_nested_edit_build_retains_one_lease_and_closes_after_last_task(actor):
    authority, parent = actor
    child_started, release = asyncio.Event(), asyncio.Event()
    children = []

    async def child():
        child_started.set()
        await release.wait()

    async def edit():
        children.append(await authority.spawn("wanx:7", "a" * 32, "c" * 32, "build", child))

    task = await authority.spawn("wanx:7", "a" * 32, "b" * 32, "edit", edit)
    await task
    await child_started.wait()
    assert len(parent.started) == 1 and not parent.child.started
    assert not parent.child.closed_outcomes
    release.set()
    await children[0]
    assert parent.child.closed_outcomes == ["completed"]


@pytest.mark.asyncio
async def test_task_cannot_add_material_or_start_another_project(actor):
    authority, parent = actor

    async def worker():
        await authority.resources("wanx:7", [])
        with pytest.raises(StudioError, match="STUDIO_RESOURCE_FORBIDDEN"):
            await authority.resources("wanx:7", [{"resourceId": "semantica", "actions": ["read"]}])
        with pytest.raises(StudioError, match="STUDIO_TASK_SCOPE_DENIED"):
            await authority.spawn("wanx:7", "c" * 32, "d" * 32, "build", lambda: asyncio.sleep(0))

    task = await authority.spawn("wanx:7", "a" * 32, "b" * 32, "build", worker)
    await task
    assert parent.child.closed_outcomes == ["completed"]


@pytest.mark.asyncio
async def test_cancel_before_first_instruction_closes_without_starting_factory(actor):
    authority, parent = actor
    started = []

    async def worker():
        started.append(True)

    task = await authority.spawn("wanx:7", "a" * 32, "b" * 32, "build", worker)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    for _ in range(20):
        if parent.child.closed_outcomes:
            break
        await asyncio.sleep(0)
    assert not started
    assert parent.child.closed_outcomes == ["cancelled"]


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group fixture")
async def test_double_cancel_does_not_acknowledge_a_live_worker(actor, tmp_path):
    from wanx_studio.native_codex import NativeCodex

    authority, parent = actor
    pool = NativeCodex(SimpleNamespace(project_root=tmp_path))
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(30)",
        stdout=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    await proc.stdout.readline()
    started = asyncio.Event()

    async def work():
        try:
            started.set()
            await asyncio.Future()
        finally:
            await pool.stop(proc)

    task = await authority.spawn("wanx:7", "a" * 32, "b" * 32, "build", work)
    try:
        await started.wait()
        task.cancel()
        await asyncio.sleep(0.03)
        task.cancel()
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 4)
        assert proc.returncode is not None
        assert parent.child.closed_outcomes == ["cancelled"]
    finally:
        if proc.returncode is None:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group fixture")
async def test_stopping_reaped_worker_also_stops_its_descendant(tmp_path):
    from wanx_studio.native_codex import NativeCodex

    pool = NativeCodex(SimpleNamespace(project_root=tmp_path))
    child_code = "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)"
    parent_code = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c',sys.argv[1]],stdout=subprocess.DEVNULL); print(p.pid,flush=True)"
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        parent_code,
        child_code,
        stdout=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    child_pid = int(await proc.stdout.readline())
    await proc.wait()
    try:
        await pool.stop(proc)
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="POSIX process-group fixture")
async def test_loop_shutdown_cancelling_cleanup_never_acknowledges_live_process(actor, tmp_path):
    from wanx_studio.native_codex import NativeCodex

    authority, parent = actor
    pool = NativeCodex(SimpleNamespace(project_root=tmp_path))
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(30)",
        stdout=asyncio.subprocess.PIPE,
        start_new_session=True,
    )
    await proc.stdout.readline()
    entered = asyncio.Event()

    async def work():
        try:
            entered.set()
            await asyncio.Future()
        finally:
            await pool.stop(proc)

    task = await authority.spawn("wanx:7", "a" * 32, "b" * 32, "build", work)
    try:
        await entered.wait()
        task.cancel()
        await asyncio.sleep(0.02)
        cleanups = [
            t
            for t in asyncio.all_tasks()
            if getattr(t.get_coro(), "__qualname__", "") == "NativeCodex._stop"
        ]
        assert len(cleanups) == 1
        cleanups[0].cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert parent.child.uncertain and not parent.child.closed_outcomes
    finally:
        if proc.returncode is None:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()

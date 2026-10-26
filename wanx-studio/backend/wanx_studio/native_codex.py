"""Private persistent workers, never shared across owners, projects or roles."""
import asyncio
import json
import os
import signal
import sys
from dataclasses import dataclass

from .contracts import StudioError


@dataclass
class Worker:
    proc: asyncio.subprocess.Process
    fingerprint: str
    key: tuple


class NativeCodex:
    def __init__(self, service):
        self.svc = service
        self.workers = {}
        self.locks = {}

    async def acquire(self, key, script, config):
        lock = self.locks.setdefault(key, asyncio.Lock())
        await lock.acquire()
        try:
            if getattr(self.svc, 'closing', False):
                raise StudioError('STUDIO_CLOSED', 409)
            fingerprint = json.dumps(config, sort_keys=True)
            old = self.workers.get(key)
            if old and old.proc.returncode is None and old.fingerprint == fingerprint:
                return old
            if old:
                await self.stop(old.proc)
            env = {k: v for k, v in os.environ.items() if k in {'PATH', 'LANG', 'TMPDIR'}}
            proc = await asyncio.create_subprocess_exec(
                'node', str(self.svc.project_root/'codex'/script),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, cwd=self.svc.project_root,
                env={**env, **config, 'WANX_PYTHON_PATH': sys.executable},
                start_new_session=True, limit=4*1024*1024)
            worker = Worker(proc, fingerprint, key)
            self.workers[key] = worker
            return worker
        except BaseException:
            lock.release()
            raise

    async def release(self, worker, healthy):
        from .local_authority import requires_physical_close
        # A local task's closure receipt describes drained OS workers. Do not
        # keep its authenticated native process alive for another lease.
        healthy = healthy and not requires_physical_close()
        try:
            if not healthy:
                await self.stop(worker.proc)
                self.workers.pop(worker.key, None)
        finally:
            self.locks[worker.key].release()

    async def abandon(self, proc):
        # Covers errors while assembling/writing the first payload, before the
        # consumer's try/finally has taken ownership of the lease.
        worker=next((w for w in self.workers.values() if w.proc is proc),None)
        if worker and self.locks[worker.key].locked():
            await self.release(worker,False)
        else:
            await self.stop(proc)

    async def stop(self, proc):
        # Revocation, user cancellation and service shutdown can race. A second
        # cancellation must never let the caller acknowledge physical closure
        # while the worker is still alive.
        cleanup = asyncio.create_task(self._stop(proc))
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        try:
            cleanup.result()
        except BaseException:
            from .local_authority import physical_close_uncertain
            physical_close_uncertain()
            raise
        if cancelled:
            raise asyncio.CancelledError

    async def _stop(self, proc):
        from .local_authority import physical_close_uncertain, requires_physical_close
        try:
            if os.name == 'nt':
                killer = await asyncio.create_subprocess_exec('taskkill', '/PID', str(proc.pid), '/T', '/F', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await killer.wait()
                if killer.returncode and requires_physical_close():
                    raise StudioError('STUDIO_WORKER_CLOSE_UNCONFIRMED', 503)
                if proc.returncode is None:
                    await asyncio.wait_for(proc.wait(), 2)
                return
            # Each native worker/compiler has its own session/process group.
            # A reaped leader does not prove its descendants are gone.
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                await proc.wait()
                return
            if proc.returncode is None:
                try:
                    await asyncio.wait_for(proc.wait(), 1)
                except TimeoutError:
                    pass
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                # A just-reaped orphan can briefly be owned by the OS reaper.
                # Confirm disappearance below; EPERM is never proof of exit.
                pass
            await proc.wait()
            deadline = asyncio.get_running_loop().time() + 1
            while True:
                try:
                    os.killpg(proc.pid, 0)
                except ProcessLookupError:
                    return
                except PermissionError:
                    pass
                if asyncio.get_running_loop().time() >= deadline:
                    raise StudioError('STUDIO_WORKER_CLOSE_UNCONFIRMED', 503)
                await asyncio.sleep(.02)
        except BaseException:
            physical_close_uncertain()
            raise

    async def close(self):
        await asyncio.gather(*(self.stop(w.proc) for w in self.workers.values()), return_exceptions=True)
        self.workers.clear()

    async def close_project(self, owner, project_id):
        keys=[key for key in self.workers if key[:2]==(owner,project_id)]
        await asyncio.gather(*(self.stop(self.workers.pop(key).proc) for key in keys))

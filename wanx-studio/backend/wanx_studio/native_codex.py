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
        try:
            if not healthy:
                self.workers.pop(worker.key, None)
                await self.stop(worker.proc)
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
        if proc.returncode is not None:
            return
        if os.name == 'nt':
            killer = await asyncio.create_subprocess_exec('taskkill', '/PID', str(proc.pid), '/T', '/F', stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await killer.wait()
        else:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            await asyncio.wait_for(proc.wait(), 4)
        except TimeoutError:
            try:
                if os.name == 'nt':proc.kill()
                else:os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await proc.wait()

    async def close(self):
        await asyncio.gather(*(self.stop(w.proc) for w in self.workers.values()), return_exceptions=True)
        self.workers.clear()

    async def close_project(self, owner, project_id):
        keys=[key for key in self.workers if key[:2]==(owner,project_id)]
        await asyncio.gather(*(self.stop(self.workers.pop(key).proc) for key in keys))

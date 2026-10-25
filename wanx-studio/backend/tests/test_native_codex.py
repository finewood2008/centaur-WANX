import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from wanx_studio.native_codex import NativeCodex
from wanx_studio.runner import Runner


async def test_workers_reuse_only_same_owner_project_role_and_config(tmp_path):
    root=tmp_path/'source';(root/'codex').mkdir(parents=True)
    (root/'codex/echo.mjs').write_text("process.stdin.resume();setInterval(()=>{},10000)")
    pool=NativeCodex(SimpleNamespace(project_root=root))
    try:
        key=('alice','p1','interview')
        a=await pool.acquire(key,'echo.mjs',{'FINGERPRINT':'1'});await pool.release(a,True)
        b=await pool.acquire(key,'echo.mjs',{'FINGERPRINT':'1'})
        assert a.proc is b.proc and b.proc.returncode is None
        await pool.release(b,True)
        for other in [('bob','p1','interview'),('alice','p2','interview'),('alice','p1','build')]:
            w=await pool.acquire(other,'echo.mjs',{'FINGERPRINT':'1'})
            assert w.proc is not a.proc
            await pool.release(w,True)
        changed=await pool.acquire(key,'echo.mjs',{'FINGERPRINT':'2'})
        assert changed.proc is not a.proc and a.proc.returncode is not None
        await pool.release(changed,True)
    finally:
        procs=[w.proc for w in pool.workers.values()]
        await pool.close()
        assert all(p.returncode is not None for p in procs)


async def test_failed_or_cancelled_worker_is_reaped_and_can_be_retried(tmp_path):
    (tmp_path/'codex').mkdir();(tmp_path/'codex/echo.mjs').write_text('process.stdin.resume()')
    pool=NativeCodex(SimpleNamespace(project_root=tmp_path))
    try:
        key=('alice','p','build');first=await pool.acquire(key,'echo.mjs',{})
        await pool.release(first,False)
        assert first.proc.returncode is not None and key not in pool.workers
        second=await asyncio.wait_for(pool.acquire(key,'echo.mjs',{}),1)
        assert second.proc.pid!=first.proc.pid
        await pool.release(second,True)
    finally:await pool.close()


async def test_build_readiness_never_spawns_a_throwaway_probe(monkeypatch):
    async def forbidden(*args,**kwargs):raise AssertionError('duplicate preflight process')
    monkeypatch.setattr(asyncio,'create_subprocess_exec',forbidden)
    monkeypatch.setattr('wanx_studio.runner.runtime_config',lambda:{'WANX_CODEX_PATH':'synthetic'})
    runner=Runner(SimpleNamespace())
    assert (await runner.preflight(for_turn=True))['available']

"""Cache bytes are shared; customer state and its reference roots are never deleted."""

import asyncio
import json
import multiprocessing
import os
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
from test_resources import setup as setup
from test_resources import signed

from wanx_bridge.config import BridgeAuthError
from wanx_bridge.resource_cache import (
    CACHE_MIN_FREE_BYTES,
    CACHE_RETENTION_SECONDS,
    cache_io,
    cache_lock,
)
from wanx_bridge.resources import ResourceCatalog, atomic
from wanx_bridge.resources_contract import canonical

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Box cache uses POSIX flock")


def _success(data):
    return httpx.Response(200, json={"code": 200, "success": True, "data": data})


def _download(envelope):
    return _success(
        {
            "envelope": envelope,
            "url": "https://artifacts.example/resource.json",
            "expiresAt": int(time.time()) + 300,
        }
    )


def _download_worker(config, envelope, raw, start, counter, results):
    """Different interpreters prove the lock is not just an asyncio.Lock."""

    async def run():
        async def handler(request):
            if request.url.host == "artifacts.example":
                with open(counter, "ab") as stream:
                    stream.write(b"download\n")
                await asyncio.sleep(0.1)
                return httpx.Response(200, content=raw)
            return _download(envelope)

        catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
        try:
            package = await catalog.package(envelope)
            results.put({"resourceId": package["resourceId"]})
        finally:
            await catalog.close()

    try:
        if not start.wait(10):
            raise RuntimeError("workers did not start")
        asyncio.run(run())
    except BaseException as exc:
        results.put({"error": repr(exc)})
        raise


def test_processes_download_identical_package_only_once(setup, tmp_path):
    private, _, config = setup
    _, raw, envelope = signed(private)
    context = multiprocessing.get_context("spawn")
    start, results = context.Event(), context.Queue()
    counter = tmp_path / "downloads.log"
    workers = [
        context.Process(
            target=_download_worker, args=(config, envelope, raw, start, str(counter), results)
        )
        for _ in range(2)
    ]
    try:
        for worker in workers:
            worker.start()
        start.set()
        for worker in workers:
            worker.join(15)
            assert worker.exitcode == 0
        assert [results.get(timeout=2) for _ in workers] == [{"resourceId": "companion"}] * 2
        assert counter.read_text().splitlines() == ["download"]
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
            worker.join(2)


def _cached(config, private, name, *, recent=False):
    _, raw, envelope = signed(private, resource_id=name)
    digest = envelope["payload"]["package"]["sha256"]
    for folder, contents in (("packages", raw), ("envelopes", canonical(envelope))):
        path = config.state_dir / folder / (digest + ".json")
        atomic(path, contents)
        if not recent:
            old = time.time() - CACHE_RETENTION_SECONDS - 3600
            os.utime(path, (old, old))
    return digest, envelope


def _record(pair, *, status="ready", **extra):
    digest, envelope = pair
    return {"digest": digest, "envelope": envelope, "status": status, "version": "1.0.0", **extra}


async def test_gc_keeps_live_references_but_not_unused_historical_resolutions(setup):
    private, _, config = setup
    catalog = ResourceCatalog(config)
    pairs = {
        name: _cached(config, private, name, recent=name == "recent")
        for name in (
            "active",
            "pending",
            "shared-expert",
            "shared-skill",
            "dependency",
            "latest",
            "resolved",
            "recent",
            "unused",
        )
    }
    atomic(
        config.state_dir / "bindings" / ("a" * 64 + ".json"),
        canonical(
            {
                "schemaVersion": 1,
                "scope": {},
                "resources": {"expert:active": _record(pairs["active"])},
                "pendingResources": {
                    "expert:pending": _record(pairs["pending"], status="preparing")
                },
            }
        ),
    )
    for kind, name in (("experts", "shared-expert"), ("skills", "shared-skill")):
        atomic(
            config.state_dir / "instances" / kind / ("b" * 64 + ".json"),
            canonical(
                {
                    "schemaVersion": 1,
                    "identity": {"resourceId": name},
                    "record": _record(
                        pairs[name],
                        dependencyResources={"dependency": _record(pairs["dependency"])},
                    ),
                }
            ),
        )
    atomic(
        config.state_dir / "catalog.json",
        canonical(
            {
                "schemaVersion": 1,
                "items": [pairs["latest"][1]],
            }
        ),
    )
    atomic(
        config.state_dir / "resolutions" / ("c" * 64 + ".json"),
        canonical(
            {
                "schemaVersion": 1,
                "applicationId": "test.app",
                "artifactId": "artifact-1",
                "backendProductId": "wanx",
                "requirements": [],
                "resources": [pairs["resolved"][1]],
            }
        ),
    )
    # A path outside the two cache folders is never a cleanup target.
    memory = config.state_dir / "customer-data" / "memory.json"
    atomic(memory, b'{"memory":"preserve"}')
    result = await catalog.cleanup()
    assert result["status"] == "ok" and result["removed"] == 2
    assert result["reclaimedBytes"] > 0
    for name, (digest, _) in pairs.items():
        for folder in ("packages", "envelopes"):
            assert (config.state_dir / folder / (digest + ".json")).exists() == (
                name not in {"unused", "resolved"}
            )
    assert memory.read_bytes() == b'{"memory":"preserve"}'
    await catalog.close()


@pytest.mark.parametrize(
    "failure",
    [
        "invalid-json",
        "duplicate-fields",
        "unknown-version",
        "missing-records",
        "invalid-record",
        "unknown-index",
        "symlink-ledger",
        "symlink-directory",
        "symlink-cache",
        "unknown-file",
    ],
)
async def test_gc_fails_closed_before_removing_anything(setup, tmp_path, failure):
    private, _, config = setup
    catalog = ResourceCatalog(config)
    digest, envelope = _cached(config, private, "unused")
    ledger = config.state_dir / "bindings" / ("a" * 64 + ".json")
    valid = {"schemaVersion": 1, "scope": {}, "resources": {}}
    if failure == "invalid-json":
        atomic(ledger, b"{")
    elif failure == "duplicate-fields":
        atomic(ledger, b'{"schemaVersion":1,"scope":{},"resources":{"active":{}},"resources":{}}')
    elif failure == "unknown-version":
        atomic(ledger, canonical({**valid, "schemaVersion": 2}))
    elif failure == "missing-records":
        atomic(ledger, canonical({"schemaVersion": 1, "scope": {}}))
    elif failure == "invalid-record":
        atomic(ledger, canonical({**valid, "resources": {"expert:x": {"version": "1.0.0"}}}))
    elif failure == "unknown-index":
        atomic(config.state_dir / "instances" / "future" / "data.json", canonical(valid))
    elif failure == "symlink-ledger":
        outside = tmp_path / "outside.json"
        outside.write_bytes(canonical(valid))
        ledger.parent.mkdir()
        ledger.symlink_to(outside)
    elif failure == "symlink-directory":
        outside = tmp_path / "outside"
        outside.mkdir()
        ledger.parent.symlink_to(outside, target_is_directory=True)
    elif failure == "symlink-cache":
        (config.state_dir / "packages" / ("f" * 64 + ".json")).symlink_to(
            config.state_dir / "packages" / (digest + ".json")
        )
    else:
        atomic(ledger.with_name("unrecognized-ledger.json"), canonical(valid))
    result = await catalog.cleanup()
    assert result == {
        "status": "skipped",
        "code": "RESOURCE_CACHE_STATE_UNVERIFIED",
        "removed": 0,
        "reclaimedBytes": 0,
    }
    assert (config.state_dir / "packages" / (digest + ".json")).exists()
    assert (
        json.loads((config.state_dir / "envelopes" / (digest + ".json")).read_bytes()) == envelope
    )
    await catalog.close()


@pytest.mark.parametrize("empty_ledger", [False, True])
async def test_gc_handles_new_install_and_valid_empty_ledger(setup, empty_ledger):
    private, _, config = setup
    catalog = ResourceCatalog(config)
    digest, _ = _cached(config, private, "unused")
    if empty_ledger:
        atomic(
            config.state_dir / "bindings" / ("a" * 64 + ".json"),
            canonical(
                {
                    "schemaVersion": 1,
                    "scope": {},
                    "resources": {},
                    "pendingResources": {},
                }
            ),
        )
    assert (await catalog.cleanup())["removed"] == 1
    assert not (config.state_dir / "packages" / (digest + ".json")).exists()
    await catalog.close()


async def test_gc_skips_live_preparation_without_waiting_or_lock_inversion(setup):
    private, _, config = setup
    catalog = ResourceCatalog(config)
    digest, _ = _cached(config, private, "unused")
    async with cache_lock(config.state_dir, prepare=True) as acquired:
        assert acquired
        async with asyncio.timeout(1):
            result = await catalog.cleanup()
        assert result["code"] == "RESOURCE_PREPARATION_BUSY"
        # A runtime which owns prepare.lock can still download through cache.lock.
        async with cache_lock(config.state_dir) as cache_acquired:
            assert cache_acquired
    assert (config.state_dir / "packages" / (digest + ".json")).exists()
    assert (await catalog.cleanup())["removed"] == 1
    await catalog.close()


async def test_old_unreferenced_cache_can_be_cleaned_before_retrying_capacity(setup, monkeypatch):
    private, _, config = setup
    downloads = []
    _, raw, envelope = signed(private, resource_id="needed")

    async def handler(request):
        if request.url.host == "artifacts.example":
            downloads.append(request)
            return httpx.Response(200, content=raw)
        return _download(envelope)

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    old, _ = _cached(config, private, "old-unused")
    monkeypatch.setattr("wanx_bridge.resources.CACHE_MAX_BYTES", len(raw) + 1)
    async with cache_lock(config.state_dir, prepare=True):
        with pytest.raises(BridgeAuthError, match="RESOURCE_CACHE_FULL"):
            await catalog.package(envelope)
    assert downloads == []
    assert (await catalog.cleanup())["removed"] == 1
    assert not (config.state_dir / "packages" / (old + ".json")).exists()
    assert (await catalog.package(envelope))["resourceId"] == "needed"
    assert len(downloads) == 1
    await catalog.close()


async def test_recent_reuse_refreshes_retention_and_poll_collects_old_cache(setup):
    private, _, config = setup
    catalog_envelopes = []

    async def handler(request):
        assert request.url.path.endswith("/catalog")
        return _success({"schemaVersion": 1, "items": catalog_envelopes})

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    reused, envelope = _cached(config, private, "reused")
    unused, _ = _cached(config, private, "unused")
    assert (await catalog.package(envelope))["resourceId"] == "reused"
    assert await catalog.synchronize() == {"count": 0, "failures": []}
    assert catalog.last_cleanup["removed"] == 1
    assert (config.state_dir / "packages" / (reused + ".json")).exists()
    assert not (config.state_dir / "packages" / (unused + ".json")).exists()
    await catalog.close()


async def test_low_disk_space_refuses_new_bytes_without_deleting_existing_files(setup, monkeypatch):
    private, _, config = setup
    _, raw, envelope = signed(private, resource_id="needed")

    async def handler(request):
        assert request.url.host != "artifacts.example"
        return _download(envelope)

    catalog = ResourceCatalog(config, transport=httpx.MockTransport(handler))
    digest, _ = _cached(config, private, "retained", recent=True)
    monkeypatch.setattr(
        "wanx_bridge.resources.shutil.disk_usage",
        lambda _: SimpleNamespace(
            free=len(raw) + CACHE_MIN_FREE_BYTES - 1,
        ),
    )
    with pytest.raises(BridgeAuthError, match="RESOURCE_CACHE_FULL"):
        await catalog.package(envelope)
    assert (config.state_dir / "packages" / (digest + ".json")).exists()
    await catalog.close()


async def test_cancelled_filesystem_write_finishes_before_cache_lock_is_released(setup):
    _, _, config = setup
    config.state_dir.mkdir()
    started, release = threading.Event(), threading.Event()

    def write():
        started.set()
        assert release.wait(5)

    async def store():
        async with cache_lock(config.state_dir):
            await cache_io(write)

    task = asyncio.create_task(store())
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        for _ in range(4):
            await asyncio.sleep(0)
        assert not task.done()
        with pytest.raises(BridgeAuthError, match="RESOURCE_CACHE_BUSY"):
            async with cache_lock(config.state_dir, timeout=0.05):
                pytest.fail("unfinished filesystem write lost its lock")
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with cache_lock(config.state_dir, timeout=0.1) as acquired:
        assert acquired


async def test_cancelled_filesystem_failure_is_consumed_and_preserved_as_cause():
    started, release = threading.Event(), threading.Event()

    def failed_write():
        started.set()
        assert release.wait(5)
        raise OSError("disk write failed")

    task = asyncio.create_task(cache_io(failed_write))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError) as caught:
            await task
    assert isinstance(caught.value.__cause__, OSError)
    assert str(caught.value.__cause__) == "disk write failed"


async def test_waiter_cancellation_releases_its_lock_descriptor(setup):
    _, _, config = setup
    config.state_dir.mkdir()
    entered = asyncio.Event()

    async def wait():
        entered.set()
        async with cache_lock(config.state_dir):
            pytest.fail("holder still owns the cache")

    async with cache_lock(config.state_dir):
        task = asyncio.create_task(wait())
        await entered.wait()
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    async with cache_lock(config.state_dir, timeout=0.1) as acquired:
        assert acquired

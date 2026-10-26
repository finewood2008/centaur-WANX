"""Bounded execution and source budgets, independent of cloud sessions."""

from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass

from .local_trust_config import LocalTrustError
from .local_trust_protocol import BindingProtocolError

OPERATIONS = {
    "first-root/challenge": ("first_root_challenge", (), "public"),
    "first-root/commit": (
        "commit_first_root",
        ("accessProof", "approvalProof", "secretProof"),
        "public",
    ),
    "auth/challenge": ("auth_challenge", (), "public"),
    "state": ("read_state", ("proof",), "management"),
    "requests/challenge": ("request_challenge", (), "public"),
    "requests": ("submit_request", ("requestProof",), "public"),
    "requests/read": ("read_request", ("proof",), "management"),
    "requests/approve": ("approve_request", ("requestId", "approvalProof"), "management"),
    "requests/cancel": ("cancel_request", ("cancelProof",), "management"),
}
V2_OPERATIONS = {
    "team/policy": ("team_policy", (), "public"),
    "team/requests": (
        "submit_team_request",
        ("requestProof", "approvalProof", "cloudProof"),
        "team_requests",
    ),
    "team/requests/read": ("read_team_request", ("proof",), "team_requests"),
    "team/requests/consent": (
        "consent_team_request",
        ("requestId", "targetAccessProof", "targetApprovalProof"),
        "team_requests",
    ),
    "operations/restore-key": (
        "receive_restore_key",
        ("operationId", "archiveSha256", "dataKey", "proof"),
        "management",
    ),
    "mutations/challenge": ("mutation_challenge", ("actor", "action"), "public"),
    "mutations/authenticated-challenge": (
        "authenticated_mutation_challenge_v2",
        ("proof",),
        "authenticated_nonce",
    ),
    "mutations/prepare": ("prepare_mutation", ("prepareProof",), "management"),
    "mutations/commit": (
        "commit_mutation",
        (
            "mutationProof",
            "targetAccessProof",
            "targetApprovalProof",
            "recoveryMaterialProof",
            "sourceRecoveryProof",
        ),
        "management",
    ),
    "auth/challenge": ("auth_challenge_v2", (), "nonce"),
    "authenticated-challenge": ("authenticated_challenge_v2", ("proof",), "authenticated_nonce"),
    "read": ("read_v2", ("proof",), "management"),
}
BACKUP_IO_OPERATIONS = frozenset(
    {
        "targets.list",
        "source.begin",
        "source.append",
        "source.finalize",
        "source.read",
        "archive.read",
        "transfer.plan",
    }
)
V2_OPERATIONS.update(
    {
        "backup-io/" + name: ("backup_io", ("body", "proof"), "backup_io")
        for name in BACKUP_IO_OPERATIONS
    }
)
OPERATIONS.update({"v2/" + key: value for key, value in V2_OPERATIONS.items()})
CONCURRENCY = {
    "team_requests": 4,
    "public": 4,
    "management": 8,
    "data": 32,
    "inspection": 1,
    "nonce": 4,
    "authenticated_nonce": 4,
    "backup_io": 4,
}
SOURCE_PER_MINUTE = {
    "team_requests": 120,
    "public": 60,
    "management": 120,
    "nonce": 60,
    "authenticated_nonce": 600,
    "backup_io": 600,
}
MAX_SOURCES = 4096


@dataclass
class _Admission:
    group: str
    job: asyncio.Future | None = None
    released: bool = False
    change_job: asyncio.Task | None = None


class LocalTrustService:
    def __init__(self, authority, *, clock=time.time, budget_clock=time.monotonic):
        self._authority = authority
        self._clock, self._budget_clock = clock, budget_clock
        self._pools = {
            group: ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"trust-{group}")
            for group in CONCURRENCY
        }
        self._execution_lock = threading.Lock()
        self._active = dict.fromkeys(CONCURRENCY, 0)
        self._sources = {group: {} for group in CONCURRENCY}
        self._jobs = set()
        self._changes = set()
        self._closing = False
        self.on_authority_changed = None

    @asynccontextmanager
    async def admission(self, source: str, operation: str):
        if self._closing:
            raise LocalTrustError("LOCAL_TRUST_UNAVAILABLE")
        group = OPERATIONS[operation][2]
        now = self._budget_clock()
        sources = {key: value for key, value in self._sources[group].items() if now - value[0] < 60}
        self._sources[group] = sources
        start, count = sources.get(source, (now, 0))
        if (
            (source not in sources and len(sources) >= MAX_SOURCES)
            or count >= SOURCE_PER_MINUTE[group]
            or self._active[group] >= CONCURRENCY[group]
        ):
            raise LocalTrustError("LOCAL_TRUST_RATE_LIMITED", 429)
        sources[source] = (start, count + 1)
        self._active[group] += 1
        admission = _Admission(group)
        try:
            yield admission
        finally:
            if admission.job is None or admission.job.done():
                self._release(admission)
            else:
                # A disconnected HTTP caller does not release queued/running
                # SQLite work early and thereby create an unbounded executor.
                admission.job.add_done_callback(lambda _: self._release(admission))

    def _release(self, admission):
        if not admission.released:
            self._active[admission.group] -= 1
            admission.released = True

    def schedule_authority_change(self, callback, *args):
        """Event-loop side of the authority's nonblocking commit observer."""
        task = asyncio.create_task(callback(*args))
        self._changes.add(task)

        def changed(value):
            self._changes.discard(value)
            if not value.cancelled():
                value.exception()

        task.add_done_callback(changed)
        return task

    def _execute(self, operation, body):
        method, fields, _ = OPERATIONS[operation]
        try:
            if operation in {"v2/backup-io/source.finalize", "v2/backup-io/transfer.plan"}:
                name = operation.rsplit("/", 1)[1]
                with self._execution_lock:
                    checked = self._authority.backup_io_preflight(
                        name, body["body"], body["proof"], int(self._clock())
                    )
                # The bounded inspection thread holds neither the authority lock
                # nor its SQLite transaction during potentially 200 MiB hashing.
                self._authority.run_backup_io_preflight(name, body["body"], checked)
            with self._execution_lock:
                arguments = [body[field] for field in fields]
                if operation.startswith("v2/backup-io/"):
                    arguments.insert(0, operation.rsplit("/", 1)[1])
                result = getattr(self._authority, method)(*arguments, int(self._clock()))
                if operation.startswith("v2/backup-io/"):
                    if type(result) is not dict or set(result) != {"receipt", "contentBase64"}:
                        raise ValueError("invalid authority response")
                elif not isinstance(result, str):
                    raise ValueError("invalid authority response")
                return result
        except BindingProtocolError:
            raise
        except Exception as exc:
            if (
                method == "backup_io"
                and isinstance(exc, RuntimeError)
                and exc.args == ("LOCAL_BACKUP_CAPACITY",)
            ):
                # The fixed OS provider exports this one quota code without a
                # Bridge dependency. Do not expose any other exception text.
                raise LocalTrustError("LOCAL_TRUST_CAPACITY", 429) from None
            # Never expose exception text, proofs, database contents or paths.
            raise LocalTrustError("LOCAL_TRUST_UNAVAILABLE") from None

    async def invoke(self, admission, operation: str, body: dict) -> str | dict:
        if self._closing or admission.job is not None:
            raise LocalTrustError("LOCAL_TRUST_UNAVAILABLE")
        loop = asyncio.get_running_loop()
        inspection = operation in {"v2/backup-io/source.finalize", "v2/backup-io/transfer.plan"}
        if inspection and self._active["inspection"] >= CONCURRENCY["inspection"]:
            raise LocalTrustError("LOCAL_TRUST_RATE_LIMITED", 429)
        if inspection:
            self._active["inspection"] += 1
        try:
            job = loop.run_in_executor(
                self._pools["inspection" if inspection else admission.group],
                self._execute,
                operation,
                body,
            )
        except BaseException:
            if inspection:
                self._active["inspection"] -= 1
            raise
        admission.job = job
        self._jobs.add(job)

        def done(future):
            if inspection:
                self._active["inspection"] -= 1
            self._jobs.discard(future)
            if not future.cancelled():
                failure = future.exception()  # Retrieve disconnected errors.
                if (
                    failure is None
                    and operation
                    in {"first-root/commit", "requests/approve", "v2/mutations/commit"}
                    and self.on_authority_changed
                ):
                    admission.change_job = self.schedule_authority_change(self.on_authority_changed)

        job.add_done_callback(done)
        result = await asyncio.shield(job)
        if admission.change_job is not None:
            await asyncio.shield(admission.change_job)
        # Thread commit callbacks are queued before the executor future resolves.
        # Complete their bounded invalidation/evidence work before returning ACK.
        if self._changes:
            await asyncio.gather(*(asyncio.shield(task) for task in tuple(self._changes)))
        return result

    async def execute_authority(self, fn, *args):
        """Bound physical work until the thread finishes, even after cancellation."""
        if self._closing or self._active["data"] >= CONCURRENCY["data"]:
            raise LocalTrustError("LOCAL_TRUST_RATE_LIMITED", 429)
        self._active["data"] += 1

        def execute():
            with self._execution_lock:
                return fn(*args)

        try:
            job = asyncio.get_running_loop().run_in_executor(self._pools["data"], execute)
        except BaseException:
            self._active["data"] -= 1
            raise
        self._jobs.add(job)

        def done(future):
            self._active["data"] -= 1
            self._jobs.discard(future)
            if not future.cancelled():
                future.exception()

        job.add_done_callback(done)
        return await asyncio.shield(job)

    async def close(self):
        if self._closing:
            return
        self._closing = True
        if self._jobs:
            await asyncio.gather(
                *(asyncio.shield(job) for job in tuple(self._jobs)), return_exceptions=True
            )
        if self._changes:
            await asyncio.gather(
                *(asyncio.shield(job) for job in tuple(self._changes)), return_exceptions=True
            )
        loop = asyncio.get_running_loop()
        for pool in self._pools.values():
            await loop.run_in_executor(None, pool.shutdown, True)
        await loop.run_in_executor(None, self._authority.close)

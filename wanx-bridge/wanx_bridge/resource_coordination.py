"""Durable resource-write barrier shared with the host OTA executor.

An expired lease or released flock never proves an Octop POST has stopped.
Uncertain writes remain barriers until separately verified recovery resolves them.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from typing import Any

from .resources_contract import canonical, fail

PROTOCOL = "wanx.resource-coordination.v1"


def _digest(value: Any) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def write_digest(method: str, path: str, arguments: dict[str, Any]) -> str:
    def normalized(value: Any) -> Any:
        if isinstance(value, bytes):
            return {"sha256": hashlib.sha256(value).hexdigest(), "size": len(value)}
        if isinstance(value, (tuple, list)):
            return [normalized(item) for item in value]
        if isinstance(value, dict):
            return {key: normalized(item) for key, item in value.items()}
        return value

    return _digest({"method": method, "path": path, "arguments": normalized(arguments)})


def _read(path: Path, limit: int = 65536) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError()
        value = json.loads(stream.read(limit + 1), object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError()
    return value


def assert_no_legacy_pending(directory: Path) -> dict[str, Any]:
    """Read only: prove that Bridge-owned ledgers contain no unfinished preparation.

    This is not evidence that an unrecorded historic Octop request stopped. The
    OTA caller must separately close admission and validate the live container's
    coordination protocol/environment/mounts before using this snapshot.
    """
    directory = Path(directory)
    lock_fd = None

    def entries(folder: Path) -> list[Path]:
        if folder.is_symlink():
            raise ValueError()
        if not folder.exists():
            return []
        if not folder.is_dir():
            raise ValueError()
        paths = list(folder.iterdir())
        if len(paths) > 4096 or any(path.is_symlink() or not path.is_file() for path in paths):
            raise ValueError()
        if any(re.fullmatch(r"[0-9a-f]{64}\.json", path.name) is None for path in paths):
            raise ValueError()
        return paths

    def record(value: Any, *, key: str | None = None, depth: int = 0) -> None:
        if depth > 16 or not isinstance(value, dict):
            raise ValueError()
        if value.get("status") == "preparing" or "pendingSkill" in value:
            raise fail("RESOURCE_PREPARATION_PENDING", 409)
        if value.get("status") != "ready":
            raise ValueError()
        envelope = value.get("envelope")
        if (
            not isinstance(envelope, dict)
            or not isinstance(envelope.get("payload"), dict)
            or not isinstance(envelope.get("signature"), dict)
        ):
            raise ValueError()
        payload = envelope["payload"]
        kind, resource_id = payload.get("kind"), payload.get("resourceId")
        if kind not in {"expert", "skill-package"} or not ResourceWriteCoordinator._text(
            resource_id
        ):
            raise ValueError()
        if key is not None and key != kind + ":" + resource_id:
            raise ValueError()
        package = payload.get("package")
        if (
            not isinstance(package, dict)
            or not ResourceWriteCoordinator._hex(value.get("digest"))
            or package.get("sha256") != value["digest"]
            or not isinstance(value.get("version"), str)
            or not value["version"]
            or payload.get("version") != value["version"]
        ):
            raise ValueError()
        identity = value.get("instanceId") if kind == "expert" else value.get("packageId")
        hashes = value.get("files") if kind == "expert" else value.get("skills")
        if (
            not ResourceWriteCoordinator._text(identity)
            or not isinstance(hashes, dict)
            or any(
                not isinstance(name, str) or not name or not ResourceWriteCoordinator._hex(digest)
                for name, digest in hashes.items()
            )
        ):
            raise ValueError()
        dependencies = value.get("dependencyResources", {})
        if not isinstance(dependencies, dict):
            raise ValueError()
        for child_key, child in dependencies.items():
            record(child, key=child_key, depth=depth + 1)

    def ledger(path: Path, *, candidate: bool = False, instance: bool = False) -> None:
        value = _read(path, 16 * 1024 * 1024)
        if type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1:
            raise ValueError()
        if instance:
            if (
                set(value) != {"schemaVersion", "identity", "record"}
                or not isinstance(value["identity"], dict)
                or not isinstance(value["record"], dict)
                or value["record"].get("sharedIdentity") != value["identity"]
            ):
                raise ValueError()
            record(value["record"])
            payload = value["record"]["envelope"]["payload"]
            if path.stem != _digest(value["identity"]) or any(
                value["identity"].get(key) != payload[key] for key in ("kind", "resourceId")
            ):
                raise ValueError()
            return
        if (
            set(value)
            - (
                {"schemaVersion", "scope", "resources", "pendingResources"}
                | ({"bindingSetStatus"} if candidate else set())
            )
            or not isinstance(value.get("scope"), dict)
            or not isinstance(value.get("resources"), dict)
            or not isinstance(value.get("pendingResources", {}), dict)
        ):
            raise ValueError()
        if value.get("pendingResources") or (
            candidate and value.get("bindingSetStatus") == "preparing"
        ):
            raise fail("RESOURCE_PREPARATION_PENDING", 409)
        if candidate and value.get("bindingSetStatus") != "ready":
            raise ValueError()
        scope = value["scope"]
        if candidate:
            names = ("device_id", "ownership_epoch", "sub", "user_id", "application_id", "product")
            if (
                set(scope) != set(names) | {"artifact_id", "operation_id", "binding_set_id"}
                or scope["binding_set_id"] != path.stem
                or path.stem
                != _digest(
                    {
                        "scope": {key: scope[key] for key in names},
                        "artifactId": scope["artifact_id"],
                        "operationId": scope["operation_id"],
                    }
                )
            ):
                raise ValueError()
        elif path.stem != _digest(scope):
            raise ValueError()
        for key, item in value["resources"].items():
            record(item, key=key)

    try:
        if directory.is_symlink():
            raise ValueError()
        if not directory.exists():
            return {"status": "ready", "ledgerCount": 0, "evidence": "no-pending-resource-ledgers"}
        if not directory.is_dir():
            raise ValueError()
        lock = directory / "prepare.lock"
        if lock.exists() or lock.is_symlink():
            lock_fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            info = os.fstat(lock_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError()
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise fail("RESOURCE_PREPARATION_BUSY", 409) from exc
        bindings = [
            (path, folder == "binding-sets", False)
            for folder in ("bindings", "binding-sets")
            for path in entries(directory / folder)
        ]
        instances = directory / "instances"
        if instances.is_symlink():
            raise ValueError()
        if instances.exists() and (
            not instances.is_dir()
            or any(
                child.name not in {"skills", "experts"} or child.is_symlink() or not child.is_dir()
                for child in instances.iterdir()
            )
        ):
            raise ValueError()
        bindings.extend(
            (path, False, True)
            for folder in ("skills", "experts")
            for path in entries(instances / folder)
        )
        if bindings and lock_fd is None:
            raise ValueError()
        for path, candidate, instance in bindings:
            ledger(path, candidate=candidate, instance=instance)
        return {
            "status": "ready",
            "ledgerCount": len(bindings),
            "evidence": "no-pending-resource-ledgers",
        }
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise fail("RESOURCE_LOCAL_STATE_INVALID", 503) from exc
    finally:
        if lock_fd is not None:
            os.close(lock_fd)


def _atomic(path: Path, value: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".coord-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


class ResourceWriteCoordinator:
    """One resource operation. Caller already owns the Bridge prepare.lock."""

    def __init__(
        self,
        directory: Path | None,
        *,
        device_id: str,
        ownership_epoch: int,
        operation_id: str,
        scope_digest: str,
    ) -> None:
        self.directory = directory
        self.device_id, self.ownership_epoch = device_id, ownership_epoch
        self.operation_id, self.scope_digest = operation_id, scope_digest
        self.started = self.wrote = self.uncertain = False
        self.record: dict[str, Any] | None = None

    @classmethod
    def from_env(
        cls, *, device_id: str, ownership_epoch: int, operation_id: str, scope_digest: str
    ) -> ResourceWriteCoordinator:
        configured = os.environ.get("WANX_RESOURCE_COORDINATION_DIR")
        if configured is not None and (
            not configured.strip() or not Path(configured).is_absolute()
        ):
            raise fail("RESOURCE_COORDINATION_INVALID", 503)
        return cls(
            Path(configured) if configured is not None else None,
            device_id=device_id,
            ownership_epoch=ownership_epoch,
            operation_id=operation_id,
            scope_digest=scope_digest,
        )

    @contextlib.contextmanager
    def _locked(self):
        if self.directory is None:
            yield None
            return
        fd = None
        try:
            if self.directory.is_symlink() or not self.directory.is_dir():
                raise ValueError()
            intents = self.directory / "intents"
            if intents.is_symlink() or not intents.is_dir():
                raise ValueError()
            fd = os.open(
                self.directory / "coordination.lock",
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | os.O_NONBLOCK,
            )
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError()
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise fail("RESOURCE_COORDINATION_BUSY", 409) from exc
            protocol = _read(self.directory / "protocol.json")
            if (
                set(protocol)
                != {"schemaVersion", "protocol", "component", "deviceId", "writerUid", "writerGid"}
                or protocol.get("schemaVersion") != 1
                or type(protocol.get("schemaVersion")) is not int
                or protocol.get("protocol") != PROTOCOL
                or protocol.get("component") != "wanx"
                or protocol.get("deviceId") != self.device_id
                or type(protocol.get("writerUid")) is not int
                or protocol["writerUid"] != os.geteuid()
                or type(protocol.get("writerGid")) is not int
                or protocol["writerGid"] != os.getegid()
            ):
                raise ValueError()
            gate = _read(self.directory / "gate.json")
            if (
                set(gate) != {"schemaVersion", "mode", "generation", "owner", "lastRelease"}
                or gate.get("schemaVersion") != 1
                or type(gate.get("schemaVersion")) is not int
                or gate.get("mode") not in {"open", "closed"}
                or not self._integer(gate.get("generation"))
            ):
                raise ValueError()
            if gate["mode"] == "open":
                if gate["owner"] is not None:
                    raise ValueError()
            else:
                self._owner(gate["owner"])
            previous = gate["lastRelease"]
            if previous is not None:
                if not isinstance(previous, dict) or set(previous) != {
                    "operationId",
                    "planDigest",
                    "attemptGeneration",
                    "nonce",
                    "fromGeneration",
                    "toGeneration",
                }:
                    raise ValueError()
                self._owner(
                    {
                        key: previous[key]
                        for key in ("operationId", "planDigest", "attemptGeneration", "nonce")
                    }
                )
                if (
                    not self._integer(previous["fromGeneration"])
                    or not self._integer(previous["toGeneration"])
                    or previous["toGeneration"]
                    not in {previous["fromGeneration"], previous["fromGeneration"] + 1}
                    or previous["toGeneration"] != gate["generation"]
                ):
                    raise ValueError()
            yield gate
        except (OSError, ValueError, TypeError, UnicodeError) as exc:
            raise fail("RESOURCE_COORDINATION_INVALID", 503) from exc
        finally:
            if fd is not None:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

    def _path(self) -> Path:
        assert self.directory is not None
        return (
            self.directory
            / "intents"
            / (hashlib.sha256(self.operation_id.encode()).hexdigest() + ".json")
        )

    @staticmethod
    def _integer(value: Any, minimum: int = 0) -> bool:
        return type(value) is int and minimum <= value <= 9007199254740991

    @staticmethod
    def _hex(value: Any) -> bool:
        return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None

    @staticmethod
    def _text(value: Any) -> bool:
        return (
            isinstance(value, str) and 0 < len(value) <= 256 and not any(ord(c) < 32 for c in value)
        )

    @classmethod
    def _owner(cls, value: Any) -> None:
        if (
            not isinstance(value, dict)
            or set(value) != {"operationId", "planDigest", "attemptGeneration", "nonce"}
            or not cls._text(value["operationId"])
            or not cls._hex(value["planDigest"])
            or not cls._hex(value["nonce"])
            or not cls._integer(value["attemptGeneration"], 1)
        ):
            raise ValueError()

    def _record_shape(self, record: dict[str, Any], gate: dict[str, Any]) -> None:
        if (
            set(record)
            != {
                "schemaVersion",
                "operationId",
                "deviceId",
                "ownershipEpoch",
                "scopeDigest",
                "gateGeneration",
                "state",
                "writeIntentDigest",
            }
            or type(record["schemaVersion"]) is not int
            or record["schemaVersion"] != 1
            or not self._text(record["operationId"])
            or record["deviceId"] != self.device_id
            or not self._integer(record["ownershipEpoch"], 1)
            or not self._hex(record["scopeDigest"])
            or not self._integer(record["gateGeneration"])
            or record["gateGeneration"] > gate["generation"]
            or record["state"]
            not in {"preparing", "in_flight", "uncertain", "completed", "aborted"}
            or (
                record["writeIntentDigest"] is not None
                and not self._hex(record["writeIntentDigest"])
            )
            or (record["state"] == "aborted" and record["writeIntentDigest"] is not None)
        ):
            raise ValueError()

    def _validate(self, record: dict[str, Any], gate: dict[str, Any]) -> None:
        self._record_shape(record, gate)
        expected = {
            "schemaVersion": 1,
            "operationId": self.operation_id,
            "deviceId": self.device_id,
            "ownershipEpoch": self.ownership_epoch,
            "scopeDigest": self.scope_digest,
        }
        if any(record.get(key) != value for key, value in expected.items()) or record.get(
            "state"
        ) not in {"preparing", "in_flight", "uncertain", "completed", "aborted"}:
            raise fail("RESOURCE_COORDINATION_INVALID", 503)
        if (
            type(record.get("gateGeneration")) is not int
            or record["gateGeneration"] != gate["generation"]
        ):
            raise fail("RESOURCE_COORDINATION_GENERATION_CHANGED", 409)
        digest = record.get("writeIntentDigest")
        if digest is not None and (
            not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            raise fail("RESOURCE_COORDINATION_INVALID", 503)

    def begin(self) -> None:
        if self.directory is None or self.started:
            return
        with self._locked() as gate:
            path = self._path()
            entries = list(path.parent.iterdir())
            if len(entries) > 4096:
                raise ValueError()
            # A different operation ID is never an escape hatch for a POST
            # whose outcome remains unknown after the previous process exited.
            for entry in entries:
                if not re.fullmatch(r"[0-9a-f]{64}\.json", entry.name):
                    raise ValueError()
                other = _read(entry)
                self._record_shape(other, gate)
                if (
                    entry.name
                    != hashlib.sha256(other["operationId"].encode()).hexdigest() + ".json"
                ):
                    raise ValueError()
                if entry != path and other["state"] not in {"completed", "aborted"}:
                    raise fail(
                        "RESOURCE_WRITE_UNCERTAIN"
                        if other["state"] in {"in_flight", "uncertain"}
                        else "RESOURCE_PREPARATION_BUSY",
                        409,
                    )
            if path.exists() or path.is_symlink():
                record = _read(path)
                # A terminal, zero-write cancellation is the one safe case in
                # which this operation may enter a later runtime generation.
                # Do not relax the fence for any POST outcome or completed set.
                self._record_shape(record, gate)
                if record["state"] == "aborted" and gate["mode"] == "open":
                    record["gateGeneration"] = gate["generation"]
                self._validate(record, gate)
                if record["state"] in {"in_flight", "uncertain"}:
                    raise fail("RESOURCE_WRITE_UNCERTAIN", 409)
                if record["state"] == "completed":
                    raise fail("RESOURCE_OPERATION_COMPLETED", 409)
                if record["state"] == "aborted" and gate["mode"] != "open":
                    raise fail("RESOURCE_OTA_IN_PROGRESS", 409)
            else:
                if gate["mode"] != "open":
                    raise fail("RESOURCE_OTA_IN_PROGRESS", 409)
                record = {
                    "schemaVersion": 1,
                    "operationId": self.operation_id,
                    "deviceId": self.device_id,
                    "ownershipEpoch": self.ownership_epoch,
                    "scopeDigest": self.scope_digest,
                    "gateGeneration": gate["generation"],
                    "state": "preparing",
                    "writeIntentDigest": None,
                }
                self._record_shape(record, gate)
            record["state"] = "preparing"
            _atomic(path, record)
            self.record, self.started = record, True

    def before_write(self, digest: str) -> None:
        if self.directory is None:
            return
        if not self._hex(digest):
            raise fail("RESOURCE_COORDINATION_INVALID", 503)
        self.begin()
        with self._locked() as gate:
            record = _read(self._path())
            self._validate(record, gate)
            if self.uncertain or record["state"] not in {"preparing", "in_flight"}:
                raise fail("RESOURCE_WRITE_UNCERTAIN", 409)
            record.update(state="in_flight", writeIntentDigest=digest)
            _atomic(self._path(), record)
            self.record, self.wrote = record, True

    def mark_uncertain(self) -> None:
        if not self.started or not self.wrote:
            return
        self.uncertain = True
        with self._locked() as gate:
            record = _read(self._path())
            self._validate(record, gate)
            record["state"] = "uncertain"
            _atomic(self._path(), record)
            self.record = record

    def finish(self, ready: bool) -> None:
        if not self.started:
            return
        with self._locked() as gate:
            record = _read(self._path())
            self._validate(record, gate)
            if self.uncertain or (self.wrote and not ready):
                record["state"] = "uncertain"
            else:
                record["state"] = "completed" if ready else "aborted"
            _atomic(self._path(), record)
            self.record = record

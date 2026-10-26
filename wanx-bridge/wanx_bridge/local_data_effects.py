"""Bounded, credential-free physical closure evidence. Never an authority writer.

Updates run on the runtime event loop. A deferred publisher builds immutable
snapshots outside the sessions state lock; the ledger thread reads snapshots
under a short pointer lock and never calls back into the event loop or SQLite.
"""

from __future__ import annotations

import asyncio
import copy
import threading
from collections import OrderedDict

from .local_data_protocol import digest, need


class PhysicalEffects:
    MAX_EFFECTS = 128
    MAX_HISTORY = 512

    def __init__(self, generation, audiences, wall, monotonic, *, worker_required=False):
        need(type(worker_required) is bool)
        self.generation, self.audiences = generation, frozenset(audiences)
        self.wall, self.monotonic = wall, monotonic
        self.sessions, self.operations, self.effects = OrderedDict(), OrderedDict(), OrderedDict()
        self.inventory = {}
        self.worker_required, self.worker = worker_required, None
        self.worker_boots = set()
        self.lost_at = self.wall() - 1000  # Older-generation histories cannot be reconstructed.
        self.lost_live_history = False
        self._scheduled = False
        self._published = {}
        self._pointer_lock = threading.Lock()

    def _dirty(self):
        if not self._scheduled:
            self._scheduled = True
            asyncio.get_running_loop().call_soon(self._publish)

    def _keep(self, store, key, value):
        store[key] = value
        store.move_to_end(key)
        while len(store) > self.MAX_HISTORY:
            _, removed = store.popitem(last=False)
            self.lost_at = max(self.lost_at, removed["updatedAtMs"])
            if (
                not removed["ended"]
                or "operationId" in removed
                and not (
                    removed["gatewayFinished"]
                    and (removed["isChild"] or removed["transportClosed"])
                    and (removed["nativeGeneration"] is None or removed["nativeClosed"])
                )
            ):
                self.lost_live_history = True

    @staticmethod
    def _matches(effect, value):
        return (
            value["bindingId"] in effect["bindings"]
            and value["authorizationVersion"] < effect["expected"]["authorizationVersion"]
            and (not value["ended"] or value["updatedAtMs"] >= effect["expected"]["committedAtMs"])
        )

    def _update(self, name, key, value):
        self._keep(getattr(self, name), key, value)
        for effect in self.effects.values():
            if effect.get("final") is not None:
                continue
            if key in effect[name] or self._matches(effect, value):
                if len(effect[name]) >= self.MAX_HISTORY and key not in effect[name]:
                    effect["incomplete"] = True
                else:
                    effect[name][key] = value
        self._dirty()

    def session(self, value):
        context = value["context"]
        self._update(
            "sessions",
            value["sessionId"],
            {
                "sessionId": value["sessionId"],
                "bindingId": context["bindingId"],
                "authorizationVersion": context["authorizationVersion"],
                "closed": value["closed"],
                "ended": value["closed"],
                "updatedAtMs": self.wall(),
            },
        )

    def operation(self, value):
        self._update(
            "operations",
            value["operationId"],
            {
                "operationId": value["operationId"],
                "sessionId": value["sessionId"],
                "bindingId": value["context"]["bindingId"],
                "authorizationVersion": value["context"]["authorizationVersion"],
                "audience": value["route"]["audience"],
                "nativeGeneration": value["nativeGeneration"],
                "nativeClosed": value["nativeClosed"],
                "gatewayFinished": value["gatewayFinished"],
                "transportClosed": value["gatewayTransportClosed"],
                "isChild": value["parentOperationId"] is not None,
                "ended": value["state"] == "closed",
                "updatedAtMs": self.wall(),
            },
        )

    def observed(self, audience, generation, active_ids, accepted):
        self.inventory[audience] = {
            "generation": generation,
            "active": list(active_ids),
            "accepted": accepted,
            "deadline": self.monotonic() + 1,
        }
        self._dirty()

    def committed(self, commit):
        identifier = commit["operationId"]
        expected = {
            key: copy.deepcopy(value)
            for key, value in commit.items()
            if key not in {"affectedBindingIds", "affectedJobs", "affectedJobsComplete"}
        }
        prior = self.effects.get(identifier)
        if prior is not None:
            # Exact historical retry does not reset evidence or its deadline.
            if (
                prior["expected"] != expected
                or prior["bindings"] != frozenset(commit["affectedBindingIds"])
                or prior["jobs"] != commit.get("affectedJobs", [])
                or not commit.get("affectedJobsComplete", True)
            ):
                prior["incomplete"] = True
                prior["final"] = None
                self._dirty()
            return
        effect = {
            "expected": expected,
            "bindings": frozenset(commit["affectedBindingIds"]),
            "incomplete": self.lost_live_history
            or commit["committedAtMs"] <= self.lost_at
            or not commit.get("affectedJobsComplete", True),
            "jobs": copy.deepcopy(commit.get("affectedJobs", [])),
            # Readiness is checked at publication. A known boot may first be
            # unready while draining a job, then supply real closure evidence.
            "workerBootId": self.worker["workerBootId"] if self.worker else None,
            "sessions": {},
            "operations": {},
            "final": None,
        }
        for name in ("sessions", "operations"):
            effect[name] = {
                key: value
                for key, value in getattr(self, name).items()
                if self._matches(effect, value)
            }
        if any(op["sessionId"] not in effect["sessions"] for op in effect["operations"].values()):
            effect["incomplete"] = True
        self.effects[identifier] = effect
        while len(self.effects) > self.MAX_EFFECTS:
            self.effects.popitem(last=False)
        self._dirty()

    def worker_observed(self, body):
        prior = self.worker
        if prior and body["workerBootId"] == prior["workerBootId"]:
            need(body["sequence"] > prior["sequence"], "LOCAL_DATA_REPLAY")
        else:
            need(
                body["workerBootId"] not in self.worker_boots and len(self.worker_boots) < 8,
                "LOCAL_DATA_REPLAY",
            )
            self.worker_boots.add(body["workerBootId"])
        self.worker = {**body, "deadline": self.monotonic() + 1}
        self._dirty()

    def _worker_state(self, effect, mono):
        jobs = effect["jobs"]
        if not self.worker_required and not jobs:
            return True, 0, 0, None
        value = self.worker
        ready = value is not None and value["ready"] and mono < value["deadline"]
        same_boot = ready and (not jobs or value["workerBootId"] == effect["workerBootId"])
        reported = (
            {(job["operationId"], job["attempt"]): job for job in value["jobs"]} if value else {}
        )
        closed = unknown = 0
        for job in jobs:
            found = reported.get((job["operationId"], job["attempt"]))
            matches = (
                same_boot
                and found is not None
                and all(found[name] == item for name, item in job.items() if name != "stateVersion")
                and found["stateVersion"] >= job["stateVersion"]
            )
            if not matches or found["phase"] == "unknown":
                unknown += 1
            elif found["phase"] == "closed" and not found["publicationPending"]:
                closed += 1
        return bool(same_boot), closed, unknown, value

    def _publish(self):
        self._scheduled = False
        now, mono = self.wall(), self.monotonic()
        result = {}
        for identifier, effect in self.effects.items():
            if effect["final"] is not None:
                result[identifier] = (effect["final"], None)
                continue
            expected = effect["expected"]
            inventory = {name: self.inventory.get(name) for name in self.audiences}
            ready = bool(self.audiences) and all(
                value is not None and value["accepted"] and mono < value["deadline"]
                for value in inventory.values()
            )
            operations = tuple(effect["operations"].values())
            native = [op for op in operations if op["nativeGeneration"] is not None]
            native_closed = sum(op["nativeClosed"] for op in native)
            native_unknown = sum(
                not op["nativeClosed"]
                and not (
                    (entry := inventory.get(op["audience"]))
                    and entry["accepted"]
                    and mono < entry["deadline"]
                    and entry["generation"] == op["nativeGeneration"]
                    and op["operationId"] in entry["active"]
                )
                for op in native
            )
            worker_ready, worker_closed, worker_unknown, worker = self._worker_state(effect, mono)
            target_operations = len(native) + len(effect["jobs"])
            closed_operations = native_closed + worker_closed
            unknown_operations = native_unknown + worker_unknown
            closed_sessions = sum(
                session["closed"]
                and all(
                    op["gatewayFinished"] and (op["isChild"] or op["transportClosed"])
                    for op in operations
                    if op["sessionId"] == identifier
                )
                for identifier, session in effect["sessions"].items()
            )
            gateway_unknown = any(
                op["gatewayFinished"] and not op["isChild"] and not op["transportClosed"]
                for op in operations
            )
            unknown = (
                effect["incomplete"]
                or not ready
                or not worker_ready
                or unknown_operations
                or gateway_unknown
            )
            complete = (
                closed_sessions == len(effect["sessions"])
                and closed_operations == target_operations
                and all(
                    op["gatewayFinished"] and (op["isChild"] or op["transportClosed"])
                    for op in operations
                )
            )
            state = (
                "unknown"
                if unknown
                else "effective"
                if complete
                else "failed"
                if now > expected["deadlineMs"]
                else "pending"
            )
            body = {
                **copy.deepcopy(expected),
                "effectState": state,
                "gateway": {
                    "generation": self.generation,
                    "targetSessions": len(effect["sessions"]),
                    "closedSessions": closed_sessions,
                    "pendingSessions": len(effect["sessions"]) - closed_sessions,
                },
                "native": {
                    "targetOperations": target_operations,
                    "closedOperations": closed_operations,
                    "pendingOperations": target_operations - closed_operations - unknown_operations,
                    "unknownOperations": unknown_operations,
                },
                "observedAtMs": now,
                "evidenceDigest": digest(
                    {
                        "purpose": "centuarai.local-data.physical-effect",
                        **expected,
                        "sessions": list(effect["sessions"].values()),
                        "operations": list(operations),
                        "participants": {
                            name: None
                            if entry is None
                            else {key: value for key, value in entry.items() if key != "deadline"}
                            for name, entry in sorted(inventory.items())
                        },
                        "completeHistory": not effect["incomplete"],
                        "workerRequired": self.worker_required,
                        "jobs": effect["jobs"],
                        "workerBootId": effect["workerBootId"],
                        "worker": None
                        if worker is None
                        else {key: value for key, value in worker.items() if key != "deadline"},
                    }
                ),
            }
            if state == "effective":
                effect["final"] = body  # A proven historical closure remains a fact.
                result[identifier] = (body, None)
            else:
                deadline = min(
                    (entry["deadline"] for entry in inventory.values() if entry), default=mono
                )
                if self.worker_required or effect["jobs"]:
                    deadline = min(deadline, worker["deadline"] if worker is not None else mono)
                result[identifier] = (body, deadline)
        with self._pointer_lock:
            self._published = result

    def snapshot(self, request_id, expected):
        with self._pointer_lock:
            item = self._published.get(request_id)
        if item is None or any(item[0].get(key) != value for key, value in expected.items()):
            return None
        body = copy.deepcopy(item[0])
        if item[1] is not None and self.monotonic() >= item[1]:
            body["effectState"] = "unknown"
        return body

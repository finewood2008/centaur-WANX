"""Ephemeral local data admission. The injected authority is the only ledger owner.

All state transitions are short event-loop critical sections. Authority calls,
policy callbacks, cryptography and closure callbacks run outside the state lock.
Every return after such work is fenced against close/expiry/invalidation.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import inspect
import re
import secrets
import time

from centuarai_local_data_gate.team import (
    merge_grants,
    resource_binding_route,
    resource_needs,
    resource_write_route,
    team_resource,
    validate_members,
    validate_team,
)

from .local_data_effects import PhysicalEffects
from .local_data_protocol import (
    DataProtocolError,
    canonical,
    decode_channel_locator,
    decode_session_intent_locator,
    decode_session_locator,
    digest,
    digest32,
    encode,
    fields,
    gateway_proof_digest,
    grants,
    integer,
    need,
    principal_namespace,
    public_key_thumbprint,
    token,
    validate_authorization,
    validate_clipboard_scope,
    validate_gateway_request,
    validate_headers,
    validate_target,
    validate_worker_job,
    verify_channel_proof,
    verify_session_intent,
    verify_session_proof,
)


def _id():
    return secrets.token_urlsafe(32)


def _clone(value):
    return copy.deepcopy(value)


def _allows(granted, resource, action):
    aliases = {"space": {"space", "space:personal"}, "space:personal": {"space", "space:personal"}}
    for grant in granted:
        source = grant["resourceId"]
        if action in grant["actions"] and (
            source == resource
            or resource in aliases.get(source, set())
            or source == "wanx"
            and resource in {"space", "space:personal", "clipboard"}
        ):
            return True
    return False


class LocalDataSessions:
    def __init__(
        self,
        *,
        authority,
        execute_authority,
        box_id,
        box_key_thumbprint,
        box_response_signer,
        gateway_signer,
        gateway_verifier,
        gateway_lease_signer,
        gateway_id,
        application_policy,
        route_policy,
        child_policy=None,
        gateway_resources_signer=None,
        gateway_members_signer=None,
        gateway_task_signer=None,
        gateway_grants_signer=None,
        gateway_observation_signer=None,
        required_audiences=(),
        worker_required=False,
        wall_clock_ms=None,
        monotonic_clock=None,
        on_operation_closed=None,
        generation=None,
        limits=None,
    ):
        token(box_id)
        digest32(box_key_thumbprint)
        token(gateway_id)
        self.authority = authority
        self.execute_authority = execute_authority
        self.box_id, self.box_key_thumbprint, self.gateway_id = (
            box_id,
            box_key_thumbprint,
            gateway_id,
        )
        self.generation = generation or _id()
        digest32(self.generation)
        self.box_response_signer, self.gateway_signer = box_response_signer, gateway_signer
        self.gateway_verifier, self.gateway_lease_signer = gateway_verifier, gateway_lease_signer
        self.gateway_resources_signer = gateway_resources_signer
        self.gateway_members_signer = gateway_members_signer
        self.gateway_task_signer = gateway_task_signer
        self.gateway_grants_signer = gateway_grants_signer
        self.gateway_observation_signer = gateway_observation_signer
        need(set(required_audiences) <= {"octop", "clipboard", "semantica", "semantica-mcp"})
        self.application_policy, self.route_policy, self.child_policy = (
            application_policy,
            route_policy,
            child_policy,
        )
        self.wall_clock_ms = wall_clock_ms or (lambda: time.time_ns() // 1_000_000)
        self.monotonic_clock = monotonic_clock or time.monotonic
        self.on_operation_closed = on_operation_closed
        self.effects = PhysicalEffects(
            self.generation,
            required_audiences,
            self.wall_clock_ms,
            self.monotonic_clock,
            worker_required=worker_required,
        )
        self._inventory_nonces = {}
        defaults = {
            "sessions": 256,
            "sessions_per_binding": 32,
            "challenges": 256,
            "challenges_per_binding": 32,
            "intent_queries": 8,
            "intent_replay_per_binding": 64,
            "intent_replay_total": 4096,
            "renewal_challenges": 128,
            "renewals_per_binding": 32,
            "replay_per_session": 1024,
            "replay_total": 16384,
            "operations": 128,
            "operations_per_session": 16,
            "staging": 8,
            "staging_per_binding": 2,
            "staging_bytes": 1024**3,
            "authority_queries": 32,
            "authority_cache": 256,
        }
        for key, value in (limits or {}).items():
            need(key in defaults and type(value) is int and 0 < value <= defaults[key])
            defaults[key] = value
        self.limits = defaults
        self._lock = asyncio.Lock()
        self._sessions, self._challenges, self._operations = {}, {}, {}
        self._renewal_budgets = {}
        self._intent_queries, self._intent_replay = {}, {}
        self._cache, self._queries = {}, {}
        self._revision = 0
        self._closed = False
        self._clock_failed = False
        self._last_wall = 0

    def _now(self):
        now = self.wall_clock_ms()
        integer(now)
        if now < self._last_wall:
            self._clock_failed = True
        self._last_wall = max(self._last_wall, now)
        need(not self._clock_failed, "LOCAL_DATA_CLOCK_ROLLBACK")
        return now, self.monotonic_clock()

    def _running(self):
        need(not self._closed and not self._clock_failed, "LOCAL_DATA_SESSION_EXPIRED")

    def _session_live(self, session, now, mono):
        self._running()
        need(
            session is not None
            and not session["closed"]
            and now < session["expiresAtMs"]
            and mono < session["hardDeadline"]
            and now < session["presenceExpiresAtMs"]
            and mono < session["presenceDeadline"],
            "LOCAL_DATA_SESSION_EXPIRED",
        )

    def _op_live(self, operation, now, mono):
        need(operation is not None and operation["state"] != "closed", "LOCAL_DATA_SESSION_EXPIRED")
        self._session_live(self._sessions.get(operation["sessionId"]), now, mono)
        need(
            operation["state"] != "staging" or mono < operation["stageDeadline"],
            "LOCAL_DATA_SESSION_EXPIRED",
        )
        if operation["parentOperationId"] is not None:
            parent = self._operations.get(operation["parentOperationId"])
            need(parent is not None and parent["state"] == "active", "LOCAL_DATA_SESSION_EXPIRED")

    def _prune(self, now, mono):
        self._intent_replay = {key: end for key, end in self._intent_replay.items() if now < end}
        self._challenges = {
            key: value
            for key, value in self._challenges.items()
            if now < value["expiresAtMs"] and mono < value["deadline"]
        }
        self._cache = {key: value for key, value in self._cache.items() if mono < value["deadline"]}
        for session in self._sessions.values():
            session["replay"] = {key: end for key, end in session["replay"].items() if end > now}
        # Logical denial does not free disk/socket capacity. Owners must report
        # physical cleanup first, even if a worker or native process has stalled.
        self._operations = {
            key: value
            for key, value in self._operations.items()
            if self._reserved(value) or value.get("proofExpiresAtMs", 0) > now
        }
        live_ids = {value["sessionId"] for value in self._operations.values()}
        self._sessions = {
            key: value
            for key, value in self._sessions.items()
            if key in live_ids
            or not value["closed"]
            and now < value["expiresAtMs"]
            and mono < value["presenceDeadline"]
        }

    def _burn(self, session, jti, end, now):
        need(jti not in session["replay"], "LOCAL_DATA_REPLAY")
        need(
            len(session["replay"]) < self.limits["replay_per_session"]
            and sum(len(item["replay"]) for item in self._sessions.values())
            < self.limits["replay_total"],
            "LOCAL_DATA_CAPACITY",
        )
        session["replay"][jti] = end

    def _snapshot(self, operation):
        return _clone(
            {
                name: operation[name]
                for name in (
                    "operationId",
                    "sessionId",
                    "parentOperationId",
                    "context",
                    "route",
                    "bodySha256",
                    "bodyBytes",
                    "state",
                    "constraints",
                    "requiredGrants",
                    "observation",
                )
            }
        )

    def _close_op_locked(self, operation, reason):
        if operation["state"] == "closed":
            return []
        operation["state"] = "closed"
        operation["outcome"] = reason
        self.effects.operation(operation)
        result = [(self._snapshot(operation), reason)]
        for child in self._operations.values():
            if child["parentOperationId"] == operation["operationId"]:
                result.extend(self._close_op_locked(child, reason))
        return result

    @staticmethod
    def _reserved(operation):
        return (
            operation["state"] != "closed"
            or not operation["gatewayFinished"]
            or operation["nativeGeneration"] is not None
            and not operation["nativeClosed"]
        )

    def _close_session_locked(self, session, reason):
        session["closed"] = True
        self.effects.session(session)
        result = []
        for operation in self._operations.values():
            if operation["sessionId"] == session["sessionId"]:
                result.extend(self._close_op_locked(operation, reason))
        return result

    async def _notify(self, events):
        if self.on_operation_closed:

            async def notify_one(operation, reason):
                result = self.on_operation_closed(operation, reason)
                if inspect.isawaitable(result):
                    await asyncio.wait_for(result, timeout=1.0)

            # One blocked socket callback cannot prevent cancellation of sibling
            # operations. State is already denied; transport owners retain their
            # own positive closure evidence rather than inferring success here.
            await asyncio.gather(
                *(notify_one(operation, reason) for operation, reason in events),
                return_exceptions=True,
            )

    async def _end_session(self, session_id, reason):
        async with self._lock:
            session = self._sessions.get(session_id)
            events = self._close_session_locked(session, reason) if session else []
        await self._notify(events)

    def _authority_query(self, binding_id):
        # This closure executes in the runtime's bounded authority executor, so
        # a queued call does not use a stale pre-queue expiry timestamp.
        return self.authority.get_authorization(binding_id, self.wall_clock_ms() // 1000)

    async def _view(self, binding_id, minimum_cache_ms=0):
        now, mono = self._now()
        async with self._lock:
            self._running()
            hit = self._cache.get(binding_id)
            if (
                hit
                and mono + minimum_cache_ms / 1000 < hit["deadline"]
                and (hit["view"]["expiresAt"] is None or now < hit["view"]["expiresAt"] * 1000)
            ):
                return _clone(hit["view"])
            task = self._queries.get(binding_id)
            if task is None:
                self._cache = {
                    key: value for key, value in self._cache.items() if mono < value["deadline"]
                }
                need(len(self._queries) < self.limits["authority_queries"], "LOCAL_DATA_CAPACITY")
                need(
                    binding_id in self._cache
                    or len(set(self._cache) | set(self._queries)) < self.limits["authority_cache"],
                    "LOCAL_DATA_CAPACITY",
                )
                task = asyncio.create_task(self._load_view(binding_id, self._revision, mono))
                self._queries[binding_id] = task
                task.add_done_callback(
                    lambda done: done.exception() if not done.cancelled() else None
                )
        # A cancelled request does not cancel or remove the in-flight executor
        # reservation. All waiters share the same publication/invalidation fence.
        view = await asyncio.shield(task)
        now, mono = self._now()
        async with self._lock:
            self._running()
            hit = self._cache.get(binding_id)
            need(hit is not None and mono < hit["deadline"], "LOCAL_DATA_CONTEXT_CHANGED")
        return _clone(view)

    async def _load_view(self, binding_id, revision, started):
        pending = asyncio.create_task(self.execute_authority(self._authority_query, binding_id))
        pending.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        owner = asyncio.current_task()
        try:
            view = _clone(await asyncio.wait_for(asyncio.shield(pending), timeout=1.0))
            self._validate_view(view)
            current, end = self._now()
            need(
                view["expiresAt"] is None or current < view["expiresAt"] * 1000,
                "LOCAL_DATA_FORBIDDEN",
            )
            async with self._lock:
                self._running()
                need(view["bindingId"] == binding_id, "LOCAL_DATA_CONTEXT_CHANGED")
                # Invalidations never let an in-flight result repopulate cache.
                need(revision == self._revision and end < started + 1, "LOCAL_DATA_CONTEXT_CHANGED")
                self._cache[binding_id] = {"view": view, "deadline": started + 1}
            return _clone(view)
        except DataProtocolError:
            raise
        except Exception as exc:
            raise DataProtocolError("LOCAL_DATA_FORBIDDEN") from exc
        finally:
            if pending.done():
                await self._release_query(binding_id, owner)
            else:
                # A timed-out physical DB call still occupies its admission slot.
                # Keep the failed shared task so retries cannot multiply it.
                pending.add_done_callback(
                    lambda _: asyncio.create_task(self._release_query(binding_id, owner))
                )

    async def _release_query(self, binding_id, owner):
        async with self._lock:
            if self._queries.get(binding_id) is owner:
                del self._queries[binding_id]

    def _validate_view(self, view):
        required = {
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "rosterVersion",
            "rosterDigest",
            "policyVersion",
            "authorizationVersion",
            "principalSecurityVersion",
            "principalStatus",
            "ownershipState",
            "bindingId",
            "bindingRevision",
            "principalId",
            "clientId",
            "accessKey",
            "status",
            "grants",
            "expiresAt",
        }
        fields(view, required | ({"team"} if "team" in view else set()))
        if view.get("team") is not None:
            validate_team(view["team"], view)
        need(
            view["boxId"] == self.box_id
            and view["boxKeyThumbprint"] == self.box_key_thumbprint
            and view["status"] == view["principalStatus"] == "active"
            and view["ownershipState"] == "owned",
            "LOCAL_DATA_FORBIDDEN",
        )
        for name in ("bindingId", "principalId", "clientId"):
            token(view[name])
        for name in (
            "ownershipEpoch",
            "rosterVersion",
            "policyVersion",
            "authorizationVersion",
            "principalSecurityVersion",
            "bindingRevision",
        ):
            integer(view[name])
        digest32(view["rosterDigest"])
        public_key_thumbprint(view["accessKey"])
        grants(view["grants"])
        if view["expiresAt"] is not None:
            integer(view["expiresAt"])

    @staticmethod
    def _auth(view, allowed):
        result = {
            key: view[key]
            for key in (
                "boxId",
                "boxKeyThumbprint",
                "ownershipEpoch",
                "principalId",
                "bindingId",
                "clientId",
                "authorizationVersion",
                "principalSecurityVersion",
                "bindingRevision",
            )
        }
        result.update(
            grants=_clone(allowed),
            grantExpiresAtMs=None if view["expiresAt"] is None else view["expiresAt"] * 1000,
        )
        validate_authorization(result)
        return result

    async def _current(self, session_id, minimum_cache_ms=0):
        now, mono = self._now()
        async with self._lock:
            session = self._sessions.get(session_id)
            self._session_live(session, now, mono)
            context = _clone(session["context"])
        try:
            view = await self._view(context["bindingId"], minimum_cache_ms)
            for key in (
                "boxId",
                "boxKeyThumbprint",
                "ownershipEpoch",
                "principalId",
                "bindingId",
                "clientId",
                "principalSecurityVersion",
                "bindingRevision",
            ):
                need(view[key] == context[key], "LOCAL_DATA_CONTEXT_CHANGED")
            need(
                view["authorizationVersion"] >= context["authorizationVersion"],
                "LOCAL_DATA_CONTEXT_CHANGED",
            )
            # Membership/role/ACL mutations cannot upgrade a live channel. A
            # changed team capability closes it; fresh approval opens a new one.
            need(view.get("team") == context.get("team"), "LOCAL_DATA_CONTEXT_CHANGED")
            allowed = [
                {
                    "resourceId": g["resourceId"],
                    "actions": [
                        a for a in g["actions"] if _allows(view["grants"], g["resourceId"], a)
                    ],
                }
                for g in context["grants"]
            ]
            allowed = [g for g in allowed if g["actions"]]
            grants(allowed)
            fresh = self._auth(view, allowed)
            if context["grantExpiresAtMs"] is not None:
                fresh["grantExpiresAtMs"] = min(
                    context["grantExpiresAtMs"],
                    fresh["grantExpiresAtMs"] or context["grantExpiresAtMs"],
                )
            now, mono = self._now()
            async with self._lock:
                session = self._sessions.get(session_id)
                self._session_live(session, now, mono)
                # A parallel positive query may advance a version; never revert it.
                need(
                    fresh["authorizationVersion"] >= session["context"]["authorizationVersion"],
                    "LOCAL_DATA_CONTEXT_CHANGED",
                )
                session["context"].update(fresh)
                limit = fresh["grantExpiresAtMs"]
                if limit is not None:
                    session["expiresAtMs"] = min(session["expiresAtMs"], limit)
                    session["hardDeadline"] = min(
                        session["hardDeadline"], mono + (limit - now) / 1000
                    )
                self._session_live(session, now, mono)
                return _clone(session["context"])
        except Exception:
            await self._end_session(session_id, "denied")
            raise

    async def _intent_view(self, binding_id):
        """Unverified locators cannot fill the active session query/cache pool."""
        async with self._lock:
            self._running()
            task = self._intent_queries.get(binding_id)
            if task is None:
                need(
                    len(self._intent_queries) < self.limits["intent_queries"], "LOCAL_DATA_CAPACITY"
                )
                task = asyncio.create_task(self._load_intent_view(binding_id))
                self._intent_queries[binding_id] = task
                task.add_done_callback(
                    lambda done: done.exception() if not done.cancelled() else None
                )
        return _clone(await asyncio.shield(task))

    async def _load_intent_view(self, binding_id):
        owner = asyncio.current_task()
        started = self.monotonic_clock()
        pending = asyncio.create_task(self.execute_authority(self._authority_query, binding_id))
        pending.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)

        async def release():
            async with self._lock:
                if self._intent_queries.get(binding_id) is owner:
                    del self._intent_queries[binding_id]

        try:
            view = _clone(await asyncio.wait_for(asyncio.shield(pending), timeout=1.0))
            self._validate_view(view)
            now, mono = self._now()
            need(
                view["bindingId"] == binding_id
                and mono < started + 1
                and (view["expiresAt"] is None or now < view["expiresAt"] * 1000),
                "LOCAL_DATA_FORBIDDEN",
            )
            return view
        except DataProtocolError:
            raise
        except Exception as exc:
            raise DataProtocolError("LOCAL_DATA_FORBIDDEN") from exc
        finally:
            if pending.done():
                await release()
            else:
                pending.add_done_callback(lambda _: asyncio.create_task(release()))

    async def challenge(self, body):
        fields(body, {"proof"})
        locator = decode_session_intent_locator(body["proof"])
        need(
            locator["boxId"] == self.box_id
            and locator["boxKeyThumbprint"] == self.box_key_thumbprint,
            "LOCAL_DATA_CONTEXT_CHANGED",
        )
        revision = self._revision
        view = await self._intent_view(locator["bindingId"])
        now, mono = self._now()
        payload = verify_session_intent(body["proof"], view["accessKey"], now_ms=now)
        # Unknown applications must not reserve a candidate even with a valid key.
        allowed = self.application_policy(
            payload["applicationId"], payload["launchId"], _clone(view)
        )
        grants(allowed)
        now, mono = self._now()
        challenge = _id()
        result = {
            "challenge": challenge,
            "gatewayGeneration": self.generation,
            "issuedAtMs": now,
            "expiresAtMs": now + 30000,
        }
        signed = self.box_response_signer("session-challenge", result, now)
        async with self._lock:
            self._running()
            self._prune(now, mono)
            need(
                revision == self._revision and now < payload["expiresAtMs"],
                "LOCAL_DATA_CONTEXT_CHANGED",
            )
            binding = payload["bindingId"]
            nonce = (binding, payload["jti"])
            need(nonce not in self._intent_replay, "LOCAL_DATA_REPLAY")
            need(
                len(self._intent_replay) < self.limits["intent_replay_total"]
                and sum(key[0] == binding for key in self._intent_replay)
                < self.limits["intent_replay_per_binding"],
                "LOCAL_DATA_CAPACITY",
            )
            initial = {
                key: row for key, row in self._challenges.items() if "parentSessionId" not in row
            }
            prior = [
                key
                for key, row in initial.items()
                if all(
                    row[name] == payload[name]
                    for name in ("bindingId", "applicationId", "launchId")
                )
            ]
            need(
                len(initial) - len(prior) < self.limits["challenges"]
                and sum(row["bindingId"] == binding for row in initial.values()) - len(prior)
                < self.limits["challenges_per_binding"],
                "LOCAL_DATA_CAPACITY",
            )
            self._intent_replay[nonce] = payload["expiresAtMs"]
            for key in prior:
                del self._challenges[key]
            self._challenges[challenge] = {
                **{
                    key: _clone(payload[key])
                    for key in ("bindingId", "applicationId", "launchId", "requestId", "channelKey")
                },
                "expiresAtMs": now + 30000,
                "deadline": mono + 30,
                "accessKey": _clone(view["accessKey"]),
                "ceiling": self._auth(view, allowed),
            }
        return signed

    async def renewal_challenge(self, proof):
        payload = await self._channel(proof, "renewal")
        context = await self._current(payload["sessionId"])
        view = await self._view(context["bindingId"])
        proposed = public_key_thumbprint(payload["channelKey"])
        need(proposed != public_key_thumbprint(view["accessKey"]), "LOCAL_DATA_FORBIDDEN")
        now, mono = self._now()
        challenge_id = _id()
        result = {
            "challenge": challenge_id,
            "gatewayGeneration": self.generation,
            "issuedAtMs": now,
            "expiresAtMs": now + 30000,
        }
        signed = self.box_response_signer("session-challenge", result, now)
        async with self._lock:
            session = self._sessions.get(payload["sessionId"])
            self._session_live(session, now, mono)
            old_key = _clone(session["channelKey"])
        need(proposed != public_key_thumbprint(old_key), "LOCAL_DATA_FORBIDDEN")
        async with self._lock:
            now, mono = self._now()
            session = self._sessions.get(payload["sessionId"])
            self._session_live(session, now, mono)
            need(now < payload["expiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")
            self._prune(now, mono)
            self._burn(session, payload["jti"], payload["expiresAtMs"], now)
            existing = [row for row in self._challenges.values() if "parentSessionId" in row]
            prior = [
                key
                for key, row in self._challenges.items()
                if row.get("parentSessionId") == payload["sessionId"]
            ]
            need(
                len(existing) - len(prior) < self.limits["renewal_challenges"],
                "LOCAL_DATA_CAPACITY",
            )
            self._renewal_budgets = {
                key: value for key, value in self._renewal_budgets.items() if mono < value[0]
            }
            binding = context["bindingId"]
            need(
                binding in self._renewal_budgets or len(self._renewal_budgets) < 256,
                "LOCAL_DATA_CAPACITY",
            )
            deadline, used = self._renewal_budgets.get(binding, (mono + 60, 0))
            need(used < self.limits["renewals_per_binding"], "LOCAL_DATA_CAPACITY")
            self._renewal_budgets[binding] = (deadline, used + 1)
            # A fresh signed retry supersedes a lost response's unused proposal;
            # a late Access proof for the old challenge can never commit.
            for key in prior:
                del self._challenges[key]
            self._challenges[challenge_id] = {
                "bindingId": binding,
                "applicationId": context["applicationId"],
                "launchId": context["launchId"],
                "expiresAtMs": result["expiresAtMs"],
                "deadline": mono + 30,
                "parentSessionId": payload["sessionId"],
                "requestId": payload["requestId"],
                "channelKey": _clone(payload["channelKey"]),
                "accessKey": _clone(view["accessKey"]),
                "ceiling": _clone(context),
            }
        return signed

    async def create_session(self, access_proof, *, renewal=False):
        need(type(renewal) is bool)
        locator = decode_session_locator(access_proof)
        need(locator["gatewayGeneration"] == self.generation, "LOCAL_DATA_CONTEXT_CHANGED")
        async with self._lock:
            self._prune(*self._now())
            challenge_copy = _clone(self._challenges.get(locator["challenge"]))
            need(
                challenge_copy is not None
                and challenge_copy["bindingId"] == locator["bindingId"]
                and ("parentSessionId" in challenge_copy) == renewal,
                "LOCAL_DATA_FORBIDDEN",
            )
        # No current-authority work is triggered by a random locator or bad PoP.
        payload = verify_session_proof(
            access_proof, challenge_copy["accessKey"], now_ms=self._now()[0]
        )
        view = await self._view(locator["bindingId"])
        need(view["accessKey"] == challenge_copy["accessKey"], "LOCAL_DATA_CONTEXT_CHANGED")
        now, mono = self._now()
        for name in (
            "boxId",
            "boxKeyThumbprint",
            "ownershipEpoch",
            "principalId",
            "bindingId",
            "clientId",
        ):
            need(payload[name] == view[name], "LOCAL_DATA_CONTEXT_CHANGED")
        async with self._lock:
            need(
                self._challenges.get(payload["challenge"]) == challenge_copy,
                "LOCAL_DATA_FORBIDDEN",
            )
            if renewal:
                self._session_live(self._sessions.get(challenge_copy["parentSessionId"]), now, mono)
        for name in ("requestId", "channelKey", "applicationId", "launchId"):
            need(payload[name] == challenge_copy[name], "LOCAL_DATA_CONTEXT_CHANGED")
        for name in (
            "ownershipEpoch",
            "principalId",
            "bindingId",
            "clientId",
            "bindingRevision",
            "principalSecurityVersion",
        ):
            need(view[name] == challenge_copy["ceiling"][name], "LOCAL_DATA_CONTEXT_CHANGED")
        allowed = _clone(
            self.application_policy(payload["applicationId"], payload["launchId"], _clone(view))
        )
        grants(allowed)
        if renewal:
            allowed = [
                {
                    "resourceId": item["resourceId"],
                    "actions": [
                        action
                        for action in item["actions"]
                        if _allows(allowed, item["resourceId"], action)
                    ],
                }
                for item in challenge_copy["ceiling"]["grants"]
            ]
            allowed = [item for item in allowed if item["actions"]]
            grants(allowed)
        need(
            all(
                _allows(view["grants"], grant["resourceId"], action)
                for grant in allowed
                for action in grant["actions"]
            ),
            "LOCAL_DATA_FORBIDDEN",
        )
        authorization = self._auth(view, allowed)
        if renewal and challenge_copy["ceiling"]["grantExpiresAtMs"] is not None:
            bound = challenge_copy["ceiling"]["grantExpiresAtMs"]
            authorization["grantExpiresAtMs"] = min(
                bound, authorization["grantExpiresAtMs"] or bound
            )
        session_id = _id()
        hard = min(now + 300000, authorization["grantExpiresAtMs"] or now + 300000)
        presence = min(now + 3000, hard)
        result = {
            "sessionId": session_id,
            "gatewayGeneration": self.generation,
            "applicationId": payload["applicationId"],
            "launchId": payload["launchId"],
            "channelKeyThumbprint": public_key_thumbprint(payload["channelKey"]),
            "issuedAtMs": now,
            "expiresAtMs": hard,
            "presenceExpiresAtMs": presence,
            "heartbeatIntervalMs": 1000,
            "authorization": authorization,
        }
        signed = self.box_response_signer("session", result, now)
        context = {
            **authorization,
            "applicationId": payload["applicationId"],
            "launchId": payload["launchId"],
            "principalNamespace": principal_namespace(
                self.box_key_thumbprint, view["ownershipEpoch"], view["principalId"]
            ),
        }
        if view.get("team") is not None:
            context["team"] = _clone(view["team"])
        async with self._lock:
            current, tick = self._now()
            self._running()
            self._prune(current, tick)
            challenge = self._challenges.get(payload["challenge"])
            need(challenge == challenge_copy, "LOCAL_DATA_CONTEXT_CHANGED")
            if renewal:
                self._session_live(
                    self._sessions.get(challenge_copy["parentSessionId"]), current, tick
                )
                need(challenge == challenge_copy, "LOCAL_DATA_CONTEXT_CHANGED")
            need(
                challenge is not None
                and all(
                    challenge[key] == payload[key]
                    for key in ("bindingId", "applicationId", "launchId")
                ),
                "LOCAL_DATA_REPLAY",
            )
            need(
                current < payload["expiresAtMs"] and current < presence,
                "LOCAL_DATA_SESSION_EXPIRED",
            )
            need(
                len(self._sessions) < self.limits["sessions"]
                and sum(
                    s["context"]["bindingId"] == view["bindingId"] and not s["closed"]
                    for s in self._sessions.values()
                )
                < self.limits["sessions_per_binding"],
                "LOCAL_DATA_CAPACITY",
            )
            need(
                self._cache.get(view["bindingId"], {}).get("view") == view,
                "LOCAL_DATA_CONTEXT_CHANGED",
            )
            del self._challenges[payload["challenge"]]
            self._sessions[session_id] = {
                "sessionId": session_id,
                "context": context,
                "channelKey": payload["channelKey"],
                "closed": False,
                "expiresAtMs": hard,
                "presenceExpiresAtMs": presence,
                "hardDeadline": mono + (hard - now) / 1000,
                "presenceDeadline": mono + (presence - now) / 1000,
                "sequence": 0,
                "replay": {},
            }
            self.effects.session(self._sessions[session_id])
        return signed

    async def _channel(self, proof, kind):
        locator = decode_channel_locator(proof, kind=kind)
        need(locator["gatewayGeneration"] == self.generation, "LOCAL_DATA_CONTEXT_CHANGED")
        now, mono = self._now()
        async with self._lock:
            session = self._sessions.get(locator["sessionId"])
            self._session_live(session, now, mono)
            key, context = _clone(session["channelKey"]), _clone(session["context"])
        payload = verify_channel_proof(proof, key, kind=kind, now_ms=now)
        need(
            payload["boxId"] == self.box_id
            and all(payload[name] == context[name] for name in ("applicationId", "launchId")),
            "LOCAL_DATA_CONTEXT_CHANGED",
        )
        return payload

    async def heartbeat(self, proof):
        payload = await self._channel(proof, "heartbeat")
        context = await self._current(payload["sessionId"])
        now, mono = self._now()
        async with self._lock:
            session = self._sessions.get(payload["sessionId"])
            self._session_live(session, now, mono)
            self._prune(now, mono)
            need(
                now < payload["expiresAtMs"] and payload["sequence"] > session["sequence"],
                "LOCAL_DATA_REPLAY",
            )
            self._burn(session, payload["jti"], payload["expiresAtMs"], now)
            # A delayed heartbeat can never grant 3 seconds from its receipt.
            deadline = min(
                payload["expiresAtMs"], payload["issuedAtMs"] + 3000, session["expiresAtMs"]
            )
            need(now < deadline, "LOCAL_DATA_SESSION_EXPIRED")
            session["sequence"] = payload["sequence"]
            session["presenceExpiresAtMs"] = deadline
            session["presenceDeadline"] = mono + (deadline - now) / 1000
            result = {
                "sessionId": session["sessionId"],
                "sequence": payload["sequence"],
                "issuedAtMs": now,
                "presenceExpiresAtMs": deadline,
                "authorizationVersion": context["authorizationVersion"],
                "bindingRevision": context["bindingRevision"],
            }
        signed = self.box_response_signer("heartbeat", result, now)
        async with self._lock:
            now, mono = self._now()
            self._session_live(self._sessions.get(payload["sessionId"]), now, mono)
        return signed

    async def close_session(self, proof):
        # Closing is a safe termination: it requires the current channel key but
        # no positive authority query that could prevent revocation/lock cleanup.
        payload = await self._channel(proof, "close")
        now, mono = self._now()
        async with self._lock:
            session = self._sessions.get(payload["sessionId"])
            self._session_live(session, now, mono)
            self._burn(session, payload["jti"], payload["expiresAtMs"], now)
            events = self._close_session_locked(session, "cancelled")
        await self._notify(events)
        return self.box_response_signer(
            "closed", {"sessionId": payload["sessionId"], "closedAtMs": now}, now
        )

    @staticmethod
    def _observation(observation):
        fields(
            observation, {"transport", "method", "rawTarget", "headers", "bodySha256", "bodyBytes"}
        )
        need(
            observation["transport"] in ("http", "websocket")
            and observation["method"]
            in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")
        )
        validate_target(observation["rawTarget"])
        validate_headers(observation["headers"])
        digest32(observation["bodySha256"])
        integer(observation["bodyBytes"], zero=True)

    @staticmethod
    def _route(route, context, observation):
        fields(
            route,
            {"audience", "resourceId", "action", "serviceContext", "bodyLimit", "upstreamPath"},
        )
        need(
            route["audience"] in ("octop", "clipboard", "semantica", "semantica-mcp")
            and (
                route["resourceId"] in ("wanx", "space", "space:personal", "clipboard", "semantica")
                or context.get("team") is not None
                and team_resource(route["resourceId"])
            )
            and route["action"] in ("execute", "read", "write"),
            "LOCAL_DATA_ROUTE_DENIED",
        )
        integer(route["bodyLimit"], zero=True)
        validate_target(route["upstreamPath"])
        token(route["resourceId"])
        need(observation["bodyBytes"] <= route["bodyLimit"], "LOCAL_DATA_CAPACITY")
        need(
            _allows(context["grants"], route["resourceId"], route["action"]), "LOCAL_DATA_FORBIDDEN"
        )

    def _reserve_operation(self, session, context, route, observation, now, mono, parent=None):
        active = [op for op in self._operations.values() if self._reserved(op)]
        need(
            len(active) < self.limits["operations"]
            and sum(op["sessionId"] == session["sessionId"] for op in active)
            < self.limits["operations_per_session"],
            "LOCAL_DATA_CAPACITY",
        )
        if observation["bodyBytes"]:
            staged = [op for op in active if op["bodyBytes"]]
            need(
                len(staged) < self.limits["staging"]
                and sum(op["context"]["bindingId"] == context["bindingId"] for op in staged)
                < self.limits["staging_per_binding"]
                and 2 * (sum(op["bodyBytes"] for op in staged) + observation["bodyBytes"])
                <= self.limits["staging_bytes"],
                "LOCAL_DATA_CAPACITY",
            )
        op_id = _id()
        operation = {
            "operationId": op_id,
            "sessionId": session["sessionId"],
            "parentOperationId": parent,
            "context": _clone(context),
            "route": _clone(route),
            "observation": _clone(observation),
            "bodySha256": observation["bodySha256"],
            "bodyBytes": observation["bodyBytes"],
            "state": "staging",
            "stageDeadline": mono + 300,
            "nativeGeneration": None,
            "nativeState": None,
            "nativeClosed": False,
            "gatewayFinished": parent is not None,
            "gatewayTransportClosed": parent is not None,
            "constraints": {},
            "requiredGrants": None,
            "nativeNonces": {},
            "gatewayProof": None,
            "minting": False,
        }
        self._operations[op_id] = operation
        self.effects.operation(operation)
        return operation

    async def admit_request(self, proof, observation):
        observation = _clone(observation)
        self._observation(observation)
        payload = await self._channel(proof, "request")
        need(
            all(
                canonical(payload[name]) == canonical(value) for name, value in observation.items()
            ),
            "LOCAL_DATA_CONTEXT_CHANGED",
        )
        context = await self._current(payload["sessionId"])
        route = _clone(self.route_policy(_clone(context), observation))
        self._route(route, context, observation)
        now, mono = self._now()
        async with self._lock:
            session = self._sessions.get(payload["sessionId"])
            self._session_live(session, now, mono)
            self._prune(now, mono)
            need(now < payload["expiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")
            self._burn(session, payload["jti"], payload["expiresAtMs"], now)
            operation = self._reserve_operation(session, context, route, observation, now, mono)
            return self._snapshot(operation)

    async def assert_live(self, operation_id, *, minimum_cache_ms=0):
        digest32(operation_id)
        try:
            now, mono = self._now()
            async with self._lock:
                operation = self._operations.get(operation_id)
                self._op_live(operation, now, mono)
                session_id = operation["sessionId"]
            context = await self._current(session_id, minimum_cache_ms)
            now, mono = self._now()
            async with self._lock:
                operation = self._operations.get(operation_id)
                self._op_live(operation, now, mono)
                need(
                    _allows(
                        context["grants"],
                        operation["route"]["resourceId"],
                        operation["route"]["action"],
                    ),
                    "LOCAL_DATA_FORBIDDEN",
                )
                operation["context"] = context
                need(
                    all(
                        _allows(context["grants"], grant["resourceId"], action)
                        for grant in operation["requiredGrants"] or []
                        for action in grant["actions"]
                    ),
                    "LOCAL_DATA_FORBIDDEN",
                )
                return self._snapshot(operation)
        except Exception:
            await self._deny_operation(operation_id)
            raise

    async def activate_request(self, operation_id, body_sha256, body_bytes):
        digest32(body_sha256)
        integer(body_bytes, zero=True)
        await self.assert_live(operation_id)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(operation_id)
            self._op_live(operation, now, mono)
            need(operation["state"] == "staging", "LOCAL_DATA_REPLAY")
            matches = (
                operation["bodySha256"] == body_sha256 and operation["bodyBytes"] == body_bytes
            )
            if matches:
                operation["state"] = "active"
                return self._snapshot(operation)
            events = self._close_op_locked(operation, "denied")
        await self._notify(events)
        raise DataProtocolError("LOCAL_DATA_BODY_MISMATCH")

    async def bind_clipboard_export(self, operation_id, *, export_id, parent):
        """Gateway-only binding from its verified staged parent export body."""
        value = {"application": "wanx.clipboard", "exportId": export_id, "parent": parent}
        validate_clipboard_scope(value)
        need(export_id is not None, "LOCAL_DATA_FORBIDDEN")
        await self.assert_live(operation_id)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(operation_id)
            self._op_live(operation, now, mono)
            route = operation["route"]
            need(
                operation["state"] == "staging"
                and not operation["constraints"]
                and route["audience"] == "clipboard"
                and route["action"] == "write"
                and re.fullmatch(r"/api/clipboard/v1/[0-9a-f]{32}/export", route["upstreamPath"])
                is not None,
                "LOCAL_DATA_FORBIDDEN",
            )
            operation["constraints"] = {"clipboardScope": value}

    async def bind_mcp_operation(self, operation_id, operation_name):
        need(
            operation_name
            in (
                "mcp_initialize",
                "mcp_initialized",
                "mcp_ping",
                "mcp_tools_list",
                "search_knowledge",
                "search_workspaces",
                "get_evidence",
                "retrieval_status",
            ),
            "LOCAL_DATA_ROUTE_DENIED",
        )
        await self.assert_live(operation_id)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(operation_id)
            self._op_live(operation, now, mono)
            need(
                operation["state"] == "staging"
                and operation["route"]["audience"] == "semantica-mcp"
                and operation["route"]["serviceContext"]["operation"] == "mcp_pending",
                "LOCAL_DATA_FORBIDDEN",
            )
            operation["route"]["serviceContext"]["operation"] = operation_name

    async def gateway_request(self, operation_id, hop_observation):
        hop_observation = _clone(hop_observation)
        self._observation(hop_observation)
        snapshot = await self.assert_live(operation_id)
        now, mono = self._now()
        route, context = snapshot["route"], snapshot["context"]
        need(
            hop_observation["rawTarget"] == route["upstreamPath"]
            and hop_observation["bodyBytes"] <= route["bodyLimit"],
            "LOCAL_DATA_CONTEXT_CHANGED",
        )
        async with self._lock:
            operation = self._operations.get(operation_id)
            self._op_live(operation, now, mono)
            need(
                operation["state"] == "active"
                and operation["gatewayProof"] is None
                and not operation["minting"],
                "LOCAL_DATA_REPLAY",
            )
            # A gateway adapter may rewrite a fixed target; it may not turn a
            # small staged request into an unreserved larger native upload.
            need(hop_observation["bodyBytes"] <= operation["bodyBytes"], "LOCAL_DATA_CAPACITY")
            operation["minting"] = True
        payload = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.gateway-request",
            "audience": route["audience"],
            "gatewayId": self.gateway_id,
            "gatewayGeneration": self.generation,
            "sessionId": snapshot["sessionId"],
            "operationId": operation_id,
            "parentOperationId": snapshot["parentOperationId"],
            "jti": _id(),
            "issuedAtMs": now,
            "expiresAtMs": now + 2000,
            **hop_observation,
            **{
                key: context[key]
                for key in (
                    "boxId",
                    "boxKeyThumbprint",
                    "ownershipEpoch",
                    "principalId",
                    "bindingId",
                    "clientId",
                    "authorizationVersion",
                    "principalSecurityVersion",
                    "bindingRevision",
                    "applicationId",
                    "launchId",
                )
            },
            "resourceId": route["resourceId"],
            "action": route["action"],
            "serviceContext": route["serviceContext"],
        }
        if context.get("team") is not None:
            payload.update(schemaVersion=2, team=_clone(context["team"]))
        try:
            validate_gateway_request(payload)
            signed = self.gateway_signer(payload)
            proof_digest = gateway_proof_digest(signed)
            now, mono = self._now()
            async with self._lock:
                operation = self._operations.get(operation_id)
                self._op_live(operation, now, mono)
                operation.update(
                    gatewayProof=signed,
                    gatewayPayload=payload,
                    proofDigest=proof_digest,
                    proofExpiresAtMs=payload["expiresAtMs"],
                    minting=False,
                )
            return signed
        except BaseException:
            await self._deny_operation(operation_id)
            raise

    async def finish_operation(self, operation_id, outcome="completed", *, transport_closed=False):
        """Gateway owner calls only after its transport and staged file are closed."""
        digest32(operation_id)
        need(outcome in ("completed", "cancelled", "denied", "outcome-unknown"))
        need(type(transport_closed) is bool)
        async with self._lock:
            operation = self._operations.get(operation_id)
            if operation is not None:
                operation["gatewayFinished"] = True
                operation["gatewayTransportClosed"] |= transport_closed
                self.effects.operation(operation)
            events = self._close_op_locked(operation, outcome) if operation else []
        await self._notify(events)

    async def _deny_operation(self, operation_id):
        async with self._lock:
            operation = self._operations.get(operation_id)
            events = self._close_op_locked(operation, "denied") if operation else []
        await self._notify(events)

    def _native_nonce(self, operation, nonce, now):
        digest32(nonce)
        operation["nativeNonces"] = {
            key: end for key, end in operation["nativeNonces"].items() if end > now
        }
        need(nonce not in operation["nativeNonces"], "LOCAL_DATA_REPLAY")
        need(len(operation["nativeNonces"]) < 128, "LOCAL_DATA_CAPACITY")
        operation["nativeNonces"][nonce] = now + 2000

    def _native_match(self, operation, body, audience, now, mono):
        self._op_live(operation, now, mono)
        need(
            operation["route"]["audience"] == audience
            and operation["nativeGeneration"] == body["nativeGateGeneration"],
            "LOCAL_DATA_FORBIDDEN",
        )
        self._native_nonce(operation, body["gateNonce"], now)

    def _lease_payload(self, operation, body, state, now, mono):
        context, route = operation["context"], operation["route"]
        session = self._sessions.get(operation["sessionId"])
        cache = self._cache.get(context["bindingId"])
        end = now + 1000
        if state != "closed":
            need(cache is not None and mono < cache["deadline"], "LOCAL_DATA_CONTEXT_CHANGED")
            end = min(
                end,
                session["presenceExpiresAtMs"],
                session["expiresAtMs"],
                now + max(0, int((cache["deadline"] - mono) * 1000)),
            )
            need(now < end, "LOCAL_DATA_SESSION_EXPIRED")
        result = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.gateway-lease",
            "audience": route["audience"],
            "gatewayId": self.gateway_id,
            "gatewayGeneration": self.generation,
            "nativeGateGeneration": body["nativeGateGeneration"],
            "gateNonce": body["gateNonce"],
            "sessionId": operation["sessionId"],
            "operationId": operation["operationId"],
            "parentOperationId": operation["parentOperationId"],
            "gatewayProofDigest": operation["proofDigest"],
            "state": state,
            **{
                key: context[key]
                for key in (
                    "ownershipEpoch",
                    "authorizationVersion",
                    "principalSecurityVersion",
                    "bindingId",
                    "bindingRevision",
                    "principalId",
                    "clientId",
                    "applicationId",
                    "launchId",
                )
            },
            "resourceId": route["resourceId"],
            "action": route["action"],
            "issuedAtMs": now,
            "expiresAtMs": end,
        }
        if context.get("team") is not None:
            result.update(schemaVersion=2, teamDigest=digest(context["team"]))
        return result

    async def _sign_lease(self, payload):
        signed = self.gateway_lease_signer(payload)
        if payload["state"] != "closed":
            now, mono = self._now()
            async with self._lock:
                self._op_live(self._operations.get(payload["operationId"]), now, mono)
                need(now < payload["expiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")
        return signed

    async def native_admit(self, body, *, audience):
        fields(body, {"gatewayProof", "nativeGateGeneration", "gateNonce"})
        digest32(body["nativeGateGeneration"])
        digest32(body["gateNonce"])
        now, _ = self._now()
        payload = self.gateway_verifier(body["gatewayProof"], now)
        need(
            payload["gatewayGeneration"] == self.generation and payload["audience"] == audience,
            "LOCAL_DATA_CONTEXT_CHANGED",
        )
        await self.assert_live(payload["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(payload["operationId"])
            self._op_live(operation, now, mono)
            need(
                operation["gatewayProof"] == body["gatewayProof"]
                and now < payload["expiresAtMs"]
                and operation["nativeGeneration"] is None,
                "LOCAL_DATA_REPLAY",
            )
            self._native_nonce(operation, body["gateNonce"], now)
            operation["nativeGeneration"] = body["nativeGateGeneration"]
            operation["nativeState"] = "staging"
            self.effects.operation(operation)
            lease = self._lease_payload(operation, body, "staging", now, mono)
        return await self._sign_lease(lease)

    async def native_activate(self, body, *, audience):
        fields(
            body, {"operationId", "nativeGateGeneration", "gateNonce", "bodySha256", "bodyBytes"}
        )
        digest32(body["nativeGateGeneration"])
        digest32(body["bodySha256"])
        integer(body["bodyBytes"], zero=True)
        await self.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            self._native_match(operation, body, audience, now, mono)
            need(operation["nativeState"] == "staging", "LOCAL_DATA_REPLAY")
            hop = operation["gatewayPayload"]
            matches = (
                hop["bodySha256"] == body["bodySha256"] and hop["bodyBytes"] == body["bodyBytes"]
            )
            if matches:
                operation["nativeState"] = "active"
                lease = self._lease_payload(operation, body, "active", now, mono)
                events = []
            else:
                events = self._close_op_locked(operation, "denied")
        await self._notify(events)
        need(matches, "LOCAL_DATA_BODY_MISMATCH")
        return await self._sign_lease(lease)

    async def native_check(self, body, *, audience):
        fields(body, {"operationId", "nativeGateGeneration", "gateNonce"})
        digest32(body["nativeGateGeneration"])
        await self.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            self._native_match(operation, body, audience, now, mono)
            lease = self._lease_payload(operation, body, operation["nativeState"], now, mono)
        return await self._sign_lease(lease)

    async def native_closed(self, body, *, audience):
        fields(body, {"operationId", "nativeGateGeneration", "gateNonce", "outcome"})
        digest32(body["operationId"])
        digest32(body["nativeGateGeneration"])
        need(body["outcome"] in ("completed", "cancelled", "denied", "outcome-unknown"))
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            need(
                operation is not None
                and operation["nativeGeneration"] == body["nativeGateGeneration"]
                and operation["route"]["audience"] == audience,
                "LOCAL_DATA_FORBIDDEN",
            )
            self._native_nonce(operation, body["gateNonce"], now)
            # Native completion may precede the gateway forwarding its final
            # buffered response bytes. Preserve current authorization for that
            # drain; only the gateway's finish (or denial) ends a direct op.
            operation["nativeState"] = "closed"
            operation["nativeClosed"] = True
            self.effects.operation(operation)
            events = (
                self._close_op_locked(operation, body["outcome"])
                if body["outcome"] != "completed" or operation["parentOperationId"] is not None
                else []
            )
            lease = self._lease_payload(operation, body, "closed", now, mono)
        await self._notify(events)
        return await self._sign_lease(lease)

    async def native_authorize_resources(self, body, *, audience):
        fields(body, {"operationId", "nativeGateGeneration", "gateNonce", "grants"})
        digest32(body["nativeGateGeneration"])
        grants(body["grants"])
        request_digest = digest(body)
        need(
            self.gateway_resources_signer is not None and audience == "octop",
            "LOCAL_DATA_FORBIDDEN",
        )
        await self.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            self._native_match(operation, body, audience, now, mono)
            need(
                operation["parentOperationId"] is None
                and operation["nativeState"] == "active"
                and "task" not in operation["constraints"]
                and (
                    operation["context"]["applicationId"] == "wanx-host"
                    and operation["observation"]["method"] == "POST"
                    and operation["route"]["upstreamPath"]
                    in (
                        "/api/platform/applications/readiness",
                        "/api/platform/applications/prepare",
                        "/api/platform/applications/candidates/prepare",
                    )
                    or operation["context"]["applicationId"] in {"wanx-host", "ai.wanx.studio"}
                    and operation["route"]["resourceId"] == "team:management"
                    and "applications.manage"
                    in operation["context"].get("team", {}).get("permissions", [])
                    and resource_binding_route(
                        operation["observation"]["method"], operation["route"]["upstreamPath"]
                    )
                    and resource_needs(body["grants"])
                    or operation["context"]["applicationId"].startswith("ai.wanx.selfmade.")
                    and operation["route"]["resourceId"]
                    == "team:application:" + operation["context"]["applicationId"]
                    and operation["observation"]["method"] == "POST"
                    and re.fullmatch(
                        r"/api/app-studio/runtime/[A-Za-z0-9_-]{1,128}/(?:invoke|files)",
                        operation["route"]["upstreamPath"],
                    )
                    and resource_needs(body["grants"])
                ),
                "LOCAL_DATA_FORBIDDEN",
            )
            need(
                all(
                    _allows(operation["context"]["grants"], grant["resourceId"], action)
                    for grant in body["grants"]
                    for action in grant["actions"]
                ),
                "LOCAL_DATA_FORBIDDEN",
            )
            if operation["route"]["upstreamPath"].startswith("/api/app-studio/") and any(
                grant["resourceId"] == "wanx" and "write" in grant["actions"]
                for grant in body["grants"]
            ):
                need(
                    resource_write_route(
                        operation["observation"]["method"], operation["route"]["upstreamPath"]
                    ),
                    "LOCAL_DATA_SCOPE_DENIED",
                )
            aggregate = merge_grants(operation["requiredGrants"] or [], body["grants"])
            grants(aggregate)
            if operation["route"]["upstreamPath"].startswith("/api/platform/applications/"):
                need(
                    operation["requiredGrants"] is None
                    or operation["requiredGrants"] == body["grants"],
                    "LOCAL_DATA_CONTEXT_CHANGED",
                )
            operation["requiredGrants"] = _clone(aggregate)
            payload = {
                **self._lease_payload(operation, body, "active", now, mono),
                "purpose": "centuarai.local-data.gateway-resources",
                "requestDigest": request_digest,
                "grants": _clone(aggregate),
            }
        signed = self.gateway_resources_signer(payload)
        now, mono = self._now()
        async with self._lock:
            self._op_live(self._operations.get(body["operationId"]), now, mono)
            need(now < payload["expiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")
        return signed

    async def native_task_start(self, body, *, audience):
        fields(
            body,
            {
                "operationId",
                "nativeGateGeneration",
                "gateNonce",
                "projectId",
                "taskId",
                "taskPurpose",
            },
        )
        for name in ("projectId", "taskId"):
            need(type(body[name]) is str and re.fullmatch(r"[a-f0-9]{32}", body[name]) is not None)
        need(audience == "octop" and self.gateway_task_signer is not None, "LOCAL_DATA_FORBIDDEN")
        await self.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            parent = self._operations.get(body["operationId"])
            self._native_match(parent, body, audience, now, mono)
            context = parent["context"]
            need(
                parent["nativeState"] == "active"
                and parent["parentOperationId"] is None
                and "task" not in parent["constraints"]
                and context["applicationId"] == "ai.wanx.studio"
                and parent["route"]["resourceId"] == "team:management"
                and parent["route"]["action"] == "execute"
                and "applications.manage" in context.get("team", {}).get("permissions", []),
                "LOCAL_DATA_FORBIDDEN",
            )
            prefix = "/api/app-studio/"
            project = body["projectId"]
            paths = {
                "build": {
                    prefix + "projects/" + project + "/build",
                    prefix + "_builder/projects/" + project + "/build",
                    prefix + "_client/launch/" + project + "/start",
                },
                "interview": {prefix + "projects/" + project + "/interview/turns"},
                "edit": {prefix + "_builder/projects/" + project + "/edits"},
            }
            if body["taskPurpose"] == "edit" and re.fullmatch(
                prefix + "_builder/projects/" + project + r"/edits/[a-f0-9]{32}/(?:answer|retry)",
                parent["route"]["upstreamPath"],
            ):
                paths["edit"].add(parent["route"]["upstreamPath"])
            need(
                parent["observation"]["method"] == "POST"
                and parent["route"]["upstreamPath"] in paths.get(body["taskPurpose"], set()),
                "LOCAL_DATA_SCOPE_DENIED",
            )
            tasks = [
                op
                for op in self._operations.values()
                if "task" in op["constraints"] and self._reserved(op)
            ]
            need(
                len(tasks) < 32 and sum(op["sessionId"] == parent["sessionId"] for op in tasks) < 4,
                "LOCAL_DATA_CAPACITY",
            )
            need(
                not any(op["constraints"]["task"]["taskId"] == body["taskId"] for op in tasks),
                "LOCAL_DATA_REPLAY",
            )
            observation = {
                **parent["observation"],
                "bodyBytes": 0,
                "bodySha256": encode(hashlib.sha256(b"").digest()),
            }
            operation = self._reserve_operation(
                self._sessions[parent["sessionId"]],
                context,
                parent["route"],
                observation,
                now,
                mono,
            )
            operation.update(
                state="active",
                nativeState="active",
                nativeGeneration=body["nativeGateGeneration"],
                gatewayFinished=True,
                gatewayTransportClosed=True,
                proofDigest=parent["proofDigest"],
                gatewayProof=parent["gatewayProof"],
            )
            operation["constraints"]["task"] = {
                "parentRequestId": parent["operationId"],
                **{key: body[key] for key in ("projectId", "taskId", "taskPurpose")},
            }
            operation["requiredGrants"] = _clone(parent["requiredGrants"])
            self.effects.operation(operation)
            payload = self._task_payload(operation, body, "active", now, mono)
        return await self._sign_task(payload)

    def _task_payload(self, operation, body, state, now, mono):
        return {
            **self._lease_payload(operation, body, state, now, mono),
            "purpose": "centuarai.local-data.gateway-task",
            **operation["constraints"]["task"],
            "grants": _clone(operation["requiredGrants"] or []),
        }

    async def _sign_task(self, payload):
        signed = self.gateway_task_signer(payload)
        if payload["state"] != "closed":
            now, mono = self._now()
            async with self._lock:
                self._op_live(self._operations.get(payload["operationId"]), now, mono)
                need(now < payload["expiresAtMs"], "LOCAL_DATA_SESSION_EXPIRED")
        return signed

    async def native_task_check(self, body, *, audience):
        fields(body, {"operationId", "nativeGateGeneration", "gateNonce"})
        await self.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            self._native_match(operation, body, audience, now, mono)
            need(audience == "octop" and "task" in operation["constraints"], "LOCAL_DATA_FORBIDDEN")
            payload = self._task_payload(operation, body, "active", now, mono)
        return await self._sign_task(payload)

    async def native_task_close(self, body, *, audience):
        fields(body, {"operationId", "nativeGateGeneration", "gateNonce", "outcome"})
        need(body["outcome"] in {"completed", "cancelled", "denied", "outcome-unknown"})
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            need(
                audience == "octop"
                and operation is not None
                and "task" in operation["constraints"]
                and operation["nativeGeneration"] == body["nativeGateGeneration"],
                "LOCAL_DATA_FORBIDDEN",
            )
            self._native_nonce(operation, body["gateNonce"], now)
            # Only the native worker reports this after process and I/O drain.
            # Logical invalidation and missed checks never mark physical closure.
            operation.update(nativeState="closed", nativeClosed=True)
            events = self._close_op_locked(operation, body["outcome"])
            self.effects.operation(operation)
            payload = self._task_payload(operation, body, "closed", now, mono)
        await self._notify(events)
        return await self._sign_task(payload)

    async def native_resource_grants(self, body, *, audience):
        fields(body, {"operationId", "nativeGateGeneration", "gateNonce"})
        need(audience == "octop" and self.gateway_grants_signer is not None, "LOCAL_DATA_FORBIDDEN")
        await self.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            self._native_match(operation, body, audience, now, mono)
            context = operation["context"]
            need(
                operation["nativeState"] == "active"
                and "task" not in operation["constraints"]
                and operation["route"]["resourceId"] == "team:management"
                and "applications.manage" in context.get("team", {}).get("permissions", []),
                "LOCAL_DATA_FORBIDDEN",
            )
            payload = {
                **self._lease_payload(operation, body, "active", now, mono),
                "purpose": "centuarai.local-data.gateway-grants",
                "grants": _clone(context["grants"]),
                "requestDigest": digest(body),
            }
        signed = self.gateway_grants_signer(payload)
        await self.assert_live(body["operationId"])
        return signed

    async def native_team_members(self, body, *, audience):
        """Read current members for an admitted management request, never all users."""
        fields(body, {"operationId", "nativeGateGeneration", "gateNonce"})
        digest32(body["nativeGateGeneration"])
        need(
            audience == "octop" and self.gateway_members_signer is not None, "LOCAL_DATA_FORBIDDEN"
        )
        snapshot = await self.assert_live(body["operationId"])
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            self._native_match(operation, body, audience, now, mono)
            team = operation["context"].get("team")
            need(
                operation["nativeState"] == "active"
                and "task" not in operation["constraints"]
                and operation["route"]["resourceId"] == "team:management"
                and team is not None
                and bool(set(team["permissions"]) & {"members.read", "applications.manage"}),
                "LOCAL_DATA_FORBIDDEN",
            )
            binding = operation["context"]["bindingId"]

        def query():
            return self.authority.get_team_members(binding, self.wall_clock_ms() // 1000)

        members = _clone(await self.execute_authority(query))
        validate_members(members)
        await self.assert_live(body["operationId"], minimum_cache_ms=750)
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["operationId"])
            self._op_live(operation, now, mono)
            need(
                operation["nativeGeneration"] == body["nativeGateGeneration"]
                and operation["context"].get("team") == snapshot["context"].get("team"),
                "LOCAL_DATA_CONTEXT_CHANGED",
            )
            payload = {
                **self._lease_payload(operation, body, "active", now, mono),
                "purpose": "centuarai.local-data.gateway-members",
                "requestDigest": digest(body),
                "members": members,
            }
        signed = self.gateway_members_signer(payload)
        await self.assert_live(body["operationId"])
        return signed

    async def native_observe(self, body, *, audience):
        fields(body, {"nativeGateGeneration", "gateNonce", "activeOperationIds"})
        digest32(body["nativeGateGeneration"])
        digest32(body["gateNonce"])
        values = body["activeOperationIds"]
        need(type(values) is list and len(values) <= 128)
        for value in values:
            digest32(value)
        need(values == sorted(set(values)))
        need(
            audience in self.effects.audiences and self.gateway_observation_signer is not None,
            "LOCAL_DATA_FORBIDDEN",
        )
        request_digest = digest(body)
        now, mono = self._now()
        async with self._lock:
            self._running()
            nonces = {
                key: end
                for key, end in self._inventory_nonces.get(audience, {}).items()
                if end > now
            }
            need(body["gateNonce"] not in nonces, "LOCAL_DATA_REPLAY")
            need(len(nonces) < 128, "LOCAL_DATA_CAPACITY")
            nonces[body["gateNonce"]] = now + 2000
            self._inventory_nonces[audience] = nonces
            current = [
                op
                for op in self._operations.values()
                if op["route"]["audience"] == audience
                and op["nativeGeneration"] is not None
                and not op["nativeClosed"]
            ]
            accepted = (
                all(op["nativeGeneration"] == body["nativeGateGeneration"] for op in current)
                and sorted(op["operationId"] for op in current) == values
            )
            self.effects.observed(audience, body["nativeGateGeneration"], values, accepted)
        payload = {
            "schemaVersion": 1,
            "purpose": "centuarai.local-data.gateway-observation",
            "audience": audience,
            "gatewayId": self.gateway_id,
            "gatewayGeneration": self.generation,
            "nativeGateGeneration": body["nativeGateGeneration"],
            "gateNonce": body["gateNonce"],
            "requestDigest": request_digest,
            "accepted": accepted,
            "issuedAtMs": now,
            "expiresAtMs": now + 1000,
        }
        return self.gateway_observation_signer(payload)

    async def observe_commit(self, commit):
        fields(
            commit,
            {
                "operationId",
                "targetScope",
                "authorizationVersion",
                "committedAtMs",
                "deadlineMs",
                "affectedBindingIds",
            }
            | ({"affectedJobs"} if "affectedJobs" in commit else set())
            | ({"affectedJobsComplete"} if "affectedJobsComplete" in commit else set()),
        )
        need(type(commit.get("affectedJobsComplete", True)) is bool)
        jobs = commit.get("affectedJobs", [])
        need(type(jobs) is list and len(jobs) <= 128)
        for job in jobs:
            validate_worker_job(job)
        order = [(job["operationId"], job["attempt"]) for job in jobs]
        need(order == sorted(set(order)))
        digest32(commit["operationId"])
        fields(commit["targetScope"], {"kind", "id"})
        need(commit["targetScope"]["kind"] in ("session", "binding", "principal", "ownership"))
        token(commit["targetScope"]["id"])
        for name in ("authorizationVersion", "committedAtMs", "deadlineMs"):
            integer(commit[name])
        need(commit["deadlineMs"] == commit["committedAtMs"] + 5000)
        values = commit["affectedBindingIds"]
        need(type(values) is list and len(values) <= 4096)
        for value in values:
            token(value)
        need(values == sorted(set(values)))
        async with self._lock:
            self._running()
            self.effects.committed(_clone(commit))

    def effect_snapshot(self, request_id, expected):
        return self.effects.snapshot(request_id, expected)

    async def observe_worker(self, body):
        fields(body, {"workerBootId", "sequence", "ready", "jobs"})
        digest32(body["workerBootId"])
        integer(body["sequence"])
        need(
            type(body["ready"]) is bool and type(body["jobs"]) is list and len(body["jobs"]) <= 128
        )
        for value in body["jobs"]:
            validate_worker_job(value, evidence=True)
        order = [(job["operationId"], job["attempt"]) for job in body["jobs"]]
        need(order == sorted(set(order)))
        async with self._lock:
            self._running()
            self.effects.worker_observed(_clone(body))

    async def child_hop(self, body, *, audience):
        fields(
            body,
            {
                "parentOperationId",
                "nativeGateGeneration",
                "gateNonce",
                "audience",
                "transport",
                "method",
                "rawTarget",
                "headers",
                "bodySha256",
                "bodyBytes",
            },
        )
        digest32(body["nativeGateGeneration"])
        digest32(body["gateNonce"])
        observation = {
            key: body[key]
            for key in ("transport", "method", "rawTarget", "headers", "bodySha256", "bodyBytes")
        }
        self._observation(observation)
        need(
            self.child_policy is not None
            and (audience, body["audience"])
            in {("clipboard", "octop"), ("semantica-mcp", "semantica"), ("octop", "semantica")},
            "LOCAL_DATA_ROUTE_DENIED",
        )
        parent = await self.assert_live(body["parentOperationId"])
        need(parent["parentOperationId"] is None, "LOCAL_DATA_FORBIDDEN")
        route = _clone(self.child_policy(_clone(parent), _clone(body)))
        self._route(route, parent["context"], observation)
        # Fixed child policy additionally binds the exact parent route. A write
        # or execute operation may need an already-granted read callback; read
        # never becomes write/execute and write never becomes execute.
        child_actions = [parent["route"]["action"]]
        if parent["route"]["action"] in ("write", "execute"):
            child_actions.append("read")
        need(
            route["audience"] == body["audience"]
            and (
                _allows(
                    [{"resourceId": parent["route"]["resourceId"], "actions": child_actions}],
                    route["resourceId"],
                    route["action"],
                )
                or audience == "octop"
                and body["audience"] == "semantica"
                and route["action"] == "read"
                and _allows(parent["requiredGrants"] or [], route["resourceId"], "read")
            ),
            "LOCAL_DATA_FORBIDDEN",
        )
        now, mono = self._now()
        async with self._lock:
            operation = self._operations.get(body["parentOperationId"])
            self._native_match(operation, body, audience, now, mono)
            need(operation["nativeState"] == "active", "LOCAL_DATA_FORBIDDEN")
            session = self._sessions[operation["sessionId"]]
            child = self._reserve_operation(
                session,
                operation["context"],
                route,
                observation,
                now,
                mono,
                parent=operation["operationId"],
            )
            # The child service has hashed its own bounded request. Its receiving
            # native gate independently stages it before running any handler.
            child["state"] = "active"
            child_id = child["operationId"]
        return await self.gateway_request(child_id, observation)

    async def invalidate_authority(self, binding_ids=None, principal_ids=None):
        bindings = None if binding_ids is None else set(binding_ids)
        principals = None if principal_ids is None else set(principal_ids)
        async with self._lock:
            self._revision += 1
            self._cache.clear()
            events = []
            for session in self._sessions.values():
                if (
                    bindings is None
                    and principals is None
                    or bindings is not None
                    and session["context"]["bindingId"] in bindings
                    or principals is not None
                    and session["context"]["principalId"] in principals
                ):
                    events.extend(self._close_session_locked(session, "denied"))
        await self._notify(events)

    async def sweep(self):
        """Runtime calls every <=250 ms even if no request/heartbeat arrives."""
        events = []
        try:
            now, mono = self._now()
        except DataProtocolError:
            # A clock rollback closes all live channels; no clock is repaired by
            # renewing an old session. Restart establishes a fresh generation.
            async with self._lock:
                for session in self._sessions.values():
                    events.extend(self._close_session_locked(session, "denied"))
            await self._notify(events)
            return
        async with self._lock:
            for session in self._sessions.values():
                try:
                    self._session_live(session, now, mono)
                except DataProtocolError:
                    events.extend(self._close_session_locked(session, "cancelled"))
            for operation in self._operations.values():
                if (
                    operation["state"] != "closed"
                    and (operation["state"] == "staging" or operation["nativeState"] == "staging")
                    and mono >= operation["stageDeadline"]
                ):
                    events.extend(self._close_op_locked(operation, "cancelled"))
            self._prune(now, mono)
            live = [
                op["operationId"] for op in self._operations.values() if op["state"] != "closed"
            ]
        await self._notify(events)
        # Queries for the same binding coalesce; the injected executor separately
        # caps physical DB work. Each check also fences the session on completion.
        await asyncio.gather(*(self._sweep_operation(op_id) for op_id in live))

    async def _sweep_operation(self, operation_id):
        try:
            await self.assert_live(operation_id)
        except DataProtocolError:
            pass

    async def close(self):
        async with self._lock:
            self._closed = True
            self._revision += 1
            self._cache.clear()
            self._challenges.clear()
            events = []
            for session in self._sessions.values():
                events.extend(self._close_session_locked(session, "cancelled"))
        await self._notify(events)

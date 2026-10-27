"""Local ledger authorization for one offline BLE Wi-Fi change.

The consume transaction is the authorization linearization point. It never
executes OS commands; even a lost reply cannot issue execution a second time.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from contextvars import ContextVar
from time import monotonic

from . import local_ledger_engine as ledger
from . import local_trust_protocol as evidence
from . import local_wifi_protocol as protocol

TTL = 120
RETENTION = 86400
MAX_RETAINED = 4096
_invocation = ContextVar("local_wifi_invocation", default=None)


class _Invocation:
    def __init__(self, cancelled, deadline, clock):
        self.cancelled, self.deadline, self.clock = cancelled, deadline, clock
        self.expires_at = None
        self.highwater = 0

    def check(self):
        protocol.need(
            not self.cancelled.is_set() and monotonic() < self.deadline, "LOCAL_WIFI_UNAVAILABLE"
        )
        now = int(self.clock())
        self.highwater = max(self.highwater, now)
        return now

    def limit(self, deadline):
        self.expires_at = ledger.minimum(self.expires_at, deadline)


class LocalWifiAuthority:
    def __init__(self, authority):
        self.owner = authority
        self.db = authority._db
        # The existing authority owns boot identity, SQLite locking and clock
        # high water. Do not create a second authorization store or boot.
        with authority._lock:
            with authority._transaction(authority._meta()["lastSeenNow"]):
                self.db.execute("""CREATE TABLE IF NOT EXISTS wifi_challenges (
                    digest TEXT PRIMARY KEY, intent_digest TEXT UNIQUE NOT NULL,
                    nonce_key TEXT UNIQUE NOT NULL, binding_id TEXT NOT NULL,
                    boot_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
                    proof TEXT NOT NULL, session_digest TEXT)""")
                self.db.execute("""CREATE TABLE IF NOT EXISTS wifi_sessions (
                    digest TEXT PRIMARY KEY, binding_id TEXT NOT NULL,
                    boot_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
                    proof TEXT NOT NULL)""")
                self.db.execute("""CREATE TABLE IF NOT EXISTS wifi_operations (
                    session_digest TEXT PRIMARY KEY, boot_id TEXT NOT NULL,
                    apply_digest TEXT NOT NULL, observed TEXT NOT NULL,
                    state TEXT NOT NULL, created_at INTEGER NOT NULL,
                    execution_proof TEXT NOT NULL, result_proof TEXT)""")
                # Power loss has an uncertain physical outcome. Never replay it.
                self.db.execute(
                    "UPDATE wifi_operations SET state='interrupted' WHERE boot_id!=? AND state='consumed'",
                    (authority._boot_id,),
                )

    def dispatch(self, name, body, cancelled, deadline, clock):
        """Run a root IPC call with time sampled inside serialized authority work.

        The executor retains cancelled jobs until their physical threads finish.
        A request fence makes those jobs harmless after timeout/disconnection;
        the same fence is checked immediately before transaction commit.
        """
        protocol.need(name in {"challenge", "session", "check", "consume", "result"})
        guard = _Invocation(cancelled, deadline, clock)
        with self.owner._lock:
            token = _invocation.set(guard)
            try:
                return getattr(self, name)(body, guard.check())
            finally:
                _invocation.reset(token)

    @contextmanager
    def _transaction(self, now):
        guard = _invocation.get()
        try:
            with self.owner._transaction(
                now, observed_now=(lambda: guard.highwater) if guard else None
            ) as meta:
                if guard is not None:
                    # BEGIN IMMEDIATE may itself wait for another SQLite writer.
                    # Refresh after admission and after that wait, never widen
                    # the existing persistent clock-rollback boundary.
                    now = guard.check()
                    protocol.need(now >= meta["lastSeenNow"], "LOCAL_WIFI_UNAVAILABLE")
                    meta["lastSeenNow"] = now
                    self.owner._save_meta(meta)
                protocol.need(self.owner._ledger is not None, "LOCAL_WIFI_UNAVAILABLE")
                self.db.execute(
                    "DELETE FROM wifi_challenges WHERE expires_at<=?", (now - RETENTION,)
                )
                self.db.execute("DELETE FROM wifi_sessions WHERE expires_at<=?", (now - RETENTION,))
                self.db.execute(
                    "UPDATE wifi_operations SET state='interrupted' WHERE created_at<=? AND state='consumed'",
                    (now - RETENTION,),
                )
                self.db.execute(
                    "DELETE FROM wifi_operations WHERE created_at<=? AND state!='consumed'",
                    (now - RETENTION,),
                )
                yield meta, now
                if guard is not None:
                    final_now = guard.check()
                    protocol.need(final_now >= meta["lastSeenNow"], "LOCAL_WIFI_UNAVAILABLE")
                    protocol.need(
                        guard.expires_at is None or final_now < guard.expires_at,
                        "LOCAL_WIFI_EXPIRED",
                    )
                    meta["lastSeenNow"] = final_now
                    self.owner._save_meta(meta)
                    guard.check()
        except protocol.LocalWifiError:
            raise
        except evidence.BindingProtocolError:
            raise protocol.LocalWifiError("LOCAL_WIFI_UNAVAILABLE") from None

    def _eligible(self, meta, binding_id, now):
        snapshot = self.owner._ledger.snapshot(meta)
        row = ledger.binding(snapshot, binding_id)
        protocol.need(
            ledger.binding_valid(snapshot, row, now)
            and row["role"] == "manage"
            and row["approvalKey"] is not None
            and row["approvalKey"] != row["accessKey"],
            "LOCAL_WIFI_FORBIDDEN",
        )
        grants = [
            item
            for item in ledger.effective_grants(snapshot, row, now)
            if item["resourceId"] == protocol.RESOURCE
            and item["resourceScope"] == "shared"
            and "write" in item["actions"]
        ]
        protocol.need(bool(grants), "LOCAL_WIFI_FORBIDDEN")
        member = ledger.principal(snapshot, row["principalId"])
        context = {
            "boxId": meta["boxId"],
            "boxKeyThumbprint": meta["boxKeyThumbprint"],
            "ownershipEpoch": meta["ownershipEpoch"],
            "authorityBootId": self.owner._boot_id,
            "authorizationVersion": meta["authorizationVersion"],
            "bindingId": row["bindingId"],
            "bindingRevision": row["bindingRevision"],
            "principalId": row["principalId"],
            "principalSecurityVersion": member["principalSecurityVersion"],
            "clientId": row["clientId"],
            "approvalKeyVersion": row["approvalKeyVersion"],
        }
        deadline = ledger.minimum(
            now + TTL, row["expiresAt"], *(item["expiresAt"] for item in grants)
        )
        guard = _invocation.get()
        if guard is not None:
            guard.limit(deadline)
        return row, context, deadline

    def _signed(self, kind, **values):
        return protocol.sign(kind, protocol.payload(kind, **values), self.owner._key)

    def _box(self, kind, proof):
        return protocol.verify(kind, proof, self.owner.bundle["boxKey"])

    def _capacity(self, table, binding_id, now):
        protocol.need(
            self.db.execute(f"SELECT count(*) FROM {table}").fetchone()[0] < MAX_RETAINED,
            "LOCAL_WIFI_CAPACITY",
        )
        total, own = self.db.execute(
            f"SELECT count(*), coalesce(sum(binding_id=?),0) FROM {table} WHERE boot_id=? AND expires_at>?",
            (binding_id, self.owner._boot_id, now),
        ).fetchone()
        protocol.need(total < 64 and own < 4, "LOCAL_WIFI_CAPACITY")

    def challenge(self, body, now):
        protocol.fields(body, {"intentProof", "ble"})
        protocol.ble(body["ble"])
        intent = protocol.decode("intent", body["intentProof"])
        with self._transaction(now) as (meta, now):
            row, context, deadline = self._eligible(meta, intent["bindingId"], now)
            protocol.verify("intent", body["intentProof"], row["accessKey"])
            protocol.need(
                intent["ble"] == body["ble"]
                and all(
                    intent[key] == context[key]
                    for key in (
                        "boxId",
                        "boxKeyThumbprint",
                        "ownershipEpoch",
                        "bindingId",
                        "clientId",
                    )
                ),
                "LOCAL_WIFI_CONTEXT_CHANGED",
            )
            intent_digest = protocol.digest(intent)
            previous = self.db.execute(
                "SELECT * FROM wifi_challenges WHERE intent_digest=?", (intent_digest,)
            ).fetchone()
            if previous is not None:
                value = self._box("challenge", previous["proof"])
                self._current(value, body["ble"], context, now)
                protocol.need(previous["session_digest"] is None, "LOCAL_WIFI_REPLAY")
                return {"challenge": previous["proof"]}
            nonce_key = protocol.digest({"bindingId": row["bindingId"], "nonce": intent["nonce"]})
            protocol.need(
                self.db.execute(
                    "SELECT 1 FROM wifi_challenges WHERE nonce_key=?", (nonce_key,)
                ).fetchone()
                is None,
                "LOCAL_WIFI_REPLAY",
            )
            self._capacity("wifi_challenges", row["bindingId"], now)
            proof = self._signed(
                "challenge",
                context=context,
                ble=body["ble"],
                challengeId=evidence._encode(os.urandom(32)),
                intentDigest=intent_digest,
                issuedAt=now,
                expiresAt=deadline,
            )
            digest = protocol.digest(protocol.decode("challenge", proof))
            self.db.execute(
                "INSERT INTO wifi_challenges VALUES (?,?,?,?,?,?,?,NULL)",
                (
                    digest,
                    intent_digest,
                    nonce_key,
                    row["bindingId"],
                    self.owner._boot_id,
                    deadline,
                    proof,
                ),
            )
            return {"challenge": proof}

    def _current(self, value, observed_ble, context, now):
        protocol.need(
            value["context"] == context and value["ble"] == observed_ble,
            "LOCAL_WIFI_CONTEXT_CHANGED",
        )
        protocol.need(value["issuedAt"] <= now < value["expiresAt"], "LOCAL_WIFI_EXPIRED")
        guard = _invocation.get()
        if guard is not None:
            guard.limit(value["expiresAt"])

    def session(self, body, now):
        protocol.fields(body, {"challenge", "accessProof", "ble", "tokenCiphertextSha256"})
        protocol.ble(body["ble"])
        protocol.hex_digest(body["tokenCiphertextSha256"])
        challenge = self._box("challenge", body["challenge"])
        challenge_digest = protocol.digest(challenge)
        with self._transaction(now) as (meta, now):
            row, context, deadline = self._eligible(meta, challenge["context"]["bindingId"], now)
            self._current(challenge, body["ble"], context, now)
            saved = self.db.execute(
                "SELECT * FROM wifi_challenges WHERE digest=?", (challenge_digest,)
            ).fetchone()
            protocol.need(saved is not None, "LOCAL_WIFI_REPLAY")
            access = protocol.verify("session-access", body["accessProof"], row["accessKey"])
            protocol.need(
                access["challengeDigest"] == challenge_digest
                and access["tokenCiphertextSha256"] == body["tokenCiphertextSha256"],
                "LOCAL_WIFI_CONTEXT_CHANGED",
            )
            if saved["session_digest"] is not None:
                session = self.db.execute(
                    "SELECT * FROM wifi_sessions WHERE digest=?", (saved["session_digest"],)
                ).fetchone()
                protocol.need(session is not None, "LOCAL_WIFI_REPLAY")
                receipt = self._box("session-receipt", session["proof"])
                protocol.need(
                    receipt["tokenCiphertextSha256"] == body["tokenCiphertextSha256"],
                    "LOCAL_WIFI_REPLAY",
                )
                self._current(receipt, body["ble"], context, now)
                return {"sessionReceipt": session["proof"]}
            self._capacity("wifi_sessions", row["bindingId"], now)
            deadline = min(deadline, challenge["expiresAt"])
            proof = self._signed(
                "session-receipt",
                context=context,
                ble=body["ble"],
                sessionId=evidence._encode(os.urandom(32)),
                challengeDigest=challenge_digest,
                tokenCiphertextSha256=body["tokenCiphertextSha256"],
                applyNonce=evidence._encode(os.urandom(32)),
                issuedAt=now,
                expiresAt=deadline,
            )
            digest = protocol.digest(protocol.decode("session-receipt", proof))
            self.db.execute(
                "INSERT INTO wifi_sessions VALUES (?,?,?,?,?)",
                (digest, row["bindingId"], self.owner._boot_id, deadline, proof),
            )
            self.db.execute(
                "UPDATE wifi_challenges SET session_digest=? WHERE digest=?",
                (digest, challenge_digest),
            )
            return {"sessionReceipt": proof}

    def _session(self, body, meta, now):
        protocol.ble(body["ble"])
        receipt = self._box("session-receipt", body["sessionReceipt"])
        digest = protocol.digest(receipt)
        protocol.need(
            self.db.execute("SELECT 1 FROM wifi_sessions WHERE digest=?", (digest,)).fetchone()
            is not None,
            "LOCAL_WIFI_REPLAY",
        )
        row, context, _ = self._eligible(meta, receipt["context"]["bindingId"], now)
        self._current(receipt, body["ble"], context, now)
        return receipt, digest, row

    def check(self, body, now):
        protocol.fields(body, {"sessionReceipt", "ble"})
        with self._transaction(now) as (meta, now):
            receipt, digest, _ = self._session(body, meta, now)
            return {
                "valid": True,
                "checkReceipt": self._signed(
                    "check-receipt",
                    sessionDigest=digest,
                    valid=True,
                    authorizationVersion=meta["authorizationVersion"],
                    issuedAt=now,
                    expiresAt=min(now + 5, receipt["expiresAt"]),
                ),
            }

    def consume(self, body, now):
        protocol.fields(body, {"sessionReceipt", "approvalProof", "ble", "observed"})
        protocol.observed(body["observed"])
        with self._transaction(now) as (meta, now):
            receipt, digest, row = self._session(body, meta, now)
            approval = protocol.verify("apply", body["approvalProof"], row["approvalKey"])
            protocol.need(
                approval["sessionDigest"] == digest
                and approval["applyNonce"] == receipt["applyNonce"]
                and all(approval[key] == val for key, val in body["observed"].items()),
                "LOCAL_WIFI_CONTEXT_CHANGED",
            )
            apply_digest = protocol.digest(approval)
            saved = self.db.execute(
                "SELECT * FROM wifi_operations WHERE session_digest=?", (digest,)
            ).fetchone()
            if saved is not None:
                protocol.need(saved["apply_digest"] == apply_digest, "LOCAL_WIFI_REPLAY")
                execute, state = False, saved["state"]
            else:
                protocol.need(
                    self.db.execute("SELECT count(*) FROM wifi_operations").fetchone()[0]
                    < MAX_RETAINED,
                    "LOCAL_WIFI_CAPACITY",
                )
                execute, state = True, "consumed"
            proof = self._signed(
                "execution-receipt",
                sessionDigest=digest,
                **body["observed"],
                authorizationVersion=meta["authorizationVersion"],
                execute=execute,
                state=state,
                issuedAt=now,
                expiresAt=min(now + 5, receipt["expiresAt"]),
            )
            if execute:
                self.db.execute(
                    "INSERT INTO wifi_operations VALUES (?,?,?,?,?,?,?,NULL)",
                    (
                        digest,
                        self.owner._boot_id,
                        apply_digest,
                        json.dumps(body["observed"], sort_keys=True),
                        state,
                        now,
                        proof,
                    ),
                )
            return {"execute": execute, "executionReceipt": proof}

    def result(self, body, now):
        protocol.fields(body, {"executionReceipt", "outcome"})
        protocol.need(body["outcome"] in protocol.OUTCOMES)
        receipt = self._box("execution-receipt", body["executionReceipt"])
        protocol.need(receipt["execute"] is True, "LOCAL_WIFI_REPLAY")
        with self._transaction(now) as (_, now):
            saved = self.db.execute(
                "SELECT * FROM wifi_operations WHERE session_digest=?", (receipt["sessionDigest"],)
            ).fetchone()
            protocol.need(
                saved is not None
                and protocol.digest(self._box("execution-receipt", saved["execution_proof"]))
                == protocol.digest(receipt),
                "LOCAL_WIFI_REPLAY",
            )
            protocol.need(
                saved["state"] == "consumed" or saved["state"] == body["outcome"],
                "LOCAL_WIFI_RESULT_CONFLICT",
            )
            if saved["result_proof"] is not None:
                return {"resultReceipt": saved["result_proof"]}
            proof = self._signed(
                "result-receipt",
                sessionDigest=receipt["sessionDigest"],
                requestId=receipt["requestId"],
                outcome=body["outcome"],
                issuedAt=now,
            )
            self.db.execute(
                "UPDATE wifi_operations SET state=?,result_proof=? WHERE session_digest=?",
                (body["outcome"], proof, receipt["sessionDigest"]),
            )
            return {"resultReceipt": proof}

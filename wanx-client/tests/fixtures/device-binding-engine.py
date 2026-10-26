"""Synthetic JSON RPC used by the explicit Node/Python contract test only."""

import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "wanx-bridge"))

from wanx_bridge import local_trust_protocol as protocol  # noqa: E402


def execute(item):
    op = item["op"]
    if op == "metadata":
        request = item["request"]
        return {
            "canonical": protocol.canonical_request(request).decode("ascii"),
            "digest": protocol.request_digest(request),
            "thumbprint": protocol.public_key_thumbprint(request["accessKey"]),
        }
    if op == "sign":
        access = serialization.load_pem_private_key(item["accessPrivateKeyPem"].encode(), None)
        approval = serialization.load_pem_private_key(item["approvalPrivateKeyPem"].encode(), None)
        return {
            "request": protocol.sign_request(item["request"], access),
            "approval": protocol.sign_approval(item["approval"], approval),
            "cancel": protocol.sign_cancel(item["cancel"], access),
        }
    if op == "verify_request":
        request = protocol.verify_request_proof(item["proof"])
        protocol.validate_request_context(request, item["context"], item["now"])
        return request
    if op == "verify_approval":
        return protocol.verify_approval_signature(
            item["approvalProof"], item["requestProof"], item["trustedState"], item["now"]
        )
    if op == "verify_cancel":
        return protocol.verify_cancel_proof(item["proof"], item["request"], item["now"])
    raise ValueError("unknown test operation")


def reply(item):
    try:
        return {"ok": True, "value": execute(item)}
    except protocol.BindingProtocolError as error:
        return {"ok": False, "code": error.code}


if __name__ == "__main__":
    # Unexpected failures deliberately fail the child process and the test.
    print(json.dumps([reply(item) for item in json.load(sys.stdin)], separators=(",", ":")))

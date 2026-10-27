"""Fixed private data identities and the explicit box Wi-Fi management resource.

Only trusted authority/runtime callers provide principal_id. Display names,
cloud accounts, native user integers and client-selected paths are not inputs.
"""

from . import local_trust_protocol as evidence
from .local_management_protocol import digest

PRIVATE_RESOURCE_IDS = frozenset({"wanx", "space", "space:personal", "clipboard", "semantica"})
SYSTEM_RESOURCE_IDS = frozenset({"network:wifi"})


def validate_resource_grants(grants, *, empty=False):
    evidence._grants(grants, empty=empty)
    evidence._require(
        all(grant["resourceId"] in PRIVATE_RESOURCE_IDS | SYSTEM_RESOURCE_IDS for grant in grants),
        "LOCAL_TRUST_RESOURCE_UNSUPPORTED",
    )
    evidence._require(
        all(
            grant["resourceId"] != "network:wifi" or grant["actions"] == ["write"]
            for grant in grants
        )
    )


def resolve_resource(principal_id: str, resource_id: str) -> dict:
    evidence._token(principal_id)
    evidence._require(
        type(resource_id) is str and resource_id in PRIVATE_RESOURCE_IDS | SYSTEM_RESOURCE_IDS,
        "LOCAL_TRUST_RESOURCE_UNSUPPORTED",
    )
    if resource_id in SYSTEM_RESOURCE_IDS:
        # Box context/epoch is enforced by the ledger. This fixed system
        # namespace is never a principal directory or a data-gateway resource.
        return {
            "resourceId": resource_id,
            "canonicalResourceId": resource_id,
            "scope": "shared",
            "namespaceId": "namespace:"
            + digest(
                {"purpose": "centuarai.local-ledger.box-system-resource", "resourceId": resource_id}
            ),
            "principalId": principal_id,
        }
    canonical = "space:personal" if resource_id == "space" else resource_id
    namespace = digest(
        {
            "purpose": "centuarai.local-ledger.private-resource",
            "principalId": principal_id,
            "resourceId": canonical,
        }
    )
    return {
        "resourceId": resource_id,
        "canonicalResourceId": canonical,
        "scope": "principal-private",
        "namespaceId": "namespace:" + namespace,
        "principalId": principal_id,
    }

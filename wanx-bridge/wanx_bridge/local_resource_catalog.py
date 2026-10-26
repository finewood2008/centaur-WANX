"""Fixed private resource identities; never resolve another principal's data.

Only trusted authority/runtime callers provide principal_id. Display names,
cloud accounts, native user integers and client-selected paths are not inputs.
"""

from . import local_trust_protocol as evidence
from .local_management_protocol import digest

PRIVATE_RESOURCE_IDS = frozenset({"wanx", "space", "space:personal", "clipboard", "semantica"})


def validate_resource_grants(grants, *, empty=False):
    evidence._grants(grants, empty=empty)
    evidence._require(
        all(grant["resourceId"] in PRIVATE_RESOURCE_IDS for grant in grants),
        "LOCAL_TRUST_RESOURCE_UNSUPPORTED",
    )


def resolve_resource(principal_id: str, resource_id: str) -> dict:
    evidence._token(principal_id)
    evidence._require(
        type(resource_id) is str and resource_id in PRIVATE_RESOURCE_IDS,
        "LOCAL_TRUST_RESOURCE_UNSUPPORTED",
    )
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

"""Fixed private resource identities; never resolve another principal's data.

Only trusted authority/runtime callers provide principal_id. Display names,
cloud accounts, native user integers and client-selected paths are not inputs.
"""

from centuarai_local_data_gate.team import team_resource

from . import local_trust_protocol as evidence
from .local_management_protocol import digest

PRIVATE_RESOURCE_IDS = frozenset({"wanx", "space", "space:personal", "clipboard", "semantica"})


def validate_resource_grants(grants, *, empty=False):
    evidence._grants(grants, empty=empty)
    evidence._require(
        all(
            grant["resourceId"] in PRIVATE_RESOURCE_IDS or team_resource(grant["resourceId"])
            for grant in grants
        ),
        "LOCAL_TRUST_RESOURCE_UNSUPPORTED",
    )


def resolve_resource(
    principal_id: str, resource_id: str, *, box_id=None, ownership_epoch=None
) -> dict:
    evidence._token(principal_id)
    if team_resource(resource_id):
        evidence._token(box_id)
        evidence._require(
            type(ownership_epoch) is int and ownership_epoch > 0, "LOCAL_TRUST_RESOURCE_UNSUPPORTED"
        )
        namespace = digest(
            {
                "purpose": "centuarai.local-ledger.team-resource",
                "boxId": box_id,
                "ownershipEpoch": ownership_epoch,
                "resourceId": resource_id,
            }
        )
        return {
            "resourceId": resource_id,
            "canonicalResourceId": resource_id,
            "scope": "team-shared",
            "namespaceId": "namespace:" + namespace,
            "boxId": box_id,
            "ownershipEpoch": ownership_epoch,
        }
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

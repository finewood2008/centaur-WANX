from types import SimpleNamespace

from wanx_studio.context_sources import WanxContextSources


async def test_warehouse_picker_keeps_native_kb_and_starlink_ids_separate():
    warehouse = "12345678-1234-1234-1234-123456789012"
    async def current_grants():
        return [
            {"resourceId": "team:knowledge:ABC123", "actions": ["read"]},
            {"resourceId": "team:knowledge:" + warehouse, "actions": ["read"]},
            {"resourceId": "team:knowledge:22345678-1234-1234-1234-123456789012", "actions": ["write"]},
            {"resourceId": "semantica", "actions": ["read"]},
        ]
    context = SimpleNamespace(current_grants=current_grants)
    authority = SimpleNamespace(context=lambda owner: context)
    provider = WanxContextSources(None, None, None, authority)
    result = await provider.launch_sources("wanx:7", "warehouses")
    assert result == {"items": [{"id": warehouse, "name": warehouse}]}

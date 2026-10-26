import asyncio

import pytest

from test_preparation import env
from wanx_studio.contracts import StudioError


async def test_reference_checks_are_bounded_ordered_and_still_check_every_permission(env):
    svc, _, _ = env
    active = peak = 0
    calls = []

    async def metadata(owner, kind, key):
        nonlocal active, peak
        calls.append((owner, kind, key)); active += 1; peak = max(peak, active)
        try:
            await asyncio.sleep(.01)
            return {'id': key, 'kind': kind, 'revision': 'current'}
        finally:
            active -= 1

    svc.context_provider.metadata = metadata
    refs = [{'kind': 'xingtu', 'id': str(i), 'revision': 'current'} for i in range(16)]
    result = await svc.preparation.validate_references('alice', refs)
    assert [m['id'] for m in result] == [r['id'] for r in refs]
    assert peak == 4 and active == 0
    assert calls == [('alice', 'xingtu', str(i)) for i in range(16)]
    assert not svc.context_provider.reads


@pytest.mark.parametrize('failure', ['permission', 'revision'])
async def test_denied_or_changed_reference_still_blocks_and_drains_current_batch(env, failure):
    svc, _, _ = env
    calls = []; active = 0

    async def metadata(owner, kind, key):
        nonlocal active
        active += 1; calls.append(key)
        try:
            await asyncio.sleep(.01)
            if key == '0' and failure == 'permission': raise StudioError('CONTEXT_FORBIDDEN', 403)
            return {'id': key, 'revision': 'changed' if key == '0' else 'current'}
        finally:
            active -= 1

    svc.context_provider.metadata = metadata
    refs = [{'kind': 'xingtu', 'id': str(i), 'revision': 'current'} for i in range(16)]
    with pytest.raises(StudioError, match='CONTEXT_FORBIDDEN' if failure == 'permission' else 'CONTEXT_SOURCE_CHANGED'):
        await svc.preparation.validate_references('alice', refs)
    assert calls == ['0', '1', '2', '3'] and active == 0


async def test_invalid_reference_is_rejected_before_any_source_request(env):
    svc, _, _ = env
    async def forbidden(*_): raise AssertionError('source requested before validating input')
    svc.context_provider.metadata = forbidden
    with pytest.raises(StudioError, match='CONTEXT_REFERENCE_INVALID'):
        await svc.preparation.validate_references('alice', [{'kind': 'xingtu', 'id': 'valid'}, {'kind': 'invalid', 'id': 'bad'}])

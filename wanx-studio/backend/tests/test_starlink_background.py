"""ACP owns background retrieval; intake and product authority stay separate."""
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from test_preparation import env, op
from wanx_studio.context_sources import WanxContextSources
from wanx_studio.contracts import StudioError, digest

WAREHOUSE = '11111111-1111-1111-1111-111111111111'
REFERENCE = 'xingtu:team-' + WAREHOUSE + '__meeting'


class Star:
    def __init__(self):
        self.calls = []
        self.denied = False
        self.hits = True
        self.document = {'id': 'meeting', 'name': '会议流程资料', 'status': 'ready', 'revision': 1}

    async def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        if self.denied:
            raise StudioError('CONTEXT_FORBIDDEN', 403)
        if path == '/warehouses/' + WAREHOUSE:
            return {'id': WAREHOUSE, 'name': '已选团队仓'}
        if path == '/warehouses/' + WAREHOUSE + '/search':
            assert method == 'POST'
            return {'items': [{'document_id': 'meeting', 'text': '行动项由负责人核对。'}] if self.hits else []}
        if path == '/warehouses/' + WAREHOUSE + '/documents/meeting':
            return {'document': self.document}
        if path == '/warehouses/' + WAREHOUSE + '/documents/meeting/text':
            return {'text': '行动项由负责人核对。未采用的资料建议不能视为需求。' * 100}
        raise AssertionError('unselected route: ' + path)


async def ready(svc, pid):
    star = Star()
    provider = WanxContextSources(SimpleNamespace(paths=SimpleNamespace(root=svc.store.root)), None, None)
    provider.team_star = lambda owner: star
    svc.context_provider = provider
    ref = provider.project_metadata('xingtu', star.document)
    ref.update(id=REFERENCE.removeprefix('xingtu:'))
    ref.pop('itemKind')
    await svc.preparation.set_context('alice', pid, {'references': [ref], 'expectedRevision': 0})
    p = await svc.preparation.check('alice', pid, {'operationId': op()})
    await svc.preparation.handoff('alice', pid, {'expectedRevision': p['preparation']['revision']})
    p = svc.store.get('alice', pid)
    p['preparation']['interview'].update(state='running', turnId='research', turns=[{
        'id': 'research', 'operationId': 'research-op', 'text': '理解会议流程', 'state': 'running',
    }])
    svc.store.save(p)
    star.calls.clear()
    return star


async def test_acp_receives_retrieval_rules_and_reads_only_after_tool_requests(env, monkeypatch):
    svc, pid, model_calls = env
    star = await ready(svc, pid)
    pm = svc.preparation.pm
    sent = []
    monkeypatch.setattr('wanx_studio.product_manager.runtime_config', lambda *_: {'WANX_CODEX_CONFIG': '{}'})

    class Input:
        def write(self, data):
            sent.append(json.loads(data))
        async def drain(self):
            pass

    class Output:
        async def __aiter__(self):
            # A scripted ACP peer exercises the real private tool dispatcher.
            assert star.calls == []  # The host has not prefetched the warehouse.
            for key, method, args in [
                ('project', 'read_project', {}),
                ('search', 'search_context', {'query': '会议 行动项'}),
                ('read', 'read_context', {'ref': REFERENCE, 'offset': 0, 'limit': 24}),
            ]:
                yield json.dumps({'type': 'request', 'id': key, 'method': method, 'args': args}).encode()
            current = svc.store.get('alice', pid)
            yield json.dumps({'type': 'request', 'id': 'save', 'method': 'update_prd', 'args': {
                'expectedHash': digest(current['solution']),
                'summary': {'projectName': '会议助手'},
                'provenance': [{'section': 'rules', 'kind': 'background', 'sources': [REFERENCE]}],
            }}).encode()
            yield json.dumps({'type': 'text', 'text': '参考会议流程资料，行动项由负责人核对；业务取舍仍待你确认。'}).encode()
            yield b'{"type":"complete"}'
            yield b'{"type":"idle"}'

    proc = SimpleNamespace(stdin=Input(), stdout=Output(), returncode=None)
    worker = SimpleNamespace(proc=proc)
    released = []
    async def acquire(*_):
        return worker
    async def release(_, healthy):
        released.append(healthy)
    monkeypatch.setattr(svc.native_codex, 'acquire', acquire)
    monkeypatch.setattr(svc.native_codex, 'release', release)
    await pm.execute_turn('alice', pid, 'research', '帮我理解会议流程')
    prompt = sent[0]['prompt']
    assert '星图资料检索规则' in prompt and '先根据需求' in prompt
    assert '行动项由负责人核对' not in prompt
    replies = {r['id']: r for r in sent[1:]}
    assert replies['project']['result']['references'][0]['id'] == REFERENCE.removeprefix('xingtu:')
    assert replies['search']['result']['items'][0]['ref'] == REFERENCE
    assert len(replies['read']['result']['text']) == 24 and replies['read']['result']['nextOffset'] == 24
    assert replies['save']['result']['saved']
    search = next(c for c in star.calls if c[1].endswith('/search'))
    assert search[2]['payload'] == {'query': '会议 行动项', 'document_ids': ['meeting'], 'limit': 6}
    p = svc.store.get('alice', pid)
    assert released == [True] and p['preparation']['interview']['state'] == 'completed'
    assert p['solution']['capabilities'] == [] and not p['tasks'] and p['confirmation'] is None
    assert p['preparation']['provenance'][-1]['kind'] == 'background'
    assert model_calls == []  # No intake-model search or development was started.


async def test_empty_search_and_revoked_warehouse_do_not_change_product_scope(env):
    svc, pid, _ = env
    star = await ready(svc, pid)
    pm = svc.preparation.pm
    before = deepcopy(svc.store.get('alice', pid)['solution'])
    star.hits = False
    assert (await pm.tool('alice', pid, 'research', 'search_context', {'query': '不存在的流程'}))['items'] == []
    assert not any(c[1].endswith('/text') for c in star.calls)
    star.denied = True
    with pytest.raises(StudioError, match='CONTEXT_FORBIDDEN'):
        await pm.tool('alice', pid, 'research', 'search_context', {'query': '会议'})
    p = svc.store.get('alice', pid)
    assert p['solution'] == before and not p['tasks'] and p['confirmation'] is None


async def test_acp_cannot_read_unselected_material_or_another_members_project(env):
    svc, pid, _ = env
    star = await ready(svc, pid)
    pm = svc.preparation.pm
    with pytest.raises(StudioError, match='CONTEXT_NOT_SELECTED'):
        await pm.tool('alice', pid, 'research', 'read_context', {'ref': REFERENCE + '-foreign'})
    with pytest.raises(StudioError, match='PROJECT_NOT_FOUND'):
        await pm.tool('bob', pid, 'research', 'search_context', {'query': '会议'})
    assert star.calls == []

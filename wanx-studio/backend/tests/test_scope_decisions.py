from copy import deepcopy

import pytest

from test_discovery import solution
from test_preparation import env, op
from wanx_studio.contracts import StudioError, digest, readiness
from wanx_studio.iterative import proposal
from wanx_studio.scope_decisions import apply_scope_decisions, scope_state


def draft():
    s = solution()
    s['capabilities'] = []
    s['dependencies'] = [{'id': 'external-publishing', 'requirement': '外部平台发布', 'reason': '接口缺失'}]
    return {'solution': s, 'originalGoal': '自动发布并按角色审核', 'decisions': {},
            'messages': [{'id': 'accepted', 'role': 'user', 'text': '改为人工发布，首版不做审核分工'},
                         {'id': 'suggested', 'role': 'assistant', 'text': '推荐人工发布'}],
            'artifacts': [], 'confirmation': None, 'tasks': [],
            'preparation': {'revision': 1, 'gaps': ['公众号发布：缺少接口', '审核分工：缺少授权接口'],
                            'messages': [], 'interview': {'turns': []}, 'report': {'valid': True}}}


def choices(p):
    common = {'choice': 'defer', 'detail': '首版只做站内准备，人工发布，不实现审核分工', 'sourceMessageId': 'accepted'}
    return [{**common, 'kind': 'dependency', 'id': 'external-publishing', 'choice': 'manual'},
            *[{**common, 'kind': 'capability', 'id': digest(g)} for g in p['preparation']['gaps']]]


def test_accepted_scope_resolves_both_gates_preserves_original_and_never_builds():
    p = draft(); before = deepcopy(p)
    assert not proposal(p)['ready']
    assert '完整 PRD（流程、页面、数据与验收）' not in proposal(p)['missing']
    assert any('公众号发布' in x for x in proposal(p)['missing'])
    assert scope_state(p)['capabilityGaps'][0]['id'] == digest(p['preparation']['gaps'][0])
    assert apply_scope_decisions(p, choices(p)) == 3
    assert readiness(p['solution'], p['decisions'])['ready']
    assert proposal(p)['ready']
    for key in ('solution', 'originalGoal', 'messages', 'confirmation', 'tasks', 'artifacts'):
        assert p[key] == before[key]
    assert p['preparation']['gaps'] == before['preparation']['gaps']
    assert p['preparation']['report'] is None
    assert p['preparation']['revision'] == 2
    assert all(d['sourceMessageId'] == 'accepted' for d in p['preparation']['gapDecisions'].values())
    assert apply_scope_decisions(p, choices(p)) == 0
    assert p['preparation']['revision'] == 2


@pytest.mark.parametrize('source', ['suggested', 'background:doc', 'unknown', 'queued'])
def test_only_existing_processed_user_messages_can_support_scope(source):
    p = draft()
    p['messages'].append({'id': 'queued', 'role': 'user', 'text': '以后再说', 'operationId': 'later'})
    p['preparation']['interview']['turns'] = [{'operationId': 'later', 'state': 'queued'}]
    changes = choices(p); changes[-1]['sourceMessageId'] = source
    before = deepcopy(p)
    with pytest.raises(StudioError, match='SCOPE_USER_DECISION_REQUIRED'):
        apply_scope_decisions(p, changes)
    assert p == before


@pytest.mark.parametrize('field,value', [('id', 'invented'), ('choice', 'approved'), ('detail', ''), ('kind', 'permission')])
def test_invalid_batch_does_not_partially_resolve_gaps(field, value):
    p = draft(); changes = choices(p); changes[-1][field] = value; before = deepcopy(p)
    with pytest.raises(StudioError, match='SCOPE_DECISION_INVALID'):
        apply_scope_decisions(p, changes)
    assert p == before


async def test_prd_patch_records_choices_atomically_and_bad_evidence_rolls_back(env):
    svc, pid, _ = env; prep = svc.preparation
    checked = await prep.check('alice', pid, {'operationId': op()})
    await prep.handoff('alice', pid, {'expectedRevision': checked['preparation']['revision']})
    p = svc.store.get('alice', pid)
    seed = draft()
    p['solution'] = seed['solution']; p['messages'] = seed['messages']
    p['originalGoal'] = seed['originalGoal']; p['preparation']['gaps'] = seed['preparation']['gaps']
    p['preparation']['interview'].update(state='running', turnId='scope-test')
    svc.store.save(p)
    read = await prep.pm.tool('alice', pid, 'scope-test', 'read_project', {})
    assert len(read['scopeDecisions']['capabilityGaps']) == 2
    changes = choices(p); changes[-1]['sourceMessageId'] = 'suggested'
    with pytest.raises(StudioError, match='SCOPE_USER_DECISION_REQUIRED'):
        await prep.pm.tool('alice', pid, 'scope-test', 'update_prd', {
            'expectedHash': digest(p['solution']), 'summary': {'outputs': '修改不得部分保存'}, 'scopeDecisions': changes})
    current = svc.store.get('alice', pid)
    assert current['solution'] == p['solution'] and not current['decisions']
    assert not current['preparation'].get('gapDecisions')
    await prep.pm.tool('alice', pid, 'scope-test', 'update_prd', {
        'expectedHash': digest(p['solution']), 'scopeDecisions': choices(p)})
    current = svc.store.get('alice', pid)
    assert proposal(current,require_review=False)['ready']
    assert not proposal(current)['ready'],'resolving scope cannot finish an active PM turn'
    assert not current['confirmation'] and not current['tasks']
    assert current['preparation']['interview']['sync'] == 'saved'

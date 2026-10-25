import asyncio
import pytest
from test_preparation import env, op
from wanx_studio.contracts import StudioError, check_manifest
from wanx_studio.foundation import FOUNDATION_PROMPT, foundation_policy
from wanx_studio.iterative import proposal


def test_foundation_reaches_every_planning_entry_and_is_not_project_editable():
    from wanx_studio.preparation import INTAKE_PROMPT
    from wanx_studio.product_manager import PROMPT as pm
    from wanx_studio.edits import PROMPT as edits
    from wanx_studio.client_launch import PROMPT as brief
    from wanx_studio.discovery import interview_prompt
    for prompt in [INTAKE_PROMPT, pm, edits, brief, interview_prompt()]:
        assert FOUNDATION_PROMPT in prompt
    policy = foundation_policy()
    assert policy['identity']['roles'] == ['admin', 'user']
    policy['identity']['roles'].append('project-superuser')
    assert foundation_policy()['identity']['roles'] == ['admin', 'user']


def test_manifests_cannot_create_a_separate_account_store():
    m = {'schemaVersion': 1, 'entry': 'src/app.js', 'name': '测试', 'capabilities': ['data'], 'collections': {}}
    for field in ['password', 'password_hash', 'refreshToken', 'access_token']:
        m['collections'] = {'accounts': {'username': 'string', field: 'string'}}
        with pytest.raises(StudioError, match='WANX_AUTH_REQUIRED'):
            check_manifest(m)
    m['collections'] = {'staff': {'displayName': 'string', 'businessRole': 'string'}}
    assert check_manifest(m)['collections'] == m['collections']


async def test_unsupported_requirement_allows_discussion_but_never_build_permission(env):
    svc, pid, _ = env
    prep = svc.preparation
    await prep.intake('alice', pid, {'operationId': op(), 'text': '保存会议行动项'})
    p = await prep.check('alice', pid, {'operationId': op()})
    p = await prep.handoff('alice', pid, {'expectedRevision': p['preparation']['revision']})
    def gap(q):
        q['preparation']['gaps'] = ['成员间逐条报告保密，现有共享数据契约不支持']
        q['preparation']['interview'].update({'state':'completed','sync':'saved'})
    prep.mutate('alice', pid, 'fixture-gap', gap)
    p = prep.get('alice', pid)
    await prep.guard_async('alice', p, planning=True)
    with pytest.raises(StudioError, match='CAPABILITY_CHECK_REQUIRED'):
        prep.guard('alice', p, development=True)
    assert not proposal(p)['ready']
    assert any('现有 WANX 能力' in v for v in proposal(p)['missing'])
    # Losing a real interface grant still blocks even planning.
    p['preparation']['report'] = None
    with pytest.raises(StudioError, match='CAPABILITY_CHECK_REQUIRED'):
        await prep.guard_async('alice', p, planning=True)
    assert not p['tasks']


async def test_overlapping_retries_share_one_existing_interface_check(env, monkeypatch):
    svc, pid, _ = env
    prep = svc.preparation
    await prep.intake('alice', pid, {'operationId': op(), 'text': '保存会议行动项'})
    p = await prep.check('alice', pid, {'operationId': op()})
    await prep.handoff('alice', pid, {'expectedRevision': p['preparation']['revision']})
    def invalidate(q):
        q['preparation']['report'] = None
        q['preparation']['interview'].update({'state':'failed','sync':'saved'})
    prep.mutate('alice', pid, 'fixture-invalidate', invalidate)
    entered, release = asyncio.Event(), asyncio.Event()
    original, checks = prep.check, []
    async def slow(*args):
        checks.append(args[-1]['operationId']);entered.set();await release.wait()
        return await original(*args)
    monkeypatch.setattr(prep, 'check', slow)
    a=asyncio.create_task(prep.pm.check_launch_capabilities('alice',pid))
    await entered.wait()
    b=asyncio.create_task(prep.pm.check_launch_capabilities('alice',pid))
    await asyncio.sleep(0)
    assert len(checks)==1
    release.set()
    assert await asyncio.gather(a,b)==[True,False]
    assert len(checks)==1

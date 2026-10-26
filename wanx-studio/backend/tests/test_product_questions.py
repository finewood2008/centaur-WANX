"""First-build choices survive real PM tools, persistence and build guards."""
import asyncio
import json
from copy import deepcopy

import pytest

from test_preparation import env, op
from test_continuous_conversation import ready
from test_discovery import solution
from wanx_studio.contracts import StudioError, digest
from wanx_studio.iterative import proposal
from wanx_studio.product_questions import add_question, pending_choices


def question(n):
    return {'text':f'产品问题 {n}？','why':'这个决定会影响首版范围。',
            'options':['完整范围｜需要更多输入','最小范围（推荐）｜先验证关键流程。']}


async def test_real_interview_persists_three_questions_without_adopting_recommendations(env, monkeypatch):
    svc,pid,_=env
    await ready(svc,pid)
    pm=svc.preparation.pm
    monkeypatch.setattr('wanx_studio.product_manager.runtime_config',lambda *a:{'WANX_CODEX_CONFIG':'{}'})
    class Input:
        def write(self,data):pass
        async def drain(self):pass
    class Output:
        async def __aiter__(self):
            p=svc.store.get('alice',pid);turn=p['preparation']['interview']['turnId']
            await pm.tool('alice',pid,turn,'update_prd',{'expectedHash':digest(p['solution']),'summary':{'projectName':'会议助手'}})
            for n in range(3):
                result=await pm.tool('alice',pid,turn,'ask_product',question(n))
                assert result['questionCount']==n+1
            with pytest.raises(StudioError,match='QUESTION_BATCH_FULL'):
                await pm.tool('alice',pid,turn,'ask_product',question(4))
            yield json.dumps({'type':'text','text':'请共同选择本轮产品方向。'}).encode()
            yield json.dumps({'type':'complete'}).encode()
            yield json.dumps({'type':'idle'}).encode()
    class Proc:
        stdin=Input();stdout=Output();returncode=None
        async def wait(self):self.returncode=0;return 0
        def terminate(self):self.returncode=0
        def kill(self):self.returncode=0
    async def spawn(*a,**kw):return Proc()
    monkeypatch.setattr(asyncio,'create_subprocess_exec',spawn)
    async def stop(proc):proc.terminate()
    monkeypatch.setattr(svc.native_codex,'stop',stop)
    initial=deepcopy(svc.store.get('alice',pid)['solution'])
    await pm.start('alice',pid,{'operationId':op(),'text':'请一起设计会议助手'})
    for _ in range(100):
        if not svc.preparation.jobs:break
        await asyncio.sleep(.01)
    saved=svc.snapshot('alice',pid)
    assert saved['preparation']['interview']['state']=='completed'
    message=saved['messages'][-1]
    assert len(message['questions'])==3
    assert len({q['id'] for q in message['questions']})==3
    assert message['question']['text']==message['questions'][0]['text']
    assert message['options']==message['questions'][0]['options']
    assert all(q['options'][0].startswith('最小范围（推荐）') for q in message['questions'])
    assert saved['solution']==initial and not saved['tasks'] and saved['confirmation'] is None
    assert pending_choices(saved) and not proposal(saved)['ready']
    svc.preparation.valid_report=lambda *a,**kw:True
    with pytest.raises(StudioError,match='PRODUCT_CHOICES_REQUIRED'):
        svc.preparation.guard('alice',svc.store.get('alice',pid),development=True)
    # An ordinary natural-language response resolves the pending batch for the PM
    # to process, without adding a new public answer/request schema.
    saved['messages'].append({'id':'answer','role':'user','text':'第一题选完整范围；其余暂不决定'})
    assert not pending_choices(saved)


async def test_question_update_retains_id_and_rejects_invalid_batch_atomically(env):
    svc,pid,_=env;p=svc.store.get('alice',pid)
    add_question(p,question(1));first=deepcopy(p['preparation']['interview']['questions'][0])
    args=question(1);args['why']='补充选择影响';args['options']=['方案A（推荐）｜原因','方案B（推荐）｜取舍']
    add_question(p,args)
    stored=p['preparation']['interview']['questions']
    assert len(stored)==1 and stored[0]['id']==first['id']
    assert sum('（推荐）' in x for x in stored[0]['options'])==1
    before=deepcopy(p)
    with pytest.raises(StudioError,match='QUESTION_INVALID'):
        add_question(p,{**args,'options':['一个']})
    assert p==before


async def test_legacy_single_question_blocks_initial_review_but_preserves_direct_edits(env):
    svc,pid,_=env;p=svc.store.get('alice',pid)
    p['solution']=solution()
    p['messages'].append({'role':'assistant','question':question(1),'options':question(1)['options']})
    assert pending_choices(p)  # A saved single question also needs an answer before review.
    p['artifacts']=[{'hash':'existing-version'}]
    add_question(p,question(1));add_question(p,question(2))
    assert p['preparation']['interview']['question']['text']==question(2)['text']
    assert not p['preparation']['interview'].get('questions')
    p['messages'][-1]['questions']=[question(1)]
    assert not pending_choices(p)


async def test_first_build_requires_full_prd_before_confirmation(env):
    svc,pid,_=env;p=svc.store.get('alice',pid)
    p['solution']=solution();p['solution']['capabilities']=[]
    assert proposal(p)['ready']
    p['solution']['prd']['pages']=[]
    assert not proposal(p)['ready']
    assert '完整 PRD（流程、页面、数据与验收）' in proposal(p)['missing']


async def test_public_readiness_does_not_claim_pending_choices_are_complete(env):
    svc,pid,_=env;p=svc.store.get('alice',pid)
    p['solution']=solution();p['solution']['capabilities']=[];p['preparation']['phase']='acp'
    p['preparation']['interview'].update(state='completed',sync='saved')
    p['confirmation']={'hash':digest(p['solution'])}
    p['messages'].append({'id':'pending','role':'assistant','text':'请共同核对','questions':[question(1),question(2)]})
    svc.store.save(p);svc.preparation.valid_report=lambda *a,**kw:True
    pending=svc.snapshot('alice',pid)
    assert not pending['readiness']['ready']
    assert 'prd.productChoices' in pending['readiness']['missing']
    p['messages'][-1].pop('questions');svc.store.save(p)
    assert svc.snapshot('alice',pid)['readiness']['ready']

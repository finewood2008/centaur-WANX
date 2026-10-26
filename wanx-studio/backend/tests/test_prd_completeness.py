"""A semantic PM assessment cannot skip a missing contract or pending feedback."""
from copy import deepcopy
import pytest
from test_preparation import env,op
from test_continuous_conversation import ready
from test_discovery import solution
from wanx_studio.contracts import digest,StudioError
from wanx_studio.iterative import proposal,propose_contract,authorize

async def prepared(env):
    svc,pid,_=env;await ready(svc,pid)
    p=svc.store.get('alice',pid);p['solution']=solution();p['decisions']={d['id']:{'choice':'manual','detail':'沿用人工步骤'} for d in p['solution']['dependencies']}
    p['preparation']['gaps']=[];s=p['preparation']['interview'];s.update({'state':'running','sync':'saved','turnId':'review-turn','readinessPolicy':1,'turns':[{'id':'review-turn','operationId':'synthetic-review','state':'running','text':'已确认主要范围'}]});svc.store.save(p)
    svc.preparation.valid_report=lambda *a,**kw:True
    return svc,pid

async def assess(svc,pid):
    p=svc.store.get('alice',pid)
    return await svc.preparation.pm.tool('alice',pid,'review-turn','complete_prd',{'expectedHash':digest(p['solution']),'summary':'主流程、范围、数据与失败验收已共同核对。'})

async def test_assessment_waits_for_complete_content_and_saved_contract(env):
    svc,pid=await prepared(env);p=svc.store.get('alice',pid)
    assert not (await assess(svc,pid))['complete']
    propose_contract(svc,'alice',pid,{'expectedHash':digest(p['solution']),'collections':{'items':{f:'string' for f in ['title','owner']}}})
    assert (await assess(svc,pid))['complete']
    assert not proposal(svc.store.get('alice',pid))['ready'],'assessment must not expose CTA during the model turn'
    p=svc.store.get('alice',pid);p['preparation']['interview']['state']='completed';p['preparation']['interview']['turns'][0]['state']='completed';svc.store.save(p)
    assert proposal(p)['ready'];assert svc.snapshot('alice',pid)['readiness']['ready']
    p['solution']['prd']['openQuestions']=['是否需要审核？'];svc.store.save(p)
    assert not proposal(p)['ready']
    with pytest.raises(StudioError,match='SOLUTION_NOT_READY'):
        svc.confirm('alice',pid,{'operationId':op(),'solutionHash':digest(p['solution']),'reviewedSections':['goal','flow','scope','pages','data','rules','acceptance']})

async def test_new_feedback_or_changed_contract_revokes_the_previous_assessment(env):
    svc,pid=await prepared(env);p=svc.store.get('alice',pid)
    propose_contract(svc,'alice',pid,{'expectedHash':digest(p['solution']),'collections':{'items':{'title':'string'}}})
    assert (await assess(svc,pid))['complete']
    p=svc.store.get('alice',pid);s=p['preparation']['interview'];s['state']='completed';s['turns'][0]['state']='completed';svc.store.save(p);assert proposal(p)['ready']
    propose_contract(svc,'alice',pid,{'expectedHash':digest(p['solution']),'collections':{'items':{'title':'string','notes':'string'}}})
    stale=svc.store.get('alice',pid);blocked=proposal(stale);assert not blocked['ready']
    with pytest.raises(StudioError,match='SOLUTION_NOT_READY'):authorize(stale,{'operationId':op(),'specHash':blocked['specHash'],'impactHash':blocked['impactHash']})
    p=svc.store.get('alice',pid);p['preparation']['interview'].update({'state':'running','turnId':'review-turn'});p['preparation']['interview']['turns'].append({'id':'next','state':'queued','text':'需要增加审核'});svc.store.save(p)
    assert not (await assess(svc,pid))['complete']
    assert not svc.store.get('alice',pid)['tasks']

async def test_existing_unconfirmed_complete_draft_gets_one_review_without_new_user_facts(env):
    svc,pid=await prepared(env);p=svc.store.get('alice',pid)
    propose_contract(svc,'alice',pid,{'expectedHash':digest(p['solution']),'collections':{'items':{'title':'string'}}})
    p=svc.store.get('alice',pid);s=p['preparation']['interview'];s['state']='completed';s['turns'][0]['state']='completed';s.pop('readinessPolicy');svc.store.save(p)
    result=svc.snapshot('alice',pid);assert not result['readiness']['ready'];assert result['readiness']['needsReview']
    before=deepcopy(p['messages'])
    # The migration uses an empty internal turn, never a fabricated user answer.
    async def no_dispatch(*a,**kw):pass
    svc.preparation.pm.dispatch=no_dispatch
    await svc.preparation.pm.start('alice',pid,{'operationId':'prd-review_'+digest(p['solution']),'text':''})
    p=svc.store.get('alice',pid);assert p['messages']==before
    assert p['preparation']['interview']['turns'][-1]['kind']=='completeness-review'
    assert not svc.snapshot('alice',pid)['readiness']['needsReview']

async def test_cannot_mark_complete_after_asking_an_unanswered_question(env):
    svc,pid=await prepared(env);p=svc.store.get('alice',pid)
    propose_contract(svc,'alice',pid,{'expectedHash':digest(p['solution']),'collections':{'items':{'title':'string'}}})
    await svc.preparation.pm.tool('alice',pid,'review-turn','ask_product',{'text':'发布前是否需要审核？','why':'会改变页面流程。','options':['人工核对（推荐）｜先走已有流程','增加审核｜需进一步讨论']})
    assert not (await assess(svc,pid))['complete']
    assert not svc.store.get('alice',pid)['preparation']['interview'].get('prdReview')

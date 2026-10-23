import asyncio
import json
from pathlib import Path
from uuid import uuid4
import pytest
from wanx_studio.contracts import StudioError,digest,readiness,complete_dependencies
from wanx_studio.prd import ProductRequirement,PRD_REVIEW_SECTIONS
from wanx_studio.discovery import interview_context
from wanx_studio.service import StudioService
from wanx_studio.runner import Runner
ROOT=Path(__file__).resolve().parents[2]
def op():return uuid4().hex

def solution():
    return {'audience':'本人','workflow':'选择文本，生成预览，确认保存，检索编辑','inputs':'本人选择的 UTF-8 文本','outputs':'标题和摘要卡片','fields':['标题','摘要'],'acceptance':['选择资料后能预览摘要','确认保存后能按标题查到卡片'],'capabilities':['data','model','files'],'dependencies':[],
    'prd':ProductRequirement.model_validate({'problem':'资料太长，事后很难找重点','currentApproach':'逐篇阅读并手动摘录','successOutcome':'能快速生成并找回摘要卡片','scenarios':[{'title':'整理资料','actor':'本人','trigger':'需要回顾一份文本','steps':['选择本人文本','点击生成并核对预览','确认保存','按标题查找并编辑'],'outcome':'找回已保存的重点'}],'features':[{'title':'生成摘要预览','description':'手动触发，保存前可编辑','priority':'must'},{'title':'标题检索与编辑','description':'检索已保存的卡片','priority':'must'}],'pages':[{'name':'我的摘要','purpose':'整理、检索卡片','blocks':[{'title':'摘要卡片','kind':'list','fields':['标题','摘要'],'actions':['选择资料','生成摘要','保存']}]},{'name':'编辑卡片','purpose':'修订后保存','blocks':[{'title':'卡片内容','kind':'form','fields':['标题','摘要'],'actions':['取消','保存']}]}],'dataFields':[{'name':'标题','type':'text','required':True,'description':'关键词检索','example':'演示资料'},{'name':'摘要','type':'longText','required':True,'description':'可编辑重点','example':'这里是演示内容'}],'rules':['只有本人使用，AI 结果经用户确认后保存'],'exceptions':['没有选择资料时不生成，失败保留输入并可重试'],'tests':[{'title':'先预览再保存','given':'已经选择文本','when':'点击生成摘要','then':'出现可编辑预览，数据未写入'},{'title':'保存后可检索','given':'已经确认并保存卡片','when':'输入标题关键词','then':'出现对应卡片'}],'outOfScope':[],'openQuestions':[]}).model_dump()}

@pytest.fixture
async def svc(tmp_path):
    service=StudioService(tmp_path,ROOT);service.runner=Runner(service)
    yield service
    await service.close()

def prepared(svc):
    p=svc.store.create('alice','资料助手','整理长文本',op())
    return svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':solution()})

def test_new_project_exposes_missing_dimensions_and_cannot_skip_visual_prd(svc):
    p=svc.store.create('alice','新项目','帮助我整理资料',op())
    state=readiness(p['solution'],{})
    assert not state['ready'] and 'prd.scenarios' in state['missing'] and 'prd.tests' in state['missing']
    context=interview_context(p)
    assert context['nextFocus']=='context' and len(context['coverage'])==6
    value={**p['solution']};value.pop('prd')
    with pytest.raises(StudioError,match='PRD_REQUIRED'):
        svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':p['solutionHash'],'solution':value})

def test_brand_colors_are_frontend_work_while_actual_external_gaps_remain():
    value=solution();value['dependencies']=[{'id':'ui-theme','requirement':'整个界面改为品牌色点缀','reason':'旧访谈误判'},{'id':'custom-integration','requirement':'外部业务系统同步','reason':'未接通'}]
    result=complete_dependencies(value,'调整配色',[])
    assert [d['id'] for d in result['dependencies']]==['custom-integration']
    value['dependencies'][0]['requirement']='调整配色并调用公众号自动发布'
    assert 'ui-theme' in {d['id'] for d in complete_dependencies(value,'完整保留目标',[])['dependencies']}

async def test_initial_discovery_spends_once_without_duplicating_goal_and_records_explanatory_question(svc):
    p=svc.store.create('alice','新项目','帮助我整理资料',op());calls=[]
    async def model(owner,body):
        calls.append(body);await asyncio.sleep(.02)
        return {'choices':[{'message':{'content':json.dumps({'message':'我理解你希望更容易找回重点。','question':{'focus':'context','text':'最近一次整理资料时，最费力的是哪一步？','why':'先确定问题，再决定功能。','options':['阅读太久','找不到原先重点']},'ideas':[{'title':'保存摘要卡片','description':'把重点变成卡片','tradeoff':'需要先核对准确性'}],'solution':p['solution']},ensure_ascii=False)}}]}
    svc.model=model
    await asyncio.gather(svc.start_discovery('alice',p['id'],{'operationId':op()}),svc.start_discovery('alice',p['id'],{'operationId':op()}))
    current=svc.store.get('alice',p['id'])
    assert len(calls)==1 and sum(m['role']=='user' for m in current['messages'])==1
    assert current['messages'][-1]['question']['focus']=='context'
    assert current['messages'][-1]['options']==['阅读太久','找不到原先重点']
    assert not current['solution']['prd']['features'] and not current['confirmation'] and not current['tasks']
    payload=json.loads(calls[0]['messages'][1]['content'])
    assert payload['interviewContext']['nextFocus']=='context' and payload['originalGoal']==p['originalGoal']

async def test_multiturn_retains_context_and_dependencies_while_prd_improves(svc):
    p=prepared(svc);calls=[]
    async def model(owner,body):
        calls.append(body)
        value=solution();value['prd']['problem']='每天手工摘录太慢，查找也很费力'
        value['prd']['openQuestions']=['资料为空时是否需要提示并保留选择？']
        return {'choices':[{'message':{'content':json.dumps({'message':'已把你的现状补入 PRD。','solution':value},ensure_ascii=False)}}]}
    svc.model=model
    p=await svc.chat('alice',p['id'],{'operationId':op(),'text':'每天手工摘录太慢，另外以后希望自动发布公众号'})
    assert p['solution']['prd']['problem']=='每天手工摘录太慢，查找也很费力'
    assert p['solution']['prd']['pages'][1]['name']=='编辑卡片'
    assert p['solution']['dependencies'][0]['id']=='external-publishing'
    assert not p['readiness']['ready'] and 'prd.openQuestions' in p['readiness']['missing']
    assert '逐篇阅读' in calls[0]['messages'][1]['content']
    with pytest.raises(StudioError,match='SOLUTION_NOT_READY'):
        svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'reviewedSections':PRD_REVIEW_SECTIONS})

async def test_only_reviewed_exact_prd_can_confirm_then_explicitly_build(svc,monkeypatch):
    p=prepared(svc)
    assert p['readiness']['ready']
    with pytest.raises(StudioError,match='CONFIRMATION_REQUIRED'):
        await svc.runner.start('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'instruction':''})
    for reviewed in [[],PRD_REVIEW_SECTIONS[:-1],['goal']*7]:
        with pytest.raises(StudioError,match='PRD_REVIEW_REQUIRED'):
            svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'reviewedSections':reviewed})
    p=svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'reviewedSections':PRD_REVIEW_SECTIONS})
    assert p['confirmation']['reviewedSections']==PRD_REVIEW_SECTIONS and not p['tasks']
    seen=[]
    async def preflight(**kwargs):return {'available':True}
    async def execute(owner,project,task_id,instruction):seen.append(project['solution']['prd'])
    monkeypatch.setattr(svc.runner,'preflight',preflight);monkeypatch.setattr(svc.runner,'execute',execute)
    started=await svc.runner.start('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'instruction':''})
    await svc.runner.jobs[started['tasks'][-1]['id']]
    assert seen==[p['solution']['prd']]

def test_page_edit_invalidates_confirmation_and_does_not_allow_old_hash(svc):
    p=prepared(svc);p=svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash'],'reviewedSections':PRD_REVIEW_SECTIONS})
    old_hash=p['solutionHash'];value=solution();value['prd']['pages'][0]['purpose']='优先查看最新保存的卡片'
    p=svc.update_solution('alice',p['id'],{'operationId':op(),'expectedHash':old_hash,'solution':value})
    assert p['confirmation'] is None and p['solutionHash']!=old_hash
    with pytest.raises(StudioError,match='SOLUTION_CHANGED'):
        svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':old_hash,'reviewedSections':PRD_REVIEW_SECTIONS})

async def test_model_cannot_forge_confirmation_or_drop_prd(svc):
    p=prepared(svc)
    async def model(owner,body):
        return {'choices':[{'message':{'content':json.dumps({'message':'已确认','solution':solution(),'confirmation':{'reviewedSections':PRD_REVIEW_SECTIONS}})}}]}
    svc.model=model
    with pytest.raises(StudioError,match='INTERVIEW_RESPONSE_INVALID'):
        await svc.chat('alice',p['id'],{'operationId':op(),'text':'补充需求'})
    current=svc.store.get('alice',p['id']);assert current['confirmation'] is None and current['messages'][-1]['text']=='补充需求'

async def test_legacy_hash_and_confirmation_survive_read_restart_and_opt_in_upgrade(tmp_path):
    svc=StudioService(tmp_path,ROOT);svc.runner=Runner(svc)
    p=svc.store.create('alice','旧项目','整理长文本',op());legacy=svc.store.get('alice',p['id']);legacy['solution']=solution();legacy['solution'].pop('prd');svc.store.save(legacy)
    p=svc.snapshot('alice',p['id']);p=svc.confirm('alice',p['id'],{'operationId':op(),'solutionHash':p['solutionHash']});old_hash=p['solutionHash'];old_confirmation=p['confirmation']
    assert digest(complete_dependencies(p['solution'],p['originalGoal'],p['messages']))==old_hash
    await svc.close()
    restored=StudioService(tmp_path,ROOT);restored.runner=Runner(restored)
    try:
        p=restored.snapshot('alice',p['id']);assert p['confirmation']==old_confirmation and p['solutionHash']==old_hash
        p=await restored.start_discovery('alice',p['id'],{'operationId':op()})
        assert p['solution'].get('prd') is not None and p['confirmation'] is None
        assert p['revisions'][-1]['source']=='user-discovery-start'
    finally:await restored.close()

async def test_project_metadata_preserves_prd_and_owned_restore(svc):
    p=prepared(svc)
    def meta(action,name=''):
        return svc.project_metadata('alice',p['id'],{'operationId':op(),'action':action,'name':name})
    renamed=meta('rename','我的名称')
    assert renamed['nameMode']=='manual' and renamed['solutionHash']==p['solutionHash']
    removed=meta('delete')
    assert removed['deletedAt'] and not svc.store.list('alice')
    assert svc.store.list('alice',True)[0]['id']==p['id']
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):
        svc.project_metadata('bob',p['id'],{'operationId':op(),'action':'restore','name':''})
    restored=meta('restore')
    assert restored['solutionHash']==p['solutionHash'] and restored['name']=='我的名称'
    assert svc.store.list('alice')[0]['id']==p['id']
    assert meta('auto-name')['nameMode']=='auto'

async def test_auto_name_uses_validated_same_interview_response_and_respects_manual_lock(svc):
    p=prepared(svc)
    async def model(owner,body):
        return {'choices':[{'message':{'content':json.dumps({'projectName':'摘要卡片助手','message':'已更新完整方案','solution':solution()},ensure_ascii=False)}}]}
    svc.model=model
    svc.project_metadata('alice',p['id'],{'operationId':op(),'action':'auto-name','name':''})
    first=await svc.chat('alice',p['id'],{'operationId':op(),'text':'请继续'})
    assert first['name']=='摘要卡片助手'
    svc.project_metadata('alice',p['id'],{'operationId':op(),'action':'rename','name':'我的手动名称'})
    second=await svc.chat('alice',p['id'],{'operationId':op(),'text':'再次补充'})
    assert second['name']=='我的手动名称' and second['autoName']=='摘要卡片助手'

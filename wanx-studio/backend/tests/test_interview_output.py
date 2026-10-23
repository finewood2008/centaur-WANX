import copy
import json
from types import SimpleNamespace
from pathlib import Path

import pytest

from wanx_studio.contracts import StudioError
from wanx_studio.discovery import (INTERVIEW_OUTPUT_TOKENS, INTERVIEW_REPAIR_TOKENS,
    InterviewOutputError, interview_prompt, parse_interview_response, response_schema)
from wanx_studio.wanx import output_budget
from test_discovery import op, prepared, solution, svc


def reply(value, finish='stop'):
    return {'choices':[{'message':{'content':json.dumps(value,ensure_ascii=False)},'finish_reason':finish}]}


def rich_response():
    value=solution()
    value['prd']['rules']=[f'规则{i}：只有本人确认才写入。'+('保留完整业务细节及异常分支。'*40) for i in range(23)]
    value['prd']['exceptions']=[f'异常{i}：失败保留输入，不代替用户作决定。' for i in range(15)]
    value['prd']['tests']=[{'title':f'验收{i}','given':'独立测试资料已准备','when':'执行对应流程','then':f'第{i}项结果可见，刷新仍存在'} for i in range(21)]
    value['acceptance']=[f'第{i}条必须可观察' for i in range(35)]
    value['prd']['openQuestions']=['尚未回答的问题必须继续保留']
    return {'message':'已更新完整七部分，尚有问题需确认。','solution':value}


def test_full_long_response_preserves_every_section_and_item():
    value=rich_response()
    assert len(json.dumps(value,ensure_ascii=False))>12000
    assert parse_interview_response(reply(value))['solution']==value['solution']
    schema=response_schema()
    assert set(schema['$defs']['ProductRequirement']['required'])==set(value['solution']['prd'])
    assert 'maxItems' in interview_prompt() and '不得' in interview_prompt()


def test_real_meeting_response_keeps_all_twenty_four_rules_and_twenty_one_cases():
    value=json.loads((Path(__file__).parent/'fixtures/meeting_prd_over_twenty.json').read_text())
    parsed=parse_interview_response(reply({'message':'完整方案待核对','solution':value}))['solution']
    assert parsed==value
    assert len(parsed['prd']['rules'])==24 and len(parsed['prd']['tests'])==21
    assert parsed['prd']['openQuestions']==value['prd']['openQuestions']


@pytest.mark.parametrize('count',[21,101,501])
def test_prd_rules_and_acceptance_have_no_item_count_limit(count):
    value=rich_response()
    value['solution']['prd']['rules']=[f'规则{i}：必须经本人确认。' for i in range(count)]
    value['solution']['prd']['tests']=[{'title':f'验收{i}','given':'准备数据','when':'执行操作','then':'结果可见'} for i in range(count)]
    value['solution']['acceptance']=[f'验收条件{i}' for i in range(count)]
    assert parse_interview_response(reply(value))['solution']==value['solution']


def test_all_prd_detail_lists_are_uncapped_but_interview_choices_stay_short():
    schema=response_schema()
    for name in ('Solution','ProductRequirement','Scenario','PageBlock','PagePlan'):
        for field in schema['$defs'][name]['properties'].values():
            if field.get('type')=='array':assert 'maxItems' not in field
    assert schema['$defs']['InterviewQuestion']['properties']['options']['maxItems']==4
    assert schema['properties']['ideas']['maxItems']==2
    value=rich_response();value['solution']['prd']['tests'][0]['given']=None
    with pytest.raises(InterviewOutputError,match='schema'):
        parse_interview_response(reply(value))


@pytest.mark.parametrize('finish', ['length','max_tokens'])
def test_truncation_rejected_even_if_partial_output_is_valid_json(finish):
    with pytest.raises(InterviewOutputError,match='truncated'):
        parse_interview_response(reply(rich_response(),finish))


@pytest.mark.parametrize('field', ['rules','tests','openQuestions','dataFields','pages','scenarios','problem'])
def test_missing_prd_sections_cannot_turn_into_empty_defaults(field):
    value=rich_response();del value['solution']['prd'][field]
    with pytest.raises(InterviewOutputError,match='schema'):
        parse_interview_response(reply(value))


async def test_counted_repair_keeps_all_context_and_complete_prd_and_is_idempotent(svc):
    p=prepared(svc);value=rich_response();calls=[]
    async def model(owner,body):
        calls.append(copy.deepcopy(body))
        if len(calls)==1:return {'choices':[{'finish_reason':'length','message':{'content':'{"solution":'}}]}
        return reply(value)
    svc.model=model;body={'operationId':op(),'text':'保留所有规则和异常，继续完善方案。'}
    result=await svc.chat('alice',p['id'],body)
    again=await svc.chat('alice',p['id'],body)
    assert len(calls)==svc.used('alice',p['id'])==2
    assert [c['max_tokens'] for c in calls]==[INTERVIEW_OUTPUT_TOKENS,INTERVIEW_REPAIR_TOKENS]
    assert calls[1]['messages'][:2]==calls[0]['messages']
    context=json.loads(calls[1]['messages'][1]['content'])
    assert context['solution']==p['solution'] and context['conversation'][-1]['text']==body['text']
    assert result['solution']==again['solution']==value['solution']
    assert result['confirmation'] is None and not result['tasks']
    assert sum(m['role']=='user' and m['text']==body['text'] for m in result['messages'])==1
    assert result['readiness']['missing']==['prd.openQuestions']


async def test_json_and_field_format_can_repair_without_applying_partial_drafts(svc):
    p=prepared(svc);value=rich_response();calls=[]
    async def model(owner,body):
        calls.append(body)
        if len(calls)==1:
            invalid=copy.deepcopy(value);invalid['solution']['prd']['dataFields'][0]['type']='string'
            return reply(invalid)
        # The rejected partial proposal must never become the repair's baseline.
        assert svc.snapshot(owner,p['id'])['solution']==p['solution']
        return reply(value)
    svc.model=model
    result=await svc.chat('alice',p['id'],{'operationId':op(),'text':'补充资料整理场景'})
    assert len(calls)==2 and result['solution']==value['solution']


@pytest.mark.parametrize('failure',['truncated','json','missing'])
async def test_retry_bound_and_failure_preserve_last_complete_prd_and_user_answer(svc,caplog,failure):
    p=prepared(svc);value=rich_response();body={'operationId':op(),'text':'新回答不得丢失'}
    async def model(owner,request):
        if failure=='truncated':return reply(value,'length')
        if failure=='json':return {'choices':[{'message':{'content':'private-content-not-for-logs {'}}]}
        broken=copy.deepcopy(value);del broken['solution']['prd']['openQuestions'];return reply(broken)
    svc.model=model
    with pytest.raises(StudioError,match='INTERVIEW_RESPONSE_TRUNCATED' if failure=='truncated' else 'INTERVIEW_RESPONSE_INVALID'):
        await svc.chat('alice',p['id'],body)
    current=svc.snapshot('alice',p['id'])
    assert svc.used('alice',p['id'])==2
    assert current['solution']==p['solution'] and current['revisions']==p['revisions']
    assert current['messages'][-1]['text']==body['text'] and not current['confirmation'] and not current['tasks']
    assert 'private-content-not-for-logs' not in caplog.text
    assert ('reason='+failure if failure!='missing' else 'reason=schema') in caplog.text


async def test_forged_authority_is_not_repaired_or_applied(svc,caplog):
    p=prepared(svc);value=rich_response();value['confirmation']={'approved':True};value['private-key-must-not-be-logged']='private-value-must-not-be-logged'
    async def model(owner,body):return reply(value)
    svc.model=model
    with pytest.raises(StudioError,match='INTERVIEW_RESPONSE_INVALID'):
        await svc.chat('alice',p['id'],{'operationId':op(),'text':'继续访谈'})
    assert svc.used('alice',p['id'])==1
    assert svc.snapshot('alice',p['id'])['solution']==p['solution']
    assert 'private-key-must-not-be-logged' not in caplog.text
    assert 'private-value-must-not-be-logged' not in caplog.text


def test_wanx_budget_supports_full_prd_and_respects_model_cap_without_expanding_app_calls():
    uncapped=SimpleNamespace(max_output_tokens=0);limited=SimpleNamespace(max_output_tokens=8192)
    assert output_budget({'max_tokens':INTERVIEW_OUTPUT_TOKENS},uncapped)==16384
    assert output_budget({'max_tokens':INTERVIEW_REPAIR_TOKENS},uncapped)==32768
    assert output_budget({'max_tokens':32768},limited)==8192
    assert output_budget({'max_tokens':4096},uncapped)==4096
    assert output_budget({},uncapped)==8192
    assert output_budget({'max_tokens':1000000},uncapped)==32768

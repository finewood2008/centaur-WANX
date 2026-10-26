"""Trusted project intake, fixed capability probes, and versioned handoff."""
from .foundation import FOUNDATION_PROMPT
import asyncio
from copy import deepcopy
import json
import time
import secrets
import re
from uuid import uuid4
from pydantic import Field
from .contracts import Input, StudioError, Solution, digest, complete_dependencies, has_credentials
from .prd_patch import rows

CONTRACT_VERSION='wanx-app-capabilities/1'
CATALOG={
 'reports':{'label':'私有报告与管理员汇总','methods':['reports.context','reports.list','reports.get','reports.save','reports.delete'],'limits':'复用 WANX 私有库；普通用户仅本人，管理员可查看本应用及环境全部报告。保存文档而非任意业务表。身份、私有库绑定与环境由服务端决定；不可共享。创建需 operationId，修改/删除需 expectedHash。','example':{'method':'reports.save','params':{'operationId':'每次新建生成唯一ID，重试沿用','title':'工作报告','content':'报告正文'}}},
 'data':{'label':'保存和维护应用数据','methods':['data.list','data.get','data.put','data.delete'],'limits':'只访问当前应用和环境的数据；更新、删除需 expectedRevision。','example':{'method':'data.put','params':{'collection':'items','value':{'title':'合成示例'},'expectedRevision':0}}},
 'model':{'label':'使用 WANX 模型生成内容','methods':['model.generate'],'limits':'用户主动触发；AI 建议需核对确认后才写入业务记录。','example':{'method':'model.generate','params':{'prompt':'请整理这段文字'},'result':{'text':'生成结果'}}},
 'knowledge':{'label':'读取获准的团队数据仓','methods':['knowledge.search','knowledge.documents','knowledge.graph','knowledge.evidence'],'limits':'管理员在星图中按应用授权；只读且遵循保护规则；不把 Key 放入代码。','example':{'method':'knowledge.search','params':{'warehouseId':'已授权仓ID','query':'具体问题'}}},
 'files':{'label':'读取用户主动选择的文本文件','methods':['files.select','files.read'],'limits':'受信选择器授权；UTF-8 txt/md/csv/json，每份不超过 256 KiB。','example':{'select':'await api.files.select()','read':'await api.files.read(id)'}},
 'background.space':{'label':'准备万象空间背景资料','methods':['context.metadata','context.read'],'limits':'仅产品经理使用；客户端只看元数据，交接后才读取正文。'},
 'background.xingtu':{'label':'准备星图背景资料','methods':['context.metadata','context.search','context.read'],'limits':'只读取用户为当前项目选择的资料，不授予生成应用访问权限。'},
}
class Brief(Input):
 goal:str=''
 scenario:str=''
 currentApproach:str=''
 pain:str=''
 outcome:str=''
 boundaries:list[str]=Field(default_factory=list)
 openQuestions:list[str]=Field(default_factory=list)
class IntakeGap(Input):
 requirement:str
 reason:str
 evidence:str

class IntakeReply(Input):
 message:str=Field(min_length=1,max_length=6000)
 brief:Brief
 capabilities:list[str]=Field(default_factory=list)
 gaps:list[IntakeGap]=Field(default_factory=list)
 options:list[str]=Field(default_factory=list,max_length=4)
 projectName:str=Field(default='',max_length=40)

INTAKE_PROMPT='''你是万象客户端的轻量产品经理。只依据本次用户对话把任务讲清楚：具体场景、现有做法、最困难之处、期待的改变和已明确边界。围绕用户最新表达深挖，每轮最多一个值得问的主问题；不按字段轮询，不问工程细节，不生成完整 PRD。自然语言为主，涉及真实取舍才提供2—4个短选项，不添加“其他”（界面统一提供）。每个选项用可独立理解的完整表述，避免只写“再加某字段”而省略基础内容。不强迫固定轮数，未知保持为空或待讨论。未经用户采纳的建议不得加入范围。你看不到所选资料，不要索取资料正文。capabilities 只能从 data/model/files/knowledge/reports 选择：持久保存数据=data，用户主动AI生成=model，生成的应用需选择和读取文件=files。应用运行时需要团队知识检索=knowledge；需先由管理员在星图中授权。用户为产品经理选背景资料不代表应用要files权限。只有用户已经明确要求、但尚无运行契约的能力才能列入gaps，每项必须有requirement、reason和逐字引用用户原话的evidence。没有采纳的建议、后置或明确不做的能力绝不能列入gaps。不要提出无关提醒/通知建议，不要发明接口、不宣布检查通过。回答严格JSON，匹配以下结构：'''+json.dumps(IntakeReply.model_json_schema(),ensure_ascii=False)

INTAKE_PROMPT += "\n" + FOUNDATION_PROMPT


def initial(project):
 return {'version':1,'phase':'intake','revision':0,'brief':Brief(goal=project['originalGoal']).model_dump(),'messages':[],'required':[],'gaps':[],'references':[],'contextRevision':0,'report':None,'handoff':None,'entryIds':{},'provenance':[],'events':[],'interview':{'state':'idle','sync':'pending','sessionId':None,'question':None,'turns':[],'stream':''}}

class Preparation:
 def __init__(self,service):
  self.svc=service; self.locks={}; self.jobs={}; self.agents={}; self.stopping=set()
  from .product_manager import ProductManager
  self.pm=ProductManager(self)
 def get(self,owner,pid):
  p=self.svc.store.get(owner,pid)
  if 'preparation' not in p:raise StudioError('INTAKE_REQUIRED',409)
  return p
 def lock(self,owner,pid):return self.locks.setdefault((owner,pid),asyncio.Lock())
 def event(self,p,kind,**data):
  events=p['preparation']['events'];events.append({'seq':len(events)+1,'type':kind,'at':time.time(),**data})
 def mutate(self,owner,pid,action,change,key=None):
  return self.svc.store.mutate(owner,pid,key or uuid4().hex,{'action':action},change)
 def enable(self,owner,pid):
  def change(p):
   if 'preparation' not in p:
    if self.svc.engines.provider:self.svc.engines.bind(owner,p)
    p['preparation']=initial(p);p['solution']['capabilities']=[]
  return self.mutate(owner,pid,'enable-intake',change)
 def state(self,owner,pid):
  p=self.get(owner,pid); result=deepcopy(p['preparation']); result['projectId']=pid
  result['solutionHash']=digest(p['solution']);return result
 def events(self,owner,pid,after=0):
  events=self.get(owner,pid)['preparation']['events'];items=[e for e in events if e['seq']>after][:200]
  return {'items':items,'nextCursor':items[-1]['seq'] if items else after,'hasMore':bool(items and items[-1]['seq']<len(events))}
 async def intake(self,owner,pid,body):
  async with self.lock(owner,pid):
   p=self.get(owner,pid); prep=p['preparation']
   if prep['phase']!='intake':raise StudioError('INTAKE_ALREADY_HANDED_OFF',409)
   text=body['text'].strip(); op=body['operationId']
   if not text:raise StudioError('INTAKE_TEXT_REQUIRED')
   if has_credentials(text):raise StudioError('INPUT_CREDENTIAL_DETECTED')
   received=next((e for e in prep['events'] if e['type']=='intake.received' and e.get('operationId')==op),None)
   previous=next((m for m in prep['messages'] if m.get('operationId')==op or received and m['id']==received.get('ref')),None)
   if previous:
    if previous['text']!=text:raise StudioError('OPERATION_CONFLICT',409)
    return self.svc.snapshot(owner,pid)
   tail=prep['messages'][-1] if prep['messages'] else None
   retry=tail if tail and tail['role']=='user' and tail['text']==text and any(e['type']=='intake.failed' and e.get('operationId')==tail.get('operationId') for e in prep['events']) else None
   def append(p):
    x=p['preparation'];message=retry or {'id':uuid4().hex,'role':'user','text':text,'operationId':op}
    if not retry:x['messages'].append(message)
    x['revision']+=1;x['report']=None
    self.event(p,'intake.received',operationId=op,ref=message['id'])
   self.mutate(owner,pid,'intake-input',append)
   # Strict projection: references, names, filenames, source text and the PRD
   # never enter this model's input.
   p=self.get(owner,pid);x=p['preparation']; projection={'conversation':[{'role':m['role'],'text':m['text'],'options':m.get('options',[])} for m in x['messages']],'brief':x['brief']}
   try:
    result=await self.svc.generate(owner,pid,{'messages':[{'role':'system','content':INTAKE_PROMPT},{'role':'user','content':json.dumps(projection,ensure_ascii=False)}],'max_tokens':4096})
    choice=result['choices'][0]
    if choice.get('finish_reason','stop')!='stop':raise ValueError()
    raw=choice['message']['content'].strip()
    if raw.startswith('```'):raw=raw.split('\n',1)[1].rsplit('```',1)[0]
    reply=IntakeReply.model_validate(json.loads(raw))
    if not set(reply.capabilities)<={'data','model','files','knowledge','reports'}:raise ValueError()
   except Exception as error:
    code=error.code if isinstance(error,StudioError) else 'INTAKE_RESPONSE_INVALID'
    self.mutate(owner,pid,'intake-failed',lambda p:self.event(p,'intake.failed',operationId=op,code=code))
    raise StudioError(code,502) from None
   def apply(p):
    x=p['preparation'];x['brief']=reply.brief.model_dump();x['required']=list(dict.fromkeys(reply.capabilities));user_text=p['originalGoal']+'\n'+'\n'.join(m['text'] for m in x['messages'] if m['role']=='user')
    x['gaps']=[gap.requirement for gap in reply.gaps if gap.evidence.strip() and gap.evidence in user_text and re.search(r'外部|接口|API|连接器|技能|录音|OCR|PDF|Word|Excel|定时|自动发布|公众号|邮件|短信',gap.evidence,re.I) and not re.search(r'不做|不需要|不要|无需|不接|以后|暂不',gap.evidence)]
    # Server retains genuine unsupported intents even if a model omits them.
    intent=complete_dependencies({**p['solution'],'dependencies':[]},p['originalGoal'],x['messages'])
    x['gaps']=list(dict.fromkeys(x['gaps']+[d['requirement'] for d in intent['dependencies']]))
    x['messages'].append({'id':uuid4().hex,'role':'assistant','text':reply.message,'options':reply.options});x['revision']+=1
    if reply.projectName:
     p['autoName']=reply.projectName
     if p.get('nameMode')=='auto':p['name']=reply.projectName
    self.event(p,'intake.updated',operationId=op)
   return self.mutate(owner,pid,'intake-reply',apply)
 def required(self,p,development=False):
  x=p['preparation']; caps=list(x['required'])
  if development:caps=list(p['solution']['capabilities'])
  return sorted(set(caps+['background.'+r['kind'] for r in x['references']]))
 def fingerprint(self,owner,p):
  provider=getattr(self.svc,'context_provider',None)
  model=self.svc.model
  return digest({'owner':owner,'instance':str(self.svc.store.root.resolve()),'contract':CONTRACT_VERSION,'model':model.fingerprint() if hasattr(model,'fingerprint') else bool(model),'engine':p.get('engine'),'codex':__import__('wanx_studio.codex_config',fromlist=['runtime_config']).runtime_config(),'files':bool(self.svc.files),'background':provider.fingerprint() if provider else None,'references':p['preparation']['references'],'revision':p['preparation']['revision']})
 def gaps(self,p):
  x=p['preparation'];decisions=x.get('gapDecisions',{})
  return [g for g in x['gaps'] if digest(g) not in decisions]
 def defer_gap(self,owner,pid,body):
  p=self.get(owner,pid)
  gap=next((g for g in p['preparation']['gaps'] if digest(g)==body['gapId']),None)
  if not gap:raise StudioError('CAPABILITY_GAP_NOT_FOUND',404)
  def change(p):
   self.svc.invalidate(p)
   x=p['preparation'];x.setdefault('gapDecisions',{})[body['gapId']]={'requirement':gap,'choice':'defer','detail':body['detail'],'source':'user-action','at':time.time()};x['revision']+=1;x['report']=None
   self.event(p,'capability.deferred',gapId=body['gapId'])
  return self.mutate(owner,pid,'defer-gap',change,body['operationId'])
 def valid_report(self,owner,p,development=False,*,allow_gaps=False):
  x=p['preparation'];r=x.get('report')
  if x.get('currentProbe',{}).get('state')=='running' or (self.gaps(p) and not allow_gaps) or not r or r['fingerprint']!=self.fingerprint(owner,p):return False
  required=self.required(p,development)
  return set(required)<=set(r['required']) and all(r['results'].get(k,{}).get('status')=='passed' for k in required) and r.get('codex',{}).get('available') is True
 def guard(self,owner,p,development=False,*,planning=False):
  self.svc.engines.guard(owner,p)
  if 'preparation' not in p:return
  x=p['preparation']
  if x['phase']!='acp':raise StudioError('HANDOFF_REQUIRED',409)
  if development and x['interview']['state']=='running':raise StudioError('INTERVIEW_BUSY',409)
  if development and any(t.get('state') in {'queued','paused'} for t in x['interview'].get('turns',[])):raise StudioError('PRD_NOT_SYNCHRONIZED',409)
  if development and x['interview']['sync']!='saved':raise StudioError('PRD_NOT_SYNCHRONIZED',409)
  if development:
   from .product_questions import pending_choices
   if pending_choices(p):raise StudioError('PRODUCT_CHOICES_REQUIRED',409)
  if not self.valid_report(owner,p,development,allow_gaps=planning):raise StudioError('CAPABILITY_CHECK_REQUIRED',409)
 async def guard_async(self,owner,p,development=False,*,planning=False):
  self.guard(owner,p,development,planning=planning)
  if 'preparation' in p:await self.validate_references(owner,p['preparation']['references'])
 async def ensure_development(self,owner,pid):
  """Prepare supported interfaces automatically without broadening resource grants."""
  self.svc.authorize_management(owner)
  p=self.get(owner,pid);x=p['preparation'];s=x['interview']
  if x['phase']!='acp':raise StudioError('HANDOFF_REQUIRED',409)
  if s['state']=='running':raise StudioError('INTERVIEW_BUSY',409)
  if s['sync']!='saved' or any(t['state'] in {'queued','paused'} for t in s['turns']):raise StudioError('PRD_NOT_SYNCHRONIZED',409)
  if self.gaps(p):raise StudioError('SOLUTION_NOT_READY',409)
  if not self.valid_report(owner,p,development=True):
   await self.check(owner,pid,{'operationId':uuid4().hex})
   p=self.get(owner,pid)
  if not self.valid_report(owner,p,development=True):
   report=p['preparation'].get('report') or {}
   for cap in self.required(p,development=True):
    result=report.get('results',{}).get(cap,{})
    if result.get('status')!='passed':raise StudioError(result.get('code') or 'CAPABILITY_PROBE_FAILED',409)
   raise StudioError(report.get('codex',{}).get('code') or 'CODEX_NOT_CONFIGURED',409)
  # Only the technical report changes; the user's selected sources and PRD stay intact.
  def refresh(p):
   x=p['preparation'];x['interview']['needsCapabilities']=False
   if x.get('handoff'):
    x['handoff']['report']=deepcopy(x['report'])
    x['handoff']['contracts']={k:CATALOG[k] for k in x['report']['required']}
  self.mutate(owner,pid,'automatic-build-readiness',refresh)
  return self.get(owner,pid)
 async def sources(self,owner,kind,parent=''):
  if kind not in {'space','xingtu'}:raise StudioError('CONTEXT_KIND_INVALID')
  provider=getattr(self.svc,'context_provider',None)
  if not provider:raise StudioError('CONTEXT_UNAVAILABLE',409)
  return await provider.list(owner,kind,parent)
 async def validate_references(self,owner,refs):
  provider=getattr(self.svc,'context_provider',None)
  if refs and not provider:raise StudioError('CONTEXT_UNAVAILABLE',409)
  for ref in refs:
   if set(ref)-{'kind','id','name','revision'} or ref.get('kind') not in {'space','xingtu'} or not isinstance(ref.get('id'),str):raise StudioError('CONTEXT_REFERENCE_INVALID')
  async def check(ref):
   metadata=await provider.metadata(owner,ref['kind'],ref['id'])
   if ref.get('revision') and ref['revision']!=metadata['revision']:raise StudioError('CONTEXT_SOURCE_CHANGED',409)
   return metadata
  checked=[]
  for offset in range(0,len(refs),4):
   batch=await asyncio.gather(*(check(ref) for ref in refs[offset:offset+4]),return_exceptions=True)
   for item in batch:
    if isinstance(item,BaseException):raise item
    checked.append(item)
  return checked
 async def set_context(self,owner,pid,body):
  async with self.lock(owner,pid):
   p=self.get(owner,pid);x=p['preparation']
   if body['expectedRevision']!=x['contextRevision']:raise StudioError('CONTEXT_CHANGED',409)
   if x['interview']['state']=='running':raise StudioError('INTERVIEW_BUSY',409)
   refs=list({(r['kind'],r['id']):r for r in body['references']}.values()); refs=await self.validate_references(owner,refs)
   def change(p):
    self.svc.invalidate(p)
    x=p['preparation'];x['references']=refs;x['contextRevision']+=1;x['report']=None
    x['interview']['sessionId']=None;x['interview']['sync']='pending';x['interview'].pop('prepared',None)
    p['confirmation']=None;p['acceptance']=None
    self.event(p,'context.selected',count=len(refs))
   return self.mutate(owner,pid,'context-select',change)
 async def read_context(self,owner,pid,ref_id,offset=0,limit=12000):
  p=self.get(owner,pid)
  if p['preparation']['phase']!='acp':raise StudioError('CONTEXT_NOT_HANDED_OFF',403)
  ref=next((r for r in p['preparation']['references'] if r['kind']+':'+r['id']==ref_id),None)
  if not ref:raise StudioError('CONTEXT_NOT_SELECTED',403)
  await self.validate_references(owner,[ref])
  provider=self.svc.context_provider; text=await provider.read(owner,ref['kind'],ref['id'])
  if not isinstance(text,str):raise StudioError('CONTEXT_PARSE_FAILED',422)
  if has_credentials(text):raise StudioError('CONTEXT_CREDENTIAL_DETECTED',403)
  offset=max(0,int(offset));limit=min(24000,max(1,int(limit)))
  return {'ref':ref_id,'name':ref['name'],'revision':ref['revision'],'offset':offset,'text':text[offset:offset+limit],'totalCharacters':len(text),'nextOffset':offset+limit if offset+limit<len(text) else None}
 async def search_context(self,owner,pid,query):
  if not isinstance(query,str) or not 1<=len(query)<=1000:raise StudioError('CONTEXT_QUERY_INVALID')
  p=self.get(owner,pid)
  if p['preparation']['phase']!='acp':raise StudioError('CONTEXT_NOT_HANDED_OFF',403)
  provider=self.svc.context_provider
  if hasattr(provider,'search_selected'):
   self.svc.authorize_management(owner)
   return await provider.search_selected(owner,p['preparation']['references'],query)
  results=[]
  for ref in p['preparation']['references'][:20]:
   part=await self.read_context(owner,pid,ref['kind']+':'+ref['id'],0,24000);text=part['text']
   at=text.casefold().find(query.casefold())
   if at>=0:results.append({'ref':ref['kind']+':'+ref['id'],'name':ref['name'],'offset':max(0,at-300),'text':text[max(0,at-300):at+1500]})
  return {'items':results}
 async def probe_runtime(self,owner,pid,cap):
  token=secrets.token_urlsafe(32);app='__probe__'+uuid4().hex;file_id=uuid4().hex
  session={'owner':owner,'project':pid,'app':app,'artifact':'probe','environment':'preview','manifest':{'capabilities':[cap],'collections':{'items':{'title':'string'}}},'files':{},'expires':time.time()+60,'_probeFiles':{file_id:{'id':file_id,'name':'合成接口测试.txt','text':'WANX_FILE_PROBE'}}}
  self.svc.runtime_sessions[token]=session
  try:
   invoke=lambda method,params:self.svc.invoke(owner,token,method,params)
   if cap=='data':
    a=await invoke('data.put',{'collection':'items','value':{'title':'合成接口测试'},'expectedRevision':0}); key=a['_id']
    assert (await invoke('data.get',{'collection':'items','id':key}))['title']=='合成接口测试'
    assert (await invoke('data.list',{'collection':'items'}))['total']==1
    try:await invoke('data.put',{'collection':'items','id':key,'value':{'title':'错误版本'},'expectedRevision':0})
    except StudioError as e:
     if e.code!='RECORD_CHANGED':raise
    else:raise StudioError('PROBE_CONFLICT_NOT_ENFORCED')
    a=await invoke('data.put',{'collection':'items','id':key,'value':{'title':'修改成功'},'expectedRevision':a['_revision']})
    await invoke('data.delete',{'collection':'items','id':key,'expectedRevision':a['_revision']})
    assert (await invoke('data.list',{'collection':'items'}))['total']==0
   elif cap=='model':
    result=await invoke('model.generate',{'prompt':'这是合成接口连通性测试，不含用户资料。只回复 WANX_OK。'})
    if not result.get('text','').strip():raise StudioError('MODEL_EMPTY_RESPONSE')
   elif cap=='knowledge':
    team=getattr(self.svc,'team',None)
    if not team:raise StudioError('KNOWLEDGE_UNAVAILABLE',409)
    target_app=self.svc.store.get(owner,pid)['appId']
    deployment=team.services.application_repo.deployment(target_app) or {}
    bindings=deployment.get('configuration',{}).get('studio_team_data',{})
    if not bindings:raise StudioError('KNOWLEDGE_AUTHORIZATION_REQUIRED',409)
    session['app']=target_app
    await invoke('knowledge.documents',{'warehouseId':next(iter(bindings))})
   elif cap=='reports':
    context=await invoke('reports.context',{})
    if not context.get('writeAvailable'):raise StudioError('REPORT_CONFIGURATION_REQUIRED',409)
    await invoke('reports.list',{})
    return {'status':'passed','coverage':'真实账号及空列表读取；写入和跨用户隔离另行验收','methods':['reports.context','reports.list'],'at':time.time()}
   elif cap=='files':
    if not self.svc.files:raise StudioError('FILES_UNAVAILABLE',409)
    try:await invoke('files.read',{'id':file_id})
    except StudioError as e:
     if e.code!='FILE_NOT_SELECTED':raise
    else:raise StudioError('PROBE_AUTH_NOT_ENFORCED')
    await self.svc.select_files(owner,token,[file_id])
    assert (await invoke('files.read',{'id':file_id}))['text']=='WANX_FILE_PROBE'
   return {'status':'passed','coverage':'合成运行时实测','methods':CATALOG[cap]['methods'],'at':time.time()}
  finally:
   self.svc.runtime_sessions.pop(token,None)
   with self.svc.store.transaction():self.svc.store.db.execute('DELETE FROM records WHERE owner=? AND app=?',(owner,app))
 async def check(self,owner,pid,body):
  async with self.lock(owner,pid):
   p=self.get(owner,pid);x=p['preparation']; op=body['operationId']
   if x['interview']['state']=='running':raise StudioError('INTERVIEW_BUSY',409)
   if any(t['state'] in {'running','queued','waiting'} for t in p['tasks']):raise StudioError('BUILD_ACTIVE',409)
   # Older intake projects were created without an engine binding. An explicit
   # check may bind the configured default before any handoff or development;
   # never replace an existing binding or alter an ACP/development project.
   if not p.get('engine') and self.svc.engines.provider and x['phase']=='intake' and not p['tasks']:
    p=self.mutate(owner,pid,'bind-intake-engine',lambda p:self.svc.engines.bind(owner,p))
    x=p['preparation']
   self.svc.engines.guard(owner,p)
   if any(a['operationId']==op for a in x.get('probeAttempts',[])):return self.svc.snapshot(owner,pid)
   required=self.required(p,development=x['phase']=='acp');fingerprint=self.fingerprint(owner,p)
   if 'capabilityIds' in body and sorted(body['capabilityIds'])!=required:raise StudioError('CAPABILITY_SET_CHANGED',409)
   def begin(p):
    x=p['preparation'];a={'operationId':op,'state':'running','at':time.time()};x.setdefault('probeAttempts',[]).append(a);x['currentProbe']=a;x['report']=None
   self.mutate(owner,pid,'probe-begin',begin)
   results={}
   for cap in required:
    self.mutate(owner,pid,'probe-start',lambda p:self.event(p,'capability.checking',capability=cap,operationId=op))
    try:
     if cap in {'data','model','files','knowledge','reports'}:results[cap]=await self.probe_runtime(owner,pid,cap)
     elif cap in CATALOG:
      refs=[r for r in x['references'] if 'background.'+r['kind']==cap]
      await self.validate_references(owner,refs)
      results[cap]={'status':'passed','coverage':'服务及所选来源元数据权限；正文未读取','at':time.time()}
     else:results[cap]={'status':'unsupported','code':'CAPABILITY_UNSUPPORTED'}
    except Exception as e:
     code=e.code if isinstance(e,StudioError) else 'CAPABILITY_PROBE_FAILED'
     status='permission_denied' if 'FORBIDDEN' in code or 'DENIED' in code else 'configuration_missing' if code in {'MODEL_NOT_CONFIGURED','FILES_UNAVAILABLE','CONTEXT_UNAVAILABLE','SEMANTICA_NOT_CONFIGURED'} else 'failed'
     results[cap]={'status':status,'code':code,'at':time.time()}
   codex=await self.svc.runner.preflight(fresh=True)
   report={'version':1,'contractVersion':CONTRACT_VERSION,'operationId':op,'fingerprint':fingerprint,'required':required,'results':results,'codex':codex,'environment':'isolated-probe-runtime','at':time.time()}
   def change(p):
    if fingerprint!=self.fingerprint(owner,p):raise StudioError('CAPABILITY_SET_CHANGED',409)
    x=p['preparation'];x['report']=report;x['currentProbe']['state']='completed'
    for a in x['probeAttempts']:
     if a['operationId']==op:a['state']='completed'
    self.event(p,'capability.checked',results=results,codex=codex.get('available',False))
   return self.mutate(owner,pid,'capability-report',change)
 async def handoff(self,owner,pid,body):
  async with self.lock(owner,pid):
   p=self.get(owner,pid);x=p['preparation']
   if x['handoff'] and x['phase']=='acp':
    await self.guard_async(owner,p)
    if x['handoff']['report']['operationId']==x['report']['operationId']:return self.svc.snapshot(owner,pid)
   if body['expectedRevision']!=x['revision']:raise StudioError('INTAKE_CHANGED',409)
   if not self.valid_report(owner,p):raise StudioError('CAPABILITY_CHECK_REQUIRED',409)
   await self.validate_references(owner,x['references'])
   def change(p):
    x=p['preparation'];previous=x['handoff']
    handoff={'version':(previous['version']+1 if previous else 1),'id':uuid4().hex,'at':time.time(),'brief':deepcopy(x['brief']),'messages':deepcopy(x['messages']),'references':deepcopy(x['references']),'scopeDecisions':deepcopy(x.get('gapDecisions',{})),'report':deepcopy(x['report']),'contracts':{k:CATALOG[k] for k in x['report']['required']}}
    # A fresh connectivity report alone does not invalidate a synchronized PRD.
    # Changed inputs/contracts still require the product manager to synchronize.
    preserve_sync=x['phase']=='acp' and x['interview']['sync']=='saved' and previous is not None and all(previous.get(k)==handoff[k] for k in ('brief','messages','references','scopeDecisions','contracts'))
    if x.get('launchConfiguration'):handoff['launchConfiguration']=deepcopy(x['launchConfiguration'])
    x['handoff']=handoff;x['phase']='acp'
    if not preserve_sync:x['interview']['sync']='pending'
    p['discoveryStarted']=True
    rows(p);self.event(p,'intake.handed-off')
   return self.mutate(owner,pid,'handoff',change)

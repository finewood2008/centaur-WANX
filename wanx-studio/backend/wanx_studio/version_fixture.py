"""Explicitly labelled synthetic UI fixture; never user acceptance or AI work."""
import json
from copy import deepcopy
from uuid import uuid4
from .contracts import digest

async def seed_versions(svc,owner):
    existing=svc.store.list(owner)
    if existing:
        match=next((p for p in existing if p.get('versionFixture')),None)
        if not match:raise RuntimeError('REFUSE_VERSION_FIXTURE_IN_EXISTING_PROJECTS')
        return match['id']
    p=svc.store.create(owner,'【软件样例】持续迭代台账','固定合成软件验证，不代表用户项目或用户采用。可体验版本预览、改进意见和恢复流程；没有调用开发模型。',uuid4().hex)
    p=await svc.runner.example(owner,p['id'],uuid4().hex)
    value=json.loads((svc.project_root/'examples/prd-interview-fixture.json').read_text())['solution']
    # Rebuild a complete, frozen seven-part snapshot for the fixed sample code.
    def complete(q):
        q['versionFixture']=True;q['solution']=value;q['decisions']={}
        q['confirmation']={'hash':digest(value),'source':'fixed-software-fixture'}
        q['artifacts']=[];q['revisions']=[{'number':1,'hash':digest(value),'solution':value,'source':'fixed-software-fixture','createdAt':q['createdAt']}]
        q['tasks']=[];q.pop('versioning',None)
    svc.store.mutate(owner,p['id'],uuid4().hex,{'action':'label-version-fixture'},complete)
    files={str(f.relative_to(svc.project_root/'examples/ledger')):f.read_text() for f in (svc.project_root/'examples/ledger').rglob('*') if f.is_file()}
    for index in range(3):
        p=svc.snapshot(owner,p['id'])
        if index:svc.versions.iteration(owner,p['id'],{'operationId':uuid4().hex,'expectedRevision':p['versioning']['revision'],'action':'begin','baseHash':p['versioning']['adoptedHash'],'goal':['','增加优先级字段','改善阅读间距'][index]})
        task_id='fixture_'+uuid4().hex
        def task(q):
            it=svc.versions.task(q,['固定台账初版','新增优先级','增加留白与行距'][index])
            q['tasks'].append({'id':task_id,'executor':'fixed-example','version':'1','state':'running','solutionHash':digest(q['solution']),'baseHash':it['baseHash'],'iterationId':it['id'],'instruction':['固定台账初版','新增优先级字段，旧字段继续保留','改善阅读间距'][index],'createdAt':q['createdAt'],'events':[{'type':'status','text':'固定软件样例，没有运行 Codex；不代表用户采用。','at':q['createdAt']}],'question':None})
        svc.store.mutate(owner,p['id'],uuid4().hex,{'action':'fixed-version-task'},task)
        if index==1:
            manifest=json.loads(files['miniapp.manifest.json']);manifest['collections']['items']['priority']='string';files['miniapp.manifest.json']=json.dumps(manifest,ensure_ascii=False)
        if index==2:files['src/styles.css']+='\n.app{line-height:1.8}\n'
        p=await svc.add_artifact(owner,p['id'],task_id,deepcopy(files))
        if index<2:
            # Fixture provenance is explicit, never a forged user-acceptance receipt.
            a=svc.store.get(owner,p['id'])['artifacts'][-1]
            svc.store.mutate(owner,p['id'],uuid4().hex,{'action':'fixed-fixture-adoption'},lambda q:svc.versions.adoption(q,a,'software-fixture',uuid4().hex))
    return p['id']

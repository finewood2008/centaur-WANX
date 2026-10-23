from __future__ import annotations

import asyncio
import os
import json
import secrets
import time
import logging
from pathlib import Path
from uuid import uuid4

from .contracts import Solution, StudioError, check_manifest, compatible, complete_dependencies, digest, readiness
from .store import Store, public
from .prd import ProductRequirement, PRD_REVIEW_SECTIONS
from .discovery import (INTERVIEW_OUTPUT_TOKENS, INTERVIEW_REPAIR_TOKENS,
                        InterviewOutputError, interview_prompt,
                        parse_interview_response, interview_context)

logger=logging.getLogger(__name__)


class StudioService:
    def __init__(self, root: Path, project_root: Path, model=None, files=None):
        root.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.lease=os.fdopen(os.open(root/"studio.lock",os.O_CREAT|os.O_RDWR|getattr(os,'O_NOFOLLOW',0),0o600),"r+b")
        try:
            if os.name=='nt':
                import msvcrt
                if os.fstat(self.lease.fileno()).st_size==0:
                    self.lease.write(b'\0');self.lease.flush()
                self.lease.seek(0)
                msvcrt.locking(self.lease.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except (BlockingIOError,OSError):
            self.lease.close()
            raise StudioError("STUDIO_ALREADY_RUNNING",409) from None
        self.store = Store(root)
        self.project_root, self.model, self.files = project_root, model, files
        self.runtime_sessions: dict[str, dict] = {}
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.background: set[asyncio.Task] = set()
        self.chat_locks: dict[tuple, asyncio.Lock] = {}
        from .preparation import Preparation
        self.preparation=Preparation(self)
        self.context_provider=None
        from .engines import Engines
        self.engines=Engines(self)
        from .versions import Versions
        self.versions=Versions(self)

    async def close(self):
        if getattr(self,'closing',False):return
        self.closing=True
        for proc in list(self.processes.values()):
            if proc.returncode is None:
                proc.terminate()
        for task in list(self.background):
            task.cancel()
        await asyncio.gather(*self.background, return_exceptions=True)
        self.store.close()
        self.lease.close()

    def snapshot(self, owner, project_id):
        p = self.store.get(owner, project_id)
        result = public(p)
        result["readiness"] = readiness(p["solution"], p["decisions"])
        if 'preparation' in p:
            x=result['preparation'];valid=self.preparation.valid_report(owner,p,development=x['phase']=='acp')
            x['capabilitiesValid']=valid
            result['readiness']['ready']=result['readiness']['ready'] and valid and x['phase']=='acp' and x['interview']['sync']=='saved' and x['interview']['state']!='running' and not any(t.get('state') in {'queued','paused'} for t in x['interview'].get('turns',[]))
        return result

    @staticmethod
    def invalidate(p):
        if any(t["state"] in {"running", "waiting", "queued"} for t in p["tasks"]):
            raise StudioError("BUILD_ACTIVE", 409)
        from .versions import ensure
        ensure(p)
        p["confirmation"] = None
        p["acceptance"] = None
        p["stage"] = "discovery"

    def revise(self, p, solution, source):
        if p['solution'].get('prd') is not None and solution.get('prd') is None and source!='fixed-example':
            raise StudioError('PRD_REQUIRED',409)
        self.invalidate(p)
        if source=="ai-proposal":
            by_id={d["id"]:d for d in p["solution"]["dependencies"]}
            by_id.update({d["id"]:d for d in solution["dependencies"]})
            solution={**solution,"dependencies":list(by_id.values())}
        solution = complete_dependencies(solution, p["originalGoal"], p["messages"])
        if digest(solution) != digest(p["solution"]):
            if 'preparation' in p and source=='user':
                from uuid import uuid4
                ids=p['preparation'].setdefault('entryIds',{})
                from .prd_patch import ARRAYS
                for section in ARRAYS:
                    old_values=p['solution']['prd'].get(section,[]);old_ids=ids.get(section,[])
                    used=set();new_ids=[]
                    for index,value in enumerate(solution['prd'][section]):
                        match=next((i for i,v in enumerate(old_values) if v==value and i not in used and i<len(old_ids)),None)
                        if match is None and index<len(old_ids) and index not in used:match=index
                        if match is not None:used.add(match)
                        new_ids.append(old_ids[match] if match is not None else uuid4().hex)
                    ids[section]=new_ids
            p["solution"] = solution
            p["decisions"] = {}
            if 'preparation' in p:
                for dep in solution['dependencies']:
                    for decision in p['preparation'].get('gapDecisions',{}).values():
                        if dep['requirement'] in decision['requirement']:
                            p['decisions'][dep['id']]={'choice':'defer','detail':decision['detail'],'solutionHash':digest(solution),'operationId':'intake-user-decision'}
            p["revisions"].append({"number": len(p["revisions"])+1,"hash":digest(solution),"solution":solution,"source":source,"createdAt":time.time()})

    def update_solution(self, owner, project_id, body):
        def change(p):
            if body["expectedHash"] != digest(p["solution"]):
                raise StudioError("SOLUTION_CHANGED", 409)
            self.revise(p, body["solution"], "user")
        return self.store.mutate(owner,project_id,body["operationId"],{"action":"solution",**body},change)

    def project_metadata(self, owner, project_id, body):
        def change(p):
            action=body['action']
            if action in {'delete','restore'}:
                if p.get('preparation',{}).get('interview',{}).get('state')=='running':raise StudioError('INTERVIEW_BUSY',409)
                if any(t['state'] in {'queued','running','waiting'} for t in p['tasks']):
                    raise StudioError('BUILD_ACTIVE',409)
                p['deletedAt']=time.time() if action=='delete' else None
            elif action=='rename':
                name=body.get('name','').strip()
                if not name: raise StudioError('PROJECT_NAME_REQUIRED',422)
                p['name']=name
                p['nameMode']='manual'
            else:
                p['nameMode']='auto'
                p['name']=p.get('autoName') or '待命名项目'
        return self.store.mutate(owner,project_id,body['operationId'],{'action':'metadata',**body},change,allow_deleted=body['action']=='restore')

    def used(self, owner, project_id):
        with self.store.lock:
            return self.store.db.execute("SELECT count(*) FROM usage WHERE owner=? AND task=?",(owner,project_id)).fetchone()[0]

    async def generate(self, owner, project_id, body, *, published_runtime=False):
        if not self.model:
            raise StudioError("MODEL_NOT_CONFIGURED",409)
        with self.store.transaction():
            if not published_runtime:self.store.get(owner,project_id)
            request_id = uuid4().hex
            self.store.db.execute("INSERT INTO usage VALUES(?,?,?,?,?)",(owner,request_id,project_id,"started",time.time()))
        try:
            result = await self.model(owner,body)
        except asyncio.CancelledError:
            with self.store.lock:
                self.store.db.execute("UPDATE usage SET state='cancelled' WHERE id=?",(request_id,))
            raise
        except Exception as error:
            with self.store.lock:
                self.store.db.execute("UPDATE usage SET state='failed' WHERE id=?",(request_id,))
            if isinstance(error, StudioError):
                raise
            raise StudioError("MODEL_UPSTREAM_FAILED",502) from None
        with self.store.lock:
            self.store.db.execute("UPDATE usage SET state='completed' WHERE id=?",(request_id,))
        return result

    async def chat(self, owner, project_id, body):
        async with self.chat_locks.setdefault((owner,project_id),asyncio.Lock()):
            return await self._chat(owner,project_id,body)

    async def start_discovery(self, owner, project_id, body):
        async with self.chat_locks.setdefault((owner,project_id),asyncio.Lock()):
            p=self.store.get(owner,project_id)
            if 'preparation' in p:raise StudioError('USE_INTERVIEW_TURNS',409)
            if p.get('discoveryStarted'):
                return public(p)
            def begin(project):
                if project['solution'].get('prd') is None:
                    self.revise(project,{**project['solution'],'prd':ProductRequirement().model_dump()},'user-discovery-start')
                else:
                    self.invalidate(project)
                project['discoveryStarted']=True
            self.store.mutate(owner,project_id,'discovery_'+body['operationId'],{'action':'start-discovery'},begin)
            return await self._chat(owner,project_id,body,initial=True)

    async def _chat(self, owner, project_id, body,initial=False):
        p = self.store.get(owner,project_id)
        # Commit the user fact first, so model/network failure never loses it.
        def append(project):
            self.invalidate(project)
            if not initial:project["messages"].append({"id":uuid4().hex,"role":"user","text":body["text"]})
            project["solution"] = complete_dependencies(project["solution"],project["originalGoal"],project["messages"])
        self.store.mutate(owner,project_id,body["operationId"],{"action":"chat",**body},append)
        reply_key = "reply_" + body["operationId"]
        current=self.store.get(owner,project_id)
        if any(m.get("operationId") == body["operationId"] for m in current["messages"] if m["role"] == "assistant"):
            return public(current)
        p = self.store.get(owner,project_id)
        base_hash = digest(p["solution"])
        if not self.model:
            response = {"message":"先想一想最近一次遇到这个问题：你当时怎样完成，哪一步最费力？连接 WANX 默认模型后，我会结合你的回答继续挖掘，并逐步整理右侧 PRD。", "solution":p["solution"]}
        else:
            messages=[{"role":"system","content":interview_prompt()},{"role":"user","content":json.dumps({"originalGoal":p["originalGoal"],"solution":p["solution"],"conversation":p["messages"],"interviewContext":interview_context(p)},ensure_ascii=False)}]
            try:
                # One bounded format repair, accounted as another real request.
                # Never splice partial JSON, apply partial sections, or retry an
                # upstream/network failure implicitly.
                for attempt,budget in enumerate((INTERVIEW_OUTPUT_TOKENS,INTERVIEW_REPAIR_TOKENS)):
                    result=await self.generate(owner,project_id,{"messages":messages,"max_tokens":budget})
                    try:
                        response=parse_interview_response(result)
                        break
                    except InterviewOutputError as error:
                        logger.warning('Interview response rejected: reason=%s attempt=%s issues=%s paths=%s',error.reason,attempt+1,','.join(error.issue_types),','.join(error.issue_paths))
                        if attempt or error.reason=='incomplete' or 'extra_forbidden' in error.issue_types:
                            code='INTERVIEW_RESPONSE_TRUNCATED' if error.reason=='truncated' else 'INTERVIEW_RESPONSE_INVALID'
                            raise StudioError(code,502) from None
                        if digest(self.store.get(owner,project_id)['solution'])!=base_hash:
                            raise StudioError('SOLUTION_CHANGED',409)
                        messages=[*messages,{"role":"system","content":'上一轮输出未通过结构校验（'+error.reason+'；字段：'+','.join(error.issue_paths)+'）。请按上面的 JSON Schema 重新返回完整 JSON 和七部分 PRD，保留所有已明确需求及待答问题，不截取、压缩或删减内容，不新增业务决定。不确认方案、不启动开发。'}]
            except StudioError as error:
                if error.code in {'INTERVIEW_RESPONSE_INVALID','INTERVIEW_RESPONSE_TRUNCATED','SOLUTION_CHANGED'}:
                    raise
                def failed(project):
                    project['messages'].append({'id':uuid4().hex,'role':'assistant','text':'这次模型调用未完成，输入已保存。可以继续补充或手动编辑方案。','error':error.code,'operationId':body['operationId']})
                self.store.mutate(owner,project_id,reply_key,{'action':'failed-reply','for':body['operationId']},failed)
                raise
        def apply(project):
            if digest(project["solution"]) != base_hash:
                raise StudioError("SOLUTION_CHANGED",409)
            self.revise(project,response["solution"],"ai-proposal")
            name=response.get('projectName')
            if name:
                project['autoName']=name
                if project.get('nameMode')=='auto': project['name']=name
            question=response.get('question')
            project["messages"].append({"id":uuid4().hex,"role":"assistant","text":response["message"],"options":question['options'] if question else response.get("options",[])[:4],"question":question,"ideas":response.get('ideas',[]),"operationId":body["operationId"]})
        return self.store.mutate(owner,project_id,reply_key,{"action":"reply","for":body["operationId"]},apply)

    def decide(self, owner, project_id, body):
        def change(p):
            self.invalidate(p)
            if body["solutionHash"] != digest(p["solution"]):
                raise StudioError("SOLUTION_CHANGED",409)
            if body["dependencyId"] not in {d["id"] for d in p["solution"]["dependencies"]}:
                raise StudioError("DEPENDENCY_NOT_FOUND",404)
            if body["choice"] == "manual" and not body["detail"].strip():
                raise StudioError("MANUAL_ACCEPTANCE_REQUIRED")
            p["decisions"][body["dependencyId"]] = {"choice":body["choice"],"detail":body["detail"],"solutionHash":body["solutionHash"],"operationId":body["operationId"]}
        return self.store.mutate(owner,project_id,body["operationId"],{"action":"decision",**body},change)

    def confirm(self, owner, project_id, body):
        def change(p):
            if any(t['state'] in {'running','waiting','queued'} for t in p['tasks']):
                raise StudioError('BUILD_ACTIVE',409)
            if body["solutionHash"] != digest(p["solution"]):
                raise StudioError("SOLUTION_CHANGED",409)
            self.preparation.guard(owner,p,development=True)
            if not readiness(p["solution"],p["decisions"])["ready"]:
                raise StudioError("SOLUTION_NOT_READY",409)
            if p['solution'].get('prd') is not None and (len(body.get('reviewedSections',[]))!=len(PRD_REVIEW_SECTIONS) or set(body.get('reviewedSections',[]))!=set(PRD_REVIEW_SECTIONS)):
                raise StudioError('PRD_REVIEW_REQUIRED',409)
            p["confirmation"] = {"hash":digest(p["solution"]),"decisionsHash":digest(p["decisions"]),"operationId":body["operationId"],"createdAt":time.time()}
            if p['solution'].get('prd') is not None:p['confirmation']['reviewedSections']=list(PRD_REVIEW_SECTIONS)
            p["acceptance"] = None
            p["stage"] = "confirmed"
        return self.store.mutate(owner,project_id,body["operationId"],{"action":"confirm",**body},change)

    def artifact(self, owner, project_id, artifact_hash):
        p = self.store.get(owner,project_id)
        a = next((a for a in p["artifacts"] if a["hash"] == artifact_hash),None)
        if not a:
            raise StudioError("ARTIFACT_NOT_FOUND",404)
        return p,a

    async def add_artifact(self, owner, project_id, task_id, files):
        # Trust-owned compiler; never executes generated code in the service.
        proc = await asyncio.create_subprocess_exec("node",str(self.project_root/"tools/compile-artifact.mjs"),stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE,cwd=self.project_root)
        out,_ = await asyncio.wait_for(proc.communicate(json.dumps({"files":files}).encode()),30)
        if proc.returncode:
            raise StudioError("ARTIFACT_VALIDATION_FAILED",422)
        compiled = json.loads(out)
        manifest = check_manifest(compiled["manifest"])
        def change(p):
            task = next((t for t in p["tasks"] if t["id"] == task_id),None)
            if not task or task["state"] != "running" or task["solutionHash"] != digest(p["solution"]) or not p["confirmation"]:
                raise StudioError("BUILD_VERSION_STALE",409)
            if not set(manifest["capabilities"]) <= set(p["solution"]["capabilities"]):
                raise StudioError("CAPABILITY_NOT_CONFIRMED",409)
            previous = next((a["manifest"] for a in p["artifacts"] if p.get("installed",{} ) and a["hash"]==p["installed"]["artifactHash"]),None)
            if not compatible(previous,manifest):
                raise StudioError("BREAKING_SCHEMA_CHANGE",409)
            h = digest({"files":files,"manifest":manifest,"solutionHash":task["solutionHash"],"taskId":task_id})
            version = f"0.1.{len(p['artifacts'])}"
            artifact={"hash":h,"version":version,"manifest":manifest,"solutionHash":task["solutionHash"],"confirmation":p["confirmation"],"taskId":task_id,"createdAt":time.time(),"files":files,"bundle":compiled["bundle"],"css":compiled["css"]}
            self.versions.add(p,artifact,task)
            p["artifacts"].append(artifact)
            task["state"] = "completed"
            p["acceptance"] = None
            p["stage"] = "preview"
        result = self.store.mutate(owner,project_id,"artifact_"+task_id,{"task":task_id,"filesHash":digest(files)},change)
        if getattr(self,'client_launch',None):
            # Public snapshots deliberately omit source files. The trusted archive
            # adapter needs the exact private artifact, never the redacted summary.
            _, artifact = self.artifact(owner,project_id,result['artifacts'][-1]['hash'])
            await self.client_launch.archive(owner,project_id,artifact)
            result = self.snapshot(owner,project_id)
        return result

    def accept(self, owner, project_id, body):
        def change(p):
            if any(t['state'] in {'running','waiting','queued'} for t in p['tasks']):
                raise StudioError('BUILD_ACTIVE',409)
            _,a = self.artifact(owner,project_id,body["artifactHash"])
            if not p["confirmation"] or a["solutionHash"] != digest(p["solution"]) or a["confirmation"] != p["confirmation"]:
                raise StudioError("ACCEPTANCE_STALE",409)
            if sorted(body["criteria"]) != list(range(len(p["solution"]["acceptance"]))):
                raise StudioError("ACCEPTANCE_INCOMPLETE",409)
            if not body["confirmedByUser"]:
                raise StudioError("USER_ACCEPTANCE_REQUIRED",409)
            p["acceptance"] = {"artifactHash":a["hash"],"solutionHash":a["solutionHash"],"operationId":body["operationId"],"createdAt":time.time()}
            self.versions.adoption(p,a,"legacy-user-acceptance",body["operationId"])
            p["stage"] = "accepted"
        return self.store.mutate(owner,project_id,body["operationId"],{"action":"accept",**body},change)

    def list_projects(self, owner, include_deleted=False):
        team=getattr(self,'team',None)
        if team and not team.is_admin(owner):return team.catalog(owner)
        return [public(p) for p in self.store.list(owner,include_deleted)]

    def install_payload(self, owner, project_id, artifact_hash):
        team=getattr(self,'team',None)
        if team and not team.is_admin(owner):return team.payload(owner,project_id,artifact_hash)

        p,a = self.artifact(owner,project_id,artifact_hash)
        if "versioning" in p:
            if not p["versioning"]["adoptedHash"]:raise StudioError("USER_ACCEPTANCE_REQUIRED",409)
            return self.versions.payload(owner,project_id,artifact_hash)
        if not p["acceptance"] or p["acceptance"]["artifactHash"] != artifact_hash or a["solutionHash"] != digest(p["solution"]) or not p["confirmation"] or p["confirmation"]["hash"] != digest(p["solution"]) or p["artifacts"][-1]["hash"] != artifact_hash or p["tasks"][-1]["id"] != a["taskId"] or any(t["state"] in {"queued","running","waiting"} for t in p["tasks"]):
            raise StudioError("USER_ACCEPTANCE_REQUIRED",409)
        previous = next((x["manifest"] for x in p["artifacts"] if p["installed"] and x["hash"] == p["installed"]["artifactHash"]),None)
        if not compatible(previous,a["manifest"]):
            raise StudioError("BREAKING_SCHEMA_CHANGE",409)
        return {"taskId":a["taskId"],"applicationId":p["appId"],"name":a["manifest"]["name"],"projectId":p["id"],"version":a["version"],"artifactHash":a["hash"],"manifest":a["manifest"],"bundle":a["bundle"],"css":a["css"]}

    def installed(self, owner, project_id, body):
        info = self.install_payload(owner,project_id,body["artifactHash"])
        if body["applicationId"] != info["applicationId"] or body["version"] != info["version"]:
            raise StudioError("INSTALL_RECEIPT_MISMATCH",409)
        def change(p):
            p["installed"] = {"artifactHash":body["artifactHash"],"version":body["version"],"createdAt":time.time()}
            p["stage"] = "installed"
        result=self.store.mutate(owner,project_id,body["operationId"],{"action":"installed",**body},change)
        if getattr(self,"team",None):self.team.seal(owner,project_id,info)
        return result

    def open_installed_runtime(self, owner, app_id, artifact_hash, environment):
        if environment!='production':raise StudioError('ENVIRONMENT_DENIED',403)
        team=getattr(self,'team',None)
        if team:
            try:
                publication=team.resolve(owner,app_id=app_id,artifact_hash=artifact_hash)
            except StudioError:
                if not team.is_admin(owner):raise
            else:
                a=publication['payload'];token=secrets.token_urlsafe(32)
                self.runtime_sessions[token]={'owner':owner,'project':publication['project'],'app':app_id,
                    'artifact':artifact_hash,'environment':'production','manifest':a['manifest'],'files':{},
                    'expires':time.time()+3600,'dataOwner':'team:'+app_id,'publicationDigest':digest(a)}
                return {'session':token,'manifest':a['manifest'],'bundle':a['bundle'],'css':a['css']}
        project=next((p for p in self.store.list(owner) if p['appId']==app_id),None)
        if not project:raise StudioError('APP_NOT_FOUND',404)
        return self.open_runtime(owner,project['id'],artifact_hash,'production')

    def open_runtime(self, owner, project_id, artifact_hash, environment):
        p,a = self.artifact(owner,project_id,artifact_hash)
        if environment == "production" and (not p["installed"] or p["installed"]["artifactHash"] != artifact_hash):
            raise StudioError("APP_NOT_INSTALLED",409)
        token = secrets.token_urlsafe(32)
        self.runtime_sessions[token] = {"owner":owner,"project":project_id,"app":p["appId"],"artifact":artifact_hash,"environment":environment,"manifest":a["manifest"],"files":{},"expires":time.time()+3600}
        return {"session":token,"manifest":a["manifest"],"bundle":a["bundle"],"css":a["css"]}

    def runtime(self, owner, token):
        s = self.runtime_sessions.get(token)
        if not s or s["owner"] != owner or s["expires"] < time.time():
            raise StudioError("RUNTIME_SESSION_EXPIRED",401)
        if "publicationDigest" in s:self.team.assert_session(owner,s)
        elif getattr(self,"team",None) and not self.team.is_admin(owner):raise StudioError("STUDIO_ADMIN_REQUIRED",403)
        return s

    async def invoke(self, owner, token, method, params):
        s = self.runtime(owner,token)
        if method not in {"data.list","data.get","data.put","data.delete","model.generate","files.read","knowledge.search","knowledge.documents","knowledge.graph","knowledge.evidence"}:
            raise StudioError("METHOD_NOT_ALLOWED",403)
        category = method.split(".")[0]
        if category not in s["manifest"]["capabilities"]:
            raise StudioError("CAPABILITY_DENIED",403)
        if method.startswith("knowledge."):
            if not getattr(self,"team",None):raise StudioError("KNOWLEDGE_UNAVAILABLE",409)
            if set(params)-{"warehouseId","query","document_ids","entity_types","limit","id"}:raise StudioError("KNOWLEDGE_INPUT_INVALID")
            from octop.infra.semantica.team_data import read_bound
            from octop.infra.semantica.client import SemanticaError
            try:return await read_bound(self.team.services,owner,s["app"],method.split(".")[1],params)
            except SemanticaError as exc:raise StudioError(exc.code,exc.status) from None
        if method.startswith("data."):
            return await asyncio.to_thread(self.data,s,method,params)
        if method == "model.generate":
            if set(params) - {"prompt"} or not isinstance(params.get("prompt"),str) or not 1 <= len(params["prompt"]) <= 24000:
                raise StudioError("MODEL_INPUT_INVALID")
            result = await self.generate(owner,s["app"] if "publicationDigest" in s else s["project"],{"messages":[{"role":"user","content":params["prompt"]}],"max_tokens":4096},published_runtime="publicationDigest" in s)
            return {"text":result["choices"][0]["message"].get("content", ""),"usage":result.get("usage")}
        if method == "files.read":
            if set(params) != {"id"} or params["id"] not in s["files"]:
                raise StudioError("FILE_NOT_SELECTED",403)
            return s["files"][params["id"]]
        raise StudioError("METHOD_NOT_ALLOWED",403)

    def data(self, s, method, params):
        if set(params) - {"collection","id","value","expectedRevision","offset","limit"}:
            raise StudioError("DATA_INPUT_INVALID")
        collection = params.get("collection")
        schema = s["manifest"]["collections"].get(collection)
        if not schema:
            raise StudioError("COLLECTION_NOT_DECLARED",403)
        scope = (s.get("dataOwner",s["owner"]),s["app"],s["environment"],collection)
        with self.store.transaction():
            if method == "data.list":
                limit = min(max(int(params.get("limit",100)),1),200)
                offset = max(int(params.get("offset",0)),0)
                rows = self.store.db.execute("SELECT id,revision,body FROM records WHERE owner=? AND app=? AND environment=? AND collection=? ORDER BY id LIMIT ? OFFSET ?",(*scope,limit,offset)).fetchall()
                total = self.store.db.execute("SELECT count(*) FROM records WHERE owner=? AND app=? AND environment=? AND collection=?",scope).fetchone()[0]
                return {"items":[{**json.loads(r["body"]),"_id":r["id"],"_revision":r["revision"]} for r in rows],"total":total}
            record_id = params.get("id") or uuid4().hex
            if not isinstance(record_id,str) or len(record_id)>128:
                raise StudioError("DATA_INPUT_INVALID")
            row = self.store.db.execute("SELECT revision,body FROM records WHERE owner=? AND app=? AND environment=? AND collection=? AND id=?",(*scope,record_id)).fetchone()
            if method == "data.get":
                return None if not row else {**json.loads(row["body"]),"_id":record_id,"_revision":row["revision"]}
            if params.get("expectedRevision",0) != (row["revision"] if row else 0):
                raise StudioError("RECORD_CHANGED",409)
            if method == "data.delete":
                self.store.db.execute("DELETE FROM records WHERE owner=? AND app=? AND environment=? AND collection=? AND id=?",(*scope,record_id))
                return {"deleted":True}
            if method != "data.put":
                raise StudioError("METHOD_NOT_ALLOWED",403)
            value = params.get("value")
            types = {"string":str,"number":(int,float),"boolean":bool}
            if not isinstance(value,dict) or set(value)-set(schema) or any(not isinstance(v,types[schema[k]]) or (schema[k]=="number" and isinstance(v,bool)) for k,v in value.items()):
                raise StudioError("RECORD_SCHEMA_INVALID")
            if len(json.dumps(value).encode()) > 262144:
                raise StudioError("RECORD_TOO_LARGE",413)
            # Old running versions preserve fields added by a newer compatible
            # version, instead of accidentally deleting fields they cannot see.
            value={**(json.loads(row['body']) if row else {}),**value}
            revision = (row["revision"] if row else 0)+1
            self.store.db.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,app,environment,collection,id) DO UPDATE SET revision=excluded.revision,body=excluded.body",(*scope,record_id,revision,json.dumps(value,ensure_ascii=False)))
            return {**value,"_id":record_id,"_revision":revision}

    async def select_files(self, owner, token, ids):
        s = self.runtime(owner,token)
        if "files" not in s["manifest"]["capabilities"] or not self.files:
            raise StudioError("FILES_UNAVAILABLE",409)
        if len(ids)>10:
            raise StudioError("FILE_LIMIT")
        if '_probeFiles' in s:
            if not set(ids)<=set(s['_probeFiles']):raise StudioError('FILE_NOT_SELECTED',403)
            selected=[s['_probeFiles'][key] for key in ids]
        else:
            selected = await self.files(owner,ids)
        if any(Path(f.get("name","")).suffix.lower() not in {".txt",".md",".csv",".json"} for f in selected):
            raise StudioError("FILE_TYPE_UNSUPPORTED")
        if any(not isinstance(f.get("text"),str) or len(f["text"].encode())>262144 for f in selected):
            raise StudioError("FILE_TOO_LARGE",413)
        s["files"] = {f["id"]:f for f in selected}
        return [{"id":f["id"],"name":f["name"],"size":len(f["text"].encode())} for f in selected]

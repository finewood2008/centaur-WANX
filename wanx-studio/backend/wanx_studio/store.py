from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

from .contracts import StudioError, digest, readiness
from .prd import ProductRequirement


class Store:
    """Dedicated WANX-side database; never opens the user's existing WANX DB."""
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = root
        self.lock = threading.RLock()
        self.db = sqlite3.connect(root / "studio.sqlite", check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(owner TEXT, key TEXT, hash TEXT, result TEXT, PRIMARY KEY(owner,key));
        CREATE TABLE IF NOT EXISTS records(owner TEXT, app TEXT, environment TEXT, collection TEXT, id TEXT, revision INTEGER, body TEXT,
          PRIMARY KEY(owner,app,environment,collection,id));
        CREATE TABLE IF NOT EXISTS usage(owner TEXT, id TEXT PRIMARY KEY, task TEXT, state TEXT, created REAL);
        CREATE TABLE IF NOT EXISTS task_events(owner TEXT, project TEXT, task TEXT, seq INTEGER, body TEXT,
          PRIMARY KEY(task,seq));
        """)
        # A server restart never labels an in-flight build as completed.
        with self.transaction():
            for row in self.db.execute("SELECT id, body FROM projects").fetchall():
                p = json.loads(row["body"])
                for task in p['tasks']:
                    for seq, event in enumerate(task.get('events', []), 1):
                        self.db.execute('INSERT OR IGNORE INTO task_events VALUES(?,?,?,?,?)',
                                        (p['owner'],p['id'],task['id'],seq,json.dumps(event,ensure_ascii=False)))
                changed = False
                for edit in p.get('_edits',{}).get('items',[]):
                    if edit['state'] in {'preparing','building','validating'}:
                        tasks=set(edit.get('taskIds',[]))|{t['id'] for t in p['tasks'] if t.get('editId')==edit['id']}
                        artifact=next((a for a in p['artifacts'] if a['taskId'] in tasks),None)
                        edit.update({'state':'completed','artifactHash':artifact['hash']} if artifact else {'state':'interrupted','error':'SERVICE_RESTARTED'})
                        changed=True
                finished_edits={e['id'] for e in p.get('_edits',{}).get('items',[]) if e['state'] in {'completed','no_change','discussed'}}
                preparation=p.get('preparation',{})
                for attempt in preparation.get('probeAttempts',[]):
                    if attempt['state']=='running':attempt['state']='interrupted';changed=True
                if preparation.get('currentProbe',{}).get('state')=='running':preparation['currentProbe']['state']='interrupted';changed=True
                interview=preparation.get('interview',{})
                if interview.get('state')=='running':
                    interview.update({'state':'failed','sync':'failed','error':'INTERVIEW_INTERRUPTED'})
                    for turn in interview.get('turns',[]):
                        if turn.get('state')=='running':turn['state']='failed'
                    changed=True
                for turn in interview.get('turns',[]):
                    if turn.get('transferredTo') in finished_edits and turn.get('state')!='completed':
                        turn['state']='completed';changed=True
                    if turn.get('state')=='queued':
                        turn['state']='paused';interview['error']='INTERVIEW_INTERRUPTED';changed=True
                for task in p["tasks"]:
                    if task["state"] in {"running", "queued", "waiting"}:
                        task["state"] = "interrupted"
                        task["error"] = "SERVICE_RESTARTED"
                        changed = True
                if changed:
                    finished=p.get('_edits',{}).get('enabled') and p['artifacts'] and all(e['state'] in {'completed','no_change','discussed','cancelled'} for e in p['_edits']['items'])
                    p['stage']=('adopted' if p.get('versioning',{}).get('adoptedHash')==p['artifacts'][-1]['hash'] else 'preview') if finished else 'interrupted'
                    self.save(p)

    @contextmanager
    def transaction(self):
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.execute("COMMIT")
            except BaseException:
                self.db.execute("ROLLBACK")
                raise

    def close(self):
        self.db.close()

    def append_event(self, owner, project_id, task_id, event):
        seq=self.db.execute('SELECT coalesce(max(seq),0)+1 FROM task_events WHERE task=?',(task_id,)).fetchone()[0]
        self.db.execute('INSERT INTO task_events VALUES(?,?,?,?,?)',(owner,project_id,task_id,seq,json.dumps(event,ensure_ascii=False)))
        return seq

    def task_events(self, owner, project_id, task_id, after=0, limit=100):
        with self.lock:
            limit=min(max(limit,1),100)
            p=self.get(owner,project_id)
            if not any(t['id']==task_id for t in p['tasks']):
                raise StudioError('TASK_NOT_FOUND',404)
            rows=self.db.execute('SELECT seq,body FROM task_events WHERE owner=? AND project=? AND task=? AND seq>? ORDER BY seq LIMIT ?',
                                 (owner,project_id,task_id,max(after,0),min(max(limit,1),100)+1)).fetchall()
            items=[{**json.loads(row['body']),'seq':row['seq']} for row in rows[:limit]]
            return {'items':items,'nextCursor':items[-1]['seq'] if items else after,'hasMore':len(rows)>limit}

    def list(self, owner: str, include_deleted=False) -> list[dict]:
        with self.lock:
            return sorted([json.loads(r[0]) for r in self.db.execute("SELECT body FROM projects WHERE owner=?", (owner,))], key=lambda x: x["updatedAt"], reverse=True) if include_deleted else [p for p in self.list(owner,True) if not p.get("deletedAt")]

    def get(self, owner: str, project_id: str, allow_deleted=False) -> dict:
        with self.lock:
            row = self.db.execute("SELECT body FROM projects WHERE owner=? AND id=?", (owner, project_id)).fetchone()
        if not row:
            raise StudioError("PROJECT_NOT_FOUND", 404)
        p=json.loads(row[0])
        if p.get("deletedAt") and not allow_deleted:
            raise StudioError("PROJECT_DELETED",404)
        return p

    def save(self, project: dict):
        project["updatedAt"] = time.time()
        self.db.execute("INSERT INTO projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", (project["id"], project["owner"], json.dumps(project, ensure_ascii=False)))

    def mutate(self, owner: str, project_id: str, key: str, payload: dict, change, *, allow_deleted=False):
        with self.transaction():
            h = digest({"project": project_id, "payload": payload})
            old = self.db.execute("SELECT hash,result FROM operations WHERE owner=? AND key=?", (owner, key)).fetchone()
            if old:
                if old[0] != h:
                    raise StudioError("OPERATION_CONFLICT", 409)
                return public(json.loads(old[1]))
            p = self.get(owner, project_id, allow_deleted)
            change(p)
            self.save(p)
            result = public(p)
            self.db.execute("INSERT INTO operations VALUES(?,?,?,?)", (owner, key, h, json.dumps(result, ensure_ascii=False)))
            return result

    def create(self, owner: str, name: str, goal: str, operation_id: str) -> dict:
        with self.transaction():
            h = digest({"name": name, "goal": goal})
            old = self.db.execute("SELECT hash,result FROM operations WHERE owner=? AND key=?", (owner, operation_id)).fetchone()
            if old:
                if old[0] != h:
                    raise StudioError("OPERATION_CONFLICT", 409)
                return public(json.loads(old[1]))
            p = {"id": uuid4().hex, "appId": "ai.wanx.selfmade." + uuid4().hex, "owner": owner, "name": name,
                 "nameMode":"auto", "autoName":None, "originalGoal": goal, "stage": "discovery", "createdAt": time.time(), "updatedAt": time.time(),
                 "messages": [{"id": uuid4().hex,"role":"user","text":goal}],
                 "solution": {"audience":"","workflow":"","inputs":"","outputs":"","fields":[],"acceptance":[],"capabilities":["data","model"],"dependencies":[],"prd":ProductRequirement().model_dump()},
                 "revisions": [], "decisions": {}, "confirmation": None, "tasks": [], "artifacts": [], "acceptance": None, "installed": None}
            self.save(p)
            result = public(p)
            self.db.execute("INSERT INTO operations VALUES(?,?,?,?)", (owner,operation_id,h,json.dumps(result,ensure_ascii=False)))
            return result


def public(project: dict) -> dict:
    # Source and bundled code are served only through dedicated artifact routes.
    result = {k: v for k, v in project.items() if k in {"id","appId","name","nameMode","autoName","originalGoal","stage","createdAt","updatedAt","messages","solution","revisions","decisions","confirmation","tasks","artifacts","acceptance","installed","preparation","engine","versioning","versionFixture","deletedAt","example"}}
    from .versions import summaries,state
    result["artifacts"] = [{k:v for k,v in a.items() if k not in {"files","bundle","css","snapshot","checkpoint","checkpointHash"}} for a in project["artifacts"]]
    result["tasks"]=[{k:v for k,v in t.items() if k in {"id","executor","version","state","solutionHash","createdAt","events","question","baseHash","iterationId","instruction","operationId","engine","error"}} for t in project["tasks"]]
    result["versions"]=summaries(project)
    result["versioning"]=state(project)
    result["versioning"]["iterations"]=[{k:v for k,v in item.items() if k!="draft"} for item in result["versioning"]["iterations"]]
    result["solutionHash"] = digest(project["solution"])
    result['readiness'] = readiness(project['solution'],project['decisions'])
    if 'preparation' in project and not project['artifacts']:
        from .iterative import proposal
        complete=proposal(project)
        result['readiness']['ready']=result['readiness']['ready'] and complete['ready']
        result['readiness']['needsReview']=complete['needsCompletenessReview']
    return result

"""WANX engine selection; Codex uses the managed native app-server runtime."""
import re
import time
import socket
from .contracts import StudioError,digest

class Engines:
 def __init__(self,svc,provider=None):
  self.svc=svc;self.provider=provider;self.checks={}
  svc.store.db.execute('CREATE TABLE IF NOT EXISTS studio_preferences(owner TEXT PRIMARY KEY,engine TEXT)')
 def configs(self,owner):return self.provider(owner) if self.provider else {}
 def fingerprint(self,owner,key):
  raw=self.configs(owner).get(key)
  if raw is None:raise StudioError('ENGINE_NOT_CONFIGURED',409)
  return digest({'instance':str(self.svc.store.root.resolve()),'owner':owner,'id':key,'config':raw})
 def supported(self,key,raw):
  # Admin-defined executable strings are not an arbitrary-command escape hatch.
  command=raw.get('command','').split('/')[-1]
  args=raw.get('args',[])
  # Keep existing saved ACP bindings valid; their command is not executed.
  return key=='codex' and (command=='codex' and args==['app-server'] or command=='codex-acp' and not args or command=='npx' and args in [['-y','@zed-industries/codex-acp'],['-y','@agentclientprotocol/codex-acp']]) and not raw.get('env') and raw.get('trusted',False)
 def item(self,owner,key,raw):
  fp=self.fingerprint(owner,key);check=self.checks.get((owner,key,fp))
  adapted=self.supported(key,raw)
  status='unsupported' if not adapted else 'disabled' if not raw.get('enabled',False) else check['status'] if check else 'unchecked'
  return {'id':key,'name':'Codex' if key=='codex' else re.sub(r'[^\w .-]','',key)[:60],'enabled':bool(raw.get('enabled',False)),'adapted':adapted,'status':status,'fingerprint':fp,'location':'WANX 服务 · '+socket.gethostname(),'checkedAt':check['at'] if check else None,'code':check.get('code') if check else None}
 def list(self,owner):
  items=[self.item(owner,k,v) for k,v in self.configs(owner).items()]
  row=self.svc.store.db.execute('SELECT engine FROM studio_preferences WHERE owner=?',(owner,)).fetchone()
  default=row[0] if row else 'codex' if any(i['id']=='codex' and i['adapted'] and i['enabled'] for i in items) else None
  return {'version':1,'items':items,'defaultId':default,'location':'WANX 服务 · '+socket.gethostname()}
 async def check(self,owner,key):
  item=self.require(owner,key);result=await self.svc.runner.preflight(fresh=True)
  self.checks[(owner,key,item['fingerprint'])]={'status':'available' if result['available'] else 'failed','code':result.get('code'),'at':time.time()}
  return self.list(owner)
 def require(self,owner,key):
  raw=self.configs(owner).get(key)
  if raw is None:raise StudioError('ENGINE_NOT_CONFIGURED',409)
  item=self.item(owner,key,raw)
  if not item['adapted']:raise StudioError('ENGINE_NOT_ADAPTED',409)
  if not item['enabled']:raise StudioError('ENGINE_DISABLED',409)
  return item
 def select(self,owner,key):
  self.require(owner,key)
  with self.svc.store.transaction():self.svc.store.db.execute('INSERT INTO studio_preferences VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET engine=excluded.engine',(owner,key))
  return self.list(owner)
 def bind(self,owner,p,key=None):
  key=key or self.list(owner)['defaultId']
  if not key:raise StudioError('ENGINE_NOT_CONFIGURED',409)
  item=self.require(owner,key);p['engine']={k:item[k] for k in ['id','name','fingerprint','location']}
 def guard(self,owner,p,required=False):
  if not self.provider:return # Legacy test/local service has no WANX registry.
  binding=p.get('engine')
  if not binding:
   if not required and 'preparation' not in p:return # Existing installed/accepted products need no new build binding.
   raise StudioError('ENGINE_BINDING_REQUIRED',409)
  item=self.require(owner,binding['id'])
  if item['fingerprint']!=binding['fingerprint']:raise StudioError('ENGINE_CONFIGURATION_CHANGED',409)

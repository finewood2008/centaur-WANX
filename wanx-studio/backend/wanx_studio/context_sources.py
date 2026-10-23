"""WANX-owned sources. Only this trusted adapter sees storage and service credentials."""
import asyncio
from pathlib import Path
import re
from .contracts import StudioError, TEXT_EXTENSIONS, digest

class WanxContextSources:
 def __init__(self,server,space,files):self.server,self.space,self.files=server,space,files
 def fingerprint(self):
  path=self.server.paths.root/'semantica.json'
  # Detect configuration rotation without copying or hashing credential values.
  stat=path.stat() if path.exists() else None
  return {'space':str(self.server.paths.root.resolve()),'xingtuConfigurationRevision':stat.st_mtime_ns if stat else None}
 def star(self,owner):
  from octop.infra.semantica.client import SemanticaClient
  return SemanticaClient.from_file(self.server.paths.root/'semantica.json',int(owner.removeprefix('wanx:')),'wanx')
 def team_star(self,owner):
  from octop.infra.semantica.client import SemanticaClient
  user=self.server.services.user_repo.get(int(owner.removeprefix('wanx:')))
  if not user or user.disabled or user.role!='admin':raise StudioError('STUDIO_ADMIN_REQUIRED',403)
  return SemanticaClient.from_file(self.server.paths.root/'semantica.json',user.id,'wanx',team=True)
 def workspaces(self,owner):
  from octop.infra.personal_space.workspaces import Workspaces
  return Workspaces(self.server.paths.root/'.wanx-personal-space',int(owner.removeprefix('wanx:')))
 async def launch_sources(self,owner,kind,parent='',space_id='personal'):
  if kind=='warehouses':
   value=await self.team_star(owner).request('GET','/warehouses')
   return {'items':[{'id':r['id'],'name':r.get('name') or r['id']} for r in value.get('items',value.get('warehouses',[]))]}
  if kind not in {'storage','references'}:raise StudioError('CONTEXT_KIND_INVALID')
  storage=self.workspaces(owner)
  if not parent:
   items=await asyncio.to_thread(storage.spaces)
   return {'items':[{'id':s['id'],'name':s['name'],'root':s['root'],'itemKind':'space'} for s in items if not s.get('trashed')]}
  # Prefix is private picker navigation, never an OS path.
  folder='' if parent=='root' else parent
  value=await asyncio.to_thread(storage.listing,folder,False,space_id)
  spaces=await asyncio.to_thread(storage.spaces)
  current=next(s for s in spaces if s['id']==value['space_id'])
  return {'items':[self.project_metadata('space',x) for x in value['items'] if x['kind']=='folder' or kind=='references' and Path(x['name']).suffix.lower() in TEXT_EXTENSIONS and x.get('size',0)<=262144],'parent':value['parent'],'spaceId':value['space_id'],'spaceName':current['name'],'root':value['root'],'breadcrumbs':value['breadcrumbs'],'folderName':(await asyncio.to_thread(storage.metadata,value['parent']))['name'] if value['parent'] else current['name']}
 async def launch_storage(self,owner,selection):
  if set(selection)-{'spaceId','folderId','name','spaceName'}:raise StudioError('PROJECT_STORAGE_INVALID')
  storage=self.workspaces(owner)
  spaces=await asyncio.to_thread(storage.spaces)
  selected=next((s for s in spaces if s['id']==selection.get('spaceId') and not s.get('trashed')),None)
  if not selected:raise StudioError('PROJECT_STORAGE_UNAVAILABLE',403)
  folder=selection.get('folderId','')
  if folder:
   item=await asyncio.to_thread(storage.metadata,folder)
   if item['kind']!='folder' or item['space_id']!=selected['id']:raise StudioError('PROJECT_STORAGE_UNAVAILABLE',403)
   name=item['name']
  else:
   if selected['root']:raise StudioError('PROJECT_STORAGE_UNAVAILABLE',403)
   name=selected['name']
  return {'spaceId':selected['id'],'folderId':folder,'name':name,'spaceName':selected['name']}
 async def launch_warehouse(self,owner,key):
  if not re.fullmatch(r'[a-f0-9-]{36}',key):raise StudioError('CONTEXT_REFERENCE_INVALID')
  star=self.team_star(owner)
  detail=await star.request('GET','/warehouses/'+key)
  warehouse=detail.get('warehouse',detail)
  refs=[];offset=0
  while True:
   result=await star.request('GET','/warehouses/'+key+'/documents',query={'limit':'200','offset':str(offset)})
   items=result.get('items',result.get('documents',[]))
   for doc in items:
    meta=self.project_metadata('xingtu',doc);meta['id']='team-'+key+'__'+meta['id'];meta.pop('itemKind',None);refs.append(meta)
   if len(refs)>1000:raise StudioError('CONTEXT_TOO_MANY_DOCUMENTS',409)
   if not items or not result.get('has_more',len(items)==200):break
   offset+=len(items)
  return {'id':key,'name':warehouse.get('name') or key},refs
 async def launch_archive(self,owner,pid,selection,artifact):
  import hashlib,json
  selected=await self.launch_storage(owner,selection)
  storage=self.workspaces(owner)
  # Immutable per-version archive, no overwriting user's existing files.
  payload=json.dumps({'projectId':pid,'version':artifact['version'],'artifactHash':artifact['hash'],'files':artifact['files']},ensure_ascii=False,indent=2).encode()
  key=hashlib.sha256((pid+artifact['hash']).encode()).hexdigest()[:32]
  try:
   existing=await asyncio.to_thread(storage.metadata,key)
   return {'id':key,'name':existing['name'],'state':'saved'}
  except Exception as error:
   if getattr(error,'code','')!='SPACE_NOT_FOUND':raise
  name='WanX-'+pid[:8]+'-v'+artifact['version']+'.json'
  await asyncio.to_thread(storage.upload_create,selected['folderId'],name,len(payload),key,selected['spaceId'])
  state=await asyncio.to_thread(storage.upload_status,key)
  offset=state['offset']
  while offset<len(payload):
   block=payload[offset:offset+1024*1024]
   await asyncio.to_thread(storage.upload_chunk,key,offset,block,hashlib.sha256(block).hexdigest());offset+=len(block)
  result=await asyncio.to_thread(storage.upload_complete,key,hashlib.sha256(payload).hexdigest())
  return {'id':result['id'],'name':result['name'],'state':'saved'}
 def project_metadata(self,kind,item):
  key=str(item.get('id',item.get('document_id','')))
  if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',key):raise StudioError('CONTEXT_REFERENCE_INVALID')
  return {'kind':kind,'id':key,'name':str(item.get('name') or item.get('title') or key),'revision':digest({k:item.get(k) for k in ['id','document_id','modified','updated_at','revision','size','status']}),'itemKind':item.get('kind','file')}
 async def list(self,owner,kind,parent=''):
  try:
   if kind=='space':
    value=await asyncio.to_thread(self.space(owner).listing,parent,False)
    return {'items':[self.project_metadata(kind,x) for x in value['items']],'parent':value['parent'],'breadcrumbs':value['breadcrumbs']}
   if parent and not re.fullmatch(r'offset:[0-9]{1,7}',parent):raise StudioError('CONTEXT_REFERENCE_INVALID')
   offset=int(parent.split(':')[1]) if parent else 0
   value=await self.star(owner).request('GET','/documents',query={'limit':'200','offset':str(offset)})
   items=value.get('items',value.get('documents',[]))
   more=value.get('has_more',len(items)==200)
   return {'items':[self.project_metadata(kind,x) for x in items],'parent':parent,'hasMore':more,'nextParent':f'offset:{offset+len(items)}' if more and items else None}
  except StudioError:raise
  except Exception as e:raise StudioError(getattr(e,'code','CONTEXT_UNAVAILABLE'),getattr(e,'status',409)) from None
 async def metadata(self,owner,kind,key):
  if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',key):raise StudioError('CONTEXT_REFERENCE_INVALID')
  try:
   if kind=='xingtu' and key.startswith('team-'):
    if not re.fullmatch(r'team-[a-f0-9-]{36}__[A-Za-z0-9_-]{1,80}',key):raise StudioError('CONTEXT_REFERENCE_INVALID')
    warehouse,doc=key[5:].split('__',1)
    value=await self.team_star(owner).request('GET','/warehouses/'+warehouse+'/documents/'+doc)
    meta=self.project_metadata(kind,value.get('document',value));meta['id']=key;meta.pop('itemKind',None);return meta
   if kind=='space':
    value=await asyncio.to_thread(self.space(owner).metadata,key)
    if value['kind']!='file':raise StudioError('CONTEXT_FILE_REQUIRED')
   else:
    value=await self.star(owner).request('GET','/documents/'+key)
    value=value.get('document',value)
   meta=self.project_metadata(kind,value);meta.pop('itemKind',None);return meta
  except StudioError:raise
  except Exception as e:raise StudioError(getattr(e,'code','CONTEXT_UNAVAILABLE'),getattr(e,'status',409)) from None
 async def read(self,owner,kind,key):
  await self.metadata(owner,kind,key)
  if kind=='space':return (await self.files(owner,[key]))[0]['text']
  try:
   if key.startswith('team-'):
    warehouse,doc=key[5:].split('__',1)
    result=await self.team_star(owner).request('GET','/warehouses/'+warehouse+'/documents/'+doc+'/text')
   else:result=await self.star(owner).request('GET','/documents/'+key+'/text')
   text=result.get('text',result.get('content'))
   if not isinstance(text,str):raise StudioError('CONTEXT_PARSE_FAILED',422)
   return text
  except StudioError:raise
  except Exception as e:raise StudioError(getattr(e,'code','CONTEXT_UNAVAILABLE'),getattr(e,'status',409)) from None

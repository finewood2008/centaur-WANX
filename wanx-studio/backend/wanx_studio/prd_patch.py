"""Incremental, version-bound PRD edits. IDs live beside the legacy PRD contract."""
from copy import deepcopy
from uuid import uuid4
from .contracts import Solution, StudioError, digest

ARRAYS={'scenarios','features','pages','dataFields','rules','exceptions','tests','outOfScope','openQuestions'}
TEXT={'problem','currentApproach','successOutcome'}

def rows(project):
    ids=project['preparation'].setdefault('entryIds',{})
    result={}
    for section in ARRAYS:
        values=project['solution']['prd'][section]
        names=ids.setdefault(section,[])
        while len(names)<len(values):names.append(uuid4().hex)
        if len(names)!=len(values):raise StudioError('PRD_IDS_CHANGED',409)
        result[section]=[{'id':key,'value':value} for key,value in zip(names,values)]
    return result

def apply_patch(project,args):
    if set(args)-{'expectedHash','text','upsert','remove','summary','capabilities','provenance','scopeDecisions'}:raise StudioError('PRD_PATCH_INVALID')
    if args.get('expectedHash')!=digest(project['solution']):raise StudioError('SOLUTION_CHANGED',409)
    candidate=deepcopy(project)
    indexed=rows(candidate)
    for key,value in args.get('text',{}).items():
        if key not in TEXT or not isinstance(value,str):raise StudioError('PRD_PATCH_INVALID')
        candidate['solution']['prd'][key]=value
    for change in args.get('remove',[]):
        if set(change)!={'section','id'} or change['section'] not in ARRAYS:raise StudioError('PRD_PATCH_INVALID')
        entries=indexed[change['section']]
        if not any(e['id']==change['id'] for e in entries):raise StudioError('PRD_ENTRY_NOT_FOUND',409)
        entries[:]=[e for e in entries if e['id']!=change['id']]
    for change in args.get('upsert',[]):
        if set(change)-{'section','id','value'} or change.get('section') not in ARRAYS or 'value' not in change:raise StudioError('PRD_PATCH_INVALID')
        entries=indexed[change['section']]; key=change.get('id')
        if key:
            entry=next((e for e in entries if e['id']==key),None)
            if not entry:raise StudioError('PRD_ENTRY_NOT_FOUND',409)
            entry['value']=change['value']
        else:entries.append({'id':uuid4().hex,'value':change['value']})
    for section,entries in indexed.items():
        candidate['solution']['prd'][section]=[e['value'] for e in entries]
        candidate['preparation']['entryIds'][section]=[e['id'] for e in entries]
    for key,value in args.get('summary',{}).items():
        if key not in {'audience','workflow','inputs','outputs','projectName'} or not isinstance(value,str):raise StudioError('PRD_PATCH_INVALID')
        if key=='projectName':
            if not 1<=len(value)<=40:raise StudioError('PROJECT_NAME_REQUIRED')
            candidate['autoName']=value
            if candidate.get('nameMode')=='auto':candidate['name']=value
        else:candidate['solution'][key]=value
    if 'capabilities' in args:candidate['solution']['capabilities']=args['capabilities']
    prd=candidate['solution']['prd']
    candidate['solution']['fields']=[f['name'] for f in prd['dataFields']]
    candidate['solution']['acceptance']=[t['title']+'：'+t['then'] for t in prd['tests']]
    candidate['solution']=Solution.model_validate(candidate['solution']).model_dump(exclude_none=True)
    source_ids={r['kind']+':'+r['id'] for r in candidate['preparation']['references']}
    message_ids={m['id'] for m in candidate['messages'] if m['role']=='user'}|{m['id'] for m in candidate['preparation']['messages'] if m['role']=='user'}
    provenance=args.get('provenance',[])
    for item in provenance:
        if set(item)-{'section','kind','sources','note'} or item.get('section') not in TEXT|ARRAYS or item.get('kind') not in {'user','background','hypothesis'}:raise StudioError('PRD_PROVENANCE_INVALID')
        if not set(item.get('sources',[]))<=source_ids|message_ids:raise StudioError('CONTEXT_NOT_SELECTED',403)
        if item['kind']=='background' and not set(item.get('sources',[]))&source_ids:raise StudioError('PRD_PROVENANCE_INVALID')
        if item['kind']=='user' and not set(item.get('sources',[]))&message_ids:raise StudioError('PRD_PROVENANCE_INVALID')
    candidate['preparation'].setdefault('provenance',[]).extend(provenance)
    return candidate

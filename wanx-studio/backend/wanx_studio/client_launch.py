"""Private client launch bridge. Existing public Studio contracts stay unchanged."""
import json
from uuid import uuid4
from fastapi import Depends
from pydantic import Field
from .contracts import Input, Operation, StudioError, digest, has_credentials, TEXT_EXTENSIONS
from pathlib import Path


class Suggest(Input):
    text: str = Field(min_length=1, max_length=12000)


class Launch(Operation):
    projectId: str | None = None
    expectedRevision: int = 0
    original: str = Field(min_length=1, max_length=12000)
    requirement: str = Field(min_length=1, max_length=12000)
    confirmed: bool
    engineId: str
    storage: dict
    warehouseIds: list[str] = Field(default_factory=list, max_length=10)
    references: list[dict] = Field(default_factory=list, max_length=100)


PROMPT = '''你是需求整理助手。将用户的一段需求改写为简洁、可编辑的构建简报，一次完成，不提问，不写完整PRD。保留用户意图，按“目标、主要使用方式、核心功能、建议边界、待在Builder确认”组织。可以补充合理建议，但明确标注“建议”，不得捏造业务事实、权限、日期、接口或承诺。未知内容标为待确认。不要读取或索取资料、不要启动开发。只返回JSON：{"requirement":"整理后的中文需求，最多9000字"}。'''


class ClientLaunch:
    def __init__(self, svc):
        self.svc = svc

    def provider(self):
        value = getattr(self.svc, 'context_provider', None)
        if not value: raise StudioError('CONTEXT_UNAVAILABLE', 409)
        return value

    async def suggest(self, owner, body):
        text = body['text'].strip()
        if not text: raise StudioError('INTAKE_TEXT_REQUIRED')
        if has_credentials(text): raise StudioError('INPUT_CREDENTIAL_DETECTED')
        result = await self.svc.generate(owner, 'client-launch-suggestion', {
            'messages': [{'role':'system', 'content':PROMPT}, {'role':'user', 'content':text}], 'max_tokens':4096
        }, published_runtime=True)
        try:
            choice = result['choices'][0]
            if choice.get('finish_reason', 'stop') != 'stop': raise ValueError()
            raw = choice['message']['content'].strip()
            if raw.startswith('```'): raw = raw.split('\n', 1)[1].rsplit('```', 1)[0]
            value = json.loads(raw)
            if set(value) != {'requirement'} or not isinstance(value['requirement'], str) or not 1 <= len(value['requirement'].strip()) <= 12000: raise ValueError()
            if has_credentials(value['requirement']): raise ValueError()
            return {'requirement':value['requirement'].strip(), 'inputHash':digest(text)}
        except (KeyError, TypeError, ValueError):
            raise StudioError('INTAKE_RESPONSE_INVALID', 502) from None

    async def configure(self, owner, body):
        if not body['confirmed']: raise StudioError('REQUIREMENT_CONFIRMATION_REQUIRED', 409)
        text = body['requirement'].strip()
        if not text or has_credentials(text) or has_credentials(body['original']): raise StudioError('INPUT_CREDENTIAL_DETECTED')
        provider = self.provider()
        storage = await provider.launch_storage(owner, body['storage'])
        refs = await self.svc.preparation.validate_references(owner, body['references'])
        if any(r['kind']=='space' and Path(r['name']).suffix.lower() not in TEXT_EXTENSIONS for r in refs):
            raise StudioError('FILE_TYPE_UNSUPPORTED',409)
        warehouse_ids = list(dict.fromkeys(body['warehouseIds']))
        warehouses = []
        for key in warehouse_ids:
            warehouse, selected = await provider.launch_warehouse(owner, key)
            warehouses.append(warehouse)
            refs.extend(selected)
        refs = list({(r['kind'], r['id']):r for r in refs}.values())
        if len(refs) > 1000: raise StudioError('CONTEXT_TOO_MANY_DOCUMENTS', 409)
        self.svc.engines.require(owner, body['engineId'])
        pid = body.get('projectId')
        if pid:
            p = self.svc.store.get(owner, pid)
            prior=p['preparation'].get('launchRequest')
            if prior and prior['operationId']==body['operationId']:
                if prior['hash']!=digest(body):raise StudioError('OPERATION_CONFLICT',409)
                return self.svc.snapshot(owner,pid)
            if p['preparation']['revision'] != body['expectedRevision']: raise StudioError('INTAKE_CHANGED', 409)
            if p['preparation']['phase'] != 'intake' or p['tasks']: raise StudioError('INTAKE_ALREADY_HANDED_OFF', 409)
        else:
            p = self.svc.store.create(owner, text.splitlines()[0].removeprefix('目标：')[:30] or '新应用', body['original'].strip(), body['operationId'])
            pid = p['id']
            self.svc.preparation.enable(owner, pid)
        async with self.svc.preparation.lock(owner, pid):
            def apply(p):
                x = p['preparation']
                if x['phase'] != 'intake' or p['tasks']: raise StudioError('INTAKE_ALREADY_HANDED_OFF', 409)
                if body.get('projectId') and x['revision'] != body['expectedRevision']: raise StudioError('INTAKE_CHANGED', 409)
                self.svc.engines.bind(owner, p, body['engineId'])
                x['brief'] = {'goal':text, 'scenario':'', 'currentApproach':'', 'pain':'', 'outcome':'', 'boundaries':[], 'openQuestions':[]}
                # Only the explicit user-confirmed rewrite becomes authoritative.
                x['messages'].append({'id':uuid4().hex, 'role':'user', 'text':text, 'operationId':body['operationId']})
                x['references'] = refs
                x['contextRevision'] += 1
                x['revision'] += 1
                x['report'] = None
                x['required'] = []  # Runtime permissions are decided in the Builder PRD.
                x['gaps'] = []
                x['launchConfiguration'] = {'version':1, 'requirement':text, 'original':body['original'].strip(), 'confirmedByUser':True, 'storage':storage, 'warehouses':warehouses, 'engineId':body['engineId']}
                x['launchRequest'] = {'operationId':body['operationId'],'hash':digest(body)}
                self.svc.preparation.event(p, 'launch.configured')
            return self.svc.store.mutate(owner, pid, 'launch-config-'+body['operationId'], body, apply)

    async def start(self, owner, pid):
        p = self.svc.preparation.get(owner, pid)
        config = p['preparation'].get('launchConfiguration')
        if not config or not config.get('confirmedByUser'): raise StudioError('REQUIREMENT_CONFIRMATION_REQUIRED', 409)
        await self.provider().launch_storage(owner, config['storage'])
        await self.svc.preparation.validate_references(owner, p['preparation']['references'])
        p = await self.svc.preparation.check(owner, pid, {'operationId':uuid4().hex})
        p = await self.svc.preparation.handoff(owner, pid, {'expectedRevision':p['preparation']['revision']})
        # Open PRD discussion; only the separate PRD confirmation can start coding.
        return p

    async def archive(self, owner, pid, artifact):
        config = self.svc.store.get(owner, pid).get('preparation', {}).get('launchConfiguration')
        if not config: return
        try:
            receipt = await self.provider().launch_archive(owner, pid, config['storage'], artifact)
            self.svc.preparation.mutate(owner, pid, 'launch-archive', lambda p: p['preparation'].setdefault('storageReceipts', {}).update({artifact['hash']:receipt}))
            return receipt
        except Exception as error:
            code = getattr(error, 'code', 'PROJECT_STORAGE_WRITE_FAILED')
            self.svc.preparation.mutate(owner, pid, 'launch-archive-failed', lambda p: self.svc.preparation.event(p, 'storage.failed', code=code, artifactHash=artifact['hash']))


def mount_client_launch(router, svc, identity):
    bridge = ClientLaunch(svc)
    svc.client_launch = bridge

    @router.post('/_client/launch/suggest', include_in_schema=False)
    async def suggest(body:Suggest, owner=Depends(identity)):
        return await bridge.suggest(owner, body.model_dump())

    @router.get('/_client/launch/sources', include_in_schema=False)
    async def sources(kind:str, parent:str='', spaceId:str='personal', owner=Depends(identity)):
        return await bridge.provider().launch_sources(owner, kind, parent, spaceId)

    @router.post('/_client/launch/configure', include_in_schema=False)
    async def configure(body:Launch, owner=Depends(identity)):
        return await bridge.configure(owner, body.model_dump())

    @router.post('/_client/launch/{pid}/start', include_in_schema=False)
    async def start(pid:str, owner=Depends(identity)):
        return await bridge.start(owner, pid)

    @router.post('/_client/launch/{pid}/archive/{artifact_hash}', include_in_schema=False)
    async def retry_archive(pid:str, artifact_hash:str, owner=Depends(identity)):
        _, artifact = svc.artifact(owner, pid, artifact_hash)
        receipt = await bridge.archive(owner, pid, artifact)
        if not receipt:
            raise StudioError('PROJECT_STORAGE_WRITE_FAILED', 409)
        return svc.snapshot(owner, pid)

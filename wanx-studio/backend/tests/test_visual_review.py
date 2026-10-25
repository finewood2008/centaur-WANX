import base64
from copy import deepcopy
import json
import struct
import zlib

import pytest
from pydantic import ValidationError

from test_studio import svc, seeded, op
from test_iterative import start
from test_versions import candidate
from wanx_studio.contracts import StudioError
from wanx_studio.store import public
from wanx_studio.visual_review import VisualReview, authorize_visual


def review(p):
    def chunk(name,data):return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data))
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',20,20,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\0'+b'\xff'*60)*20))+chunk(b'IEND',b'')
    return {'baseHash':p['artifacts'][-1]['hash'],'expectedRevision':p['versioning']['revision'],
            'image':'data:image/png;base64,'+base64.b64encode(png).decode(),
            'viewport':{'width':1000,'height':600},'regions':[{'x':.1,'y':.1,'width':.2,'height':.3}]}


async def test_visual_build_freezes_pixels_and_baseline_but_keeps_them_out_of_public_state(svc,monkeypatch):
    p=await seeded(svc);p=svc.store.get('alice',p['id']);before=deepcopy(svc.store.get('alice',p['id'])['artifacts'][0]);v=review(p)
    result,body=await start(svc,p,monkeypatch,visualReview=v)
    stored=svc.store.get('alice',p['id']);task=stored['tasks'][-1]
    assert task['visualReview']==v and task['baseHash']==before['hash']
    assert stored['artifacts'][0]==before
    assert 'visualReview' not in result['tasks'][-1]
    assert v['image'] not in json.dumps(public(stored))
    again=await svc.runner.start('alice',p['id'],{'operationId':body['operationId'],'solutionHash':body['specHash'],'instruction':body['instruction']},iterative=body)
    assert again['tasks'][-1]['id']==task['id']
    with pytest.raises(StudioError,match='PROJECT_NOT_FOUND'):
        await svc.runner.start('bob',p['id'],{'operationId':op(),'solutionHash':body['specHash'],'instruction':''},iterative=body)


async def test_visual_build_rejects_stale_version_revision_and_plan(svc):
    p=await seeded(svc);v=review(p)
    assert authorize_visual(svc.store.get('alice',p['id']),v)['regions']==v['regions']
    for changes in [{'expectedRevision':v['expectedRevision']+1},{'baseHash':'0'*64}]:
        with pytest.raises(StudioError):authorize_visual(svc.store.get('alice',p['id']),{**v,**changes})
    p=deepcopy(svc.store.get('alice',p['id']));p['solution']['outputs']='changed'
    with pytest.raises(StudioError,match='VISUAL_REVIEW_STALE'):authorize_visual(p,v)


async def test_visual_input_rejects_non_images_oversize_and_outside_regions(svc):
    p=await seeded(svc);v=review(p)
    for changes in [{'image':'file:///secret'},{'image':'data:image/svg+xml;base64,AAAA'},
                    {'image':'data:image/png;base64,'+'A'*1400000},
                    {'regions':[]},{'regions':[{'x':.9,'y':0,'width':.5,'height':.2}]},
                    {'regions':[{'x':float('nan'),'y':0,'width':.2,'height':.2}]}]:
        with pytest.raises(ValidationError):VisualReview.model_validate({**v,**changes})


async def test_restore_previous_unadopted_version_archives_iteration_and_preserves_data(svc):
    p=await seeded(svc);old=p['artifacts'][0]['hash'];p=await candidate(svc,p)
    current=p['artifacts'][-1]['hash'];draft=deepcopy(p['solution'])
    session=svc.open_runtime('alice',p['id'],current,'preview')['session']
    row=await svc.invoke('alice',session,'data.put',{'collection':'items','value':{'title':'试用数据'}})
    check=svc.versions.restore_check('alice',p['id'],old)
    result=svc.versions.restore('alice',p['id'],{'operationId':op(),'expectedRevision':check['expectedRevision'],'artifactHash':old,'checkHash':check['checkHash'],'confirmedByUser':True})
    assert len(result['artifacts'])==3 and result['artifacts'][-1]['restoredFrom']==old
    assert result['versioning']['iteration'] is None and result['versioning']['iterations'][-1]['state']=='abandoned'
    stored=svc.store.get('alice',p['id'])
    assert stored['versioning']['iterations'][-1]['draft']['solution']==draft
    assert {old,current}<=set(a['hash'] for a in stored['artifacts'])
    assert (await svc.invoke('alice',session,'data.get',{'collection':'items','id':row['_id']}))['title']=='试用数据'

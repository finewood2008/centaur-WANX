import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpaceLinkBridge} from '../shell/space-links.mjs';

test('Agent HTTP enrollment rejects impersonation and keeps approval bound to account and box', async t => {
  let saved, listener, account='owner', box='box-a';
  const calls=[];
  const connection='a'.repeat(32), space='b'.repeat(32), root='c'.repeat(32);
  const client={
    snapshot:()=>({phase:'ready',account:{phase:account?'authenticated':'out',accountId:account},connection:{deviceId:box}}),
    subscribe(fn){listener=fn;return ()=>{};},
    applicationConnection:async()=>({context(){},request:async input=>{
      calls.push(input);
      const value=input.path.endsWith('/connections') ? {id:connection,space_id:space,root,token:JSON.parse(input.body).credential}
        : input.path.endsWith('/spaces') ? [{id:space,connections:[{id:connection,state:'active'}]}]
          : {id:root,kind:'folder'};
      return {status:200,headers:{},body:Buffer.from(JSON.stringify(value))};
    }}),
  };
  const bridge=await createSpaceLinkBridge({client,serviceURL:'https://platform.test',store:{load:async()=>saved,save:async value=>{saved=structuredClone(value);}}});
  t.after(()=>bridge.close());
  const profile='d'.repeat(32), key='e'.repeat(43);
  const post=(route,body,headers={})=>fetch(`http://127.0.0.1:${saved.port}${route}`,{method:'POST',headers:{'content-type':'application/json',Connection:'close',...headers},body:JSON.stringify(body)});
  const enroll=()=>post('/space-agents/enroll',{profile,key,name:'Same name'});
  const pending=await (await enroll()).json();
  assert.equal(pending.status,'pending');
  assert.equal((await (await enroll()).json()).id,pending.id);
  assert.equal((await post('/space-agents/enroll',{profile,key:'f'.repeat(43)})).status,403);
  assert.equal((await post('/space-agents/'+key,{action:'list'})).status,403);
  assert.equal((await post('/space-agents/'+key,{action:'connection-status'},{Origin:'https://untrusted.test'})).status,403);
  assert.equal(calls.length,0);
  await bridge.manage('reject',{id:pending.id});
  assert.equal((await post('/space-agents/'+key,{action:'list'})).status,403);
  assert.equal(calls.length,0);
  await bridge.manage('approve',{id:pending.id,name:'Approved'});
  assert.equal((await post('/space-agents/'+key,{action:'stat'})).status,200);
  const before=calls.length;
  box='box-b';listener();
  assert.equal((await post('/space-agents/'+key,{action:'stat'})).status,409);
  box='box-a';account='other';listener();
  assert.equal((await post('/space-agents/'+key,{action:'stat'})).status,409);
  account=null;listener();
  assert.equal((await post('/space-agents/'+key,{action:'stat'})).status,503);
  assert.equal(calls.length,before,'changed scope must not forward requests to a different owner or box');
  account='owner';listener();
  assert.equal((await post('/space-agents/'+key,{action:'stat'})).status,200);
  const status=await (await enroll()).text();
  assert.ok(!status.includes(key));
  assert.ok(!status.includes(saved.agents[0].token));
  await bridge.manage('storage-set',{id:'personal',path:'/Volumes/Space'});
  assert.equal(calls.at(-1).path,'/api/personal-space/spaces/personal/storage');
  assert.deepEqual(JSON.parse(calls.at(-1).body),{path:'/Volumes/Space'});
});


test('storage chooser uses native folders only for local mode, binds scope, and otherwise browses the box', async t=>{
 let saved,listener,box='local-box',mode='local',chooseResult='/Volumes/My Space',pending;
 const requests=[];
 const bridge=await createSpaceLinkBridge({
  serviceURL:'https://platform.test',store:{load:async()=>saved,save:async s=>saved=s},
  chooseStorageDirectory:async()=>pending?new Promise(r=>pending=r):chooseResult,
  client:{snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:'owner'},connection:{deviceId:box,mode}}),subscribe(fn){listener=fn;return ()=>{};},applicationConnection:async()=>({context(){},request:async input=>{
   requests.push(input);const value=input.path.endsWith('/defaults')?{tree_root:'/data',default_root_dir:'/data'}:{path:input.path.includes('projects')?'/data/projects':'/data',entries:[{name:'projects',path:'/data/projects'}]};
   return {status:200,body:Buffer.from(JSON.stringify(value))};
  }})}
 });t.after(()=>bridge.close());
 assert.deepEqual(await bridge.manage('storage-choose'),{path:'/Volumes/My Space'});assert.equal(requests.length,0);
 chooseResult=null;assert.deepEqual(await bridge.manage('storage-choose'),{canceled:true});
 pending=true;const selection=bridge.manage('storage-choose');await new Promise(r=>setImmediate(r));box='other';listener();pending('/old-scope');await assert.rejects(selection,/SPACE_CONTEXT_CHANGED/);
 mode='netbird';pending=null;
 const root=await bridge.manage('storage-choose');assert.equal(root.parent,'/data');assert.equal(root.browse,true);
 const folder=await bridge.manage('storage-choose',{path:'/data/projects'});assert.equal(folder.path,'/data/projects');assert.equal(folder.parent,'/data');
 assert.equal(requests.at(-1).path,'/api/filesystem/dirs?path=%2Fdata%2Fprojects');
 assert.equal(requests.at(-1).method,'GET');
 const denied=await fetch(`http://127.0.0.1:${saved.port}/space-agents/${'x'.repeat(43)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'storage-choose'})});assert.equal(denied.status,403);
});

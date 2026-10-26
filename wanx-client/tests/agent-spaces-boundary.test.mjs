import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpaceLinkBridge} from '../shell/space-links.mjs';

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
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,open,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createPersonalSpace,MAX_UPLOAD_BYTES} from '../shell/personal-space.mjs';
import {IMPORT_WINDOW} from '../shell/space-upload-imports.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),uid=()=>randomUUID().replaceAll('-','');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async predicate=>{for(let i=0;i<2000;i++){if(await predicate())return;await sleep(5);}throw Error('timed out');};
const reset=()=>Object.assign(Error('lost receipt'),{code:'ECONNRESET'});
async function fixture(t,options={}) {
 const root=await mkdtemp(path.join(tmpdir(),'wanx-folder-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let saved=[],service,state={phase:'ready',account:{phase:'authenticated',accountId:'owner'},connection:{deviceId:'79'}};
 const listeners=new Set(),entries=new Map(),uploads=new Map(),calls=[],events=[];
 const uniqueName=(parent,name,except)=>{let candidate=name,index=1;while([...entries.values()].some(e=>e.parent===parent&&e.name===candidate&&e.id!==except))candidate=name+` (${index++})`;return candidate;};
 const client={snapshot:()=>state,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f);},applicationConnection:async()=>{
  const box=state.connection?.deviceId,owner=state.account.accountId;
  const context=()=>{if(state.phase!=='ready'||state.connection?.deviceId!==box||state.account.accountId!==owner)throw Object.assign(Error('changed'),{code:'NETWORK_CHANGED'});};
  return {context,request:async input=>{
   context();calls.push(input);await options.before?.(input,{entries,uploads});if(input.signal.aborted)throw input.signal.reason;
   const url=new URL(input.path,'http://local'),route=url.pathname.split('/').slice(3),id=route[1];let value={};
   const body=Buffer.isBuffer(input.body)?input.body:input.body?JSON.parse(input.body):{};
   if(route[0]==='files'&&route.length===1)value={items:[...entries.values()].filter(e=>e.parent===(url.searchParams.get('parent')||''))};
   else if(route[0]==='folders'){const entry={id:uid(),parent:body.parent,name:uniqueName(body.parent,body.name),kind:'folder',space_id:body.space_id||'personal'};entries.set(entry.id,entry);value=entry;}
   else if(route[0]==='files'){
    const entry=entries.get(id);if(!entry)return {status:404,body:Buffer.from('{}'),headers:{}};
    if(input.method==='PATCH')Object.assign(entry,{parent:body.parent,name:uniqueName(body.parent,body.name,id)});value=entry;
   }else if(route[0]==='uploads'&&route.length===1){if(!uploads.has(body.id))uploads.set(body.id,{...body,offset:0,state:'pending',bytes:Buffer.alloc(0),publications:0});value=uploads.get(body.id);}
   else if(route[0]==='uploads'&&route[2]==='complete'){
    const upload=uploads.get(id);assert.equal(body.digest,hash(upload.bytes));assert.equal(upload.bytes.length,upload.size);
    if(upload.state!=='complete'){upload.publications++;entries.set(id,{id,parent:upload.parent,name:uniqueName(upload.parent,upload.name),kind:'file',size:upload.size,digest:body.digest,space_id:upload.space_id});}upload.state='complete';value={id};
   }else if(input.method==='PUT'){
    const upload=uploads.get(id);assert.equal(Number(url.searchParams.get('offset')),upload.offset);assert.equal(input.headers['x-content-sha256'],hash(input.body));assert.ok(input.body.length<=1024*1024);assert.equal(input.freshConnection,true);assert.equal(input.idleTimeoutMs,15000);
    upload.bytes=Buffer.concat([upload.bytes,input.body]);upload.offset+=input.body.length;value={offset:upload.offset};
   }else if(input.method==='DELETE')uploads.delete(id);
   await options.after?.(input,{entries,uploads});return {status:200,body:Buffer.from(JSON.stringify(value)),headers:{}};
  }};
 }};
 const settings={client,store:{load:async()=>structuredClone(saved),save:async v=>{saved=structuredClone(v);}},serviceURL:'http://test',retryBaseMs:1,maxRetries:1,recoveryCooldownMs:30,random:()=>.5,onEvent:e=>events.push(e),chooseUploads:async()=>options.selection||[]};
 service=await createPersonalSpace(settings);t.after(()=>service.close());
 return {root,entries,uploads,calls,events,saved:()=>saved,get service(){return service;},state:patch=>{state={...state,...patch};for(const f of listeners)f();},restart:async()=>{await service.close();service=await createPersonalSpace(settings);},done:()=>wait(()=>service.snapshot().imports.length&&service.snapshot().imports.every(b=>['complete','failed'].includes(b.phase)))};
}
async function samples(f,count=137){const folder=path.join(f.root,'中文 资料 #😀');await mkdir(path.join(folder,'一级','二级'),{recursive:true});await mkdir(path.join(folder,'空文件夹'));for(let i=0;i<count;i++)await writeFile(path.join(folder,i%2?'一级/二级':'',`材料 ${i} #%.txt`),`中文 ${i}\n  内容\n`);return folder;}
const remotePath=(entries,entry)=>entry.parent?remotePath(entries,entries.get(entry.parent))+'/'+entry.name:entry.name;

test('folder streams >20 files, retaining hierarchy, empty folders, exact names and full bytes',async t=>{
 const f=await fixture(t),folder=await samples(f),reply=await f.service.uploads('',[folder]);assert.ok(reply.scanning);assert.ok(f.service.snapshot().tasks.length<=20);
 await f.done();assert.equal(f.uploads.size,137);assert.equal([...f.entries.values()].filter(e=>e.kind==='folder').length,4);
 for(const entry of f.entries.values())if(entry.kind==='file'){const relative=remotePath(f.entries,entry).split('/').slice(1).join('/');assert.deepEqual(f.uploads.get(entry.id).bytes,await readFile(path.join(folder,relative)));assert.equal(f.uploads.get(entry.id).publications,1);}
 assert.ok([...f.entries.values()].some(e=>e.name==='空文件夹'));assert.doesNotMatch(JSON.stringify(f.service.snapshot()),new RegExp(f.root));assert.ok(![...f.entries.values()].some(e=>e.name.startsWith('.wanx-import-')));
});
test('lost folder-create, rename, chunk and commit ACKs reconcile without duplicate publications',async t=>{
 const lost=new Set();const f=await fixture(t,{after:input=>{const stage=input.path.endsWith('/folders')?'folder':input.method==='PATCH'?'rename':input.method==='PUT'?'chunk':input.path.endsWith('/complete')?'commit':null;if(stage&&!lost.has(stage)){lost.add(stage);throw reset();}}});
 const folder=await samples(f,3);await f.service.uploads('',[folder]);await f.done();assert.deepEqual([...lost].sort(),['chunk','commit','folder','rename']);assert.equal(f.uploads.size,3);assert.equal([...f.entries.values()].filter(e=>e.kind==='folder').length,4);assert.ok([...f.uploads.values()].every(u=>u.publications===1));assert.equal(f.service.snapshot().imports[0].failed,0);
});
test('same-name user destination survives; repeated active drops reuse their batch',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,{before:async input=>{if(input.method==='PUT')await Promise.race([gate,new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}))]);}});const folder=await samples(f,3),existing={id:uid(),parent:'',kind:'folder',name:path.basename(folder)};f.entries.set(existing.id,{...existing});
 const first=await f.service.uploads('',[folder]);await wait(()=>f.calls.some(c=>c.method==='PUT'));const again=await f.service.uploads('',[folder]);assert.equal(again.batchId,first.batchId);assert.equal(again.duplicate,true);release();await f.done();assert.deepEqual(f.entries.get(existing.id),existing);assert.equal([...f.entries.values()].filter(e=>e.parent==='').length,2);assert.equal(f.uploads.size,3);
});
test('oversized and symlink sources skip individually; retry rescans repaired sources',async t=>{
 const f=await fixture(t),folder=await samples(f,2),big=path.join(folder,'超限.bin'),h=await open(big,'w');await h.truncate(MAX_UPLOAD_BYTES+1);await h.close();
 await symlink(folder,path.join(folder,'循环链接'),process.platform==='win32'?'junction':'dir');await f.service.uploads('',[folder]);await f.done();assert.equal(f.uploads.size,2);assert.equal(f.service.snapshot().imports[0].failed,2);assert.ok(f.service.snapshot().tasks.some(t=>t.error==='SPACE_SOURCE_LINK'));
 await rm(path.join(folder,'循环链接'));await writeFile(big,'变小后重试');await f.service.transfer('retry-batch',f.service.snapshot().imports[0].id);await f.done();assert.equal(f.uploads.size,3);assert.equal(f.service.snapshot().imports[0].failed,0);assert.equal([...f.entries.values()].filter(e=>e.kind==='folder').length,4);
});
test('bounded buffer, durable batch pause and restart preserve scanning and stable IDs',async t=>{
 let held=true;const f=await fixture(t,{before:async input=>{if(input.method==='PUT'&&held)await new Promise((_,reject)=>{if(input.signal.aborted)return reject(input.signal.reason);input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});});}});const folder=await samples(f,220),reply=await f.service.uploads('',[folder]);await wait(()=>f.calls.some(c=>c.method==='PUT'));await sleep(40);
 assert.ok(f.service.snapshot().tasks.filter(t=>!['complete','paused'].includes(t.phase)).length<=IMPORT_WINDOW);
 await f.service.transfer('pause-batch',reply.batchId);const calls=f.calls.length;await f.restart();await sleep(40);assert.equal(f.calls.length,calls);held=false;await f.service.transfer('resume-batch',reply.batchId);await f.done();assert.equal(f.uploads.size,220);assert.ok([...f.uploads.values()].every(u=>u.publications===1));assert.equal([...f.entries.values()].filter(e=>e.kind==='folder').length,4);
});
test('exhausted network retries cool down and recover automatically, retaining all queued files',async t=>{
 let faults=6;const f=await fixture(t,{before:input=>{if(input.method==='PUT'&&faults-->0)throw reset();}}),folder=await samples(f,28);await f.service.uploads('',[folder]);await f.done();assert.equal(f.uploads.size,28);assert.ok(f.events.some(e=>e.errorCode==='ECONNRESET'));assert.ok(f.service.snapshot().tasks.every(t=>t.phase==='complete'));assert.ok([...f.uploads.values()].every(u=>u.publications===1));
});
test('box changes freeze the original import and never dispatch to the other box',async t=>{
 let held=true;const f=await fixture(t,{before:async input=>{if(input.method==='PUT'&&held)await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));}}),folder=await samples(f,50);await f.service.uploads('',[folder]);await wait(()=>f.calls.some(c=>c.method==='PUT'));f.state({connection:{deviceId:'other'}});await sleep(30);const calls=f.calls.length;assert.deepEqual(f.service.snapshot().tasks,[]);assert.deepEqual(f.service.snapshot().imports,[]);held=false;await sleep(30);assert.equal(f.calls.length,calls);f.state({connection:{deviceId:'79'}});await f.service.transfer('resume-all');await f.done();assert.equal(f.uploads.size,50);
});
test('one thousand small files finish in bounded pages while the event loop keeps running',async t=>{
 const f=await fixture(t),folder=await samples(f,1000);let ticks=0;const timer=setInterval(()=>ticks++,2);t.after(()=>clearInterval(timer));await f.service.uploads('',[folder]);await f.done();assert.equal(f.uploads.size,1000);assert.equal(f.service.snapshot().imports[0].files,1000);assert.ok(ticks>0);assert.ok([...f.uploads.values()].every(u=>u.publications===1));
});

test('completed records clear by exact batch without changing uploaded content or another active batch',async t=>{
 const f=await fixture(t),folder=await samples(f,3),job=await f.service.uploads('',[folder]);await f.done();const contents=f.entries.size;await f.service.transfer('clear-completed',job.batchId);assert.equal(f.entries.size,contents);assert.equal(f.service.snapshot().tasks.length,0);assert.equal(f.service.snapshot().imports.length,0);assert.equal(f.saved().length,0);
});
test('startup on the same account default local box keeps original jobs waiting until box 79 reconnects',async t=>{
 let held=true;const f=await fixture(t,{before:async input=>{if(input.method==='PUT'&&held)await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true}));}}),folder=await samples(f,30);await f.service.uploads('',[folder]);await wait(()=>f.calls.some(c=>c.method==='PUT'));
 await f.service.close();f.state({connection:{deviceId:'local'}});await f.restart();const calls=f.calls.length;await sleep(30);assert.equal(f.calls.length,calls);assert.equal(f.service.snapshot().tasks.length,0);held=false;f.state({connection:{deviceId:'79'}});await f.done();assert.equal(f.uploads.size,30);
});

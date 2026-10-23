import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createSuperClipboard,CLIP_FILE_LIMIT} from '../shell/super-clipboard.mjs';
import {createClipboardCache} from '../shell/clipboard-cache.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=','base64');
const image=size=>Buffer.concat([png,Buffer.alloc(Math.max(0,size-png.length),73)]);
const hash=b=>createHash('sha256').update(b).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate){for(let i=0;i<250;i++){if(await predicate())return;await delay(20);}throw Error('Timed out');}
function backend(){
 const items=new Map(),batches=new Map();let revision=0,dropped=false,puts=0,commits=0,hold=null;
 const error=code=>Object.assign(Error(code),{code});
 const usage=()=>({used:[...items.values()].reduce((n,i)=>n+i.bytes.length,0),reserved:[...items.values()].reduce((n,i)=>n+i.size,0),limit:1024**3});
 return {items,batches,counts:()=>({puts,commits}),dropCommit:false,holdPut(fn){hold=fn;},
 async request(route,options={}){
  if(options.signal?.aborted)throw error('SPACE_PAUSED');
  const u=new URL('http://box'+(route||'/')),id=u.pathname.split('/')[1],body=options.body;
  if(id==='batches'){
   if(batches.has(body.id))assert.deepEqual(batches.get(body.id),body.items);else{
    batches.set(body.id,structuredClone(body.items));for(const i of body.items)items.set(i.id,{...i,bytes:Buffer.alloc(0),state:'pending',version:1});
   }
   return {items:body.items.map(i=>items.get(i.id)).filter(Boolean).map(i=>({...i,offset:i.bytes.length})),usage:usage()};
  }
  if(id==='manage'){for(const target of body.targets){const i=items.get(target.id);if(!i)continue;if(body.action==='cancel')items.delete(target.id);else if(body.action==='trash')i.trashed=1;else if(body.action==='purge')items.delete(target.id);else if(body.action==='restore')i.trashed=null;else if(body.action==='rename')i.name=body.name;i.version++;}revision++;return {ok:true};}
  if(!id){if(u.searchParams.get('since')===String(revision))return {unchanged:true,revision,usage:usage()};return {revision,items:[...items.values()].filter(i=>i.state==='ready'&&!i.trashed).map(i=>({...i,preview:i.kind==='text'?i.bytes.toString():'',expires:Date.now()/1000+2592000})),usage:usage(),next_offset:null};}
  const i=items.get(id);if(!i||i.trashed)throw error('CLIPBOARD_NOT_FOUND');
  if(u.pathname.endsWith('/complete')){
   assert.equal(hash(i.bytes),body.digest);if(i.state!=='ready'){commits++;i.state='ready';revision++;}
   if(this.dropCommit&&!dropped){dropped=true;throw error('ECONNRESET');}return i;
  }
  if(u.pathname.endsWith('/content')){
   if(options.method==='PUT'){
    if(hold)await hold(options.signal,i);
    if(options.signal?.aborted)throw error('SPACE_PAUSED');
    assert.equal(hash(body),options.headers['x-content-sha256']);const offset=Number(u.searchParams.get('offset'));assert.equal(offset,i.bytes.length);
    i.bytes=Buffer.concat([i.bytes,body]);puts++;return {offset:i.bytes.length};
   }
   const offset=Number(u.searchParams.get('offset')),length=Number(u.searchParams.get('length')),bytes=i.bytes.subarray(offset,offset+length);return {bytes,headers:{'x-content-sha256':hash(bytes)}};
  }
  return {...i,offset:i.bytes.length};
 }};
}
async function fixture(t,{ready=true,server=backend(),storeState=null}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-clipboard-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let s={account:{phase:'authenticated',accountId:'owner'},phase:ready?'ready':'offline',connection:ready?{deviceId:'box-a'}:null};
 let listener,stored=storeState;
 const account=()=>JSON.stringify(['test-service','owner']);const bound=()=>s.connection?JSON.stringify([account(),s.connection.deviceId]):null;
 const client={snapshot:()=>s,subscribe(fn){listener=fn;return()=>{};}};
 const personalSpace={snapshot:()=>({scope:bound()}),clipboardRequest:(route,options)=>server.request(route,options)};
 const copied={};const systemClipboard={async read(){return {text:'explicit synthetic paste'};},writeText:v=>{copied.text=v;},writeImage:v=>{copied.image=v;},writeFiles:v=>{copied.files=v;}};
 const opts={client,personalSpace,serviceURL:'test-service',store:{load:async()=>structuredClone(stored),save:async x=>{stored=structuredClone(x);}},directory,deviceName:'synthetic-client',systemClipboard,chooseFiles:async()=>[],chooseDownload:async()=>null,retryBaseMs:5};
 const service=await createSuperClipboard(opts);t.after(()=>service.close());
 return {service,server,directory,copied,stored:()=>stored,opts,change(value){s={...s,...value};listener();},bound};
}

test('explicit text capture, lost commit acknowledgement, encrypted cache and real-byte copy',async t=>{
 const f=await fixture(t);f.server.dropCommit=true;
 assert.equal(f.server.items.size,0);assert.equal(f.copied.text,undefined);
 const text='中文\n  spaces #?& 🐎';await f.service.operation('capture',{text});
 await waitFor(()=>f.service.snapshot().tasks.length===0);
 assert.equal(f.server.items.size,1);assert.equal(f.server.counts().commits,1);
 const [id]=f.server.items.keys();await f.service.operation('copy',{id});assert.equal(f.copied.text,text);
 const files=await readdir(path.join(f.directory,'encrypted'));const encrypted=await readFile(path.join(f.directory,'encrypted',files[0]));
 assert.equal(encrypted.includes(Buffer.from(text)),false);assert.equal(JSON.stringify(f.stored()).includes(text),false);
 await f.service.operation('capture',{text});await waitFor(()=>f.service.snapshot().tasks.length===0);
 assert.equal(f.server.items.size,2,'a second intentional paste must be a new card');
});

test('offline cache survives restart, stays bound to original box and does not copy automatically',async t=>{
 const f=await fixture(t);f.change({phase:'offline',connection:null});
 await f.service.operation('capture',{text:'offline synthetic'});assert.equal(f.server.items.size,0);assert.equal(f.service.snapshot().tasks[0].phase,'waiting');
 await f.service.close();const stored=f.stored();
 const again=await fixture(t,{ready:false,server:f.server,storeState:stored});
 // Restart using the same encrypted payload directory, just as an installed client does.
 await again.service.close();const opts={...again.opts,directory:f.directory,store:{load:async()=>structuredClone(stored),save:async x=>{}}};
 const resumed=await createSuperClipboard(opts);t.after(()=>resumed.close());
 again.change({phase:'ready',connection:{deviceId:'box-b'}});await delay(40);assert.equal(f.server.items.size,0);
 again.change({phase:'ready',connection:{deviceId:'box-a'}});await waitFor(()=>resumed.snapshot().tasks.length===0);
 assert.equal(f.server.items.size,1);assert.equal(again.copied.text,undefined);
});

test('whole batch validation rejects 21 images and 20 MiB + 1 without adding queue entries',async t=>{
 const f=await fixture(t),file=path.join(f.directory,'中文 sample #.png');await writeFile(file,png);
 await assert.rejects(f.service.operation('capture',{paths:Array(21).fill(file)}),{code:'CLIPBOARD_LIMIT'});
 const oversized=path.join(f.directory,'too-large.png');await writeFile(oversized,Buffer.alloc(CLIP_FILE_LIMIT+1));
 await assert.rejects(f.service.operation('capture',{paths:[file,oversized]}),{code:'CLIPBOARD_LIMIT'});
 await assert.rejects(f.service.operation('capture',{paths:[file,f.directory]}),{code:'CLIPBOARD_IMAGES_ONLY'});
 assert.equal(f.service.snapshot().tasks.length,0);assert.equal(f.server.batches.size,0);assert.equal((await readdir(path.join(f.directory,'encrypted'))).length,0);
});

test('manual pause keeps acknowledged offset, resume completes once, second device copies image bytes',async t=>{
 const server=backend(),f=await fixture(t,{server}),data=image(1024*1024+512),file=path.join(f.directory,'中文 空格 #%.png');await writeFile(file,data);
 let entered=false;server.holdPut(async(signal,i)=>{if(i.bytes.length){entered=true;await new Promise((resolve,reject)=>{if(signal.aborted)return reject(Object.assign(Error('paused'),{code:'SPACE_PAUSED'}));signal.addEventListener('abort',()=>reject(Object.assign(Error('paused'),{code:'SPACE_PAUSED'})),{once:true});});}});
 await f.service.operation('capture',{paths:[file]});await waitFor(()=>entered);
 const task=f.service.snapshot().tasks[0];assert.equal(task.offset,1024*1024);
 await f.service.operation('transfer',{action:'pause',id:task.id});await delay(30);assert.equal(f.service.snapshot().tasks[0].phase,'paused');
 server.holdPut(null);await f.service.operation('transfer',{action:'resume',id:task.id});await waitFor(()=>f.service.snapshot().tasks.length===0);
 assert.equal(server.counts().commits,1);assert.equal(server.counts().puts,2);
 const other=await fixture(t,{server});await other.service.operation('refresh');const item=other.service.snapshot().items[0];
 assert.equal(item.name,path.basename(file));await other.service.operation('copy',{id:item.id});
 assert.deepEqual(other.copied.image,data);assert.equal(other.copied.files,undefined);
});

test('logout blocks reads and leaves offline content encrypted for its original owner',async t=>{
 const f=await fixture(t);await f.service.operation('capture',{text:'private synthetic'});await waitFor(()=>f.service.snapshot().tasks.length===0);
 const [id]=f.server.items.keys();f.change({account:{phase:'signed_out'},phase:'offline',connection:null});
 assert.equal(f.service.snapshot().items.length,0);await assert.rejects(f.service.operation('copy',{id}));await assert.rejects(f.service.operation('capture',{text:'x'}),{code:'ACCOUNT_LOGIN_REQUIRED'});
});

test('encrypted payload authentication catches corrupted local cache',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-clip-cache-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const cache=await createClipboardCache(directory,Buffer.alloc(32,9)),id='a'.repeat(32);await cache.put(id,Buffer.from('synthetic'));
 const file=path.join(directory,id+'.enc'),data=await readFile(file);data[data.length-1]^=1;await writeFile(file,data);
 await assert.rejects(cache.read(id),{code:'CLIPBOARD_CACHE_DAMAGED'});
});


test('an explicitly selected box survives restart even before the first capture',async t=>{
 const f=await fixture(t,{ready:false});
 f.change({phase:'ready',connection:{deviceId:'box-a'}});await delay(10);await f.service.close();
 const again=await fixture(t,{ready:false,storeState:f.stored()});
 await again.service.operation('capture',{text:'offline first capture after restart'});
 assert.equal(again.service.snapshot().tasks[0].phase,'waiting');
 assert.equal(again.service.snapshot().boxId,'box-a');
 assert.equal(again.server.items.size,0);
});


test('exact text/image limits and twenty-image batch are accepted; next byte is atomically rejected',async t=>{
 const f=await fixture(t);
 const text='a'.repeat(1024*1024);
 await f.service.operation('capture',{text});await waitFor(()=>f.service.snapshot().tasks.length===0);
 const count=f.server.items.size;
 await assert.rejects(f.service.operation('capture',{text:text+'中'}),{code:'CLIPBOARD_LIMIT'});
 assert.equal(f.server.items.size,count);
 const file=path.join(f.directory,'exact-20MiB.png');await writeFile(file,image(CLIP_FILE_LIMIT));
 await f.service.operation('capture',{paths:[file]});await waitFor(()=>f.service.snapshot().tasks.length===0);
 assert.equal([...f.server.items.values()].find(i=>i.name==='exact-20MiB.png').bytes.length,CLIP_FILE_LIMIT);
 const files=[];for(let i=0;i<20;i++){const p=path.join(f.directory,'batch-'+i+'.png');await writeFile(p,png);files.push(p);}
 await f.service.operation('capture',{paths:files});await waitFor(()=>f.service.snapshot().tasks.length===0);
 assert.equal(f.server.items.size,count+21);
});


test('P2P tunnel timeout after acknowledged chunk retries the same item and offset',async t=>{
 const server=backend(),f=await fixture(t,{server}),data=image(1024*1024+29),file=path.join(f.directory,'隧道恢复.png');await writeFile(file,data);
 let dropped=false;server.holdPut(async(signal,item)=>{if(item.bytes.length&&!dropped){dropped=true;throw Object.assign(Error('tunnel_timeout'),{code:'tunnel_timeout'});}});
 await f.service.operation('capture',{paths:[file]});await waitFor(()=>f.service.snapshot().tasks.length===0);
 assert.equal(dropped,true);assert.equal(server.items.size,1);assert.equal(server.counts().commits,1);assert.equal(server.counts().puts,2);assert.deepEqual([...server.items.values()][0].bytes,data);
});


test('temporary business outage keeps explicit capture encrypted and later syncs once',async t=>{
 const server=backend(),send=server.request.bind(server);let unavailable=true;
 server.request=async(...args)=>{if(unavailable)throw Object.assign(Error('tunnel_timeout'),{code:'tunnel_timeout'});return send(...args);};
 const f=await fixture(t,{server});await f.service.operation('capture',{text:'断线时主动保存的合成内容'});
 await waitFor(()=>f.service.snapshot().tasks[0]?.phase==='waiting');assert.equal(server.items.size,0);
 assert.equal(f.service.snapshot().tasks[0].error,'tunnel_timeout');
 assert.equal(JSON.stringify(f.stored()).includes('断线时主动保存的合成内容'),false);
 unavailable=false;await waitFor(()=>f.service.snapshot().tasks.length===0);assert.equal(server.items.size,1);assert.equal(server.counts().commits,1);
});


test('all ingress paths reject generic attachments and spoofed images atomically',async t=>{
 const f=await fixture(t),picture=path.join(f.directory,'照片 #.png'),file=path.join(f.directory,'文档.txt'),fake=path.join(f.directory,'伪装.png');
 await writeFile(picture,png);await writeFile(file,'plain file');await writeFile(fake,'not an image');
 for(const paths of [[file],[picture,file],[picture,fake]])await assert.rejects(f.service.operation('capture',{paths}),{code:'CLIPBOARD_IMAGES_ONLY'});
 f.opts.systemClipboard.read=async()=>({paths:[file],image:png.toString('base64'),text:'must not fall back to text'});
 await assert.rejects(f.service.operation('paste'),{code:'CLIPBOARD_IMAGES_ONLY'});
 await assert.rejects(f.service.operation('capture',{image:Buffer.from('binary').toString('base64')}),{code:'CLIPBOARD_IMAGES_ONLY'});
 assert.equal(f.service.snapshot().tasks.length,0);assert.equal(f.server.batches.size,0);
 assert.equal((await readdir(path.join(f.directory,'encrypted'))).length,0);
 f.opts.systemClipboard.read=async()=>({image:png.toString('base64'),mime:'image/png'});
 await f.service.operation('paste');await waitFor(()=>f.service.snapshot().tasks.length===0);
 const item=[...f.server.items.values()][0];assert.equal(item.kind,'image');assert.deepEqual(item.bytes,png);
});

test('retrying the same note recovers a failed local save without losing the draft',async t=>{
 const f=await fixture(t);f.change({phase:'offline'});
 const save=f.opts.store.save;let failWrite=true;
 f.opts.store.save=async value=>{if(failWrite)throw Object.assign(Error('ENOSPC'),{code:'ENOSPC'});return save(value);};
 const blocks=[{type:'text',text:'中文  unchanged draft\n保留'}];
 await assert.rejects(f.service.operation('note-save',{blocks}),{code:'SECURE_STORAGE_WRITE_FAILED'});
 assert.deepEqual(f.service.snapshot().note.blocks,blocks);
 assert.equal(f.service.snapshot().error,'SECURE_STORAGE_WRITE_FAILED');
 failWrite=false;await f.service.operation('note-save',{blocks});
 assert.equal(f.service.snapshot().error,null);
 assert.deepEqual(f.stored().notes[f.bound()].blocks,blocks);
 await f.service.operation('capture',{text:'queue available after storage recovers'});
 assert.equal(f.service.snapshot().tasks.length,1);
});

test('a native note picker or paste finishing after a box switch cannot capture into the new target',async t=>{
 const f=await fixture(t);const chosen=[],clipboard=[];
 f.opts.chooseFiles=async()=>new Promise(resolve=>chosen.push(resolve));
 f.opts.systemClipboard.read=async()=>new Promise(resolve=>clipboard.push(resolve));
 const service=await createSuperClipboard(f.opts);t.after(()=>service.close());
 const picking=service.operation('choose',{panel:true});
 const pasting=service.operation('note-paste',{});
 await delay(0);f.change({connection:{deviceId:'box-b'}});chosen[0]([]);clipboard[0]({text:'old target'});
 await assert.rejects(picking,{code:'SPACE_CONTEXT_CHANGED'});
 await assert.rejects(pasting,{code:'SPACE_CONTEXT_CHANGED'});
 assert.equal(service.snapshot().tasks.length,0);
});

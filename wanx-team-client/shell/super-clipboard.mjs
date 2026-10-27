import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFile, lstat, writeFile, unlink} from 'node:fs/promises';
import path from 'node:path';
import {createSharedNote} from './shared-note.mjs';
import {createClipboardCache, CACHE_LIMIT} from './clipboard-cache.mjs';
import {dataOwnerKey, dataInteractionKey} from '../device-trust/data-context.mjs';

export const CLIP_FILE_LIMIT=20*1024*1024, CLIP_TEXT_LIMIT=1024*1024;
const CHUNK=1024*1024, QUOTA=1024*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=()=>randomUUID().replaceAll('-','');
const fail=code=>Object.assign(new Error(code),{code});
const active=t=>!['complete','canceled'].includes(t.phase);
const transient=e=>[408,429,502,503,504].includes(e.status)||/^(ECONN|EPIPE|ETIMEDOUT|EHOST|ENET|EAI_|BOX_CONNECTION|SPACE_CONNECTION|SPACE_NETWORK|CLIPBOARD_UPSTREAM|WANX_UPSTREAM|SPACE_CHUNK_STALLED|SESSION_CLOSED|GATEWAY_CLOSED|CONNECT_TIMEOUT|NETWORK_CHANGED|NETWORK_NOT_READY|tunnel_timeout|tunnel_rejected|network_unavailable|network_recovering|netbird_peer_disconnected)/.test(e.code||e.message||'');
const imageMime=name=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'})[path.extname(name).toLowerCase()];
const imageType=bytes=>bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex'))?'image/jpeg':/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
const valid=id=>{if(!/^[a-f0-9]{32}$/.test(id||''))throw fail('SPACE_INVALID_ID');return id;};

export async function createSuperClipboard({client,personalSpace,serviceURL,store,directory,deviceName,systemClipboard,chooseFiles,chooseDownload,onChanged=()=>{},retryBaseMs=1000}){
  const saved=await store.load();if(saved&&saved.version!==1)throw fail('CLIPBOARD_CACHE_DAMAGED');
  if(saved&&(!Array.isArray(saved.tasks)||!Array.isArray(saved.batches)||!Array.isArray(saved.cache)||!saved.bindings||Buffer.from(saved.key||'','base64').length!==32))throw fail('CLIPBOARD_CACHE_DAMAGED');
  const state=saved||{version:1,key:randomBytes(32).toString('base64'),tasks:[],batches:[],bindings:{},cache:[]};
  state.notes ||= {};
  const cache=await createClipboardCache(path.join(directory,'encrypted'),Buffer.from(state.key,'base64'));
  await cache.clean(new Set([...state.tasks.map(t=>t.id),...state.cache.map(t=>t.id)]));
  for(const t of state.tasks)if(active(t)&&t.phase!=='paused')t.phase='waiting';
  let closed=false,job=null,timer=null,scope=null,loaded=null,listKey='',epoch=0,writes=Promise.resolve(),mutations=Promise.resolve(),interaction=null;
  let view={kind:'all',query:'',trash:false},cacheWrites=Promise.resolve(),reservedCache=0;
  const reserveCache = amount => {const p=cacheWrites.catch(()=>{}).then(async()=>{await evict(amount+reservedCache);reservedCache+=amount;return ()=>{reservedCache-=amount;};});cacheWrites=p;return p;};
  let storageError=null,note=null,contextGeneration=0;const downloads=new Map(),requests=new Set();
  const ticket=()=>({scope,generation:contextGeneration});
  const assertTicket=value=>{if(closed||!value.scope||value.scope!==scope||value.generation!==contextGeneration)throw fail('SPACE_CONTEXT_CHANGED');};
  const persist=()=>{const copy=structuredClone(state);writes=writes.catch(()=>{}).then(async()=>{await store.save(copy);if(storageError){storageError=null;notify();wake();}});return writes.catch(()=>{storageError='SECURE_STORAGE_WRITE_FAILED';job?.controller.abort();throw fail(storageError);});};
  const serial=fn=>{const result=mutations.catch(()=>{}).then(fn);mutations=result;return result;};
  const accountKey=()=>dataOwnerKey(client.snapshot(),serviceURL);
  const online=()=>!!scope&&!!dataInteractionKey(client.snapshot(),serviceURL)&&personalSpace.snapshot().scope===scope;
  function sync(){
    const account=accountKey(),s=client.snapshot(),box=s.connection?.deviceId||(account?state.bindings[account]:null);
    if(account&&s.connection?.deviceId&&state.bindings[account]!==s.connection.deviceId){state.bindings[account]=s.connection.deviceId;void persist().catch(()=>notify());}
    const next=account&&box?JSON.stringify([account,box]):null;
    const nextInteraction=dataInteractionKey(s,serviceURL);
    if(next!==scope||nextInteraction!==interaction){scope=next;interaction=nextInteraction;epoch++;contextGeneration++;loaded=null;listKey='';job?.controller.abort();for(const controller of requests)controller.abort();downloads.clear();}
    if(!online())job?.controller.abort();notify();wake();note?.wake();
  }
  function snapshot(){
    return {scope,dataOwnerId:accountKey(),dataContextId:dataInteractionKey(client.snapshot(),serviceURL),online:online(),note:note?.snapshot(),boxId:scope?JSON.parse(scope)[1]:null,error:storageError,
      tasks:state.tasks.filter(t=>t.scope===scope&&active(t)).map(({id,name,kind,size,offset,phase,error,batch})=>({id,name,kind,size,offset,phase,error,batch})),
      items:loaded?.items||[],usage:loaded?.usage||{used:0,reserved:0,limit:QUOTA},revision:loaded?.revision,next_offset:loaded?.next_offset};
  }
  const notify=()=>{if(!closed)onChanged(snapshot());};
  function wake(delay=0){clearTimeout(timer);if(!closed){timer=setTimeout(()=>void pump(),delay);timer.unref?.();}}
  async function request(route,options={},bound=scope){
    if(!bound||bound!==scope||!online())throw fail('BOX_CONNECTION_REQUIRED');
    const current=ticket(),controller=new AbortController();requests.add(controller);
    try{
      const signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal;
      const result=await personalSpace.clipboardRequest(route,{...options,signal},bound);
      assertTicket(current);if(!accountKey())throw fail('SPACE_CONTEXT_CHANGED');return result;
    }finally{requests.delete(controller);}
  }
  async function refresh({kind='all',query='',trash=false,offset=0,poll=false}={}){
    if(!online())return snapshot();view={kind,query,trash};const bound=scope,tag=++epoch;
    const key=JSON.stringify([kind,query,trash]);
    const route=`?kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(query)}&trash=${trash}&offset=${offset}`+
      (poll&&key===listKey&&loaded?.revision!==undefined?`&since=${loaded.revision}`:'');
    const result=await request(route,{},bound);
    if(scope!==bound||tag!==epoch)return snapshot();
    if(!result.unchanged){loaded={...result,items:offset&&key===listKey?[...loaded.items,...result.items]:result.items};listKey=key;}
    else if(loaded)loaded.usage=result.usage;
    notify();return snapshot();
  }
  async function evict(required=0){
    let used=await cache.size();const leaseBytes=(state.lease?.size||0);
    for(const item of [...state.cache].sort((a,b)=>a.used-b.used)){
      if(used+required+leaseBytes<=CACHE_LIMIT)break;
      if(state.tasks.some(t=>t.id===item.id&&active(t)))continue;
      await cache.remove(item.id);state.cache=state.cache.filter(c=>c.id!==item.id);used=await cache.size();
    }
    if(used+required+leaseBytes>CACHE_LIMIT)throw fail('CLIPBOARD_CACHE_FULL');
  }
  async function capture(input={}){const current=ticket();return serial(async()=>{
    if(storageError)throw fail(storageError);if(!scope)throw fail(accountKey()?'BOX_CONNECTION_REQUIRED':'ACCOUNT_LOGIN_REQUIRED');
    assertTicket(current);
    const bound=scope,paths=input.paths||[],descriptors=[];
    if(!Array.isArray(paths)||paths.length>20)throw fail('CLIPBOARD_LIMIT');
    if(paths.length){
      for(const file of paths){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('CLIPBOARD_IMAGES_ONLY');
        if(info.size>CLIP_FILE_LIMIT)throw fail('CLIPBOARD_LIMIT');
        const name=path.basename(file),mime=imageMime(name);if(!mime)throw fail('CLIPBOARD_IMAGES_ONLY');descriptors.push({name,kind:'image',mime,size:info.size,path:file,stamp:`${info.size}:${info.mtimeMs}:${info.ino}`});}
    }else{
      let bytes,kind,mime,name;
      if(input.image){bytes=Buffer.from(input.image,'base64');kind='image';mime=input.mime||'image/png';name=input.name||`截图-${new Date().toISOString().replaceAll(':','-')}.png`;}
      else if(typeof input.text==='string'&&input.text.length){bytes=Buffer.from(input.text,'utf8');kind='text';mime='text/plain';name=`文字-${new Date().toISOString().replaceAll(':','-')}.txt`;}
      else throw fail(input.virtual?'CLIPBOARD_VIRTUAL_FILE':'CLIPBOARD_EMPTY');
      if(bytes.length>(kind==='text'?CLIP_TEXT_LIMIT:CLIP_FILE_LIMIT))throw fail('CLIPBOARD_LIMIT');
      descriptors.push({name,kind,mime,size:bytes.length,bytes});
    }
    const total=descriptors.reduce((n,d)=>n+d.size,0);
    let known=null;
    if(online()){try{known=(await request('',{},bound)).usage;}catch(error){if(!transient(error))throw error;}}
    if(known&&known.reserved+total>known.limit)throw fail('CLIPBOARD_QUOTA');
    const release=await reserveCache(total+descriptors.length*28);
    const batch=uuid(),created=[];
    try{
      for(const d of descriptors){
        const bytes=d.bytes||await readFile(d.path);if(bytes.length!==d.size)throw fail('SPACE_LOCAL_FILE_CHANGED');
        if(d.path){const info=await lstat(d.path);if(`${info.size}:${info.mtimeMs}:${info.ino}`!==d.stamp)throw fail('SPACE_LOCAL_FILE_CHANGED');}
        if(d.kind==='image'&&imageType(bytes)!==d.mime)throw fail('CLIPBOARD_IMAGES_ONLY');
        const id=uuid();await cache.put(id,bytes);created.push({id,kind:d.kind,name:d.name,mime:d.mime,size:bytes.length,digest:hash(bytes),device:deviceName});
      }
      assertTicket(current);if(!accountKey())throw fail('SPACE_CONTEXT_CHANGED');
      const tasks=created.map(item=>({...item,scope:bound,batch,phase:online()?'queued':'waiting',offset:0,attempt:0,created:Date.now()}));
      state.batches.push({id:batch,scope:bound,items:created});state.tasks.push(...tasks);
      try{await persist();}catch(e){state.batches=state.batches.filter(b=>b.id!==batch);state.tasks=state.tasks.filter(t=>t.batch!==batch);throw e;}
      notify();wake();return {...snapshot(),captured:created.map(({id,kind,name,mime})=>({id,kind,name,mime}))};
    }catch(e){for(const item of created)await cache.remove(item.id);throw e;}finally{release();}
  });}
  async function pump(){
    if(closed||job||!online()||storageError)return;
    const task=state.tasks.find(t=>t.scope===scope&&(!t.next||t.next<=Date.now())&&(['queued','waiting'].includes(t.phase)||(t.phase==='canceled'&&t.cancelPending)));
    if(!task){const times=state.tasks.filter(t=>t.scope===scope&&t.phase==='waiting'&&t.next).map(t=>t.next);if(times.length)wake(Math.max(0,Math.min(...times)-Date.now()));return;}const bound=scope,controller=new AbortController();job={task,controller};
    try{
      const batch=state.batches.find(b=>b.id===task.batch);task.phase=task.phase==='canceled'?'canceled':'uploading';notify();
      const reserved=await request('/batches',{method:'POST',body:{id:batch.id,items:batch.items},signal:controller.signal},bound);
      const remote=reserved.items.find(i=>i.id===task.id);
      if(task.cancelPending){
        if(remote)await request('/manage',{method:'POST',body:{action:remote.state==='ready'?'trash':'cancel',targets:[{id:task.id,expected:remote.version}]},signal:controller.signal},bound);
        task.cancelPending=false;await cache.remove(task.id);await persist();return;
      }
      if(!remote||remote.trashed)throw fail('CLIPBOARD_NOT_FOUND');
      if(remote.state!=='ready'){
        const bytes=await cache.read(task.id);if(hash(bytes)!==task.digest)throw fail('CLIPBOARD_CACHE_DAMAGED');task.offset=remote.offset||0;
        if(!Number.isSafeInteger(task.offset)||task.offset<0||task.offset>task.size)throw fail('SPACE_UPLOAD_OFFSET_INVALID');
        while(task.offset<task.size){
          if(controller.signal.aborted||task.phase==='paused'||task.cancelPending)throw fail('SPACE_PAUSED');
          const chunk=bytes.subarray(task.offset,task.offset+CHUNK);
          const r=await request(`/${task.id}/content?offset=${task.offset}`,{method:'PUT',body:chunk,raw:false,signal:controller.signal,headers:{'content-type':'application/octet-stream','x-content-sha256':hash(chunk)}},bound);
          if(r.offset!==task.offset+chunk.length)throw fail('SPACE_UPLOAD_OFFSET_INVALID');task.offset=r.offset;task.attempt=0;await persist();notify();
        }
        await request(`/${task.id}/complete`,{method:'POST',body:{digest:task.digest},signal:controller.signal},bound);
      }
      if(task.cancelPending||task.phase==='paused')throw fail('SPACE_PAUSED');
      task.phase='complete';delete task.next;task.offset=task.size;task.error=null;
      state.cache=state.cache.filter(c=>c.id!==task.id);state.cache.push({id:task.id,scope:bound,size:task.size,used:Date.now()});await persist();
      if(bound===scope)await refresh(view).catch(()=>{});
    }catch(error){
      if(task.phase==='canceled'||task.phase==='paused'){}
      else if(bound!==scope||!online()){task.phase='waiting';task.error=null;}
      else if(transient(error)&&++task.attempt<=6){task.phase='waiting';task.error=error.code||'SPACE_NETWORK_WAIT';task.next=Date.now()+Math.min(15000,retryBaseMs*2**(task.attempt-1));}
      else{task.phase='failed';task.error=error.code||'CLIPBOARD_TRANSFER_FAILED';}
      await persist().catch(()=>{});
    }finally{job=null;notify();note?.wake();wake(Math.max(0,(task.next||0)-Date.now()));}
  }
  async function transfer(action,id){
    const task=state.tasks.find(t=>t.id===id&&t.scope===scope&&active(t));if(!task)throw fail('CLIPBOARD_NOT_FOUND');
    if(action==='pause'){task.phase='paused';if(job?.task===task)job.controller.abort();}
    else if(action==='resume'){task.phase='queued';task.error=null;task.attempt=0;delete task.next;}
    else if(action==='cancel'){task.phase='canceled';task.cancelPending=true;if(job?.task===task)job.controller.abort();}
    else throw fail('CLIPBOARD_INVALID');await persist();notify();wake();return snapshot();
  }
  async function content(id){
    valid(id);const bound=scope,current=ticket();
    const item=await request(`/${id}`); // Revalidate deletion/expiry even when local bytes are cached.
    if(item.state!=='ready')throw fail('CLIPBOARD_NOT_READY');
    let bytes;try{bytes=await cache.read(id);if(hash(bytes)!==item.digest)bytes=null;}catch{}
    assertTicket(current);
    if(!bytes){
      if(downloads.has(id))return downloads.get(id);
      const promise=(async()=>{const release=await reserveCache(item.size+28);try{const chunks=[];
        for(let offset=0;offset<item.size;offset+=CHUNK){const r=await request(`/${id}/content?offset=${offset}&length=${CHUNK}&expected=${item.version}`,{raw:true},bound);if(hash(r.bytes)!==r.headers['x-content-sha256'])throw fail('SPACE_CHUNK_INVALID');chunks.push(r.bytes);}
        const data=Buffer.concat(chunks);if(hash(data)!==item.digest)throw fail('SPACE_CHUNK_INVALID');assertTicket(current);await cache.put(id,data);assertTicket(current);
        state.cache=state.cache.filter(c=>c.id!==id);state.cache.push({id,scope:bound,size:item.size,used:Date.now(),item});await persist();assertTicket(current);return {item,bytes:data};}finally{release();}
      })().finally(()=>{if(downloads.get(id)===promise)downloads.delete(id);});downloads.set(id,promise);return promise;
    }
    return {item,bytes};
  }
  async function clearLease(){
    const old=state.lease;if(!old)return;delete state.lease;await persist();
    if(old.file&&path.resolve(old.file).startsWith(path.resolve(directory,'handoff')+path.sep))await unlink(old.file).catch(()=>{});
  }
  async function copy(id){
    const current=ticket(),{item,bytes}=await content(id);assertTicket(current);
    if(item.kind==='text'){await systemClipboard.writeText(bytes.toString('utf8'));await clearLease();}
    else if(item.kind==='image'){await systemClipboard.writeImage(bytes);await clearLease();}
    else throw fail('CLIPBOARD_IMAGES_ONLY');
    return {copied:true};
  }
  async function operation(action,input={}){
    const current=ticket();
    if(action==='snapshot')return snapshot();if(action==='refresh')return refresh(input);
    if(action==='note-save'){await note.save(input.blocks);return snapshot();}
    if(action==='note-refresh'){await note.refresh();return snapshot();}
    if(action==='note-command'){await note.command(input.action);return snapshot();}
    if(action==='capture')return capture(input);
    if(action==='note-paste'){const data=await systemClipboard.read();assertTicket(current);return typeof data.text==='string'&&!data.paths&&!data.image?{...snapshot(),text:data.text}:capture(data);}
    if(action==='paste'){const data=await systemClipboard.read();assertTicket(current);return capture(data);}
    if(action==='choose'){const paths=await chooseFiles(input);assertTicket(current);return paths.length?capture({paths}):snapshot();}
    if(action==='transfer')return transfer(input.action,input.id);
    if(action==='copy')return copy(input.id);
    if(action==='preview'){
      const task=state.tasks.find(t=>t.id===input.id&&t.scope===scope&&t.kind==='image'&&t.phase!=='canceled');
      const cached=state.cache.find(t=>t.id===input.id&&t.scope===scope&&t.item?.kind==='image');
      const attached=note.snapshot().blocks?.some(b=>b.type==='image'&&b.item===input.id);
      if(scope&&(task||attached&&cached)){try{const item=task||cached.item,bytes=await cache.read(input.id);assertTicket(current);if(hash(bytes)!==item.digest)throw fail('CLIPBOARD_CACHE_DAMAGED');return {item,data:bytes.toString('base64')};}catch(error){assertTicket(current);if(!online())throw error;}}
      const {item,bytes}=await content(input.id);assertTicket(current);return {item,data:bytes.toString('base64')};
    }
    if(action==='download'){const {item,bytes}=await content(input.id);assertTicket(current);const file=await chooseDownload(item.original_name||item.name);assertTicket(current);if(!file)return {canceled:true};await writeFile(file,bytes);return {saved:true};}
    if(action==='manage'){await request('/manage',{method:'POST',body:input});return refresh(view);}
    if(action==='export'){return request(`/${valid(input.id)}/export`,{method:'POST',body:{id:input.export_id||uuid(),expected:input.expected,parent:input.parent||'',space_id:input.space_id||'personal'}});}
    throw fail('CLIPBOARD_INVALID');
  }
  note=createSharedNote({notes:state.notes,scope:()=>scope,online,request,persist,changed:notify,retryMs:retryBaseMs,
    imagesReady:(blocks,bound)=>blocks.filter(b=>b.type==='image').every(b=>!state.tasks.some(t=>t.id===b.item&&t.scope===bound&&t.phase!=='complete'))});
  const unsubscribe=client.subscribe(sync);sync();await persist();
  return {snapshot,operation,async close(){closed=true;contextGeneration++;clearTimeout(timer);unsubscribe();job?.controller.abort();for(const controller of requests)controller.abort();await mutations.catch(()=>{});await note.close();while(job)await new Promise(r=>setTimeout(r,10));await persist();}};
}

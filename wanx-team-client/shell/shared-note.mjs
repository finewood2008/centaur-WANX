import {randomUUID} from 'node:crypto';
const id=()=>randomUUID().replaceAll('-','');
const error=code=>Object.assign(Error(code),{code});
const clone=value=>structuredClone(value);
export function normalizeNote(blocks){
  if(!Array.isArray(blocks)||blocks.length>2000)throw error('CLIPBOARD_NOTE_LIMIT');
  const result=[];
  for(const b of blocks){
    if(b?.type==='text'&&typeof b.text==='string'&&Object.keys(b).every(k=>['type','text'].includes(k))){
      if(b.text){if(result.at(-1)?.type==='text')result.at(-1).text+=b.text;else result.push({type:'text',text:b.text});}
    }else if(b?.type==='image'&&/^[a-f0-9]{32}$/.test(b.item)&&Object.keys(b).every(k=>['type','item'].includes(k)))result.push({type:'image',item:b.item});
    else throw error('CLIPBOARD_INVALID');
  }
  if(Buffer.byteLength(JSON.stringify(result))>1024*1024)throw error('CLIPBOARD_NOTE_LIMIT');
  return result;
}

// Drafts and stable, frozen save requests live in the caller's OS-encrypted store.
export function createSharedNote({notes,scope,online,request,persist,changed,imagesReady,retryMs=1000}){
  let closed=false,timer=null,running=null,serial=Promise.resolve(),attempt=0;
  const current=()=>scope()?notes[scope()]??=({blocks:[],revision:null,dirty:false,pending:null,has_backup:false}):null;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const snapshot=()=>{const n=current();return n?clone({...n,phase:n.conflict?'conflict':n.dirty||n.pending?(online()?'syncing':'offline'):'saved'}):{blocks:[],revision:null,phase:'locked'};};
  const emit=()=>changed();
  const wake=(delay=0)=>{clearTimeout(timer);if(!closed){timer=setTimeout(()=>void flush(),delay);timer.unref?.();}};
  const enqueue=fn=>{const p=serial.catch(()=>{}).then(fn);serial=p;return p;};
  async function fetchNote(n,bound){
    const result=await request('/note'+(n.revision!==null?`?since=${n.revision}`:''),{},bound);
    if(!result.unchanged){
      if((n.dirty||n.pending)&&!same(n.blocks,result.blocks)&&!(n.revision===null&&result.revision===0))n.conflict=result;
      else if(!n.dirty&&!n.pending){n.blocks=result.blocks;n.revision=result.revision;}
      if(n.revision===null&&!n.conflict)n.revision=result.revision;
    }
    n.has_backup=result.has_backup;n.updated=result.updated;
  }
  async function refresh(){
    await serial.catch(()=>{});const n=current(),bound=scope();
    if(!n||!online()||running)return snapshot();
    // Reconcile an uncertain save receipt before comparing another device's version.
    if(n.pending||n.dirty){wake();return snapshot();}
    await fetchNote(n,bound);await persist();emit();return snapshot();
  }
  async function flush(){
    if(closed||running||!online())return;
    const n=current(),bound=scope();if(!n||n.conflict||!n.dirty&&!n.pending)return;
    running=(async()=>{try{
      if(n.revision===null){await fetchNote(n,bound);if(n.conflict)return;}
      if(!n.pending){
        if(!imagesReady(n.blocks,bound))return;
        n.pending={expected:n.revision,operation:id(),blocks:clone(n.blocks),action:n.action||'save'};
        await persist();
      }
      const pending=n.pending,result=await request('/note',{method:'PUT',body:pending},bound);
      n.revision=result.accepted_revision;n.has_backup=result.has_backup;n.updated=result.updated;
      n.pending=null;n.error=null;attempt=0;
      if(same(n.blocks,pending.blocks)&&(n.action===undefined||n.action===pending.action)){
        n.blocks=result.blocks;n.dirty=false;delete n.action;
      }
      if(result.revision!==result.accepted_revision){
        if(n.dirty)n.conflict=result;else{n.blocks=result.blocks;n.revision=result.revision;}
      }
      await persist();
    }catch(e){
      n.error=e.code||'CLIPBOARD_NOTE_SYNC_FAILED';
      if(n.error==='CLIPBOARD_NOTE_CONFLICT'){
        try{n.conflict=await request('/note',{},bound);}catch{}
      }
      await persist().catch(()=>{});attempt++;
    }finally{running=null;emit();const latest=current();if(!closed&&latest===n&&(n.dirty||n.pending)&&!n.conflict)wake(Math.min(15000,retryMs*2**Math.min(attempt,4)));}})();
    await running;
  }
  async function save(blocks){return enqueue(async()=>{
    const n=current();if(!n)throw error('ACCOUNT_LOGIN_REQUIRED');const value=normalizeNote(blocks);
    if(same(n.blocks,value)&&!n.action){await persist();emit();wake(700);return snapshot();}n.blocks=value;n.dirty=true;n.error=null;delete n.action;
    await persist();emit();wake(700);return snapshot();
  });}
  async function command(action){return enqueue(async()=>{
    const n=current();if(!n)throw error('ACCOUNT_LOGIN_REQUIRED');
    if(action==='local'||action==='remote'){
      if(!n.conflict)throw error('CLIPBOARD_INVALID');
      n.recovery=clone(action==='remote'?n.blocks:n.conflict.blocks);
      n.revision=n.conflict.revision;
      if(action==='remote'){n.blocks=n.conflict.blocks;n.dirty=false;}else n.dirty=true;
      n.pending=null;delete n.conflict;delete n.action;
    }else if(action==='recover-local'){
      if(!n.recovery)throw error('CLIPBOARD_NOT_FOUND');const b=n.blocks;n.blocks=n.recovery;n.recovery=b;n.dirty=true;delete n.action;
    }else if(['clear','restore'].includes(action)){
      if(n.dirty||n.pending||n.conflict)throw error('CLIPBOARD_NOTE_BUSY');
      if(action==='clear')n.recovery=clone(n.blocks);n.action=action;n.blocks=action==='clear'?[]:n.blocks;n.dirty=true;
    }else throw error('CLIPBOARD_INVALID');
    n.error=null;await persist();emit();wake();return snapshot();
  });}
  return {snapshot,save,command,refresh,wake,async close(){closed=true;clearTimeout(timer);await serial.catch(()=>{});await running;await persist();}};
}

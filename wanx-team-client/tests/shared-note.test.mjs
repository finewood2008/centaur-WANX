import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedNote,normalizeNote} from '../shell/shared-note.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async f=>{for(let i=0;i<300;i++){if(f())return;await delay(10);}throw Error('Timed out');};
const text=value=>[{type:'text',text:value}];
function fixture(t){
  let bound='account-a-box-a',connected=true,revision=0,blocks=[],fail=false,drop=false,saves=0,stored;
  const receipts=new Map(),notes={};
  const request=async(route,options={})=>{
    if(fail)throw Object.assign(Error('tunnel_timeout'),{code:'tunnel_timeout'});
    if(options.method==='PUT'){
      const p=options.body;
      if(receipts.has(p.operation))return {...receipts.get(p.operation),blocks:structuredClone(blocks),revision};
      if(p.expected!==revision)throw Object.assign(Error('CLIPBOARD_NOTE_CONFLICT'),{code:'CLIPBOARD_NOTE_CONFLICT'});
      blocks=structuredClone(p.blocks);revision++;saves++;
      const result={blocks:structuredClone(blocks),revision,accepted_revision:revision,has_backup:false};receipts.set(p.operation,result);
      if(drop){drop=false;throw Object.assign(Error('ECONNRESET'),{code:'ECONNRESET'});}return result;
    }
    if(new URL('http://local'+route).searchParams.get('since')===String(revision))return {revision,unchanged:true};
    return {blocks:structuredClone(blocks),revision,has_backup:false};
  };
  const options={notes,scope:()=>bound,online:()=>connected,request,persist:async()=>{stored=structuredClone(notes);},changed(){},imagesReady:()=>true,retryMs:10};
  const n=createSharedNote(options);t.after(()=>n.close());
  return {n,options,notes,state:()=>({stored,saves,blocks,revision}),offline(){connected=false;},online(){connected=true;n.wake();},fail(v){fail=v;},drop(){drop=true;},switch(v){bound=v;n.wake();},remote(v){blocks=text(v);revision++;}};
}

test('continuous edits replace one note and a lost receipt never appends duplicate text',async t=>{
 const f=fixture(t);await f.n.refresh();f.drop();await f.n.save(text('中文  spaces\n原文'));f.n.wake();
 await wait(()=>f.n.snapshot().phase==='saved');assert.equal(f.state().saves,1);assert.deepEqual(f.state().blocks,text('中文  spaces\n原文'));
 await f.n.save(text('中文  spaces\n原文\n追加'));f.n.wake();await wait(()=>f.state().saves===2&&f.n.snapshot().phase==='saved');
 assert.deepEqual(f.state().blocks,text('中文  spaces\n原文\n追加'));
});

test('offline draft survives restart, stays owner/box-bound and syncs once after reconnection',async t=>{
 const f=fixture(t);await f.n.refresh();f.offline();await f.n.save(text('离线草稿'));await f.n.close();
 const saved=f.state().stored;const restarted=createSharedNote({...f.options,notes:saved});t.after(()=>restarted.close());
 assert.deepEqual(restarted.snapshot().blocks,text('离线草稿'));f.switch('account-a-box-b');await restarted.refresh();assert.deepEqual(restarted.snapshot().blocks,[]);
 f.switch('account-a-box-a');f.online();restarted.wake();await wait(()=>restarted.snapshot().phase==='saved');assert.equal(f.state().saves,1);
 f.switch(null);assert.equal(restarted.snapshot().phase,'locked');assert.deepEqual(restarted.snapshot().blocks,[]);
});

test('simultaneous device edits retain local draft and require an explicit conflict choice',async t=>{
 const f=fixture(t);await f.n.refresh();f.offline();await f.n.save(text('本机新内容'));f.remote('另一设备内容');f.online();
 await wait(()=>f.n.snapshot().phase==='conflict');assert.deepEqual(f.n.snapshot().blocks,text('本机新内容'));assert.deepEqual(f.n.snapshot().conflict.blocks,text('另一设备内容'));
 await f.n.command('remote');assert.deepEqual(f.n.snapshot().blocks,text('另一设备内容'));assert.deepEqual(f.n.snapshot().recovery,text('本机新内容'));
 await f.n.command('recover-local');f.n.wake();await wait(()=>f.n.snapshot().phase==='saved');assert.deepEqual(f.state().blocks,text('本机新内容'));
});

test('offline first edit never overwrites an existing note fetched for the first time',async t=>{
 const f=fixture(t);f.offline();await f.n.save(text('首次离线输入'));f.remote('盒子已有内容');f.online();await wait(()=>f.n.snapshot().phase==='conflict');
 assert.equal(f.state().saves,0);assert.deepEqual(f.n.snapshot().blocks,text('首次离线输入'));
});

test('text and image structure validation accepts Unicode and refuses HTML or excess bodies',()=>{
 assert.deepEqual(normalizeNote([...text('中文'),...text('\n 文字'),{type:'image',item:'a'.repeat(32)}]),[{type:'text',text:'中文\n 文字'},{type:'image',item:'a'.repeat(32)}]);
 assert.throws(()=>normalizeNote([{type:'html',text:'<script>'}]),{code:'CLIPBOARD_INVALID'});
 assert.throws(()=>normalizeNote(text('a'.repeat(1024*1024))),{code:'CLIPBOARD_NOTE_LIMIT'});
});

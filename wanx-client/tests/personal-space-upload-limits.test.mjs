import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPersonalSpace,MAX_UPLOAD_BYTES} from '../shell/personal-space.mjs';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'wanx-limits-'));let chosen=[],saved=[],writes=0;
 const requests=[],events=[],state={phase:'ready',account:{phase:'authenticated',accountId:'owner'},connection:{deviceId:'box'}};
 const client={snapshot:()=>state,subscribe:()=>()=>{},applicationConnection:async()=>({context(){},request(input){requests.push(input);throw Error('preflight only');}})};
 const service=await createPersonalSpace({client,serviceURL:'https://test',chooseUploads:async()=>chosen,store:{load:async()=>[],save:async value=>{saved=structuredClone(value);writes++;if(value.length)state.phase='recovering';}},onEvent:e=>events.push(e)});
 await new Promise(r=>setImmediate(r));t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
 return {service,requests,events,saved:()=>saved,writes:()=>writes,select(files){chosen=files;state.phase='ready';},async file(name,size=0){const file=path.join(root,name),h=await open(file,'wx');await h.truncate(size);await h.close();return file;}};
}
for(const entry of ['picker','drop']){
 for(const count of [19,20,21,201])test(`${entry}: ${count} files are accepted without a whole-batch count ceiling`,async t=>{
  const f=await fixture(t),paths=[];for(let i=0;i<count;i++)paths.push(await f.file(`${i}.txt`));f.select(paths);await f.service.uploads('',entry==='drop'?paths:undefined);assert.equal(f.saved().length,count);assert.equal(f.requests.length,0);
 });
 for(const bytes of [0,MAX_UPLOAD_BYTES-1,MAX_UPLOAD_BYTES,MAX_UPLOAD_BYTES+1])test(`${entry}: ${bytes} byte boundary is isolated to its own file`,async t=>{
  const f=await fixture(t),file=await f.file('boundary.bin',bytes);f.select([file]);await f.service.uploads('',entry==='drop'?[file]:undefined);assert.equal(f.saved().length,1);const task=f.saved()[0];assert.equal(task.size,bytes);assert.equal(task.phase,bytes>MAX_UPLOAD_BYTES?'paused':'queued');assert.equal(task.error,bytes>MAX_UPLOAD_BYTES?'SPACE_UPLOAD_LIMIT':undefined);assert.equal(f.requests.length,0);
 });
}
test('mixed oversized batch keeps valid files and records each skipped basename without native path leakage',async t=>{
 const f=await fixture(t),small=await f.file('small.txt',10),big1=await f.file('大文件.bin',MAX_UPLOAD_BYTES+1),big2=await f.file('large.bin',MAX_UPLOAD_BYTES+2);f.select([small,big1,big2]);await f.service.uploads('');
 assert.equal(f.saved().filter(t=>t.phase==='queued').length,1);assert.equal(f.saved().filter(t=>t.error==='SPACE_UPLOAD_LIMIT').length,2);assert.equal(f.service.snapshot().imports[0].failed,2);assert.doesNotMatch(JSON.stringify(f.service.snapshot()),new RegExp(path.dirname(small)));assert.equal(f.requests.length,0);
});
test('cancel selects nothing; repeated local selections deduplicate by path plus visible name',async t=>{
 const f=await fixture(t),writes=f.writes();await f.service.uploads('');assert.equal(f.writes(),writes);const file=await f.file('one.txt');f.select(Array(21).fill(file));await f.service.uploads('');assert.equal(f.saved().length,1);
});
test('dropped Unicode names remain byte-for-byte even if their disk basename is temporary',async t=>{
 const f=await fixture(t),file=await f.file('temporary.bin',1),names=['中文 报告（终稿）😀.png','cafe\u0301.txt'];await f.service.uploads('',[file,file],undefined,names);assert.deepEqual(f.saved().map(t=>t.name),names);
});
test('invalid names are isolated and do not prevent valid peers; malformed bridge arrays are rejected',async t=>{
 for(const bad of [' 前导空格.txt','尾部.txt ','../escape.txt','x\\bad.txt','a\n.txt','x.','字'.repeat(81)]){
  const f=await fixture(t),file=await f.file('temporary.bin',1);await f.service.uploads('',[file,file],undefined,['正常.txt',bad]);assert.equal(f.saved().filter(t=>t.phase==='queued').length,1);assert.equal(f.saved().filter(t=>t.error==='SPACE_INVALID_NAME').length,1);
 }
 const f=await fixture(t),file=await f.file('one.bin');await assert.rejects(f.service.uploads('',[file],undefined,[]),{code:'SPACE_INVALID_DROP'});assert.equal(f.saved().length,0);
});

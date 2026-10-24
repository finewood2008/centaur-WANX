import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {stopGroup} from '../dsh/sandbox.mjs';
const root=path.resolve('.');
async function files(){const result={};for(const name of ['miniapp.manifest.json','src/app.js','src/styles.css']){try{result[name]=await readFile('examples/ledger/'+name,'utf8')}catch{}}return result}
async function worker(t,terminal){
 const dir=await mkdtemp(path.join(os.tmpdir(),'wanx-native-worker-')),python=path.join(dir,'terminal');
 await writeFile(python,'#!/usr/bin/env node\n'+(terminal==='slow'?'process.stdin.resume();setInterval(()=>{},10000)':'process.exit(1)'),{mode:0o700});
 const proc=spawn(process.execPath,['codex/driver.mjs'],{env:{PATH:process.env.PATH,WANX_CODEX_PATH:path.join(root,'tests/fixtures/native-codex.mjs'),WANX_CODEX_CONFIG:JSON.stringify({features:{shell_tool:false},mcp_servers:{}}),WANX_PYTHON_PATH:python},stdio:['pipe','pipe','pipe'],detached:true});
 const lines=readline.createInterface({input:proc.stdout})[Symbol.asyncIterator]();let errors='';proc.stderr.on('data',x=>errors+=x);
 t.after(async()=>{await stopGroup(proc);await rm(dir,{recursive:true,force:true});assert.equal(errors,'')});
 return {proc,dir,lines};
}

test('two builds reuse native process/session; failed terminal does not fail delivery',async t=>{
 const w=await worker(t,'failed');let session;
 for(let i=0;i<2;i++){
  const taskRoot=path.join(w.dir,'task-'+i);await import('node:fs/promises').then(x=>x.mkdir(taskRoot));
  w.proc.stdin.write(JSON.stringify({taskRoot,scope:'same-project',sessionId:session,files:await files(),material:{marker:i},authorizeTools:true})+'\n');
  let result=false,reused=false,warning=false;
  for(;;){const {value,done}=await w.lines.next();assert.equal(done,false);const e=JSON.parse(value);
   if(e.type==='authorize')w.proc.stdin.write(JSON.stringify({id:e.id,result:true})+'\n');
   if(e.type==='session'){if(i)assert.equal(e.sessionId,session);session=e.sessionId;reused=e.reused}
   if(e.type==='failed')assert.fail(e.code);
   if(e.type==='status'&&e.text.includes('暂不可用'))warning=true;
   if(e.type==='result'){result=true;assert.deepEqual(e.files,await files())}
   if(e.type==='idle')break;
  }
  assert.ok(result&&warning);assert.equal(reused,i===1);assert.equal(w.proc.exitCode,null);
 }
});

test('slow terminal never blocks the model turn or first tool, and cancellation reaps worker',async t=>{
 const w=await worker(t,'slow');
 w.proc.stdin.write(JSON.stringify({taskRoot:w.dir,files:await files(),material:{},authorizeTools:true})+'\n');
 let attached=false,message=false,tool=false;
 const deadline=setTimeout(()=>w.proc.kill('SIGTERM'),8000);
 try{
  for(;;){const {value,done}=await w.lines.next();assert.equal(done,false);const e=JSON.parse(value);
   if(e.type==='terminal_attached')attached=true;
   if(e.type==='message')message=true;
   if(e.type==='authorize'){tool=true;break}
   if(e.type==='failed')assert.fail(e.code);
  }
  assert.ok(message&&tool);assert.equal(attached,false);
  await stopGroup(w.proc);assert.notEqual(w.proc.exitCode,null);
 }finally{clearTimeout(deadline)}
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

for(const driver of ['driver','interview'])test(`${driver} closes a server that finishes starting after its owner disconnects`,{skip:process.platform==='win32',timeout:15000},async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'wanx-owner-'));
  const pidFile=path.join(dir,'server.pid'),binary=path.join(dir,'fake-codex.mjs');
  const ws=fileURLToPath(import.meta.resolve('ws'));
  await writeFile(binary,`#!${process.execPath}\nimport http from 'node:http';import {writeFileSync} from 'node:fs';import {WebSocketServer} from ${JSON.stringify(ws)};writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const s=http.createServer();new WebSocketServer({server:s});setTimeout(()=>s.listen(process.argv[process.argv.indexOf('--listen')+1].slice(7)),350);`,{mode:0o700});
  const child=spawn(process.execPath,[`codex/${driver}.mjs`],{cwd:new URL('..',import.meta.url),env:{...process.env,WANX_CODEX_PATH:binary,WANX_CODEX_CONFIG:'{}'},stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();
  const exited=new Promise(resolve=>child.once('exit',resolve));let pid;
  try{
    child.stdin.write(JSON.stringify({cwd:dir,taskRoot:dir,files:{'src/app.js':'export default function App(){return null}'}})+'\n');
    // Loading the driver's compiler/ACP modules can exceed three seconds during
    // a full regression run. This wait only observes fixture startup; teardown
    // must still finish within the same strict five-second disconnect bound.
    const startupDeadline=Date.now()+8000;
    while(Date.now()<startupDeadline){try{pid=Number(await readFile(pidFile,'utf8'));break}catch{}if(child.exitCode!==null)break;await new Promise(r=>setTimeout(r,30))}
    assert.ok(pid,'fake server started');child.stdin.end();
    await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('driver did not exit')),5000))]);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    assert.match(output,/TASK_CHANNEL_DENIED|INTERVIEW_CLOSED/);
  }finally{child.kill('SIGKILL');if(pid){try{process.kill(pid,'SIGKILL')}catch{}}await rm(dir,{recursive:true,force:true})}
});

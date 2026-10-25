import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startSharedServer} from '../codex/shared-server.mjs';
const require=createRequire(import.meta.url);
async function binary(t,body){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'wanx-startup-test-')),file=path.join(cwd,'fake-codex');
 await writeFile(file,`#!${process.execPath}\n${body}`,{mode:0o700});
 t.after(()=>rm(cwd,{recursive:true,force:true}));return {binary:file,cwd,config:{},env:{PATH:process.env.PATH}};
}
const listen=`const http=require('node:http');const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});const address=process.argv[process.argv.indexOf('--listen')+1].slice(7);const server=http.createServer();new WebSocketServer({server});server.listen(address);`;
test('cold startup beyond ten seconds waits for the same process instead of restarting it',async t=>{
 const spec=await binary(t,`require('node:fs').appendFileSync(process.env.COUNT_FILE,process.pid+'\\n');setTimeout(()=>{${listen}},11000);`),count=path.join(spec.cwd,'starts'),traces=[];
 const start=performance.now(),server=await startSharedServer({...spec,env:{...spec.env,COUNT_FILE:count},onTrace:e=>traces.push(e)});
 try{
  assert.ok(performance.now()-start>=11000);assert.equal((await readFile(count,'utf8')).trim().split('\n').length,1);
  assert.equal(traces[0].phase,'server_ready');assert.equal(traces[0].appServerPid,server.child.pid);
 }finally{await server.close()}
});
test('failed launch reports bounded metadata and exits promptly without leaking stderr',async t=>{
 const spec=await binary(t,"process.stderr.write('permission denied: Bearer secret-test-value');process.exit(9)"),traces=[],start=performance.now();
 await assert.rejects(startSharedServer({...spec,onTrace:e=>traces.push(e)}),/CODEX_SHARED_SERVER_FAILED/);
 assert.ok(performance.now()-start<5000);assert.equal(traces[0].category,'PERMISSION_DENIED');assert.equal(traces[0].exitCode,9);
 assert.ok(!JSON.stringify(traces).includes('secret-test-value'));
});
test('spawn failure and cancellation release the attempted server',async t=>{
 const traces=[];await assert.rejects(startSharedServer({binary:'/synthetic/missing/codex',cwd:os.tmpdir(),config:{},env:{},onTrace:e=>traces.push(e)}),/CODEX_SHARED_SERVER_FAILED/);
 assert.equal(traces[0].spawnCode,'ENOENT');
 const spec=await binary(t,"setInterval(()=>{},1000)"),controller=new AbortController();
 setTimeout(()=>controller.abort(),200);
 await assert.rejects(startSharedServer({...spec,signal:controller.signal}),/TASK_CHANNEL_DENIED/);
});

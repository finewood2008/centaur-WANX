import http from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sandboxCommand,spawnSandbox,stopGroup} from '../dsh/sandbox.mjs';
import {ClientSideConnection,ndJsonStream} from '@agentclientprotocol/sdk';
import {Readable,Writable} from 'node:stream';

export async function probeDsh(){
  if(process.platform!=='darwin')return {available:false,version:'0.2.1-rc.2',code:'ISOLATION_PLATFORM_UNSUPPORTED'};
  const taskRoot=await mkdtemp(path.join(os.tmpdir(),'wanx-studio-probe-'));
  const outside=await mkdtemp(path.join(os.tmpdir(),'wanx-studio-outside-'));
  const secret=path.join(outside,'private.txt'),source=path.join(taskRoot,'app.js');
  await writeFile(secret,'synthetic-private');await writeFile(source,'original');
  const proxy=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{}')});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const forbidden=http.createServer((_req,res)=>res.end('forbidden'));await new Promise(r=>forbidden.listen(0,'127.0.0.1',r));
  let child, engineDiagnostic='';
  try{
    const env={WANX_TASK_PROXY:`http://127.0.0.1:${proxy.address().port}`,WANX_TASK_TOKEN:'synthetic-probe',WANX_PROBE_SECRET:secret,WANX_PROBE_SOURCE:source,WANX_PROBE_FORBIDDEN_PORT:String(forbidden.address().port)};
    let spec=await sandboxCommand({taskRoot,port:proxy.address().port,extraEnv:env,probe:true});
    child=spawnSandbox(spec);let out='',err='';child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);
    const code=await Promise.race([new Promise(r=>child.once('exit',r)),new Promise((_,reject)=>setTimeout(()=>reject(new Error('PROBE_TIMEOUT')),15000))]);
    if(code!==0)throw Object.assign(new Error('ISOLATION_PROBE_FAILED'),{diagnostic:`exit=${code};signal=${child.signalCode};${err.slice(0,1400)}`,probeOutput:out.slice(0,1000)});
    const boundaries=JSON.parse(out);if(await readFile(source,'utf8')!=='original')throw new Error('SOURCE_WRITE_ESCAPED');
    spec=await sandboxCommand({taskRoot,port:proxy.address().port,extraEnv:env});child=spawnSandbox(spec);err='';child.stderr.on('data',s=>{err+=s;engineDiagnostic+=s});
    const connection=new ClientSideConnection(()=>({async sessionUpdate(){},async requestPermission(request){const option=request.options.find(o=>o.kind==='reject_once'||o.kind==='reject_always');return option?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}}}}),ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
    const initialize=await Promise.race([connection.initialize({protocolVersion:1,clientCapabilities:{}}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('ACP_TIMEOUT')),12000))]);
    const session=await connection.newSession({cwd:taskRoot,mcpServers:[]});await connection.closeSession({sessionId:session.sessionId});
    await stopGroup(child);
    return {available:true,version:'0.2.1-rc.2',boundaries,acp:initialize.protocolVersion,modelCalls:0,resourceLimits:{wallSeconds:600,nodeHeapMiB:512,memory:'heap limit plus RSS monitoring; not a kernel quota'}};
  }catch(error){return {available:false,version:'0.2.1-rc.2',code:error.message,diagnostic:error.diagnostic||engineDiagnostic.slice(-2200),probeOutput:error.probeOutput,modelCalls:0}}
  finally{await stopGroup(child);proxy.closeAllConnections();forbidden.closeAllConnections();await new Promise(r=>proxy.close(r));await new Promise(r=>forbidden.close(r));await rm(taskRoot,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
}
if(import.meta.url===new URL(process.argv[1],'file:').href)process.stdout.write(JSON.stringify(await probeDsh(),null,2)+'\n',()=>process.exit(0));

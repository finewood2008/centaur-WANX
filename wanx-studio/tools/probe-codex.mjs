// Connectivity only: no thread, MCP tool process or model turn is created.
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const connectionCodes=new Set([
  'CODEX_SHARED_SERVER_FAILED','CODEX_SHARED_SERVER_TIMEOUT',
  'CODEX_CONNECTION_CLOSED','CODEX_CONNECTION_FAILED',
  'CODEX_REQUEST_TIMEOUT','CODEX_REQUEST_FAILED','CODEX_PROTOCOL_INVALID',
]);
const report={executor:'Codex',version:'native-app-server',transport:'app-server',
  check:'protocol',modelCalls:0,nodeVersion:process.versions.node};
const failed=code=>({...report,available:false,code});

async function createNativeSession(options){
  const {NativeSession}=await import('../codex/native-session.mjs');
  return new NativeSession(options);
}

async function readVersion(binary,{env,cwd},signal,stopGroup){
  // execFile does not pass detached through to spawn. Own an explicit process
  // group so wrappers and native descendants are drained on every exit path.
  const child=spawn(binary,['--version'],{env,cwd,detached:true,stdio:['ignore','pipe','pipe']});
  let output='',bytes=0,failed=false,closing;
  const close=()=>closing??=stopGroup(child);
  const interrupt=()=>{failed=true;void close().catch(()=>{})};
  const exited=new Promise(resolve=>{
    child.once('error',()=>resolve(null));child.once('close',code=>resolve(code));
  });
  child.stdout.on('data',data=>{
    if(failed)return;
    bytes+=data.length;
    if(bytes>4096){interrupt();return}
    output+=data;
  });
  child.stderr.resume();
  signal?.addEventListener('abort',interrupt,{once:true});
  if(signal?.aborted)interrupt();
  const timeout=setTimeout(interrupt,10000);
  try{
    const code=await exited;
    if(code!==0||failed)throw new Error('CODEX_VERSION_FAILED');
    return output;
  }finally{
    clearTimeout(timeout);signal?.removeEventListener('abort',interrupt);
    await close();
  }
}

export async function probeCodex({environment=process.env,createSession=createNativeSession,signal}={}){
  let cwd,native,result,nativeClosing;
  const active=()=>{if(signal?.aborted)throw new Error('CODEX_INTERRUPTED')};
  const closeNative=()=>nativeClosing??=(native?Promise.resolve().then(()=>native.close()):undefined);
  const interrupt=()=>void closeNative()?.catch(()=>{});
  signal?.addEventListener('abort',interrupt,{once:true});
  try{
    active();
    if(!environment.WANX_CODEX_PATH||!environment.WANX_CODEX_CONFIG)return failed('CODEX_NOT_CONFIGURED');
    let config;
    try{config=JSON.parse(environment.WANX_CODEX_CONFIG)}
    catch{return failed('CODEX_POLICY_INVALID')}
    if(!config||config.features?.shell_tool!==false||config.features?.multi_agent!==false||
       config.tools?.view_image!==false)return failed('CODEX_POLICY_INVALID');
    try{cwd=await mkdtemp(path.join(environment.TMPDIR||os.tmpdir(),'wanx-codex-probe-'))}
    catch{return failed('CODEX_TEMP_DIRECTORY_UNAVAILABLE')}
    const {runtimeEnvironment}=await import('../codex/runtime-env.mjs');
    const {stopGroup}=await import('../dsh/sandbox.mjs');
    const env=runtimeEnvironment(environment);
    active();
    let version;
    try{version=await readVersion(environment.WANX_CODEX_PATH,{env,cwd},signal,stopGroup)}
    catch{return failed(signal?.aborted?'CODEX_INTERRUPTED':'CODEX_VERSION_FAILED')}
    active();
    const match=/^codex-cli (\d+\.\d+\.\d+)$/.exec(version.trim());
    if(!match)return failed('CODEX_VERSION_INVALID');
    native=await createSession({binary:environment.WANX_CODEX_PATH,config,env});
    active();
    await native.connect(cwd);
    active();
    if(typeof native.initialization?.userAgent!=='string')throw new Error('CODEX_PROTOCOL_INVALID');
    result={...report,available:true,cliVersion:match[1],
      nativeTerminal:{available:process.platform!=='win32',readOnly:true,deferred:true},
      policy:{scope:'task-MCP-tools-only',shell:false,terminal:false,clientFileSystem:false,userApprovals:false}};
  }catch(error){
    result=failed(signal?.aborted?'CODEX_INTERRUPTED':error?.code==='ERR_MODULE_NOT_FOUND'?'CODEX_DEPENDENCIES_MISSING':
      connectionCodes.has(error?.message)?error.message:'CODEX_CONNECTION_FAILED');
  }finally{
    // Preserve the first failure, but never report success after failed cleanup.
    try{await closeNative()}
    catch{if(!result||result.available)result=failed('CODEX_CLEANUP_FAILED')}
    try{if(cwd)await rm(cwd,{recursive:true,force:true})}
    catch{if(!result||result.available)result=failed('CODEX_CLEANUP_FAILED')}
    signal?.removeEventListener('abort',interrupt);
  }
  return signal?.aborted?failed('CODEX_INTERRUPTED'):result;
}

const entry=process.argv[1]?await realpath(process.argv[1]).catch(()=>null):null;
if(entry&&import.meta.url===pathToFileURL(entry).href){
  const controller=new AbortController();
  const interrupt=()=>controller.abort();
  process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt);
  const result=await probeCodex({signal:controller.signal});
  process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);
  process.stdout.write(JSON.stringify(result)+'\n');
  if(!result.available)process.exitCode=1;
}

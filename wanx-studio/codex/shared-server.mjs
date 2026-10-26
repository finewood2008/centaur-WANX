import {spawn} from 'node:child_process';
import {mkdtemp,rm,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {stopGroup} from '../dsh/sandbox.mjs';

export const socketURL=socket=>'ws+unix://'+socket+':/';
export async function rpcRequest(socket,method,params){
  const ws=new WebSocket(socketURL(socket));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
  const pending=new Map();let id=0;
  ws.on('message',data=>{const message=JSON.parse(data);const request=pending.get(message.id);if(request){pending.delete(message.id);message.error?request.reject(new Error('CODEX_CONTROL_REQUEST_FAILED')):request.resolve(message.result)}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}))});
  try{
    await request('initialize',{clientInfo:{name:'wanx_task_controller',version:'0.2.0'},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:'initialized',params:{}}));
    return await request(method,params);
  }finally{ws.close()}
}
export function toml(value){
  if(Array.isArray(value))return '['+value.map(toml).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+'='+toml(v)).join(',')+'}';
  return JSON.stringify(value);
}
export function configArgs(config){
  return Object.entries(config).flatMap(([key,value])=>['-c',key+'='+toml(value)]);
}
export async function startSharedServer({binary,config,env,cwd,signal,onTrace=()=>{}}){
  if(signal?.aborted)throw new Error('TASK_CHANNEL_DENIED');
  const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-codex-'));
  await chmod(directory,0o700);
  const socket=path.join(directory,'server.sock');
  const settings={...config,projects:{[cwd]:{trust_level:'trusted'}}};
  const child=spawn(binary,['app-server','--listen','unix://'+socket,...configArgs(settings)],
    {cwd,env,stdio:['ignore','ignore','pipe'],detached:true});
  const started=performance.now(),deadline=started+30000;let spawnCode,exit,stderr='',socketCode;
  child.once('error',error=>{spawnCode=error.code||'SPAWN_FAILED'});
  child.once('exit',(code,signal)=>{exit={exitCode:code,signal}});
  child.stderr?.on('data',data=>{stderr=(stderr+data.toString()).slice(-4096)});
  let closing;
  const close=()=>closing??=(async()=>{await stopGroup(child);await rm(directory,{recursive:true,force:true})})();
  const abort=()=>void close();signal?.addEventListener('abort',abort,{once:true});
  try{
    // A cold launch can exceed ten seconds. Keep one process while it starts;
    // replacing it at ten seconds only restarts the same initialization work.
    while(performance.now()<deadline){
      if(signal?.aborted)throw new Error('TASK_CHANNEL_DENIED');
      if(spawnCode||exit||child.exitCode!==null||child.signalCode)throw new Error('CODEX_SHARED_SERVER_FAILED');
      const ready=await new Promise(resolve=>{
        const ws=new WebSocket(socketURL(socket),{handshakeTimeout:1000});
        ws.once('open',()=>{ws.close();resolve(true)});ws.once('error',error=>{socketCode=error.code||'HANDSHAKE_FAILED';resolve(false)});
      });
      if(ready){await chmod(socket,0o600);onTrace({phase:'server_ready',milliseconds:Math.round(performance.now()-started),appServerPid:child.pid});return {socket,child,close}}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('CODEX_SHARED_SERVER_TIMEOUT');
  }catch(error){
    const category=/address.*in use/i.test(stderr)?'ADDRESS_IN_USE':/permission denied|operation not permitted/i.test(stderr)?'PERMISSION_DENIED':/invalid.*config|failed to.*config/i.test(stderr)?'CONFIG_INVALID':/database.*(?:locked|busy)/i.test(stderr)?'DATABASE_BUSY':/panic/i.test(stderr)?'PANIC':undefined;
    onTrace({phase:'server_failed',milliseconds:Math.round(performance.now()-started),code:error.message,appServerPid:child.pid,spawnCode,...exit,socketCode,category});
    await close();throw error;
  }
  finally{signal?.removeEventListener('abort',abort)}
}

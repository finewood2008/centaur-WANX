import {spawn} from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import {createObserver} from './observer.mjs';
import {rpcRequest} from './shared-server.mjs';
import {stopGroup} from '../dsh/sandbox.mjs';

export async function startTerminal({server,sessionId,binary,python,config,env,taskRoot,root,emit}){
  // Initialize storage without inference, so the CLI can resume before the first turn.
  await rpcRequest(server.socket,'thread/inject_items',{threadId:sessionId,items:[{type:'message',role:'developer',content:[{type:'input_text',text:'本会话由 WANX 工作台经 ACP 调度，Codex CLI 是同一任务的只读观察界面。需求、源码与允许能力由受信任务工具提供。开发中不要等待终端用户输入。'}]}]});
  let resolveReady,rejectReady,closing=false,child,bytes=0,observer,timer;
  let rejectFailure;const failure=new Promise((_,reject)=>rejectFailure=reject);failure.catch(()=>{});
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});
  // Keep a rejection observed while the terminal process is starting.
  ready.catch(()=>{});
  const close=async()=>{
    if(closing)return;closing=true;clearTimeout(timer);
    if(child?.exitCode===null&&!child.signalCode)await stopGroup(child);
    await observer?.close();
  };
  try{
    observer=await createObserver({socket:server.socket,sessionId,onReady(){
      clearTimeout(timer);emit({type:'terminal_attached',text:'原版 Codex CLI 已以只读方式连接同一 ACP 任务',acpSessionId:sessionId,cliSessionId:sessionId});resolveReady();
    },onPolicy(info){if(!info.allowed)emit({type:'terminal_policy',text:'终端只读策略拒绝了控制操作',method:info.method})}});
    emit({type:'terminal_info',text:'正在连接原版 Codex CLI 只读终端',cols:96,rows:32,source:'original-codex-cli',acpSessionId:sessionId,readOnly:true});
    child=spawn(python,[path.join(root,'codex/terminal.py')],{cwd:root,env,stdio:['pipe','pipe','pipe'],detached:true});
    child.stderr.resume();
    child.once('error',()=>rejectReady(new Error('CODEX_TERMINAL_FAILED')));
    const lines=readline.createInterface({input:child.stdout});
    lines.on('line',line=>{
      try{
        const message=JSON.parse(line);
        if(message.kind==='bytes'){bytes+=Buffer.from(message.data,'base64').length;emit({type:'terminal',data:message.data,encoding:'base64'})}
        if(message.kind==='input_rejected')emit({type:'terminal_policy',text:'终端输入已被服务端拒绝'});
      }catch{rejectReady(new Error('CODEX_TERMINAL_FAILED'))}
    });
    child.once('exit',()=>{lines.close();if(!closing){const error=new Error('CODEX_TERMINAL_FAILED');rejectReady(error);rejectFailure(error)}});
    child.stdin.write(JSON.stringify({binary,socket:observer.socket,sessionId,cwd:taskRoot,config})+'\n');
    timer=setTimeout(()=>rejectReady(new Error('CODEX_TERMINAL_TIMEOUT')),20000);
    await ready;
    // Let the CLI finish its initial history hydration before starting inference.
    await new Promise(resolve=>setTimeout(resolve,300));
    return {close,failure,get bytes(){return bytes}};
  }catch(error){await close();throw error}
}

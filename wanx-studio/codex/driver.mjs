import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import{patchSource}from'../core/source-patch.mjs';
import {compileArtifact,sourcePath,validateSources} from '../core/artifact.mjs';
import {startTerminal} from './terminal.mjs';
import {visualPrompt} from './visual-feedback.mjs';

import {redact} from './events.mjs';
import {NativeSession} from './native-session.mjs';
import {serveWorker} from './worker.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
await serveWorker(async({emit:send,request})=>{
 let config,files,native,terminal,terminalPending,terminalController,finish,finished,closed=true,submitted=false,planNeeded=false;
 const token=randomUUID()+randomUUID();
 const emit=e=>send(redact(e,config?.taskRoot));
 const authorize=async()=>{if(closed)throw new Error('TASK_CHANNEL_DENIED');if(config.authorizeTools)await request('authorize')};
const proxy=http.createServer(async(req,res)=>{
  try{
    if(closed||submitted||req.method!=='POST'||req.url!=='/tool'||req.headers.authorization!=='Bearer '+token||req.headers.origin)throw new Error('TASK_CHANNEL_DENIED');
    let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>4*1024*1024)throw new Error('TASK_INPUT_TOO_LARGE')}
    const body=JSON.parse(text);let result;
    const active=config;await authorize();if(active!==config||closed||submitted)throw new Error('TASK_CHANNEL_DENIED');
    switch(body.operation){
      case'material':result=config.material;break;
      case'list':result={files:Object.keys(files)};break;
      case'read':{const name=sourcePath(body.path);if(!Object.hasOwn(files,name))throw new Error('SOURCE_NOT_FOUND');result={path:name,content:files[name]};break}
      case'plan':{if(!Array.isArray(body.entries)||body.entries.length>30||body.entries.some(e=>typeof e.content!=='string'||e.content.length>4000||!['pending','in_progress','completed'].includes(e.status)))throw new Error('PLAN_INPUT_INVALID');emit({type:'plan',text:'Codex 更新了开发计划',entries:body.entries});result={saved:true};break}
      case'patch':{const name=sourcePath(body.path),oldText=files[name]||'';const next=patchSource(files,body);files[name]=next;await writeFile(path.join(config.taskRoot,'sources.json'),JSON.stringify(files),{mode:0o600});emit({type:'file',text:'已局部修改 '+name,path:name,oldText,newText:next});result={saved:true,path:name};break}
      case'write':{const name=sourcePath(body.path);validateSources({...files,[name]:body.content});const oldText=files[name]||'';files[name]=body.content;await writeFile(path.join(config.taskRoot,'sources.json'),JSON.stringify(files),{mode:0o600});emit({type:'file',text:'已更新 '+name,path:name,oldText,newText:body.content});result={saved:true,path:name};break}
      case'validate':{emit({type:'status',text:'正在执行固定编译与运行契约校验'});await compileArtifact(files);emit({type:'validation',text:'编译与运行契约校验通过',files:Object.keys(files)});submitted=true;result={valid:true,submitted:true};finish('validated');break}
      case'require_plan':{if(typeof body.requirement!=='string'||typeof body.reason!=='string'||body.requirement.length>4000||body.reason.length>4000)throw new Error('PLAN_INPUT_INVALID');planNeeded=true;submitted=true;emit({type:'requires_plan',text:'需要回到方案阶段确认需求',requirement:body.requirement,reason:body.reason});result={stopped:true};finish('requires_plan');break}
      default:throw new Error('TOOL_DENIED');
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){const code=/^[A-Z_]+$/.test(error.message)?error.message:error.errors?'COMPILE_FAILED':'TASK_OPERATION_FAILED';const details=(error.errors||[]).map(e=>({text:e.text,line:e.location?.line,file:e.location?.file}));emit({type:'validation',text:'校验未通过：'+code,code,details});res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code,details}))}
});

 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const close=async()=>{closed=true;terminalController?.abort();await native?.close();await terminalPending;await terminal?.close();proxy.closeAllConnections();proxy.close()};
 return {close,async run(input){
  config=input;files={...config.files};validateSources(files);closed=false;submitted=false;planNeeded=false;terminal=null;terminalPending=null;terminalController=new AbortController();
  finished=new Promise(resolve=>finish=resolve);let prompt;
  try{
   if(!process.env.WANX_CODEX_CONFIG||!process.env.WANX_CODEX_PATH)throw new Error('CODEX_NOT_CONFIGURED');
   const settings=JSON.parse(process.env.WANX_CODEX_CONFIG),baseEnv={PATH:process.env.PATH,LANG:process.env.LANG||'en_US.UTF-8',TMPDIR:process.env.TMPDIR};
   native??=new NativeSession({binary:process.env.WANX_CODEX_PATH,config:settings,env:baseEnv,onEvent:emit});
   const session=await native.open({cwd:config.taskRoot,sessionId:config.sessionId,scope:config.scope||'build',mcpServers:{wanx_task:{command:process.execPath,args:[path.join(root,'codex/tools.mjs')],env:{WANX_TASK_PROXY:`http://127.0.0.1:${proxy.address().port}`,WANX_TASK_TOKEN:token}}}});
   emit({type:'session',sessionId:session.sessionId,reused:session.reused,transport:'app-server'});
   emit({type:'status',text:session.reused?'Codex 会话已复用，正在继续开发':'Codex 原生会话已就绪，正在开始开发'});
   prompt=native.prompt([{type:'text',text:'你是万象受控小应用开发者。只使用 wanx_task MCP 工具完成任务；不要调用 Shell、apply_patch、读取任意本机路径、安装依赖或调用外部连接器。先用 read_material 获取冻结方案和固定运行契约，用 list_sources/read_source 获取已有源码。已有应用优先使用 patch_source 精确修改相关片段，保留其他字节；新建文件或确需全量替换时使用 write_source。用 update_plan 向用户公开简要步骤和进展；公开说明正在做什么，用户只观看过程，不审批命令、不参与编码、不回答开发中的临时问题。必须保留原始目标和范围，无法从方案解决的实质缺口使用 require_plan 结束本轮；技术细节自行选择。最后调用 validate_app 提交成功版本后立即结束，不能替用户验收。'},...visualPrompt(config.visualReview)],{onStarted(){
    emit({type:'status',text:'已开始处理本轮开发需求',phase:'turn_started'});
    // The developer turn has already started. Its observation UI is optional.
    terminalPending=startTerminal({server:native.server,sessionId:session.sessionId,binary:process.env.WANX_CODEX_PATH,python:process.env.WANX_PYTHON_PATH||'python3',config:settings,env:baseEnv,taskRoot:native.cwd,root,emit,signal:terminalController.signal}).then(value=>{
     terminal=value;value.failure.catch(()=>emit({type:'status',text:'只读终端已断开，开发继续；进度和源码记录仍可查看'}));
    }).catch(()=>emit({type:'status',text:'只读终端暂不可用，开发继续；进度和源码记录仍可查看'}));
   }});
   prompt.catch(()=>{});
   const result=await Promise.race([prompt,finished]);
   if(planNeeded)throw new Error('PLAN_CLARIFICATION_REQUIRED');
   if(result!=='validated')throw new Error('CODEX_DEVELOPMENT_INCOMPLETE');
   const settled=await Promise.race([prompt.then(()=>true,()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),15000))]);
   if(!settled){await native.interrupt();await prompt.catch(()=>{})}
   if(terminalPending&&!terminal){
    await Promise.race([terminalPending,new Promise(resolve=>setTimeout(resolve,300))]);
    if(!terminal)terminalController.abort();
   }
   await terminalPending;
   if(terminal){await new Promise(resolve=>setTimeout(resolve,300));emit({type:'terminal_complete',text:'原版 Codex CLI 终端记录已保存',bytes:terminal.bytes,acpSessionId:session.sessionId,sessionId:session.sessionId})}
   emit({type:'result',files});
  }finally{
   closed=true;terminalController.abort();
   if(native?.turn){await native.interrupt().catch(()=>{});await prompt?.catch(()=>{})}
   await terminalPending;await terminal?.close();terminal=null;config=null;
  }
 }};
});

import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {Readable,Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {ClientSideConnection,ndJsonStream} from '@agentclientprotocol/sdk';
import {compileArtifact,sourcePath,validateSources} from '../core/artifact.mjs';
import {stopGroup} from '../dsh/sandbox.mjs';
import {activity,redact} from './events.mjs';
import {startSharedServer} from './shared-server.mjs';
import {startTerminal} from './terminal.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const lines=readline.createInterface({input:process.stdin});
const iterator=lines[Symbol.asyncIterator]();
const first=await iterator.next();if(first.done)process.exit(1);
const config=JSON.parse(first.value),files={...config.files};validateSources(files);
const emit=e=>process.stdout.write(JSON.stringify(redact(e,config.taskRoot))+'\n');
const token=randomUUID()+randomUUID();let child,conn,session,server,terminal,closed=false,submitted=false,planNeeded=false;
let finish;const finished=new Promise(resolve=>finish=resolve);
const proxy=http.createServer(async(req,res)=>{
  try{
    if(closed||submitted||req.method!=='POST'||req.url!=='/tool'||req.headers.authorization!=='Bearer '+token||req.headers.origin)throw new Error('TASK_CHANNEL_DENIED');
    let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>4*1024*1024)throw new Error('TASK_INPUT_TOO_LARGE')}
    const body=JSON.parse(text);let result;
    switch(body.operation){
      case'material':result=config.material;break;
      case'list':result={files:Object.keys(files)};break;
      case'read':{const name=sourcePath(body.path);if(!Object.hasOwn(files,name))throw new Error('SOURCE_NOT_FOUND');result={path:name,content:files[name]};break}
      case'plan':{if(!Array.isArray(body.entries)||body.entries.length>30||body.entries.some(e=>typeof e.content!=='string'||e.content.length>4000||!['pending','in_progress','completed'].includes(e.status)))throw new Error('PLAN_INPUT_INVALID');emit({type:'plan',text:'Codex 更新了开发计划',entries:body.entries});result={saved:true};break}
      case'write':{const name=sourcePath(body.path);validateSources({...files,[name]:body.content});const oldText=files[name]||'';files[name]=body.content;await writeFile(path.join(config.taskRoot,'sources.json'),JSON.stringify(files),{mode:0o600});emit({type:'file',text:'已更新 '+name,path:name,oldText,newText:body.content});result={saved:true,path:name};break}
      case'validate':{emit({type:'status',text:'正在执行固定编译与运行契约校验'});await compileArtifact(files);emit({type:'validation',text:'编译与运行契约校验通过',files:Object.keys(files)});submitted=true;result={valid:true,submitted:true};finish('validated');break}
      case'require_plan':{if(typeof body.requirement!=='string'||typeof body.reason!=='string'||body.requirement.length>4000||body.reason.length>4000)throw new Error('PLAN_INPUT_INVALID');planNeeded=true;submitted=true;emit({type:'requires_plan',text:'需要回到方案阶段确认需求',requirement:body.requirement,reason:body.reason});result={stopped:true};finish('requires_plan');break}
      default:throw new Error('TOOL_DENIED');
    }
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){const code=/^[A-Z_]+$/.test(error.message)?error.message:error.errors?'COMPILE_FAILED':'TASK_OPERATION_FAILED';const details=(error.errors||[]).map(e=>({text:e.text,line:e.location?.line,file:e.location?.file}));emit({type:'validation',text:'校验未通过：'+code,code,details});res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code,details}))}
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const close=async()=>{if(closed)return;closed=true;if(conn&&session)await conn.cancel({sessionId:session.sessionId}).catch(()=>{});await Promise.allSettled([terminal?.close(),child?.exitCode===null&&!child.signalCode?stopGroup(child):undefined,server?.close()]);proxy.closeAllConnections();proxy.close()};
process.once('SIGTERM',()=>close().finally(()=>process.exit(0)));process.once('SIGINT',()=>close().finally(()=>process.exit(0)));
(async()=>{for await(const _line of iterator){}await close()})().catch(()=>close());
try{
  if(!process.env.WANX_CODEX_CONFIG||!process.env.WANX_CODEX_PATH)throw new Error('CODEX_NOT_CONFIGURED');
  const baseEnv={PATH:process.env.PATH,LANG:process.env.LANG||'en_US.UTF-8',TMPDIR:process.env.TMPDIR};
  const settings=JSON.parse(process.env.WANX_CODEX_CONFIG);
  server=await startSharedServer({binary:process.env.WANX_CODEX_PATH,config:settings,env:baseEnv,cwd:config.taskRoot});
  const env={...baseEnv,CODEX_PATH:path.join(root,'codex/app-server-proxy.mjs'),WANX_CODEX_SOCKET:server.socket,
    INITIAL_AGENT_MODE:'read-only',NO_BROWSER:'1',CODEX_CONFIG:process.env.WANX_CODEX_CONFIG};
  child=spawn(process.execPath,[path.join(root,'node_modules/@agentclientprotocol/codex-acp/dist/index.js')],{env,stdio:['pipe','pipe','pipe'],detached:true});
  child.stderr.resume();
  conn=new ClientSideConnection(()=>({
    async sessionUpdate({update}){const event=activity(update,config.taskRoot);if(event)emit(event)},
    async requestPermission(request){emit({type:'policy',text:'受控策略已拒绝越界操作',toolCall:redact(request.toolCall,config.taskRoot)});const option=request.options.find(o=>o.kind==='reject_once'||o.kind==='reject_always');return option?{outcome:{outcome:'selected',optionId:option.optionId}}:{outcome:{outcome:'cancelled'}}}
  }),ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
  const initialize=await conn.initialize({protocolVersion:1,clientInfo:{name:'wanx-builder',version:'0.2.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
  emit({type:'status',text:'Codex ACP 已连接',agent:initialize.agentInfo});
  session=await conn.newSession({cwd:config.taskRoot,mcpServers:[{name:'wanx_task',command:process.execPath,args:[path.join(root,'codex/tools.mjs')],env:[{name:'WANX_TASK_PROXY',value:`http://127.0.0.1:${proxy.address().port}`},{name:'WANX_TASK_TOKEN',value:token}]}]});
  terminal=await startTerminal({server,sessionId:session.sessionId,binary:process.env.WANX_CODEX_PATH,python:process.env.WANX_PYTHON_PATH||'python3',config:settings,env:baseEnv,taskRoot:config.taskRoot,root,emit});
  emit({type:'status',text:'Codex 正在依据冻结方案自主开发'});
  const prompt=conn.prompt({sessionId:session.sessionId,prompt:[{type:'text',text:'你是万象受控小应用开发者。只使用 wanx_task MCP 工具完成任务；不要调用 Shell、apply_patch、读取任意本机路径、安装依赖或调用外部连接器。先用 read_material 获取冻结方案和固定运行契约，用 list_sources/read_source 获取已有源码，再 write_source 写入完整前端文件。用 update_plan 向用户公开简要步骤和进展；公开说明正在做什么，用户只观看过程，不审批命令、不参与编码、不回答开发中的临时问题。必须保留原始目标和范围，无法从方案解决的实质缺口使用 require_plan 结束本轮；技术细节自行选择。最后调用 validate_app 提交成功版本后立即结束，不能替用户验收。'}]});
  prompt.catch(()=>{});
  const result=await Promise.race([prompt,finished,terminal.failure]);
  if(planNeeded)throw new Error('PLAN_CLARIFICATION_REQUIRED');
  if(result!=='validated')throw new Error('CODEX_DEVELOPMENT_INCOMPLETE');
  // Capture the CLI's real final response and completed turn before closing it.
  await Promise.race([prompt.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,15000))]);
  await new Promise(resolve=>setTimeout(resolve,500));
  emit({type:'terminal_complete',text:'原版 Codex CLI 终端记录已保存',bytes:terminal.bytes,acpSessionId:session.sessionId});
  emit({type:'result',files});
}catch(error){emit({type:'failed',code:/^[A-Z_]+$/.test(error.message)?error.message:'CODEX_EXECUTION_FAILED'});process.exitCode=1}
finally{await close();lines.close();process.stdin.destroy()}

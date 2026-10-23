import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import {Readable,Writable} from 'node:stream';
import {execFile} from 'node:child_process';
import {ClientSideConnection,ndJsonStream} from '@agentclientprotocol/sdk';
import {sandboxCommand,spawnSandbox,stopGroup} from './sandbox.mjs';
import {compileArtifact,sourcePath,validateSources} from '../core/artifact.mjs';

const lines=readline.createInterface({input:process.stdin});
const iterator=lines[Symbol.asyncIterator]();
const first=await iterator.next();
if(first.done)process.exit(1);
const config=JSON.parse(first.value),files={...config.files};validateSources(files);
const pending=new Map(),token=randomUUID()+randomUUID();let child,closed=false,resourceTimer,finishValidation,submitted=false;
const validated=new Promise(resolve=>{finishValidation=resolve});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
function awaitAnswer(id){return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}
async function close(){
  if(closed)return;closed=true;clearInterval(resourceTimer);
  for(const p of pending.values())p.reject(new Error('TASK_REVOKED'));pending.clear();
  await stopGroup(child);proxy.closeAllConnections();proxy.close();
}
const proxy=http.createServer(async(req,res)=>{
  try{
    if(closed||req.method!=='POST'||req.headers.authorization!==`Bearer ${token}`||req.headers.origin||req.headers.host!==`127.0.0.1:${proxy.address().port}`)throw new Error('PROXY_UNAUTHORIZED');
    let text='';for await(const part of req){text+=part;if(Buffer.byteLength(text)>4*1024*1024)throw new Error('REQUEST_TOO_LARGE')}
    const body=JSON.parse(text||'{}');let result;
    if(submitted){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:'TASK_SUBMITTED'}));return}
    if(req.url==='/probe')result={ok:true};
    else if(req.url==='/model'){
      const id=randomUUID();const promise=awaitAnswer(id);emit({type:'model',id,body});result=await promise;
    }else if(req.url==='/tool'){
      switch(body.operation){
        case'material':result=config.material;break;
        case'list':result={files:Object.keys(files)};break;
        case'read':{const name=sourcePath(body.path);if(!Object.hasOwn(files,name))throw new Error('SOURCE_NOT_FOUND');result={path:name,content:files[name]};break}
        case'write':{
          const name=sourcePath(body.path),candidate={...files,[name]:body.content};validateSources(candidate);files[name]=body.content;
          const output=path.join(config.taskRoot,'sources.json');try{if((await lstat(output)).isSymbolicLink())throw new Error('SOURCE_LINK_DENIED')}catch(e){if(e.code!=='ENOENT')throw e}
          await writeFile(output,JSON.stringify(files),{mode:0o600});emit({type:'tool',text:'已更新 '+name});result={saved:true,path:name};break;
        }
        case'validate':{await compileArtifact(files);result={valid:true};emit({type:'tool',text:'静态编译与产物校验通过'});submitted=true;finishValidation({stopReason:'validated'});break}
        case'ask':{
          if(typeof body.question!=='string'||!Array.isArray(body.options)||body.options.length<2||body.options.length>4||!body.options.every(x=>typeof x==='string'))throw new Error('QUESTION_INVALID');
          const id=randomUUID();const promise=awaitAnswer(id);emit({type:'question',id,question:body.question,options:body.options});result={answer:await promise,source:'user'};break;
        }
        default:throw new Error('TOOL_DENIED');
      }
    }else throw new Error('ROUTE_DENIED');
    if(closed)throw new Error('TASK_REVOKED');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){
    const code=/^[A-Z_]+$/.test(error.message)?error.message:error.errors?'COMPILE_FAILED':'TASK_OPERATION_FAILED';
    const details=(error.errors||[]).slice(0,5).map(e=>({text:String(e.text||'').slice(0,300),line:e.location?.line,path:String(e.location?.file||'').replace(/^wanx:/,'').startsWith('src/')?String(e.location.file).replace(/^wanx:/,''):undefined}));
    emit({type:'tool',text:'任务操作未通过：'+code+(details.length?' '+details.map(e=>[e.path,e.line,e.text].filter(Boolean).join(':')).join('；'):'')});
    if(!res.headersSent)res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({code,details}));
  }
});
await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
const port=proxy.address().port;
(async()=>{for await(const line of iterator){const message=JSON.parse(line),p=pending.get(message.id);if(!p)continue;pending.delete(message.id);message.error?p.reject(new Error(message.error)):p.resolve(message.type==='answer'?message.answer:message.result)}await close()})().catch(()=>close());
process.once('SIGTERM',()=>close().finally(()=>process.exit(0)));process.once('SIGINT',()=>close().finally(()=>process.exit(0)));
try{
  const spec=await sandboxCommand({taskRoot:config.taskRoot,port,extraEnv:{WANX_TASK_PROXY:`http://127.0.0.1:${port}`,WANX_TASK_TOKEN:token}});
  child=spawnSandbox(spec);
  // Generated code never runs here. The DSH process has a heap limit, while the
  // trusted controller observes whole-process RSS/CPU and terminates on excess.
  resourceTimer=setInterval(()=>execFile('/bin/ps',['-o','rss=,time=','-p',String(child.pid)],(error,out)=>{
    if(error||closed)return;const [rss,cpu]=out.trim().split(/\s+/);const parts=(cpu||'0:0').split(':').map(Number);const seconds=parts.reduce((sum,n)=>sum*60+n,0);
    if(Number(rss)>1024*1024||seconds>300){emit({type:'failed',code:'RESOURCE_LIMIT'});close()}
  }),1000);resourceTimer.unref();
  const conn=new ClientSideConnection(()=>({
    async sessionUpdate({update}){if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')emit({type:'message',text:update.content.text});},
    async requestPermission(request){const option=request.options.find(o=>o.kind==='reject_once'||o.kind==='reject_always');if(!option)throw new Error('PERMISSION_REJECTION_UNAVAILABLE');return {outcome:{outcome:'selected',optionId:option.optionId}}}
  }),ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
  child.stderr.resume();
  await conn.initialize({protocolVersion:1,clientCapabilities:{}});
  const session=await conn.newSession({cwd:config.taskRoot,mcpServers:[]});
  emit({type:'status',text:'DSH 已启动，正在按确认方案开发'});
  const prompt=conn.prompt({sessionId:session.sessionId,prompt:[{type:'text',text:'以下已直接提供冻结需求、精确运行契约和当前所有源码，不必再调用读取工具。使用write_source修复或完成所需文件；可以在一个回复中提出多个工具调用，工具顺序执行。最后调用validate_app：编译通过立即提交本轮版本并结束任务，无需再调用模型总结。不要重复校验失败的同一内容；按错误代码和manifestExample修复。应用的试用/正式隔离由运行时完成，前端不添加环境切换或dataset字段。业务验收由用户完成。\n'+JSON.stringify({material:config.material,currentSources:files})}]});
  prompt.catch(()=>{});
  const result=await Promise.race([prompt,validated]);
  if(!['end_turn','validated'].includes(result.stopReason))throw new Error('BUILD_NOT_COMPLETE');
  await compileArtifact(files);
  if(result.stopReason==='validated')await conn.cancel({sessionId:session.sessionId}).catch(()=>{});
  else await conn.closeSession({sessionId:session.sessionId});
  emit({type:'result',files});
}catch(error){emit({type:'failed',code:/^[A-Z_]+$/.test(error.message)?error.message:'DSH_EXECUTION_FAILED'});process.exitCode=1}
finally{await close();lines.close();process.stdin.destroy()}

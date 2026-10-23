// Explicit composition of official DSH packages. No shipped base/profile,
// loader, shell, filesystem, MCP, plugin manager, retry or subagent plugins.
import {Context} from '@deepseek-ai/cordis';
import LlmRuntime,{LlmAdapter} from '@deepseek-ai/dsh-llm';
import * as Sessions from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Projection from '@deepseek-ai/dsh-session-projection';
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime,{defineTool} from '@deepseek-ai/dsh-tools';
import * as Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import * as Acp from '@deepseek-ai/dsh-acp';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

const base=process.env.WANX_TASK_PROXY,token=process.env.WANX_TASK_TOKEN;
async function rpc(path,body,signal){
  const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body),signal});
  const value=await r.json();if(!r.ok)throw new Error((/^[A-Z_]+$/.test(value.code)?value.code:'TASK_PROXY_DENIED')+(value.details?.length?' '+JSON.stringify(value.details):''));return value;
}
if(process.argv.includes('--probe')){
  const probes={};
  for(const [name,file]of [['externalRead',process.env.WANX_PROBE_SECRET],['sourceWrite',process.env.WANX_PROBE_SOURCE]]){
    try{if(name==='externalRead')await readFile(file);else await writeFile(file,'forbidden');probes[name]=false}catch{probes[name]=true}
  }
  try{await fetch('http://127.0.0.1:'+process.env.WANX_PROBE_FORBIDDEN_PORT,{signal:AbortSignal.timeout(1000)});probes.network=false}catch{probes.network=true}
  const child=spawnSync('/usr/bin/true');probes.subprocess=Boolean(child.error||child.status!==0);
  try{await rpc('/probe',{});probes.taskProxy=true}catch{probes.taskProxy=false}
  process.stdout.write(JSON.stringify(probes));process.exit(Object.values(probes).every(Boolean)?0:3);
}

class WanxAdapter extends LlmAdapter {
  providerInfo(provider){return {id:provider,name:'WANX 受信模型'}}
  providerRetryPolicy(){return {mode:'normal',maxRetries:0,retryableCodes:[],initialDelayMs:0,maxDelayMs:0,jitterRatio:0}}
  async listModels(){return [{provider:'wanx',id:'default',name:'万象默认模型',inputModalities:['text']}]}
  async resolveModel(provider,id){return {provider,id,name:'万象默认模型',inputModalities:['text'],context:{contextWindow:65536},maxTokens:8192}}
  async *stream(options){
    const messages=[];
    for(const m of options.messages){
      const content=m.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
      if(m.role==='tool'){messages.push({role:'tool',tool_call_id:m.toolCallId,content});continue}
      const tools=m.content.filter(b=>b.type==='tool-call').map(b=>({id:b.id,type:'function',function:{name:b.name,arguments:b.arguments}}));
      const reasoning=m.content.filter(b=>b.type==='reasoning').map(b=>b.text).join('');
      messages.push({role:m.role==='developer'?'system':m.role,content,...(tools.length?{tool_calls:tools}:{}),...(reasoning?{reasoning_content:reasoning}:{})});
    }
    const body={messages,max_tokens:Math.min(options.maxTokens||8192,8192),...(options.tools?.length?{tools:options.tools.map(t=>({type:'function',function:t})),tool_choice:'auto'}:{})};
    const result=await rpc('/model',body,options.signal),message=result.choices[0].message;let index=0;
    if(message.reasoning_content){const block={type:'reasoning',text:message.reasoning_content};yield{type:'block-start',index,blockType:'reasoning'};yield{type:'reasoning-delta',index,text:block.text};yield{type:'block-end',index,block};index++}
    if(message.content){const block={type:'text',text:message.content};yield{type:'block-start',index,blockType:'text'};yield{type:'text-delta',index,text:block.text};yield{type:'block-end',index,block};index++}
    for(const t of message.tool_calls||[]){const block={type:'tool-call',id:t.id,name:t.function.name,arguments:t.function.arguments};yield{type:'block-start',index,blockType:'tool-call'};yield{type:'tool-call-delta',index,id:block.id,name:block.name,argumentsDelta:block.arguments};yield{type:'block-end',index,block};index++}
    if(result.usage)yield{type:'usage',usage:{inputTokens:result.usage.prompt_tokens||0,outputTokens:result.usage.completion_tokens||0}};
    yield{type:'finish',reason:{kind:message.tool_calls?.length?'tool-calls':result.choices[0].finish_reason==='length'?'max-tokens':'stop'}};
  }
}

const ctx=new Context();
const mount=async(name,config={})=>ctx.plugin(name.default||name,config);
await mount(LlmRuntime);
await mount(Sessions);
await mount(Projection);
await mount(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'你是万象受控小应用开发者。只使用提供的工具。遵循需求方案与运行契约；遇到影响用户结果的问题调用ask_product等待用户。不要猜测缺失授权，不要求安装依赖、执行Shell、联网或自建后端。完成后说明修改与验证结果，不能替用户验收。'});
await mount(ToolRuntime);
await mount(Agents);
await mount(Persistence,{root:process.env.WANX_TASK_SESSIONS,compression:'none'});
await ctx.plugin({name:'wanx-model',inject:['llm'],apply(c){c.llm.registerAdapter(['wanx'],new WanxAdapter())}});
const toolSpecs=[
  ['read_material','读取冻结需求与运行契约',{},'material'],
  ['list_sources','列出本任务已有源文件',{},'list'],
  ['read_source','读取本任务源文件',{path:{type:'string',required:true}},'read'],
  ['write_source','写入本任务源文件，仅允许清单与src目录下JS/CSS/JSON',{path:{type:'string',required:true},content:{type:'string',required:true}},'write'],
  ['validate_app','完成本轮开发并提交版本：静态编译成功后任务立即结束，不执行生成代码。请在所有源码写好后最后调用',{},'validate'],
  ['ask_product','暂停并向用户提出影响结果的产品问题',{question:{type:'string',required:true},options:{type:'array',required:true,items:{type:'string'}}},'ask']
];
await ctx.plugin({name:'wanx-tools',inject:['tools'],apply(c){for(const[name,description,parameters,operation]of toolSpecs)c.tools.register(defineTool({name,description,parameters,output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(args,exec)=>rpc('/tool',{operation,...args},exec.signal)}))}});
await mount(AgentLoop,{agents:[],maxParallelToolCalls:1});
await mount(Acp,{provider:'wanx',model:'default'});
const shutdown=async()=>{await ctx.fiber.dispose();process.exit(0)};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);

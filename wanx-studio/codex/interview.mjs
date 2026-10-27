import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {NativeSession} from './native-session.mjs';
import {serveWorker} from './worker.mjs';
import {visualPrompt} from './visual-feedback.mjs';
import {runtimeEnvironment,runtimeEffort} from './runtime-env.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
await serveWorker(async({emit,request})=>{
 let native,active=null;const token=randomUUID()+randomUUID();
 const proxy=http.createServer(async(req,res)=>{
  try{
   if(!active||req.method!=='POST'||req.url!=='/tool'||req.headers.origin||req.headers.authorization!=='Bearer '+token)throw new Error('INTERVIEW_CHANNEL_DENIED');
   const turn=active;let text='';for await(const b of req){text+=b;if(Buffer.byteLength(text)>1024*1024)throw new Error('INTERVIEW_TOOL_TOO_LARGE')}
   if(active!==turn)throw new Error('INTERVIEW_CHANNEL_DENIED');
   const value=JSON.parse(text),result=await request('request',{method:value.method,args:value.args});
   if(active!==turn)throw new Error('INTERVIEW_CHANNEL_DENIED');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(e){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:/^[A-Z_]+$/.test(e.message)?e.message:'INTERVIEW_TOOL_FAILED'}))}
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 return {async close(){active=null;await native?.close();proxy.closeAllConnections();proxy.close()},async run(config){
  active=config;
  try{
   const env=runtimeEnvironment(),settings=JSON.parse(process.env.WANX_CODEX_CONFIG);
   native??=new NativeSession({binary:process.env.WANX_CODEX_PATH,config:settings,env,onTrace(e){if(active)emit({type:'diagnostic',...e})},onEvent(e){
    if(!active)return;
    if(e.type==='message')emit({type:'text',text:e.text});
    else if(e.type==='activity')emit({type:'status',text:'正在处理：'+e.text});
   }});
   emit({type:'status',text:'正在连接 Codex 原生会话'});
   const session=await native.open({cwd:config.cwd,sessionId:config.sessionId,scope:config.scope||config.cwd,mcpServers:{wanx_interview:{command:process.execPath,args:[path.join(root,'codex/interview-tools.mjs')],env:{WANX_INTERVIEW_PROXY:`http://127.0.0.1:${proxy.address().port}`,WANX_INTERVIEW_TOKEN:token,WANX_INTERVIEW_MODE:config.mode||'initial'}}}});
   emit({type:'session',...session,transport:'app-server'});
   emit({type:'status',text:session.reused?'已复用 Codex 会话，正在处理本轮输入':'Codex 原生会话已就绪，正在处理本轮输入'});
   await native.prompt([{type:'text',text:config.prompt},...visualPrompt(config.visualReview)],{effort:runtimeEffort(settings)});
   emit({type:'complete'});
  }finally{active=null}
 }};
});

import http from 'node:http';import readline from 'node:readline';import path from 'node:path';import{fileURLToPath}from'node:url';import{randomUUID}from'node:crypto';import{spawn}from'node:child_process';import{Readable,Writable}from'node:stream';
import{ClientSideConnection,ndJsonStream}from'@agentclientprotocol/sdk';
import{startSharedServer}from'./shared-server.mjs';import{stopGroup}from'../dsh/sandbox.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),lines=readline.createInterface({input:process.stdin}),iterator=lines[Symbol.asyncIterator]();
const first=await iterator.next();if(first.done)process.exit(1);const config=JSON.parse(first.value);
const emit=e=>process.stdout.write(JSON.stringify(e)+'\n');const token=randomUUID()+randomUUID(),pending=new Map();let child,server,conn,session,closing=false,replaying=false;
const call=(method,args)=>new Promise((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});emit({type:'request',id,method,args})});
(async()=>{for await(const line of iterator){const value=JSON.parse(line),p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(new Error(value.error)):p.resolve(value.result)}}if(!closing)await close()})().catch(()=>close());
const proxy=http.createServer(async(req,res)=>{try{
 if(closing||req.method!=='POST'||req.url!=='/tool'||req.headers.origin||req.headers.authorization!=='Bearer '+token)throw new Error('INTERVIEW_CHANNEL_DENIED');
 let text='';for await(const b of req){text+=b;if(Buffer.byteLength(text)>1024*1024)throw new Error('INTERVIEW_TOOL_TOO_LARGE')}
 const value=JSON.parse(text);const result=await call(value.method,value.args);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
}catch(e){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:/^[A-Z_]+$/.test(e.message)?e.message:'INTERVIEW_TOOL_FAILED'}))}});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
async function close(){if(closing)return;closing=true;if(conn&&session)await conn.cancel({sessionId:session.sessionId}).catch(()=>{});for(const p of pending.values())p.reject(new Error('INTERVIEW_CLOSED'));pending.clear();await Promise.allSettled([child?.exitCode===null&&!child.signalCode?stopGroup(child):undefined,server?.close()]);proxy.closeAllConnections();proxy.close();lines.close();process.stdin.destroy()}
process.once('SIGTERM',()=>close().finally(()=>process.exit(0)));process.once('SIGINT',()=>close().finally(()=>process.exit(0)));
try{
 const env={PATH:process.env.PATH,LANG:process.env.LANG||'en_US.UTF-8',TMPDIR:process.env.TMPDIR};
 const settings=JSON.parse(process.env.WANX_CODEX_CONFIG);server=await startSharedServer({binary:process.env.WANX_CODEX_PATH,config:settings,env,cwd:config.cwd});
 child=spawn(process.execPath,[path.join(root,'node_modules/@agentclientprotocol/codex-acp/dist/index.js')],{env:{...env,CODEX_PATH:path.join(root,'codex/app-server-proxy.mjs'),WANX_CODEX_SOCKET:server.socket,CODEX_CONFIG:process.env.WANX_CODEX_CONFIG,INITIAL_AGENT_MODE:'read-only',NO_BROWSER:'1'},stdio:['pipe','pipe','pipe'],detached:true});child.stderr.resume();
 conn=new ClientSideConnection(()=>({async sessionUpdate({update}){if(!replaying&&update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')emit({type:'text',text:update.content.text})},async requestPermission(){return{outcome:{outcome:'cancelled'}}}}),ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
 const initialized=await conn.initialize({protocolVersion:1,clientInfo:{name:'wanx-product-manager',version:'1.0.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
 const mcpServers=[{name:'wanx_interview',command:process.execPath,args:[path.join(root,'codex/interview-tools.mjs')],env:[{name:'WANX_INTERVIEW_PROXY',value:`http://127.0.0.1:${proxy.address().port}`},{name:'WANX_INTERVIEW_TOKEN',value:token}]}];
 if(config.sessionId){if(!initialized.agentCapabilities?.loadSession)throw new Error('INTERVIEW_RESUME_UNSUPPORTED');replaying=true;session={...await conn.loadSession({sessionId:config.sessionId,cwd:config.cwd,mcpServers}),sessionId:config.sessionId};replaying=false}
 else session=await conn.newSession({cwd:config.cwd,mcpServers});
 const effort=session.configOptions?.find(o=>o.id==='reasoning_effort');
 if(effort?.options?.some(o=>o.value==='medium'))await conn.setSessionConfigOption({sessionId:session.sessionId,configId:'reasoning_effort',value:'medium'});
 emit({type:'session',sessionId:session.sessionId});
 await conn.prompt({sessionId:session.sessionId,prompt:[{type:'text',text:config.prompt}]});emit({type:'complete'});
}catch(e){emit({type:'failed',code:/^[A-Z_]+$/.test(e.message)?e.message:'INTERVIEW_CODEX_FAILED'});process.exitCode=1}
finally{await close()}

import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {ClientSideConnection,ndJsonStream} from '@agentclientprotocol/sdk';
import {stopGroup} from '../dsh/sandbox.mjs';
import {startSharedServer} from '../codex/shared-server.mjs';
import {startTerminal} from '../codex/terminal.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const cwd=await mkdtemp(path.join(os.tmpdir(),'wanx-codex-probe-'));
let child,conn,session,server,terminal;
let closing=false;
async function cleanup(){if(closing)return;closing=true;await Promise.allSettled([terminal?.close(),child?.exitCode===null&&!child.signalCode?stopGroup(child):undefined,server?.close()]);await rm(cwd,{recursive:true,force:true})}
process.once('SIGTERM',()=>cleanup().finally(()=>process.exit(1)));
process.once('SIGINT',()=>cleanup().finally(()=>process.exit(1)));
try{
  if(!process.env.WANX_CODEX_PATH||!process.env.WANX_CODEX_CONFIG)throw new Error('CODEX_NOT_CONFIGURED');
  const config=JSON.parse(process.env.WANX_CODEX_CONFIG);
  if(config.features?.shell_tool!==false||config.features?.multi_agent!==false||config.tools?.view_image!==false)throw new Error('CODEX_POLICY_INVALID');
  const env={PATH:process.env.PATH,LANG:process.env.LANG,TMPDIR:process.env.TMPDIR};
  server=await startSharedServer({binary:process.env.WANX_CODEX_PATH,config,env,cwd});
  child=spawn(process.execPath,[path.join(root,'node_modules/@agentclientprotocol/codex-acp/dist/index.js')],{env:{...env,CODEX_PATH:path.join(root,'codex/app-server-proxy.mjs'),WANX_CODEX_SOCKET:server.socket,CODEX_CONFIG:process.env.WANX_CODEX_CONFIG,INITIAL_AGENT_MODE:'read-only',NO_BROWSER:'1'},stdio:['pipe','pipe','pipe'],detached:true});
  child.stderr.resume();
  conn=new ClientSideConnection(()=>({async sessionUpdate(){},async requestPermission(){return {outcome:{outcome:'cancelled'}}}}),ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout)));
  const result=await conn.initialize({protocolVersion:1,clientInfo:{name:'wanx-builder-probe',version:'0.2.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
  session=await conn.newSession({cwd,mcpServers:[]});
  if(session.modes?.currentModeId!=='read-only')throw new Error('CODEX_POLICY_INVALID');
  let attached=false;
  terminal=await startTerminal({server,sessionId:session.sessionId,binary:process.env.WANX_CODEX_PATH,python:process.env.WANX_PYTHON_PATH||'python3',config,env,taskRoot:cwd,root,emit(event){if(event.type==='terminal_attached'&&event.acpSessionId===event.cliSessionId)attached=true}});
  if(!attached||!terminal.bytes)throw new Error('CODEX_TERMINAL_FAILED');
  await conn.closeSession({sessionId:session.sessionId});session=null;
  process.stdout.write(JSON.stringify({available:true,executor:'Codex',version:'2.2.2',acp:result.protocolVersion,modelCalls:0,nativeTerminal:{available:true,sameSession:true,readOnly:true},policy:{scope:'task-MCP-tools-only',shell:false,terminal:false,clientFileSystem:false,userApprovals:false}})+'\n');
}catch(error){process.stdout.write(JSON.stringify({available:false,executor:'Codex',version:'2.2.2',modelCalls:0,code:/^[A-Z_]+$/.test(error.message)?error.message:'CODEX_CONNECTION_FAILED'})+'\n')}
finally{await cleanup()}
process.exit(0);

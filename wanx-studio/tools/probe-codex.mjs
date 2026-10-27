// Connectivity only: no throwaway thread, MCP tool process, CLI or model turn.
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {NativeSession} from '../codex/native-session.mjs';
import {runtimeEnvironment} from '../codex/runtime-env.mjs';

const cwd=await mkdtemp(path.join(os.tmpdir(),'wanx-codex-probe-'));let native;
try{
 if(!process.env.WANX_CODEX_PATH||!process.env.WANX_CODEX_CONFIG)throw new Error('CODEX_NOT_CONFIGURED');
 const config=JSON.parse(process.env.WANX_CODEX_CONFIG);
 if(config.features?.shell_tool!==false||config.features?.multi_agent!==false||config.tools?.view_image!==false)throw new Error('CODEX_POLICY_INVALID');
 native=new NativeSession({binary:process.env.WANX_CODEX_PATH,config,env:runtimeEnvironment()});
 await native.connect(cwd);
 process.stdout.write(JSON.stringify({available:true,executor:'Codex',version:'native-app-server',transport:'app-server',modelCalls:0,nativeTerminal:{available:process.platform!=='win32',readOnly:true,deferred:true},policy:{scope:'task-MCP-tools-only',shell:false,terminal:false,clientFileSystem:false,userApprovals:false}})+'\n');
}catch(error){process.stdout.write(JSON.stringify({available:false,executor:'Codex',modelCalls:0,code:/^[A-Z_]+$/.test(error.message)?error.message:'CODEX_CONNECTION_FAILED'})+'\n')}
finally{await native?.close();await rm(cwd,{recursive:true,force:true})}

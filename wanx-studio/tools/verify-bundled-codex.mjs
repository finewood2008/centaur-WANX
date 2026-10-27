// Image qualification only. Never creates a thread or sends a model request.
import {execFile} from 'node:child_process';
import {access,mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {NativeSession} from '../codex/native-session.mjs';

const run=promisify(execFile);
const studioRoot=fileURLToPath(new URL('..',import.meta.url));

export async function verifyBundledCodex(root=studioRoot){
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const version=manifest.dependencies?.['@openai/codex'];
  if(!/^\d+\.\d+\.\d+$/.test(version||''))throw new Error('CODEX_BUNDLE_VERSION_NOT_PINNED');
  const binary=path.join(root,'node_modules','.bin','codex');
  try{await access(binary,constants.X_OK)}catch{throw new Error('CODEX_BUNDLE_MISSING')}
  const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-codex-bundle-'));
  let native;
  try{
    const state=path.join(directory,'state');
    await mkdir(state,{mode:0o700});
    // Do not inherit host credentials, login state, plugins or proxy settings.
    const env={PATH:process.env.PATH,LANG:'C.UTF-8',CODEX_HOME:state};
    const result=await run(binary,['--version'],{env,cwd:directory,timeout:10000});
    if(result.stdout.trim()!==`codex-cli ${version}`)throw new Error('CODEX_BUNDLE_VERSION_MISMATCH');
    const config={
      model_provider:'wanx_offline_check',check_for_update_on_startup:false,
      web_search:'disabled',mcp_servers:{},
      model_providers:{wanx_offline_check:{name:'WANX offline check',base_url:'http://127.0.0.1:9/v1',
        wire_api:'responses',requires_openai_auth:false,supports_websockets:false}},
    };
    native=new NativeSession({binary,config,env});
    await native.connect(directory);
    if(typeof native.initialization?.userAgent!=='string')throw new Error('CODEX_BUNDLE_PROTOCOL_INVALID');
    return {available:true,version,transport:'app-server',modelCalls:0};
  }finally{
    try{await native?.close()}
    finally{await rm(directory,{recursive:true,force:true})}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{process.stdout.write(JSON.stringify(await verifyBundledCodex())+'\n')}
  catch(error){
    process.stdout.write(JSON.stringify({available:false,modelCalls:0,
      code:/^CODEX_[A-Z_]+$/.test(error.message)?error.message:'CODEX_BUNDLE_FAILED'})+'\n');
    process.exitCode=1;
  }
}

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {copyFile,mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {promisify} from 'node:util';
import {probeCodex} from '../tools/probe-codex.mjs';
import {stopGroup} from '../dsh/sandbox.mjs';

const run=promisify(execFile);
const require=createRequire(import.meta.url);
const probe=fileURLToPath(new URL('../tools/probe-codex.mjs',import.meta.url));
const root=fileURLToPath(new URL('..',import.meta.url));
const unix={skip:process.platform==='win32'?'Builder uses Unix app-server sockets':false};
const policy={features:{shell_tool:false,multi_agent:false},tools:{view_image:false}};

async function fixture(t,output='codex-cli 0.160.1'){
  const directory=await mkdtemp(path.join(os.tmpdir(),'probe-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const binary=path.join(directory,'codex'),capture=path.join(directory,'launch.json');
  await writeFile(binary,`#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(capture)},JSON.stringify({
  args:process.argv.slice(2),state:process.env.CODEX_HOME,
  proxy:process.env.WANX_CODEX_PROXY_TOKEN,ambient:process.env.OPENAI_API_KEY
}));
console.log(${JSON.stringify(output)});
`,{mode:0o700});
  return {directory,capture,environment:{
    PATH:process.env.PATH,TMPDIR:directory,LANG:'C.UTF-8',CODEX_HOME:path.join(directory,'state'),
    WANX_CODEX_PATH:binary,WANX_CODEX_CONFIG:JSON.stringify(policy),
    WANX_CODEX_PROXY_TOKEN:'synthetic-local-token',OPENAI_API_KEY:'SYNTHETIC_HOST_SECRET',
  }};
}

test('probe uses the actual private launch environment, reports versions and only connects',unix,async t=>{
  const {directory,capture,environment}=await fixture(t);
  const events=[];
  const result=await probeCodex({environment,createSession:options=>{
    assert.equal(options.binary,environment.WANX_CODEX_PATH);
    assert.deepEqual(options.config,policy);
    assert.equal(options.env.CODEX_HOME,environment.CODEX_HOME);
    assert.equal(options.env.WANX_CODEX_PROXY_TOKEN,'synthetic-local-token');
    assert.equal(options.env.OPENAI_API_KEY,undefined);
    return {initialization:{userAgent:'synthetic Codex'},connect:async cwd=>{assert.equal(path.dirname(cwd),directory);events.push('connect')},
      close:async()=>events.push('close')};
  }});
  assert.equal(result.available,true);
  assert.equal(result.cliVersion,'0.160.1');
  assert.equal(result.nodeVersion,process.versions.node);
  assert.equal(result.version,'native-app-server');
  assert.equal(result.check,'protocol');
  assert.equal(result.transport,'app-server');
  assert.equal(result.modelCalls,0);
  assert.deepEqual(events,['connect','close']);
  assert.deepEqual(JSON.parse(await readFile(capture,'utf8')),{
    args:['--version'],state:environment.CODEX_HOME,proxy:'synthetic-local-token',
  });
  assert.deepEqual((await readdir(directory)).sort(),['codex','launch.json']);
  assert.ok(!JSON.stringify(result).includes('synthetic-local-token'));
  assert.ok(!JSON.stringify(result).includes(directory));
});

test('arbitrary version output is rejected without leaking it or opening a session',unix,async t=>{
  const {environment}=await fixture(t,'codex-cli 0.160.1\nSYNTHETIC_PRIVATE_SECRET');
  const result=await probeCodex({environment,createSession:()=>assert.fail('must not connect')});
  assert.equal(result.code,'CODEX_VERSION_INVALID');
  assert.equal(result.modelCalls,0);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_SECRET'));
});

test('connection errors and cleanup errors remain bounded and both cleanups run',unix,async t=>{
  const {directory,environment}=await fixture(t);
  for(const primary of [false,true]){
    const result=await probeCodex({environment,createSession:()=>({
      initialization:{userAgent:'synthetic Codex'},
      connect:async()=>{if(primary)throw new Error('SYNTHETIC_PRIVATE_SECRET')},
      close:async()=>{throw new Error('SYNTHETIC_PRIVATE_SECRET')},
    })});
    assert.equal(result.available,false);
    assert.equal(result.code,primary?'CODEX_CONNECTION_FAILED':'CODEX_CLEANUP_FAILED');
    assert.equal(result.modelCalls,0);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_SECRET'));
    assert.deepEqual((await readdir(directory)).sort(),['codex','launch.json']);
  }
});

test('a malformed initialize response cannot qualify the host',unix,async t=>{
  const {environment}=await fixture(t);
  const result=await probeCodex({environment,createSession:()=>({
    initialization:{},connect:async()=>{},close:async()=>{},
  })});
  assert.equal(result.available,false);
  assert.equal(result.code,'CODEX_PROTOCOL_INVALID');
  assert.equal(result.modelCalls,0);
});

test('CLI reports malformed settings, missing binaries and temporary directory errors with exit 1',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'probe-errors-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const valid={PATH:process.env.PATH,TMPDIR:directory,
    WANX_CODEX_PATH:path.join(directory,'missing'),WANX_CODEX_CONFIG:JSON.stringify(policy)};
  for(const [env,code] of [
    [{PATH:process.env.PATH},'CODEX_NOT_CONFIGURED'],
    [{...valid,WANX_CODEX_CONFIG:'SYNTHETIC_PRIVATE_SECRET'},'CODEX_POLICY_INVALID'],
    [{...valid,TMPDIR:path.join(directory,'missing-directory')},'CODEX_TEMP_DIRECTORY_UNAVAILABLE'],
    [valid,'CODEX_VERSION_FAILED'],
  ]){
    let failure;
    try{await run(process.execPath,[probe],{env,timeout:15000})}catch(error){failure=error}
    assert.ok(failure,'failed probe must exit unsuccessfully');
    assert.equal(failure.code,1);
    assert.equal(failure.stderr,'');
    const result=JSON.parse(failure.stdout);
    assert.equal(result.available,false);
    assert.equal(result.code,code);
    assert.equal(result.modelCalls,0);
    assert.equal(result.check,'protocol');
    assert.ok(!failure.stdout.includes('SYNTHETIC_PRIVATE_SECRET'));
    assert.ok(!failure.stdout.includes(directory));
  }
  assert.deepEqual(await readdir(directory),[]);
});

test('installed bundled CLI passes the probe without a model turn or host login',unix,async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'probe-live-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const state=path.join(directory,'state');await mkdir(state,{mode:0o700});
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const config={...policy,model_provider:'wanx_probe',
    check_for_update_on_startup:false,web_search:'disabled',mcp_servers:{},
    model_providers:{wanx_probe:{name:'offline probe',base_url:'http://127.0.0.1:9/v1',
      wire_api:'responses',requires_openai_auth:false,supports_websockets:false}}};
  const {stdout,stderr}=await run(process.execPath,[probe],{timeout:60000,env:{
    PATH:process.env.PATH,LANG:'C.UTF-8',CODEX_HOME:state,
    WANX_CODEX_PATH:path.join(root,'node_modules','.bin','codex'),
    WANX_CODEX_CONFIG:JSON.stringify(config),OPENAI_API_KEY:'SYNTHETIC_HOST_SECRET',
  }});
  const result=JSON.parse(stdout);
  assert.equal(result.available,true);
  assert.equal(result.cliVersion,manifest.dependencies['@openai/codex']);
  assert.equal(result.nodeVersion,process.versions.node);
  assert.equal(result.check,'protocol');
  assert.equal(result.modelCalls,0);
  assert.equal(stderr,'');
  assert.ok(!stdout.includes('SYNTHETIC_HOST_SECRET'));
  assert.ok(!(await readdir(state)).includes('auth.json'));
});

test('incomplete service dependencies fail with JSON instead of a module loader stack',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'probe-deps-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const script=path.join(directory,'probe.mjs');await copyFile(probe,script);
  let failure;
  try{
    await run(process.execPath,[script],{env:{PATH:process.env.PATH,TMPDIR:directory,
      WANX_CODEX_PATH:process.execPath,WANX_CODEX_CONFIG:JSON.stringify(policy)},timeout:15000});
  }catch(error){failure=error}
  assert.equal(failure?.code,1);
  assert.equal(failure.stderr,'');
  const result=JSON.parse(failure.stdout);
  assert.equal(result.code,'CODEX_DEPENDENCIES_MISSING');
  assert.equal(result.available,false);
  assert.equal(result.modelCalls,0);
  assert.ok(!failure.stdout.includes(directory));
  assert.deepEqual(await readdir(directory),['probe.mjs']);
});

async function eventually(read,timeout=5000){
  const deadline=Date.now()+timeout;
  let last;
  while(Date.now()<deadline){
    try{const value=await read();if(value)return value}catch(error){last=error}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw last||new Error('Synthetic process did not reach the expected state');
}

function running(pid){
  try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw error}
}

for(const stage of ['version','startup','initialize'])for(const signal of ['SIGTERM','SIGINT']){
  test(`${signal} during ${stage} drains detached Codex children before probe exits`,unix,async t=>{
    // A short private path is required by the real Unix app-server transport.
    const directory=await mkdtemp('/tmp/wanx-probe-signal-');
    const binary=path.join(directory,'codex.cjs'),ready=path.join(directory,'ready.json');
    const calls=path.join(directory,'calls.txt');
    const script=`#!${process.execPath}
const fs=require('node:fs'),{spawn}=require('node:child_process');
const stage=${JSON.stringify(stage)},ready=${JSON.stringify(ready)};
if(process.argv.includes('--version')&&stage!=='version'){
  console.log('codex-cli 0.160.1');process.exit(0);
}
process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});
const descendant=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
const announce=()=>fs.writeFileSync(ready,JSON.stringify([process.pid,descendant.pid]));
if(stage==='initialize'){
  const http=require('node:http'),{WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});
  const server=http.createServer(),sockets=new WebSocketServer({server});
  sockets.on('connection',socket=>socket.on('message',raw=>{
    const message=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(calls)},message.method+'\\n');
    if(message.method==='initialize')announce();
  }));
  server.listen(process.argv[process.argv.indexOf('--listen')+1].slice(7));
}else{announce();setInterval(()=>{},1000)}
`;
    await writeFile(binary,script,{mode:0o700});
    const child=spawn(process.execPath,[probe],{detached:true,stdio:['ignore','pipe','pipe'],env:{
      PATH:process.env.PATH,TMPDIR:directory,WANX_CODEX_PATH:binary,
      WANX_CODEX_CONFIG:JSON.stringify(policy),OPENAI_API_KEY:'SYNTHETIC_HOST_SECRET',
    }});
    let stdout='',stderr='',pids=[];
    child.stdout.on('data',data=>{stdout+=data});
    child.stderr.on('data',data=>{stderr+=data});
    const exited=new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    t.after(async()=>{
      for(const pid of [child.pid,...pids]){
        try{process.kill(-pid,'SIGKILL')}catch{}
        try{process.kill(pid,'SIGKILL')}catch{}
      }
      await rm(directory,{recursive:true,force:true});
    });
    pids=await eventually(async()=>JSON.parse(await readFile(ready,'utf8')));
    assert.ok(pids.every(running));
    child.kill(signal);
    let timer;
    const exit=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Probe termination timeout')),5000)})])
      .finally(()=>clearTimeout(timer));
    assert.deepEqual(exit,{code:1,signal:null});
    assert.equal(JSON.parse(stdout).code,'CODEX_INTERRUPTED');
    assert.equal(JSON.parse(stdout).modelCalls,0);
    assert.equal(stderr,'');
    assert.ok(!stdout.includes('SYNTHETIC_HOST_SECRET'));
    await eventually(()=>pids.every(pid=>!running(pid)));
    assert.ok(!(await readdir(directory)).some(name=>name.startsWith('wanx-codex-')));
    if(stage==='initialize')assert.deepEqual((await readFile(calls,'utf8')).trim().split('\n'),['initialize']);
  });
}

test('version timeout drains native descendants after their wrapper exits on TERM',unix,async t=>{
  const directory=await mkdtemp('/tmp/wanx-version-timeout-');
  const binary=path.join(directory,'codex.cjs'),ready=path.join(directory,'ready.json');
  await writeFile(binary,`#!${process.execPath}
const fs=require('node:fs'),{spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`,{mode:0o700});
  let pids=[];
  t.after(async()=>{
    for(const pid of pids){try{process.kill(-pid,'SIGKILL')}catch{};try{process.kill(pid,'SIGKILL')}catch{}}
    await rm(directory,{recursive:true,force:true});
  });
  const pending=probeCodex({environment:{PATH:process.env.PATH,TMPDIR:directory,
    WANX_CODEX_PATH:binary,WANX_CODEX_CONFIG:JSON.stringify(policy)},
    createSession:()=>assert.fail('a timed-out version check must not connect')});
  pids=await eventually(async()=>JSON.parse(await readFile(ready,'utf8')));
  const result=await pending;
  assert.equal(result.code,'CODEX_VERSION_FAILED');
  assert.equal(result.available,false);
  assert.equal(result.modelCalls,0);
  await eventually(()=>pids.every(pid=>!running(pid)));
  assert.ok(!(await readdir(directory)).some(name=>name.startsWith('wanx-codex-')));
});

test('process-group cleanup still kills a surviving child after the wrapper has exited',unix,async t=>{
  const directory=await mkdtemp('/tmp/wanx-exited-wrapper-'),ready=path.join(directory,'ready');
  const descendant=`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  const wrapper=spawn(process.execPath,['-e',`
    const fs=require('node:fs');
    require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(0)}},10);
  `],{detached:true,stdio:'ignore'});
  let child;
  t.after(async()=>{
    try{process.kill(-wrapper.pid,'SIGKILL')}catch{}
    if(child)try{process.kill(child,'SIGKILL')}catch{}
    await rm(directory,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{wrapper.once('error',reject);wrapper.once('exit',resolve)});
  child=Number(await readFile(ready,'utf8'));
  assert.equal(wrapper.exitCode,0);assert.ok(running(child));
  await stopGroup(wrapper);
  await eventually(()=>!running(child));
});

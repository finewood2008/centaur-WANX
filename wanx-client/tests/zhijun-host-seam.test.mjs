import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApplicationManager} from '../applications/manager.mjs';
import {createDashboardGateway} from '../octop/gateway.mjs';

const zhijun = process.env.WANX_ZHIJUN_ROOT;
// Optional cross-repository seam: run the real prepared runtime in a child
// process, substituting Node for the Electron window at the OS launch boundary.
test('installed ZhiJun child uses Host HTTP and clears its session on box switch', {skip:!zhijun,timeout:10000}, async t => {
  const root=await mkdtemp(path.join(tmpdir(),'wanx-zhijun-seam-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const box=http.createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer private-box-token');
    res.setHeader('content-type','application/json');
    res.end(req.url==='/api/auth/me'?'{"id":4,"display_name":"盒子102"}':req.url==='/api/agents'?'[]':'{}');
  });
  box.listen(0,'127.0.0.1');await once(box,'listening');
  t.after(()=>new Promise(resolve=>{box.closeAllConnections();box.close(resolve);}));
  const transport=await createDashboardGateway({targetURL:`http://127.0.0.1:${box.address().port}`,session:{getToken:()=> 'private-box-token',close(){}}});
  t.after(()=>transport.close());
  const manifest=JSON.parse(await readFile(path.join(zhijun,'application.manifest.json'),'utf8'));
  const source=path.join(root,'source');
  await mkdir(path.dirname(path.join(source,manifest.entrypoint)),{recursive:true});
  await writeFile(path.join(source,'application.manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(source,manifest.entrypoint),`
    const {startDesktopRuntime}=require(${JSON.stringify(path.join(zhijun,'desktop/shell/runtime.cjs'))});
    startDesktopRuntime({dataDir:${JSON.stringify(path.join(root,'data'))},staticDir:${JSON.stringify(path.join(zhijun,'desktop/renderer'))}}).then(runtime=>{
      console.log(runtime.origin);
      process.send({type:'wanx:application-ready',launchId:process.env.WANX_HOST_LAUNCH_ID});
      runtime.hostClient.onSessionInvalidated(()=>console.log('expired'));
      process.once('SIGTERM',()=>{runtime.close();process.exit(0);});
    }).catch(()=>process.exit(1));
  `);
  let live=true, child, lines;
  const listeners=new Set();
  const manager=await createApplicationManager({applicationRoot:path.join(root,'installed'),applicationId:'wanx-host',
    createConnection:async()=>{
      const identity=JSON.parse((await transport.request({path:'/api/auth/me'})).body.toString());
      return {context(){if(!live)throw Error('NETWORK_CHANGED');return {boxId:'102',user:identity,connection:'ready'};},
        request:transport.request,openStream:transport.openWebSocket,
        subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
    },
    spawn:(_executable,args,options)=>{
      const installPath=args[0].slice('--wanx-application='.length);
      child=spawn(process.execPath,[path.join(installPath,manifest.entrypoint)],{...options,stdio:['ignore','pipe','pipe','ipc']});
      lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();return child;
    },
  });
  t.after(async()=>{const exited=child&&child.exitCode===null?once(child,'exit'):null;await manager.close();if(exited)await exited;});
  await manager.install({sourceDir:source});await manager.launch(manifest.applicationId,manifest.version);
  const origin=(await lines.next()).value;
  assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
  const state=await(await fetch(origin+'/api/connection')).json();
  assert.equal(state.boxId,'102');assert.equal(state.scope,'wanx-host');
  const me=await fetch(origin+'/api/me');assert.equal(me.status,200);assert.equal((await me.json()).id,4);
  live=false;for(const fn of listeners)fn();
  assert.equal((await lines.next()).value,'expired');
  assert.equal((await fetch(origin+'/api/me')).status,401);
  assert.equal((await(await fetch(origin+'/api/status')).json()).sessionExpired,true);
});

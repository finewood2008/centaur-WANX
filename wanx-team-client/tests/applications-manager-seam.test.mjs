import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createApplicationManager } from "../applications/manager.mjs";

test("Builder launches as an independent managed app, upgrades its bundle and reuses the live process", async t => {
  const {readFile,rm}=await import("node:fs/promises");
  const root=await mkdtemp(path.join(os.tmpdir(),"wanx-builder-app-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=path.join(root,"old");await mkdir(source);
  await writeFile(path.join(source,"main.cjs"),"module.exports={}");
  await writeFile(path.join(source,"application.manifest.json"),JSON.stringify({applicationId:"ai.wanx.studio",name:"旧版 Builder",version:"1.0.0",protocolVersion:1,runtime:"electron",launchMode:"shared",entrypoint:"main.cjs"}));
  const profile=path.join(root,"apps/.runtime/ai.wanx.studio");await mkdir(profile,{recursive:true});await writeFile(path.join(profile,"existing-project.txt"),"keep");
  let allowed=true,live=true;const children=[],messages=[];
  const manager=await createApplicationManager({applicationRoot:path.join(root,"apps"),applicationId:"wanx-host",
    createConnection:async()=>({context:()=>{if(!live)throw Error("SESSION_CHANGED");return{accountId:"admin",boxId:"box",user:{id:1}}},request:async()=>({status:allowed?200:403,body:JSON.stringify(allowed?{modelAvailable:false}:{code:"STUDIO_ADMIN_REQUIRED"})})}),
    spawn:(_file,_args,options)=>{const child=new EventEmitter();child.exitCode=null;child.send=message=>messages.push(message);child.kill=()=>{child.exitCode=0;child.emit("exit",0)};children.push({child,options});queueMicrotask(()=>child.emit("message",{type:"wanx:application-ready",launchId:options.env.WANX_HOST_LAUNCH_ID}));return child},
  });
  t.after(()=>manager.close());await manager.install({sourceDir:source});
  allowed=false;await assert.rejects(manager.launch("ai.wanx.studio"),/STUDIO_ADMIN_REQUIRED/);assert.equal(children.length,0);
  allowed=true;const first=await manager.launch("ai.wanx.studio");const second=await manager.launch("ai.wanx.studio");
  assert.equal(children.length,1);assert.equal(first.launchId,second.launchId);assert.ok(messages.some(message=>message.type==="wanx:application-activate"));
  const installed=(await manager.listInstalled()).find(item=>item.applicationId==="ai.wanx.studio");
  assert.equal(installed.name,"万象·开物");assert.equal(installed.version,"1.0.1");
  assert.equal(children[0].options.env.WANX_HOST_CLIENT_APPLICATION_ID,"ai.wanx.studio");
  assert.equal(await readFile(path.join(profile,"existing-project.txt"),"utf8"),"keep");
  live=false;await assert.rejects(manager.launch("ai.wanx.studio"),/SESSION_CHANGED/);assert.equal(children.length,1);
});

test("manager installs and launches an application with a one-time host environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-manager-"));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "shell"), { recursive: true });
  await writeFile(path.join(source, "shell", "main.cjs"), "module.exports = {};\n");
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({
    applicationId: "centaurai.wanx.zhijun", name: "知君", version: "0.4.2", protocolVersion: 1,
    runtime: "electron", entrypoint: "shell/main.cjs", capabilities: ["identity.read"],
  }));
  let launchOptions;
  const manager = await createApplicationManager({
    applicationRoot: path.join(root, "installed"), applicationId: "wanx-host",
    context: () => ({ boxId: "box-1", connection: "ready" }),
    spawn: (_file, _args, options) => {
      launchOptions = options;
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
      queueMicrotask(() => child.emit("message", { type: "wanx:application-ready", launchId: options.env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  });
  await manager.install({ sourceDir: source });
  const launched = await manager.launch("centaurai.wanx.zhijun");
  assert.equal(launched.state, "running");
  assert.equal(launchOptions.env.WANX_HOST_CLIENT_APPLICATION_ID, "centaurai.wanx.zhijun");
  assert.equal(launchOptions.env.WANX_HOST_PROTOCOL_VERSION, "1");
  assert.equal(launchOptions.env.WANX_HOST_TRANSPORT, "http-v1");
  assert.equal(launchOptions.env.WANX_HOST_SOCKET, undefined);
  await manager.close();
});

test("reopening after a box switch creates a new launch instead of reusing the old connection", async (t) => {
  const { EventEmitter } = await import("node:events");
  const { rm } = await import("node:fs/promises");
  const root = await mkdtemp(path.join(os.tmpdir(), "wanx-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "main.cjs"), "module.exports = {};\n");
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({
    applicationId: "centaurai.wanx.zhijun", name: "知君", version: "0.4.3", protocolVersion: 1,
    runtime: "electron", entrypoint: "main.cjs", capabilities: ["identity.read"],
  }));
  let box = "box-102";
  const children = [], environments = [];
  const manager = await createApplicationManager({
    applicationRoot: path.join(root, "installed"), applicationId: "wanx-host",
    createConnection: async () => {
      if (!box) throw Object.assign(new Error("NETWORK_NOT_READY"), { code: "NETWORK_NOT_READY" });
      const selected = box;
      return { context: () => {
        if (box !== selected) throw Object.assign(new Error("NETWORK_CHANGED"), { code: "NETWORK_CHANGED" });
        return { boxId: selected, connection: "ready" };
      } };
    },
    spawn: (_file, _args, options) => {
      environments.push(options.env);
      const child = new EventEmitter();
      child.exitCode = null;
      child.kill = () => { child.exitCode = 0; child.emit("exit", 0); };
      children.push(child);
      queueMicrotask(() => child.emit("message", { type: "wanx:application-ready", launchId: options.env.WANX_HOST_LAUNCH_ID }));
      return child;
    },
  });
  t.after(() => manager.close());
  const context = async env => {
    const response = await fetch(`${env.WANX_HOST_BASE_URL}/__wanx/context`, {
      headers: { authorization: `Bearer ${env.WANX_HOST_TOKEN}` },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await manager.install({ sourceDir: source });
  const first = await manager.launch("centaurai.wanx.zhijun", "0.4.3");
  assert.equal((await context(environments[0])).boxId, "box-102");
  assert.equal((await manager.launch("centaurai.wanx.zhijun", "0.4.3")).launchId, first.launchId);
  assert.equal(children.length, 1);
  box = "box-103";
  const second = await manager.launch("centaurai.wanx.zhijun", "0.4.3");
  assert.notEqual(second.launchId, first.launchId);
  assert.equal(children[0].exitCode, 0);
  assert.equal((await context(environments[1])).boxId, "box-103");
  await assert.rejects(context(environments[0]), { name: "TypeError" });
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(source, "application.manifest.json"), "utf8"));
  await writeFile(path.join(source, "application.manifest.json"), JSON.stringify({ ...manifest, version: "0.4.4" }));
  await manager.install({ sourceDir: source });
  const updated = await manager.launch("centaurai.wanx.zhijun", "0.4.4");
  assert.notEqual(updated.launchId, second.launchId);
  assert.equal(children[1].exitCode, 0);
  assert.equal((await context(environments[2])).boxId, "box-103");
  box = null;
  await assert.rejects(manager.launch("centaurai.wanx.zhijun", "0.4.3"), { code: "NETWORK_NOT_READY" });
  await assert.rejects(manager.launch("centaurai.wanx.zhijun"), { code: "NETWORK_NOT_READY" });
  assert.equal(children.length, 3);
});

test('HTTP launch credentials follow app stop, box switch, logout and session expiry without retargeting', async t => {
  const { EventEmitter } = await import('node:events');
  const { rm } = await import('node:fs/promises');
  const { fromEnvironment } = await import('../host-sdk/index.cjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-http-manager-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const source = path.join(root,'source'); await mkdir(source);
  await writeFile(path.join(source,'main.cjs'),'module.exports = {};');
  await writeFile(path.join(source,'application.manifest.json'),JSON.stringify({applicationId:'centaurai.wanx.zhijun',name:'知君',version:'0.4.4',protocolVersion:1,runtime:'electron',entrypoint:'main.cjs'}));
  let box='102', epoch=0, phase='ready';
  const events=new Set(), environments=[], calls=[];
  const manager=await createApplicationManager({
    applicationRoot:path.join(root,'installed'), applicationId:'wanx-host',
    createConnection:async()=>{
      if(!box)throw Object.assign(new Error('NETWORK_NOT_READY'),{code:'NETWORK_NOT_READY'});
      const pinned=box, generation=epoch;
      return {
        context(){if(epoch!==generation)throw Error('NETWORK_CHANGED');return {boxId:pinned,connection:phase,user:{id:4}};},
        request(input){calls.push({box:pinned,path:input.path});return {status:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify({boxId:pinned}))};},
        subscribe(fn){events.add(fn);return()=>events.delete(fn);},
      };
    },
    spawn:(_file,_args,options)=>{
      environments.push(options.env);
      const child=new EventEmitter();child.exitCode=null;child.kill=()=>{child.exitCode=0;child.emit('exit',0);};
      queueMicrotask(()=>child.emit('message',{type:'wanx:application-ready',launchId:options.env.WANX_HOST_LAUNCH_ID}));return child;
    },
  });
  t.after(()=>manager.close());await manager.install({sourceDir:source});
  const clients=[];t.after(()=>clients.forEach(client=>client.close()));
  const launch=async()=>{await manager.launch('centaurai.wanx.zhijun');const client=fromEnvironment(environments.at(-1));clients.push(client);await client.context();return client;};
  let client=await launch();
  assert.equal((await(await client.request('/api/test')).json()).boxId,'102');
  for(const reason of ['switch','logout','expiry','stop']) {
    const invalidated=new Promise(resolve=>client.onSessionInvalidated(resolve));
    if(reason==='stop')await manager.stop('centaurai.wanx.zhijun');
    else {epoch++;box=reason==='switch'?'103':null;for(const fn of events)fn();}
    await invalidated;
    await assert.rejects(client.request('/api/test'),{code:'HOST_SESSION_EXPIRED'});
    box='103';const previous=environments.at(-1);
    client=await launch();
    assert.notEqual(environments.at(-1).WANX_HOST_TOKEN,previous.WANX_HOST_TOKEN);
    assert.equal((await client.context()).boxId,'103');
  }
  assert.deepEqual(calls,[{box:'102',path:'/api/test'}]);
});

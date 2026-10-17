import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import readline from "node:readline";
import { createSpaceLinkBridge } from "../shell/space-links.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";
import { callTool, spaceRequest } from "../shell/space-links-mcp.mjs";

const waitFor = async predicate => { for (const end=Date.now()+30000;Date.now()<end;) { if(await predicate())return;await new Promise(r=>setTimeout(r,30)); }throw new Error("Timed out"); };
test("two configured MCP agents require owner approval and remain isolated", {skip:!process.env.WANX_SPACE_PYTHON,timeout:60000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(),"wanx-agent-links-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const listener=net.createServer(); listener.listen(0,"127.0.0.1"); await once(listener,"listening"); const port=listener.address().port; await new Promise(r=>listener.close(r));
  const child=spawn(process.env.WANX_SPACE_PYTHON,[fileURLToPath(new URL("./support/personal-space-api.py",import.meta.url)),root,String(port)],{stdio:["ignore","ignore","pipe"]});
  let output="";child.stderr.on("data",data=>output+=data);
  t.after(async()=>{if(child.exitCode===null){child.kill("SIGTERM");await once(child,"exit");}});
  const base="http://127.0.0.1:"+port;
  await waitFor(async()=>{if(child.exitCode!==null)throw Error(output);try{return(await fetch(base+"/api/personal-space/overview")).ok;}catch{return false;}});
  const gateway=await createDashboardGateway({targetURL:base,session:{getToken:()=>"test-only",close(){}}}); t.after(()=>gateway.close());
  const client={snapshot:()=>({phase:"ready",account:{phase:"authenticated",accountId:"test-owner"},connection:{deviceId:"test-box"}}),subscribe:()=>()=>{},
    applicationConnection:async()=>({context(){},request:input=>gateway.request(input)})};
  let saved, changed=0;
  const bridge=await createSpaceLinkBridge({client,serviceURL:base,store:{load:async()=>saved,save:async value=>{saved=structuredClone(value);}},profileDirectory:path.join(root,"profiles"),mcpConfig:{mcpServers:{"wanx-space":{command:process.execPath,args:[fileURLToPath(new URL("../shell/space-links-mcp.mjs",import.meta.url))]}}},onChanged:()=>changed++});t.after(()=>bridge.close());
  const owner=async(route,method="GET",body)=>{const r=await fetch(base+"/api/personal-space"+route,{method,headers:{"content-type":"application/json"},body:body?JSON.stringify(body):undefined}); assert.ok(r.ok,await r.clone().text());return r.status===204?null:r.json();};

  function start(config) {
    const process=spawn(config.command,config.args,{stdio:["pipe","pipe","pipe"]});t.after(()=>process.kill());
    const lines=readline.createInterface({input:process.stdout}),pending=new Map();let seq=0;
    lines.on("line",line=>{const m=JSON.parse(line);pending.get(m.id)?.(m);pending.delete(m.id);});
    const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(Error("MCP timeout")),10000);pending.set(id,m=>{clearTimeout(timer);resolve(m);});process.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
    const tool=async(name,args={})=>{const m=await rpc("tools/call",{name,arguments:args});if(m.result.isError)throw Error(m.result.content[0].text);return JSON.parse(m.result.content[0].text);};
    return {rpc,tool,process};
  }
  const configA=(await bridge.manage("agent-config")).mcpServers["wanx-space"];
  const configB=(await bridge.manage("agent-config")).mcpServers["wanx-space"];
  const a=start(configA),b=start(configB);
  for(const agent of [a,b]) {
    await agent.rpc("initialize",{protocolVersion:"2025-11-25",clientInfo:{name:"Same Agent",version:"1"},capabilities:{}});
    assert.equal((await agent.tool("space_connection_status")).status,"pending");
    await assert.rejects(agent.tool("space",{action:"list"}),/SPACE_APPROVAL_REQUIRED/);
  }
  const pending=await bridge.manage("requests");assert.equal(pending.length,2);
  const approvedA=await bridge.manage("approve",{id:pending[0].id,name:"A"});
  const approvedB=await bridge.manage("approve",{id:pending[1].id,name:"B"});
  const accessA=await a.tool("space_access"),accessB=await b.tool("space_access");
  assert.notEqual(accessA.space.id,accessB.space.id);
  const file=await a.tool("space_write_text",{name:"result.txt",text:"isolated small sample"});
  assert.equal((await a.tool("space_read_text",{target:file.id})).text,"isolated small sample");
  await assert.rejects(b.tool("space_read_text",{target:file.id}),/SPACE_LINK_SCOPE/);
  const grant=await bridge.manage("grant",{id:approvedB.connection,root:file.id});
  assert.equal((await b.tool("space_read_text",{target:file.id,grant_id:grant.id})).text,"isolated small sample");
  await bridge.manage("grant-revoke",{id:approvedB.connection,grant:grant.id});
  await assert.rejects(b.tool("space_read_text",{target:file.id,grant_id:grant.id}),/SPACE_LINK_SCOPE/);
  await bridge.manage("connection-manage",{id:approvedA.connection,action:"pause"});
  await assert.rejects(a.tool("space",{action:"list"}),/SPACE_AGENT_PAUSED/);
  await bridge.manage("connection-manage",{id:approvedA.connection,action:"resume"});
  a.process.kill();const again=start(configA);
  await again.rpc("initialize",{clientInfo:{name:"Different display name"}});
  assert.equal((await again.tool("space_access")).space.id,accessA.space.id);
  assert.equal((await bridge.manage("spaces")).length,3);
  await bridge.manage("connection-manage",{id:approvedA.connection,action:"disconnect"});
  await assert.rejects(again.tool("space",{action:"list"}),/SPACE_APPROVAL_REQUIRED/);
  const sameRequest=(await bridge.manage("requests")).find(x=>x.id===approvedA.id);
  const reapproved=await bridge.manage("approve",{id:sameRequest.id,name:"A",space_id:accessA.space.id});
  assert.equal(reapproved.space_id,accessA.space.id);
  await owner("/files/"+file.id,"DELETE");await owner("/trash/"+file.id,"DELETE");
  for(const space of [accessA.space,accessB.space])await bridge.manage("space-manage",{id:space.id,action:"trash"});
  await assert.rejects(again.tool("space",{action:"list"}),/SPACE_AGENT_DISCONNECTED/);
  assert.equal((await owner("/overview")).filesBytes,0);
});

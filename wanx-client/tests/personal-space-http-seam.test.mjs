import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createPersonalSpace } from "../shell/personal-space.mjs";
import { createDashboardGateway } from "../octop/gateway.mjs";

const waitFor = async predicate => { for (const deadline=Date.now()+30_000;Date.now()<deadline;) { if (await predicate()) return; await new Promise(r=>setTimeout(r,20)); } throw new Error("Timed out"); };
test("real Python service and main-process gateway transfer, restore and download a 36 MiB file", {skip: !process.env.WANX_SPACE_PYTHON, timeout: 120000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "wanx-space-http-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const listener = net.createServer(); listener.listen(0,"127.0.0.1"); await once(listener,"listening"); const port=listener.address().port; await new Promise(r=>listener.close(r));
  const child=spawn(process.env.WANX_SPACE_PYTHON,[fileURLToPath(new URL('./support/personal-space-api.py',import.meta.url)),root,String(port)],{stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',bytes=>output+=bytes);
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
  const url=`http://127.0.0.1:${port}`;
  await waitFor(async()=>{if(child.exitCode!==null)throw new Error(output);try{return (await fetch(url+'/api/personal-space/overview')).ok;}catch{return false;}});
  const gateway=await createDashboardGateway({targetURL:url,session:{getToken:()=>"test-only",close(){}}});
  t.after(()=>gateway.close());
  const data=Buffer.alloc(36*1024*1024,23), source=path.join(root,'source.bin'), target=path.join(root,'download.bin'); await writeFile(source,data);
  const state={phase:'ready',account:{phase:'authenticated',accountId:'test'},connection:{deviceId:'test-box'}};
  const client={snapshot:()=>state,subscribe:()=>()=>{},applicationConnection:async()=>({context:()=>({}),request:input=>gateway.request(input)})};
  const service=await createPersonalSpace({client,store:{load:async()=>[],save:async()=>{}},serviceURL:url,chooseUploads:async()=>[source],chooseDownload:async()=>target});t.after(()=>service.close());
  await service.refresh();
  await service.uploads('');
  await waitFor(()=>service.snapshot().tasks[0]?.phase==='complete'||service.snapshot().tasks[0]?.phase==='paused');
  assert.equal(service.snapshot().tasks[0].phase,'complete',JSON.stringify(service.snapshot()));
  let listing=await service.operation('list');assert.equal(listing.items.length,1);
  const item=listing.items[0];assert.equal(item.size,data.length);
  await service.operation('trash',{id:item.id});assert.equal((await service.operation('list')).items.length,0);
  assert.equal((await service.operation('list',{trash:true})).items.length,1);
  await service.operation('restore',{id:item.id});
  await service.download(item.id);
  await waitFor(()=>service.snapshot().tasks[1]?.phase==='complete'||service.snapshot().tasks[1]?.phase==='paused');
  assert.equal(service.snapshot().tasks[1].phase,'complete',JSON.stringify(service.snapshot()));
  assert.deepEqual(await readFile(target),data);
});

test('real HTTP batch reconciles lost chunk/final replies and pauses without duplicate files', {skip: !process.env.WANX_SPACE_PYTHON, timeout: 120000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wanx-recovery-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const child = spawn(process.env.WANX_SPACE_PYTHON, [fileURLToPath(new URL('./support/personal-space-api.py', import.meta.url)), root, String(port)], {stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes);
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const url = `http://127.0.0.1:${port}`;
  await waitFor(async () => { if (child.exitCode !== null) throw Error(stderr); try { return (await fetch(url + '/api/personal-space/overview')).ok; } catch { return false; } });
  const gateway = await createDashboardGateway({targetURL: url, session: {getToken: () => 'test-only', close() {}}});
  t.after(() => gateway.close());
  const sources = await Promise.all(Array.from({length: 6}, async (_, i) => { const file = path.join(root, `small-${i}.txt`); await writeFile(file, Buffer.alloc(512, i)); return file; }));
  let lostChunk = false, lostCommit = false, blocked = false, release;
  const gate = new Promise(r => release = r), listeners = new Set();
  let state = {phase: 'ready', account: {phase: 'authenticated', accountId: 'test'}, connection: {deviceId: 'test-box'}};
  const calls = [], records = [];
  const client = {snapshot: () => state, subscribe: fn => {listeners.add(fn); return () => listeners.delete(fn);}, applicationConnection: async () => ({context() {}, request: async input => {
    calls.push(input);
    if (lostChunk && !blocked && input.method === 'PUT') { blocked = true; await gate; }
    const response = await gateway.request(input);
    if (!lostChunk && input.method === 'PUT') { lostChunk = true; throw Object.assign(Error('ACK lost'), {code: 'ECONNRESET'}); }
    if (!lostCommit && input.path.endsWith('/complete')) { lostCommit = true; throw Object.assign(Error('commit ACK lost'), {code: 'ECONNRESET'}); }
    return response;
  }})};
  const service = await createPersonalSpace({client, store: {load: async () => [], save: async items => { records.splice(0, records.length, ...structuredClone(items)); }}, serviceURL: url, chooseUploads: async () => sources, chooseDownload: async () => null, retryBaseMs: 1, random: () => 0.5});
  t.after(() => service.close());
  await service.uploads(''); await waitFor(() => blocked);
  state = {...state, phase: 'recovering'}; for (const fn of listeners) fn(); release();
  await waitFor(() => records.every(t => ['waiting', 'complete'].includes(t.phase)));
  const held = service.snapshot().tasks.find(t => t.phase === 'waiting'); await service.transfer('pause', held.id);
  state = {...state, phase: 'ready'}; for (const fn of listeners) fn();
  await waitFor(() => service.snapshot().tasks.filter(t => t.phase === 'complete').length === 5);
  assert.equal(service.snapshot().tasks.find(t => t.id === held.id).phase, 'paused');
  await service.transfer('resume', held.id);
  await waitFor(() => service.snapshot().tasks.every(t => t.phase === 'complete'));
  const listing = await service.operation('list'); assert.equal(listing.items.length, 6);
  assert.equal(new Set(listing.items.map(t => t.id)).size, 6);
  for (let i = 0; i < 6; i++) {
    const item = listing.items.find(e => e.name === `small-${i}.txt`);
    const bytes = await fetch(`${url}/api/personal-space/files/${item.id}/content?offset=0&length=1024`).then(r => r.arrayBuffer());
    assert.deepEqual(Buffer.from(bytes), Buffer.alloc(512, i));
  }
});

test('real HTTP preserves visible filenames through upload, listing, download and image preview', {skip: !process.env.WANX_SPACE_PYTHON, timeout: 120000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wanx-names-http-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
  const child=spawn(process.env.WANX_SPACE_PYTHON,[fileURLToPath(new URL('./support/personal-space-api.py',import.meta.url)),root,String(port)],{stdio:['ignore','pipe','pipe']});
  let output='';child.stderr.on('data',b=>output+=b);t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}});
  const url=`http://127.0.0.1:${port}`;
  await waitFor(async()=>{if(child.exitCode!==null)throw Error(output);try{return(await fetch(url+'/api/personal-space/overview')).ok;}catch{return false;}});
  const gateway=await createDashboardGateway({targetURL:url,session:{getToken:()=> 'test-only',close(){}}});t.after(()=>gateway.close());
  const state={phase:'ready',account:{phase:'authenticated',accountId:'test'},connection:{deviceId:'test-box'}};
  const client={snapshot:()=>state,subscribe:()=>()=>{},applicationConnection:async()=>({context(){},request:input=>gateway.request(input)})};
  let pickedName;const destination=path.join(root,'download');
  const service=await createPersonalSpace({client,store:{load:async()=>[],save:async()=>{}},serviceURL:url,chooseDownload:async value=>{pickedName=value;return destination;}});t.after(()=>service.close());
  const names=['中文  报告（终稿）😀.png','cafe\u0301.txt','résumé & 数据.txt'];
  const data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  const sources=await Promise.all(names.map(async(_,i)=>{const p=path.join(root,`temporary-${i}.bin`);await writeFile(p,data);return p;}));
  await service.uploads('',sources,undefined,names);
  await waitFor(()=>service.snapshot().tasks.every(t=>['complete','paused'].includes(t.phase)));
  assert.ok(service.snapshot().tasks.every(t=>t.phase==='complete'),JSON.stringify(service.snapshot()));
  const listing=await service.operation('list');assert.deepEqual(listing.items.map(i=>i.name).sort(),[...names].sort());
  for(const item of listing.items){
    const before=service.snapshot().tasks.length;await service.download(item.id);
    await waitFor(()=>service.snapshot().tasks[before]?.phase==='complete');
    assert.equal(pickedName,item.name);assert.deepEqual(await readFile(destination),data);
  }
  const preview=await service.preview(listing.items.find(i=>i.name.endsWith('.png')).id);
  assert.equal(preview.type,'image/png');assert.equal(preview.name,names[0]);assert.deepEqual(Buffer.from(preview.data,'base64'),data);
});

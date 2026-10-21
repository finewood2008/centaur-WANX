import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createPersonalSpace} from '../shell/personal-space.mjs';
import {createDashboardGateway} from '../octop/gateway.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const wait=async fn=>{for(const until=Date.now()+90_000;Date.now()<until;){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');};
test('real core HTTP: nested folder >20 files plus 5 MiB payload, lost receipts, exact download and no duplicates',{skip:!process.env.WANX_SPACE_PYTHON,timeout:120_000},async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'wanx-folder-http-'));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.env.WANX_SPACE_PYTHON,[fileURLToPath(new URL('./support/personal-space-api.py',import.meta.url)),root,String(port)],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);
 const url=`http://127.0.0.1:${port}`;let service,gateway;
 t.after(async()=>{await service?.close();await gateway?.close();if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await rm(root,{recursive:true,force:true});});
 await wait(async()=>{if(child.exitCode!==null)throw Error(errors);try{return (await fetch(url+'/api/personal-space/overview')).ok;}catch{return false;}});
 gateway=await createDashboardGateway({targetURL:url,session:{getToken:()=>'fixture',close(){}}});
 const state={phase:'ready',account:{phase:'authenticated',accountId:'fixture'},connection:{deviceId:'fixture-box'}};let armed=false;const lost=new Set();
 const client={snapshot:()=>state,subscribe:()=>()=>{},applicationConnection:async()=>({context:()=>({}),request:async input=>{const r=await gateway.request(input);const stage=input.path.endsWith('/folders')?'folder':input.path.endsWith('/complete')?'commit':null;if(armed&&stage&&!lost.has(stage)){lost.add(stage);throw Object.assign(Error('lost receipt'),{code:'ECONNRESET'});}return r;}})};
 service=await createPersonalSpace({client,store:{load:async()=>[],save:async()=>{}},serviceURL:url,retryBaseMs:1});
 const destination=await service.operation('mkdir',{name:'目标目录'}),source=path.join(root,'中文 资料 #😀');await mkdir(path.join(source,'子目录','三级'),{recursive:true});await mkdir(path.join(source,'空目录'));
 const expected=new Map();for(let i=0;i<43;i++){const relative=(i%2?'子目录/三级/':'')+`报告 ${i} #%.txt`,bytes=Buffer.from(`中文 ${i}\n  空格与换行\n`);expected.set(relative,bytes);await writeFile(path.join(source,relative),bytes);}
 expected.set('大一点的合成文件.bin',Buffer.alloc(5*1024*1024+1,53));expected.set('零字节.txt',Buffer.alloc(0));for(const [n,b] of expected)if(!n.endsWith('#%.txt'))await writeFile(path.join(source,n),b);
 armed=true;await service.uploads(destination.id,[source]);await wait(()=>service.snapshot().imports[0]?.phase==='complete'||service.snapshot().imports[0]?.phase==='failed');assert.equal(service.snapshot().imports[0].failed,0,JSON.stringify(service.snapshot().tasks.filter(t=>t.phase==='paused'))+'\n'+errors);
 const rootList=await service.operation('list',{parent:destination.id});assert.equal(rootList.items.length,1);assert.equal(rootList.items[0].name,path.basename(source));const observed=new Map();let folders=0;
 async function visit(parent,prefix=''){const l=await service.operation('list',{parent});for(const item of l.items){assert.ok(!item.name.startsWith('.wanx-import-'));if(item.kind==='folder'){folders++;await visit(item.id,prefix+item.name+'/');}else observed.set(prefix+item.name,item);}}
 await visit(rootList.items[0].id);assert.equal(folders,3);assert.equal(observed.size,expected.size);assert.deepEqual([...lost].sort(),['commit','folder']);
 for(const [name,bytes] of expected){const item=observed.get(name);assert.ok(item,name);assert.equal(item.digest,digest(bytes));assert.equal(item.size,bytes.length);const parts=[];for(let offset=0;offset<item.size;offset+=1024*1024){const r=await fetch(url+`/api/personal-space/files/${item.id}/content?offset=${offset}&length=${Math.min(1024*1024,item.size-offset)}`);assert.equal(r.status,200);parts.push(Buffer.from(await r.arrayBuffer()));}assert.deepEqual(Buffer.concat(parts),bytes);}
});

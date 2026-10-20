import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {createDashboardGateway} from '../octop/gateway.mjs';
import {createPersonalSpace} from '../shell/personal-space.mjs';
import {createSuperClipboard} from '../shell/super-clipboard.mjs';

const waitFor=async fn=>{for(let i=0;i<600;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out');};
test('two real client queues share Python HTTP clipboard and reconcile dropped committed replies',{skip:!process.env.WANX_SPACE_PYTHON,timeout:90000},async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'wanx-clip-http-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const processBox=spawn(process.env.WANX_SPACE_PYTHON,[fileURLToPath(new URL('./support/clipboard-business-api.py',import.meta.url)),path.join(root,'box'),String(port)],{stdio:['ignore','ignore','pipe']});let stderr='';processBox.stderr.on('data',b=>stderr+=b);
 t.after(async()=>{if(processBox.exitCode===null){processBox.kill();await once(processBox,'exit');}});
 const url=`http://127.0.0.1:${port}`;
 await waitFor(async()=>{if(processBox.exitCode!==null)throw Error(stderr);try{return (await fetch(url+'/api/clipboard/v1',{headers:{authorization:'Bearer synthetic'}})).ok;}catch{return false;}});
 const corePort=JSON.parse(await readFile(path.join(root,'box','core-port.json'),'utf8')).port;
 const coreURL=`http://127.0.0.1:${corePort}`;
 const clients=[];let lost=false;
 for(const device of ['Mac','Windows']){
  const gateway=await createDashboardGateway({targetURL:url,session:{getToken:()=> 'synthetic',close(){}}});t.after(()=>gateway.close());
  const coreGateway=await createDashboardGateway({targetURL:coreURL,session:{getToken:()=> 'synthetic',close(){}}});t.after(()=>coreGateway.close());
  const client={snapshot:()=>({phase:'ready',account:{phase:'authenticated',accountId:'owner'},connection:{deviceId:'shared-test-box'}}),subscribe:()=>()=>{},applicationConnection:async()=>({context(){},request: input=>coreGateway.request(input),businessRequest:async(service,input)=>{assert.equal(service,'clipboard');
   const result=await gateway.request(input);
   if(!lost&&input.path.endsWith('/complete')&&input.path.includes('/clipboard/')){lost=true;throw Object.assign(Error('saved response lost'),{code:'ECONNRESET'});}return result;
  }})};
  const personalSpace=await createPersonalSpace({client,serviceURL:url,store:{load:async()=>[],save:async()=>{}}});t.after(()=>personalSpace.close());
  let copied;const clipboard=await createSuperClipboard({client,personalSpace,serviceURL:url,directory:path.join(root,device),deviceName:device,
    store:{load:async()=>null,save:async()=>{}},systemClipboard:{writeFiles:()=>{throw Error('file copy is not supported');},writeText:()=>{},writeImage:data=>{copied=data;}},chooseFiles:async()=>[],chooseDownload:async()=>null,retryBaseMs:1});
  t.after(()=>clipboard.close());clients.push({clipboard,copied:()=>copied});
 }
 const file=path.join(root,'中文 空格 #%.png'),bytes=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(1024*1024-7,97)]);await writeFile(file,bytes);
 await clients[0].clipboard.operation('capture',{paths:[file]});await waitFor(()=>clients[0].clipboard.snapshot().tasks.length===0);
 await clients[1].clipboard.operation('refresh');assert.equal(clients[1].clipboard.snapshot().items.length,1);
 const item=clients[1].clipboard.snapshot().items[0];assert.equal(item.name,path.basename(file));
 await clients[1].clipboard.operation('copy',{id:item.id});assert.deepEqual(clients[1].copied(),bytes);
 const all=await fetch(url+'/api/clipboard/v1',{headers:{authorization:'Bearer synthetic'}}).then(r=>r.json());assert.equal(all.items.length,1);assert.equal(all.usage.used,bytes.length);
 assert.deepEqual((await fetch(coreURL+'/api/personal-space/files').then(r=>r.json())).items.map(i=>i.name),['应用文件']);
 const blocks=[{type:'text',text:'共享便笺\n中文  空格 🐎\n'},{type:'image',item:item.id},{type:'text',text:'\n图片后的文字'}];
 await clients[0].clipboard.operation('note-refresh');await clients[0].clipboard.operation('note-save',{blocks});
 await waitFor(()=>clients[0].clipboard.snapshot().note.phase==='saved');
 await clients[1].clipboard.operation('note-refresh');assert.deepEqual(clients[1].clipboard.snapshot().note.blocks,blocks);
 assert.equal(clients[1].clipboard.snapshot().note.revision,1);
 assert.equal(lost,true);
});

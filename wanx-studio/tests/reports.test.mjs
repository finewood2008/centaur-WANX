import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {compileArtifact,frameDocument} from '../core/artifact.mjs';

test('compiled report apps use the opaque-frame SDK and trusted message transport',async()=>{
  const compiled=await compileArtifact({
    'miniapp.manifest.json':JSON.stringify({schemaVersion:1,name:'报告 SDK 测试',entry:'src/app.js',capabilities:['reports'],collections:{}}),
    'src/app.js':'export async function mount(root,api){root.api=api;root.identity=await api.reports.context();}'
  });
  const html=frameDocument(compiled.bundle),parent={},root={},sent=[];
  let receive;
  const port={postMessage(message){sent.push(message);queueMicrotask(()=>port.onmessage({data:{id:message.id,result:{user:{id:2,role:'user'},visibility:'own'}}}));}};
  const window={addEventListener(name,fn){if(name==='message')receive=fn;}};
  const document={getElementById:()=>root,addEventListener(){}};
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1],{window,parent,document});
  receive({source:parent,data:{type:'wanx:init'},ports:[port]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(root.identity.user.id,2);
  assert.equal(root.identity.visibility,'own');
  await root.api.reports.list({limit:10});
  await root.api.reports.get({id:'report-a'});
  await root.api.reports.save({operationId:'one-operation',title:'周报',content:'正文'});
  await root.api.reports.delete({id:'report-a',expectedHash:'latest'});
  assert.deepEqual(sent.map(m=>m.method),['reports.context','reports.list','reports.get','reports.save','reports.delete']);
  assert.match(html,/connect-src 'none'/);
  assert.ok(!html.includes('WANX_HOST_TOKEN'));
  assert.ok(!root.api.request);
});

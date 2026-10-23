import{test}from'node:test';import assert from'node:assert/strict';
import{spawn}from'node:child_process';import{mkdtemp,rm,readFile}from'node:fs/promises';import os from'node:os';import path from'node:path';import readline from'node:readline';
test('official sandboxed DSH performs ACP tool calls, pauses for a product answer and returns compiled files',{timeout:45000},async()=>{
  const taskRoot=await mkdtemp(path.join(os.tmpdir(),'wanx-dsh-loop-'));
  const manifest=JSON.parse(await readFile(new URL('../examples/ledger/miniapp.manifest.json',import.meta.url),'utf8'));
  const steps=[['read_material',{}],['ask_product',{question:'是否保留备注？',options:['保留','后置']}],['write_source',{path:'miniapp.manifest.json',content:JSON.stringify(manifest)}],['write_source',{path:'src/app.js',content:'export function mount(root, api){root.textContent="DSH 工具验证"}'}],['validate_app',{}]];
  const child=spawn(process.execPath,['dsh/driver.mjs'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',TMPDIR:process.env.TMPDIR},stdio:['pipe','pipe','pipe']});
  let error='';child.stderr.on('data',b=>error+=b);const events=[];let calls=0;
  child.stdin.write(JSON.stringify({taskRoot,files:{},material:{test:true}})+'\n');
  try{
    for await(const line of readline.createInterface({input:child.stdout})){
      const event=JSON.parse(line);events.push(event);
      if(event.type==='model'){
        const allowed=['read_material','list_sources','read_source','write_source','validate_app','ask_product'];
        assert.deepEqual(event.body.tools.map(t=>t.function.name).sort(),allowed.sort());
        const step=steps[calls++];
        const message=step?{role:'assistant',content:'',tool_calls:[{id:'call_'+calls,type:'function',function:{name:step[0],arguments:JSON.stringify(step[1])}}]}:{role:'assistant',content:'开发与校验已完成，请本人试用验收。'};
        child.stdin.write(JSON.stringify({type:'model_result',id:event.id,result:{choices:[{message,finish_reason:step?'tool_calls':'stop'}]}})+'\n');
      }
      if(event.type==='question')child.stdin.write(JSON.stringify({type:'answer',id:event.id,answer:'保留'})+'\n');
    }
    const exit=child.exitCode??await new Promise(r=>child.once('exit',r));
    assert.equal(exit,0,JSON.stringify(events)+error);assert.equal(calls,5);assert.ok(events.some(e=>e.type==='question'));assert.ok(events.some(e=>e.type==='result'&&e.files['src/app.js']));assert.ok(events.some(e=>e.text==='静态编译与产物校验通过'));assert.ok(!events.some(e=>e.type==='tool'&&e.text.includes('TASK_SUBMITTED')));
  }finally{child.kill('SIGTERM');await rm(taskRoot,{recursive:true,force:true})}
});

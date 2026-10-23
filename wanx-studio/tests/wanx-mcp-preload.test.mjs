import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../wanx-team-client/local-ui/remote-preload.cjs',import.meta.url),'utf8');
function make(result){const exports={},ipcRenderer={invoke:async(channel,input)=>channel==='wanx-client:mcp'?result(input):{},on(){},removeListener(){},send(){}};vm.runInNewContext(source,{require:()=>({ipcRenderer,contextBridge:{exposeInMainWorld:(name,value)=>exports[name]=value},webUtils:{}}),process:{platform:'darwin'}});return exports.wanxClient}
test('actual preload unwraps MCP metadata and copy receipt exactly once',async()=>{
 const client=make(({action})=>({ok:true,value:action==='details'?{url:'http://127.0.0.1:12345/mcp/space'}:{copied:true}}));
 const details=await client.action('wanx.mcp-details');assert(details.ok);assert.equal(details.value.url,'http://127.0.0.1:12345/mcp/space');assert(!details.value.value);
 assert.equal((await client.action('wanx.mcp-copy',{kind:'url'})).value.copied,true);
});
test('actual preload returns a failed MCP IPC response as an error rather than enabling copy',async()=>{
 const client=make(()=>({ok:false,code:'BOX_CONNECTION_REQUIRED'})),r=await client.action('wanx.mcp-details');assert(!r.ok);assert.match(r.code,/BOX_CONNECTION_REQUIRED/);assert(!r.value);
});

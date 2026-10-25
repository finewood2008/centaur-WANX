import{test}from'node:test';import assert from'node:assert/strict';
import{interviewSession}from'../codex/interview-session.mjs';
test('saved ACP session is reused when available',async()=>{
 const input={sessionId:'old',cwd:'/qa',mcpServers:[{name:'wanx_interview'}]};
 const r=await interviewSession({loadSession:async v=>{assert.deepEqual(v,input);return{configOptions:[]}},newSession:()=>assert.fail()},input,true);
 assert.equal(r.sessionId,'old');
});
test('unavailable ACP session recovers once before any prompt with the same tool scope',async()=>{
 let attempts=0;const input={sessionId:'old',cwd:'/qa',mcpServers:[{name:'wanx_interview'}]};
 const conn={loadSession:async()=>{throw Error('Session unavailable')},newSession:async value=>{attempts++;assert.deepEqual(value,{cwd:input.cwd,mcpServers:input.mcpServers});return{sessionId:'new'}}};
 assert.equal((await interviewSession(conn,input,true)).sessionId,'new');assert.equal(attempts,1);
 conn.newSession=async()=>{attempts++;throw Error('offline')};await assert.rejects(interviewSession(conn,input,true),/offline/);assert.equal(attempts,2);
});

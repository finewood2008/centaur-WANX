import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createCreditsReader } from '../account/credits.mjs';
const balance = { account_id:'private-subject', available:120, held:80, paid_available:100, gift_available:20 };
const state = () => ({phase:'ready', account:{phase:'authenticated',accountId:'u1',clientId:'c1'},connection:{deviceId:'authority',mode:'local'}});
const response = (body,status=200) => ({status,body:Buffer.from(JSON.stringify(body))});
const event = {sequence:1,event_id:'e1',kind:'settled',application_id:'zhijun',reservation_id:'r1',available_delta:25,held_delta:-80,expired_amount:10,reference:'任务结算',created_at:1700000000};
function fixture() {
 let current=state(), result=response(balance), pending;
 const calls=[]; const client={snapshot:()=>current,applicationRequest:async input=>{calls.push(input);return pending?await pending:result;}};
 return {reader:createCreditsReader({client,authorityDeviceId:'authority'}),client,calls,setState:s=>current=s,setResult:r=>result=r,setPending:p=>pending=p};
}
test('ledger reads require an explicitly pinned authority and never follow arbitrary boxes',async()=>{
 const f=fixture();await assert.rejects(createCreditsReader({client:f.client}).balance(),{code:'CREDITS_NOT_CONFIGURED'});
 f.setState({...state(),connection:{deviceId:'other'}});await assert.rejects(f.reader.balance(),{code:'CREDITS_NOT_CONNECTED'});assert.equal(f.calls.length,0);
});
test('reads use GET only, project public fields, and retain valid zero balances',async()=>{
 const f=fixture();assert.deepEqual(await f.reader.balance(),{available:120,held:80,paid_available:100,gift_available:20});
 assert.deepEqual(f.calls,[{method:'GET',path:'/api/credits/balance'}]);
 f.setResult(response({...balance,available:0,held:0,paid_available:0,gift_available:0}));assert.equal((await f.reader.balance()).available,0);
 f.setResult(response({...balance,available:1.5}));await assert.rejects(f.reader.balance(),{code:'CREDITS_INVALID_RESPONSE'});
 f.setResult(response({error:{code:'CREDITS_DISABLED'}},503));await assert.rejects(f.reader.balance(),{code:'CREDITS_DISABLED'});
});
test('pagination validates monotonic cursors and details cannot inject a URL',async()=>{
 const f=fixture();f.setResult(response([event]));const page=await f.reader.transactions();assert.equal(page.after,1);assert.equal(page.hasMore,false);
 await assert.rejects(f.reader.transactions({after:-1}),{code:'CREDITS_INVALID_INPUT'});
 await assert.rejects(f.reader.reservation({id:'../balance'}),{code:'CREDITS_INVALID_INPUT'});
 f.setResult(response([event]));await assert.rejects(f.reader.transactions({after:1}),{code:'CREDITS_INVALID_RESPONSE'});
});
test('account and connection changes reject in-flight balances',async()=>{
 const f=fixture();let resolve;f.setPending(new Promise(r=>resolve=r));const read=f.reader.balance();
 f.setState({...state(),account:{phase:'authenticated',accountId:'u2'}});resolve(response(balance));await assert.rejects(read,{code:'ACCOUNT_SESSION_CHANGED'});
});
const viewSource=await readFile(new URL('../local-ui/renderer/credits.js',import.meta.url),'utf8');
function view(request){const window={};vm.runInNewContext(viewSource,{window});const view=window.createCreditsView({request,changed(){}});view.reset('u1');return view;}
test('view separates settlement charges from released and expired points; task details are escaped',async()=>{
 const v=view(async(action)=>action==='credits.balance'?balance:action==='credits.transactions'?{items:[{...event,reference:'<img src=x onerror=alert(1)>'}],after:1,hasMore:false}:{reservation_id:'r1',description:'<script>bad</script>',status:'settled',budget:80,charged:45,refunded:0,task_id:'task1',expires_at:1700000000});
 await v.refresh();assert.equal(v.label(),'120 点');assert.match(v.render(),/−45 点/);assert.match(v.render(),/disabled>充值/);
 await v.action('credits-detail',{eventId:'e1'});assert.match(v.render(),/&lt;script&gt;/);assert.doesNotMatch(v.render(),/<script>/);assert.match(v.render(),/累计扣费/);assert.match(v.render(),/10 点/);
 await v.action('credits-filter',{filter:'spent'});assert.match(v.render(),/−45 点/);
});
test('unavailable is not zero and a late response cannot expose the previous account',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const v=view(async action=>{await pending;return action==='credits.balance'?balance:{items:[event],after:1,hasMore:false};});
 const reading=v.refresh();v.reset('u2');resolve();await reading;assert.equal(v.label(),'暂不可用');assert.doesNotMatch(v.render(),/120|−45/);
 const failed=view(async()=>{throw new Error('CREDITS_DISABLED')});await failed.refresh();assert.match(failed.render(),/积分服务尚未启用/);assert.doesNotMatch(failed.render(),/credits-total">0/);
});
test('pagination preserves records and failed loading can be retried',async()=>{
 let fail=false;const cursors=[];const v=view(async(action,input)=>{if(action==='credits.balance')return balance;cursors.push(input.after);if(fail)throw new Error('offline');return {items:[{...event,event_id:'e'+(input.after+1),sequence:input.after+1}],after:input.after+1,hasMore:input.after===0};});
 await v.refresh();fail=true;await v.action('credits-more',{});assert.match(v.render(),/保留上次读取的记录/);fail=false;await v.action('credits-more',{});assert.deepEqual(cursors,[0,1,1]);assert.equal((v.render().match(/class="credits-record"/g)||[]).length,2);
});

test('usage page retains points and consumption without budget controls or calls',async()=>{
 const calls=[];
 const v=view(async(action)=>{calls.push(action);return action==='credits.balance'?balance:action==='credits.transactions'?{items:[],after:0,hasMore:false}:[{id:'old-task',application_id:'zhijun',created_at:1700000000,status:'paused',simulated_points:400,budget:200,would_exceed:1}];});
 await v.refresh();assert.match(v.render(),/400 点预计消耗/);
 assert.doesNotMatch(v.render(),/预算|任务上限|授权上限|credits-extend|credits-auto/);
 assert.deepEqual(calls,['credits.balance','credits.transactions','credits.tasks']);
});

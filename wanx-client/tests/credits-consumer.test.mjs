import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount } from '../account/index.mjs';
import { createCreditsReader } from '../account/credits.mjs';
function fixture() {
  const calls = []; let clientId, value, rejected = false, mismatch = false, pending;
  const account = createAccount({store:{load:async()=>value,save:async v=>{value=v}},fetch:async(url,opts)=>{
    calls.push({url,opts});
    if(url.endsWith('/login'))clientId=JSON.parse(opts.body).clientId;
    if(url.endsWith('/login')||url.endsWith('/refresh'))return new Response(JSON.stringify({code:200,data:{accountId:'account-one',clientId,accessToken:'fixture-token',refreshToken:'fixture-refresh',expiresIn:3600}}));
    if(pending)await pending;
    if(rejected){rejected=false;return new Response('{}',{status:403});}
    return new Response(JSON.stringify({account_id:mismatch?'other':'account-one',available:0,held:0,paid_available:0,gift_available:0}));
  }});
  return {account,calls,reject(){rejected=true},mismatch(){mismatch=true},wait(p){pending=p}};
}
test('independent ledger transport signs fresh bootstrap proof, retries expired auth and returns real zero',async()=>{
  const f=fixture();await f.account.loginPassword({phone:'13800138000',password:'test-only-password'});f.reject();
  const reader=createCreditsReader({client:{snapshot:()=>({phase:'idle',account:f.account.snapshot()})},accountRequest:input=>f.account.creditsRequest({...input,serviceURL:'http://127.0.0.1:8089'})});
  assert.equal((await reader.balance()).available,0);
  const reads=f.calls.filter(c=>c.url.includes('/credits/account/'));
  assert.equal(reads.length,2);assert.notEqual(reads[0].opts.headers['X-Nexus-Nonce'],reads[1].opts.headers['X-Nexus-Nonce']);
  assert.equal(reads[0].opts.headers['X-Nexus-Signature-Version'],'NEXUSAOS-CONSUMER-APP-V1');
  assert.equal(reads[0].opts.redirect,'error');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/refresh')).length,1);
  f.mismatch();await assert.rejects(reader.balance(),{code:'ACCOUNT_SESSION_CHANGED'});
});
test('ledger rejects insecure remote URLs, arbitrary paths, and late signed-out responses',async()=>{
  const f=fixture();await f.account.loginPassword({phone:'13800138000',password:'test-only-password'});
  for(const serviceURL of ['http://example.com','https://a.test/path','https://user:pass@a.test'])
    await assert.rejects(f.account.creditsRequest({serviceURL,path:'/api/credits/balance'}),{code:'CREDITS_NOT_CONFIGURED'});
  await assert.rejects(f.account.creditsRequest({serviceURL:'http://127.0.0.1:8089',path:'/api/admin/credits/grants'}),{code:'CREDITS_NOT_CONFIGURED'});
  let resolve;f.wait(new Promise(r=>resolve=r));const read=f.account.creditsRequest({serviceURL:'http://127.0.0.1:8089',path:'/api/credits/balance'});
  f.account.close();resolve();await assert.rejects(read,{code:'ACCOUNT_CANCELLED'});
});
test('retired budget authorization paths cannot be called through the account bridge',async()=>{
 const f=fixture();await f.account.loginPassword({phone:'13800138000',password:'test-only-password'});
 const before=f.calls.length;
 for(const path of ['/v1/control/quotes','/v1/control/automatic-budget','/v1/control/tasks/'+ 'a'.repeat(32) +'/authorize'])
  await assert.rejects(f.account.creditsRequest({serviceURL:'https://gateway.wanx.test',path}),{code:'CREDITS_NOT_CONFIGURED'});
 assert.equal(f.calls.length,before);
});

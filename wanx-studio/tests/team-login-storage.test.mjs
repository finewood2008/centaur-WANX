import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createSecureAccountStore} from '../../wanx-team-client/account/store.mjs';
import {createTeamConnection} from '../integration/team-client/connection.mjs';

test('unused secure stores do not request Keychain access',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'wanx-storage-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let checks=0;
  const store=createSecureAccountStore({filePath:path.join(directory,'unused.enc'),safeStorage:{isEncryptionAvailable(){checks++;throw Error('KEYCHAIN_PROMPT')}}});
  assert.equal(await store.load(),null);
  assert.equal(checks,0);
});

test('locked or unreadable credentials are preserved without a plaintext fallback',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'wanx-storage-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'account.enc'),original=Buffer.from('existing-encrypted-session');
  await writeFile(filePath,original,{mode:0o600});
  const locked=createSecureAccountStore({filePath,safeStorage:{isEncryptionAvailable:()=>false}});
  await assert.rejects(locked.load(),/SECURE_STORAGE_UNAVAILABLE/);
  await assert.rejects(locked.save({password:'do-not-save'}),/SECURE_STORAGE_UNAVAILABLE/);
  assert.deepEqual(await readFile(filePath),original);
  const unreadable=createSecureAccountStore({filePath,safeStorage:{isEncryptionAvailable:()=>true,decryptString(){throw Error('DENIED')}}});
  await assert.rejects(unreadable.load(),/SECURE_STORAGE_READ_FAILED/);
  assert.deepEqual(await readFile(filePath),original);
});

test('encrypted store still roundtrips with private file permissions',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'wanx-storage-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'account.enc');
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s).map(b=>b^0xaa),decryptString:b=>Buffer.from(b).map(b=>b^0xaa).toString()};
  const store=createSecureAccountStore({filePath,safeStorage}),value={token:'test-session'};
  await store.save(value);
  assert.deepEqual(await store.load(),value);
  assert.equal((await readFile(filePath)).includes(Buffer.from(value.token)),false);
  if(process.platform!=='win32')assert.equal((await stat(filePath)).mode&0o077,0);
  await store.clear();assert.equal(await store.load(),null);
});

function connection({load,fetcher}){
  let clears=0,baseStarts=0;
  const base={snapshot:()=>({phase:'disconnected',account:{phase:'signed_out'}}),subscribe:()=>()=>{},initialize:async()=>{baseStarts++},close:async()=>{}};
  const client=createTeamConnection({base,createTransport:()=>{throw Error('UNEXPECTED_TRANSPORT')},store:{load,clear:async()=>{clears++}},fetcher});
  return {client,counts:()=>({clears,baseStarts})};
}

test('Keychain failure neither deletes team credentials nor switches accounts',async()=>{
  const f=connection({load:async()=>{throw Error('SECURE_STORAGE_READ_FAILED')}});
  await assert.rejects(f.client.initialize(),/SECURE_STORAGE_READ_FAILED/);
  assert.deepEqual(f.counts(),{clears:0,baseStarts:0});
  assert.equal(f.client.snapshot().account.provider,'team-server');
  await f.client.close();
});

test('temporary server failure preserves the saved team login',async()=>{
  const f=connection({load:async()=>({origin:'https://team.example.com',token:'test-token',expiresAt:Date.now()+60000}),fetcher:async()=>new Response('',{status:503})});
  await f.client.initialize();
  assert.deepEqual(f.counts(),{clears:0,baseStarts:0});
  await f.client.close();
});

test('expired or revoked team logins are still cleared',async()=>{
  for(const expired of [true,false]){
    const f=connection({load:async()=>({origin:'https://team.example.com',token:'test-token',expiresAt:Date.now()+(expired?-60000:60000)}),fetcher:async()=>new Response('',{status:401})});
    await f.client.initialize();
    assert.deepEqual(f.counts(),{clears:1,baseStarts:0});
    await f.client.close();
  }
});

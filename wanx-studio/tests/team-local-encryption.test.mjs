import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,mkdir,chmod,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCipheriv,pbkdf2Sync} from 'node:crypto';
import {createLocalEncryption,isLocalCiphertext} from '../../wanx-team-client/account/local-encryption.mjs';
import {createSecureAccountStore} from '../../wanx-team-client/account/store.mjs';
import {legacyDecryptor,migrateLocalStorage} from '../integration/team-client/migrate-local-storage.mjs';

async function directory(t){const d=await mkdtemp(path.join(tmpdir(),'wanx-local-'));t.after(()=>rm(d,{recursive:true,force:true}));return d}
function oldCiphertext(value,password){
  const cipher=createCipheriv('aes-128-cbc',pbkdf2Sync(password,'saltysalt',1003,16,'sha1'),Buffer.alloc(16,0x20));
  return Buffer.concat([Buffer.from('v10'),cipher.update(JSON.stringify(value)),cipher.final()]);
}
test('local credentials survive a new storage instance without OS encryption',async t=>{
  const d=await directory(t),filePath=path.join(d,'account.enc'),value={password:'私密密码',token:'private-refresh-token'};
  const first=createLocalEncryption({directory:d});
  await createSecureAccountStore({filePath,safeStorage:first}).save(value);
  const encrypted=await readFile(filePath);
  assert.equal(isLocalCiphertext(encrypted),true);
  assert.equal(encrypted.includes(Buffer.from(value.password)),false);
  assert.equal(encrypted.includes(Buffer.from(value.token)),false);
  const second=createLocalEncryption({directory:d});
  assert.deepEqual(await createSecureAccountStore({filePath,safeStorage:second}).load(),value);
  assert.equal(second.getSelectedStorageBackend(),'local_file');
  if(process.platform!=='win32'){
    assert.equal((await stat(path.join(d,'local-credentials'))).mode&0o077,0);
    assert.equal((await stat(path.join(d,'local-credentials/master.key'))).mode&0o077,0);
  }
  assert.equal(first.encryptString('same').equals(first.encryptString('same')),false);
});
test('modified, truncated and foreign-profile ciphertext fails authentication',async t=>{
  const d=await directory(t),other=await directory(t),first=createLocalEncryption({directory:d});
  const encrypted=first.encryptString('secret'),changed=Buffer.from(encrypted);changed[changed.length-1]^=1;
  assert.throws(()=>first.decryptString(changed),/LOCAL_ENCRYPTION_UNAVAILABLE/);
  assert.throws(()=>first.decryptString(encrypted.subarray(0,25)),/LOCAL_ENCRYPTION_UNAVAILABLE/);
  const second=createLocalEncryption({directory:other});second.encryptString('initialize');
  assert.throws(()=>second.decryptString(encrypted),/LOCAL_ENCRYPTION_UNAVAILABLE/);
});
test('missing or unsafe local keys are never replaced while reading saved credentials',async t=>{
  const d=await directory(t),first=createLocalEncryption({directory:d}),encrypted=first.encryptString('secret');
  const keyFile=path.join(d,'local-credentials/master.key'),original=await readFile(keyFile);
  await rm(keyFile);
  assert.throws(()=>createLocalEncryption({directory:d}).decryptString(encrypted),/LOCAL_ENCRYPTION_UNAVAILABLE/);
  await assert.rejects(readFile(keyFile),{code:'ENOENT'});
  await writeFile(keyFile,original,{mode:0o600});
  if(process.platform!=='win32'){
    await chmod(keyFile,0o644);
    assert.throws(()=>createLocalEncryption({directory:d}).decryptString(encrypted),/LOCAL_ENCRYPTION_UNAVAILABLE/);
    await chmod(keyFile,0o600);await rm(keyFile);
    const elsewhere=path.join(d,'other.key');await writeFile(elsewhere,original,{mode:0o600});await symlink(elsewhere,keyFile);
    assert.throws(()=>createLocalEncryption({directory:d}).decryptString(encrypted),/LOCAL_ENCRYPTION_UNAVAILABLE/);
  }
});
test('migration preserves originals and converts login, cache and pairing data',async t=>{
  const d=await directory(t),backup=await directory(t),password=Buffer.from('synthetic-keychain-secret');
  const files=['account.enc','super-clipboard.enc','consumer/scope/claim-resume/user.enc'];
  const originals=new Map();
  for(const file of files){const full=path.join(d,file);await mkdir(path.dirname(full),{recursive:true,mode:0o700});const bytes=oldCiphertext({file,token:'synthetic'},password);originals.set(file,bytes);await writeFile(full,bytes,{mode:0o600})}
  const legacy=legacyDecryptor(password);t.after(()=>legacy.close());
  const result=await migrateLocalStorage({directory:d,backupDirectory:backup,legacy});
  assert.equal(result.migrated,3);
  for(const file of files){
    assert.deepEqual(await readFile(path.join(backup,file)),originals.get(file));
    const value=await createSecureAccountStore({filePath:path.join(d,file),safeStorage:createLocalEncryption({directory:d})}).load();
    assert.deepEqual(value,{file,token:'synthetic'});
  }
  assert.equal((await migrateLocalStorage({directory:d,backupDirectory:backup,legacy:{decrypt(){throw Error('UNEXPECTED_LEGACY_ACCESS')}}})).alreadyLocal,3);
});
test('migration failure leaves every source file intact',async t=>{
  const d=await directory(t),backup=await directory(t),password=Buffer.from('synthetic-keychain-secret');
  const good=oldCiphertext({token:'keep-me'},password),bad=Buffer.from('corrupt-old-data');
  await writeFile(path.join(d,'account.enc'),good,{mode:0o600});await writeFile(path.join(d,'z-corrupt.enc'),bad,{mode:0o600});
  const legacy=legacyDecryptor(password);t.after(()=>legacy.close());
  await assert.rejects(migrateLocalStorage({directory:d,backupDirectory:backup,legacy}));
  assert.deepEqual(await readFile(path.join(d,'account.enc')),good);
  assert.deepEqual(await readFile(path.join(d,'z-corrupt.enc')),bad);
});

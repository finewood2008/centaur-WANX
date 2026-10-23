import {createDecipheriv,pbkdf2Sync,createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,lstat,rename,copyFile,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createLocalEncryption,isLocalCiphertext} from '../../../wanx-team-client/account/local-encryption.mjs';

export function legacyDecryptor(password){
  const key=pbkdf2Sync(password,'saltysalt',1003,16,'sha1');
  return {
    decrypt(bytes){
      if(!bytes.subarray(0,3).equals(Buffer.from('v10')))throw Error('LEGACY_CIPHERTEXT_INVALID');
      const decipher=createDecipheriv('aes-128-cbc',key,Buffer.alloc(16,0x20));
      return Buffer.concat([decipher.update(bytes.subarray(3)),decipher.final()]);
    },
    close(){key.fill(0)},
  };
}

// Run with the client stopped. Stage and verify every file before replacing any.
export async function migrateLocalStorage({directory,backupDirectory,legacy}){
  const storage=createLocalEncryption({directory}),files=[];
  async function collect(root){
    for(const entry of await readdir(root,{withFileTypes:true})){
      const full=path.join(root,entry.name);
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()&&root===directory&&entry.name==='consumer')await collect(full);
      else if(entry.isDirectory()&&root!==directory)await collect(full);
      else if(entry.isFile()&&entry.name.endsWith('.enc'))files.push(full);
    }
  }
  await collect(directory);
  const pending=[];
  try{
    for(const file of files){
      const info=await lstat(file);
      if(!info.isFile()||info.size>32*1024*1024)throw Error('MIGRATION_FILE_INVALID');
      const before=await readFile(file);
      if(isLocalCiphertext(before)){storage.decryptString(before);continue}
      const plain=legacy.decrypt(before);
      const text=plain.toString('utf8');JSON.parse(text);
      const encrypted=storage.encryptString(text);
      if(storage.decryptString(encrypted)!==text)throw Error('MIGRATION_VERIFY_FAILED');
      plain.fill(0);
      const relative=path.relative(directory,file),backup=path.join(backupDirectory,relative);
      await mkdir(path.dirname(backup),{recursive:true,mode:0o700});
      await copyFile(file,backup,constants.COPYFILE_EXCL);
      if(!(await readFile(backup)).equals(before))throw Error('MIGRATION_BACKUP_MISMATCH');
      const temporary=file+'.'+randomUUID()+'.migration';
      await writeFile(temporary,encrypted,{flag:'wx',mode:0o600});
      pending.push({file,temporary,before,hash:createHash('sha256').update(before).digest('hex')});
    }
    for(const item of pending)if(!(await readFile(item.file)).equals(item.before))throw Error('MIGRATION_SOURCE_CHANGED');
    const committed=[];
    try{
      for(const item of pending){await rename(item.temporary,item.file);committed.push(item)}
    }catch(error){
      for(const item of committed){
        const rollback=item.file+'.'+randomUUID()+'.rollback';
        await writeFile(rollback,item.before,{flag:'wx',mode:0o600});await rename(rollback,item.file);
      }
      throw error;
    }
    return {migrated:pending.length,alreadyLocal:files.length-pending.length,backupDirectory,files:pending.map(item=>({file:path.relative(directory,item.file),originalHash:item.hash}))};
  }finally{
    for(const item of pending)await unlink(item.temporary).catch(error=>{if(error.code!=='ENOENT')throw error});
  }
}

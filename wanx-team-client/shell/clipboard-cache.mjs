import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {mkdir, open, readFile, rename, unlink, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';

export const CACHE_LIMIT = 512 * 1024 * 1024;
const valid = id => /^[a-f0-9]{32}$/.test(id);
const fail = code => Object.assign(new Error(code), {code});

// Payloads never enter the metadata store. The random encryption key is protected by
// the same OS-backed secure store as the account; interrupted writes publish atomically.
export async function createClipboardCache(directory, key) {
  await mkdir(directory, {recursive:true,mode:0o700});
  if((await lstat(directory)).isSymbolicLink())throw fail('CLIPBOARD_CACHE_UNSAFE');
  const file = id => {if(!valid(id))throw fail('SPACE_INVALID_ID');return path.join(directory,id+'.enc');};
  async function size(){let total=0;for(const name of await readdir(directory))if(/^[a-f0-9]{32}\.enc$/.test(name))total+=(await lstat(path.join(directory,name))).size;return total;}
  return {
    size,
    async put(id, bytes){
      const target=file(id),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      const data=Buffer.concat([cipher.update(bytes),cipher.final()]);
      const payload=Buffer.concat([iv,cipher.getAuthTag(),data]);
      const tmp=target+'.tmp';let h;
      try{h=await open(tmp,'wx',0o600);await h.writeFile(payload);await h.sync();await h.close();h=null;await rename(tmp,target);}
      finally{await h?.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    },
    async read(id){
      const target=file(id);if((await lstat(target)).isSymbolicLink())throw fail('CLIPBOARD_CACHE_UNSAFE');
      const data=await readFile(target),decipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));
      try{return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]);}catch{throw fail('CLIPBOARD_CACHE_DAMAGED');}
    },
    async remove(id){await unlink(file(id)).catch(e=>{if(e.code!=='ENOENT')throw e;});},
    async clean(ids){for(const name of await readdir(directory))if(/^[a-f0-9]{32}\.enc(?:\.tmp)?$/.test(name)&&!ids.has(name.slice(0,32)))await unlink(path.join(directory,name));},
  };
}

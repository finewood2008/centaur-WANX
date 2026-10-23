import {
  constants, mkdirSync, lstatSync, openSync, closeSync, fstatSync,
  readFileSync, writeFileSync, fsyncSync, linkSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';

const header=Buffer.from('WANXLOCAL1');
const fail=()=>new Error('LOCAL_ENCRYPTION_UNAVAILABLE');
export function isLocalCiphertext(bytes){return Buffer.isBuffer(bytes)&&bytes.subarray(0,header.length).equals(header)}

// The user explicitly chose a private local key instead of macOS Keychain.
// Keep this adapter in the main process; never send its key to a renderer.
export function createLocalEncryption({directory}){
  const keyDirectory=path.join(directory,'local-credentials');
  const keyFile=path.join(keyDirectory,'master.key');
  let cachedKey;
  function privateFile(info){
    return info.isFile()&&info.size===32&&(process.platform==='win32'||(info.uid===process.getuid()&&!(info.mode&0o077)));
  }
  function key(create){
    if(cachedKey)return cachedKey;
    try{
      if(create)mkdirSync(keyDirectory,{recursive:true,mode:0o700});
      const info=lstatSync(keyDirectory);
      if(!info.isDirectory()||info.isSymbolicLink()||(process.platform!=='win32'&&(info.uid!==process.getuid()||(info.mode&0o077))))throw fail();
      if(create){
        const temporary=path.join(keyDirectory,randomUUID()+'.tmp');
        const candidate=randomBytes(32);
        let handle;
        try{
          handle=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
          writeFileSync(handle,candidate);fsyncSync(handle);closeSync(handle);handle=undefined;
          try{linkSync(temporary,keyFile)}catch(error){if(error.code!=='EEXIST')throw error}
        }finally{
          if(handle!==undefined)closeSync(handle);
          candidate.fill(0);
          try{unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error}
        }
      }
      const handle=openSync(keyFile,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{
        if(!privateFile(fstatSync(handle)))throw fail();
        const bytes=readFileSync(handle);
        if(bytes.length!==32)throw fail();
        cachedKey=bytes;
      }finally{closeSync(handle)}
      return cachedKey;
    }catch{throw fail()}
  }
  return Object.freeze({
    isEncryptionAvailable:()=>true,
    getSelectedStorageBackend:()=>'local_file',
    encryptString(value){
      if(typeof value!=='string')throw fail();
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(true),nonce);
      cipher.setAAD(header);
      const ciphertext=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
      return Buffer.concat([header,nonce,cipher.getAuthTag(),ciphertext]);
    },
    decryptString(bytes){
      if(!isLocalCiphertext(bytes)||bytes.length<header.length+28)throw fail();
      try{
        const offset=header.length,decipher=createDecipheriv('aes-256-gcm',key(false),bytes.subarray(offset,offset+12));
        decipher.setAAD(header);decipher.setAuthTag(bytes.subarray(offset+12,offset+28));
        return Buffer.concat([decipher.update(bytes.subarray(offset+28)),decipher.final()]).toString('utf8');
      }catch{throw fail()}
    },
  });
}

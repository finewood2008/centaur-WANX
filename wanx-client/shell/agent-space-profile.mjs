import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import path from 'node:path';

const fail=code=>Object.assign(new Error(code),{code});
export async function createAgentTransport({profileFile,endpoint,fetchImpl=fetch}) {
  const base=new URL(endpoint);
  if(base.protocol!=='http:' || base.hostname!=='127.0.0.1' || !base.port || base.username || base.password || base.search || base.hash || base.pathname!=='/') throw fail('SPACE_INVALID_ENDPOINT');
  if(!path.isAbsolute(profileFile)) throw fail('SPACE_INVALID_PROFILE');
  await mkdir(path.dirname(profileFile),{recursive:true,mode:0o700});
  try {await writeFile(profileFile,JSON.stringify({profile:randomUUID().replaceAll('-',''),key:randomBytes(32).toString('base64url')}),{flag:'wx',mode:0o600});}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const info=await lstat(profileFile);
  if(!info.isFile() || info.isSymbolicLink())throw fail('SPACE_INVALID_PROFILE');
  const profile=JSON.parse(await readFile(profileFile,'utf8'));
  if(!/^[a-f0-9]{32}$/.test(profile.profile || '') || !/^[A-Za-z0-9_-]{43}$/.test(profile.key || ''))throw fail('SPACE_INVALID_PROFILE');
  const send=async(route,input)=>{
    const response=await fetchImpl(new URL(route,base),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.timeout(125000)});
    if(!response.ok){let code;try{code=(await response.json()).error?.code;}catch{}throw fail(code || 'SPACE_REQUEST_FAILED');}
    return response;
  };
  let name='Agent';
  const enroll=async info=>{name=String(info?.name || name).slice(0,80);return (await send('/space-agents/enroll',{...profile,name})).json();};
  const request=async input=>{
    if(input.link)throw fail('SPACE_EXPLICIT_GRANT_REQUIRED');
    const {link,...operation}=input;
    const response=await send('/space-agents/'+profile.key,operation);
    if(input.action==='read'){
      const {createHash}=await import('node:crypto');
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length>4194304 || createHash('sha256').update(bytes).digest('hex')!==response.headers.get('x-content-sha256'))throw fail('SPACE_CHUNK_INVALID');
      return {data:bytes.toString('base64'),encoding:'base64',size:bytes.length,version:Number(response.headers.get('etag')),digest:response.headers.get('x-file-sha256')};
    }
    return response.json();
  };
  return {request,enroll};
}

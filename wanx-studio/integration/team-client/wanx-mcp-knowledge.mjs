const fail=(code,status=403)=>Object.assign(Error(code),{code,status});
// Keep the caller's WANX identity. Existing public reads authenticate the single-
// warehouse Key, box binding, scopes, expiry, revocation and delivery protection.
export async function knowledgeMcpAccess({client,key,scope,assertScope}){
 const bound=scope();assertScope(bound);
 async function request(path,options={}){
  assertScope(bound);
  const connection=await client.applicationConnection('wanx');assertScope(bound);
  const r=await connection.request({path:'/api/semantica/open/v1'+path,method:options.method||'GET',headers:{'X-Xingtu-Key':key,'content-type':'application/json'},...(options.body?{body:Buffer.from(JSON.stringify(options.body))}:{})});
  connection.context();assertScope(bound);
  let value;try{value=JSON.parse(Buffer.from(r.body).toString('utf8'))}catch{throw fail('MCP_KNOWLEDGE_UNAVAILABLE',503)}
  if(r.status<200||r.status>=300)throw fail(typeof value.code==='string'?value.code:'MCP_KNOWLEDGE_DENIED',r.status===401?401:r.status===403?403:503);
  return value;
 }
 const check=()=>request('/warehouse');await check();
 return {kind:'knowledge',request,check};
}

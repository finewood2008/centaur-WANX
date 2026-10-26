const fail=(code,status=403)=>Object.assign(Error(code),{code,status});
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const number=(value,min,max)=>typeof value==='string'&&/^(?:0|[1-9][0-9]*)$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>=min&&Number(value)<=max;
function query(url,rules){
 const entries=[...url.searchParams];
 return new Set(entries.map(([key])=>key)).size===entries.length&&entries.every(([key,value])=>Object.hasOwn(rules,key)&&rules[key](value));
}
// A local capability only selects one already-approved warehouse. Every call
// carries the current device proof and exact resource selector to the box.
export async function knowledgeMcpAccess({capability}){
 const {warehouseId,connection,resourceId}=capability;
 const checkScope=()=>{capability.check();connection.context()};
 async function request(path,options={}){
  checkScope();if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))throw fail('MCP_TOOL_DENIED');
  const url=new URL(path,'https://local.invalid');
  if(url.origin!=='https://local.invalid'||url.hash||path!==url.pathname+url.search)throw fail('MCP_TOOL_DENIED');
  let suffix,method=options.method||'GET';
  if(method==='GET'&&options.body!==undefined)throw fail('MCP_TOOL_DENIED');
  if(url.pathname==='/warehouse'&&method==='GET'&&!url.search)suffix='';
  else if(url.pathname==='/documents'&&method==='GET'&&query(url,{limit:value=>number(value,1,200),offset:value=>number(value,0,Number.MAX_SAFE_INTEGER)}))suffix='/documents'+url.search;
  else if(url.pathname==='/graph'&&method==='GET'&&query(url,{limit:value=>number(value,1,500),entity_id:identifier}))suffix='/graph'+url.search;
  else if(/^\/evidence\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)&&method==='GET'&&!url.search)suffix=url.pathname;
  else if(url.pathname==='/search'&&method==='POST'&&!url.search&&options.body&&!Array.isArray(options.body)
    &&Object.keys(options.body).every(name=>['query','limit'].includes(name))&&typeof options.body.query==='string'
    &&options.body.query.length>0&&options.body.query.length<=2000
    &&(options.body.limit===undefined||Number.isInteger(options.body.limit)&&options.body.limit>=1&&options.body.limit<=50))suffix='/search';
  else throw fail('MCP_TOOL_DENIED');
  const response=await connection.request({path:suffix===''?'/api/semantica/warehouses/'+warehouseId:'/api/semantica'+suffix,method,
    headers:{'x-wanx-data-context':resourceId,'content-type':'application/json'},
    ...(options.body?{body:Buffer.from(JSON.stringify(options.body))}:{})});
  checkScope();if(response.body.length>8*1024*1024)throw fail('MCP_RESPONSE_TOO_LARGE');
  if(response.status<200||response.status>=300)throw fail('MCP_KNOWLEDGE_DENIED',response.status===403?403:503);
  try{return JSON.parse(Buffer.from(response.body).toString('utf8'))}catch{throw fail('MCP_KNOWLEDGE_UNAVAILABLE',503)}
 }
 const check=()=>request('/warehouse');await check();return {kind:'knowledge',request,check};
}

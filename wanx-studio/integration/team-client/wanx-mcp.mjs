// Independent authenticated MCP surfaces reuse the same transport implementation.
import {schema,callTool} from './space-mcp-tools.mjs';
const versions=['2025-03-26','2025-06-18','2025-11-25'];
const fail=(code,status=400)=>Object.assign(Error(code),{code,status});
const object=properties=>({type:'object',additionalProperties:false,properties});
const string={type:'string',maxLength:128};
const integer=(min,max)=>({type:'integer',minimum:min,maximum:max});
const identifier={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'};
const spaceSchema=structuredClone(schema);delete spaceSchema.properties.link;
spaceSchema.required=['action'];spaceSchema.properties.grant_id=string;
const tool=(name,description,inputSchema,readOnlyHint=true)=>({name,description,inputSchema,annotations:{readOnlyHint,destructiveHint:false,idempotentHint:readOnlyHint,openWorldHint:false}});
const spaceTools=[
 tool('space_access','查看 Key 获准的空间和文件范围。补充目录仍需所有者授权。',object({}),true),
 tool('space','在 Key 获准范围内操作文件。写入需要已读取的版本；删除进入回收站。',spaceSchema,false),
 tool('space_read_text','读取获准范围内的 UTF-8 文本，最多 1 MiB，返回版本和摘要。',object({target:string,grant_id:string})),
 tool('space_write_text','创建或更新获准范围内的 UTF-8 文本。覆盖需要 expected 版本。', {...object({target:string,grant_id:string,name:{type:'string',maxLength:240},expected:integer(1,Number.MAX_SAFE_INTEGER),text:{type:'string',maxLength:1024*1024}}),required:['text']},false),
];
const knowledgeTools=[
 tool('xingtu_warehouse','读取 Key 对应的星图仓库概况。仓库由 Key 决定。',object({})),
 tool('xingtu_documents','读取授权仓的材料信息。',object({limit:integer(1,200),offset:integer(0,Number.MAX_SAFE_INTEGER)})),
 tool('xingtu_graph','读取本机会话所批准仓库的知识图谱与来源，遵循当前保护规则。',object({limit:integer(1,500),entity_id:identifier})),
 tool('xingtu_search','检索授权仓的证据，返回受保护的片段及来源。', {...object({query:{type:'string',minLength:1,maxLength:2000},limit:integer(1,50)}),required:['query']}),
 tool('xingtu_evidence','按 ID 读取本机会话所批准仓库内的受保护证据。',{...object({evidence_id:identifier}),required:['evidence_id']}),
];
function validate(args,s){
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(s.properties,k)))throw fail('MCP_ARGUMENT_INVALID');
 for(const k of s.required||[])if(args[k]===undefined)throw fail('MCP_ARGUMENT_INVALID');
 for(const [key,value]of Object.entries(args)){const p=s.properties[key];
  if(p.type==='string'&&(typeof value!=='string'||value.length<(p.minLength||0)||value.length>(p.maxLength||Infinity)||p.enum&&!p.enum.includes(value)||p.pattern&&!new RegExp(p.pattern).test(value)))throw fail('MCP_ARGUMENT_INVALID');
  if(p.type==='integer'&&(!Number.isSafeInteger(value)||value<p.minimum||value>p.maximum))throw fail('MCP_ARGUMENT_INVALID');
 }
}
export function mcpConfiguration(url,kind){return {mcpServers:{[kind==='space'?'wanx-space':'xingtu']:{url,headers:{Authorization:'Bearer <访问 Key>'}}}}}
export function createWanxMcp({resolve,kind}){
 if(!['space','knowledge'].includes(kind))throw Error('MCP_SURFACE_REQUIRED');
 const tools=kind==='space'?spaceTools:knowledgeTools;
 return async function handle(req,res){
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',...(status===405?{allow:'POST'}:{})});res.end(value===undefined?'':JSON.stringify(value))};
  let id=null;
  try{
   if(req.headers.origin)throw fail('MCP_ORIGIN_DENIED',403);
   const raw=req.headers.authorization;
   if(typeof raw!=='string'||!/^Bearer [A-Za-z0-9_-]{20,100}$/.test(raw))throw fail('MCP_KEY_REQUIRED',401);
   const access=await resolve(raw.slice(7)); // Fresh server-side ACL on every message.
   if(access.kind!==kind)throw fail('MCP_KEY_INVALID',401);
   if(req.method!=='POST')return send(405,{error:{code:'MCP_METHOD_NOT_ALLOWED'}});
   const protocol=req.headers['mcp-protocol-version'];if(protocol&&!versions.includes(protocol))throw fail('MCP_VERSION_UNSUPPORTED');
   if(!String(req.headers.accept).includes('application/json')||!String(req.headers.accept).includes('text/event-stream'))throw fail('MCP_ACCEPT_REQUIRED',406);
   if(!String(req.headers['content-type']).startsWith('application/json'))throw fail('MCP_JSON_REQUIRED',415);
   const chunks=[];let size=0;
   for await(const b of req){size+=b.length;if(size>6*1024*1024)throw fail('MCP_REQUEST_TOO_LARGE',413);chunks.push(b)}
   let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw fail('MCP_INVALID_JSON')}
   if(!body||body.jsonrpc!=='2.0'||Array.isArray(body)||typeof body.method!=='string'||body.id!==undefined&&typeof body.id!=='string'&&typeof body.id!=='number')throw fail('MCP_INVALID_REQUEST');
   id=body.id??null;
   const reply=result=>send(200,{jsonrpc:'2.0',id,result});
   if(body.id===undefined){if(!['notifications/initialized','notifications/cancelled'].includes(body.method))throw fail('MCP_INVALID_NOTIFICATION');return send(202)}
   if(body.method==='initialize')return reply({protocolVersion:versions.includes(body.params?.protocolVersion)?body.params.protocolVersion:versions.at(-1),capabilities:{tools:{}},serverInfo:{name:kind==='space'?'wanx-space':'xingtu',title:kind==='space'?'空间 MCP':'星图 MCP',version:'1.0.0'},instructions:kind==='space'?'仅操作空间 Key 获准的文件范围。星图使用独立 MCP 地址和仓库 Key。客户端需保持运行。':'仅访问本机会话 Key 绑定的已批准星图仓库；仅材料、图谱、证据读取和脱敏检索。空间文件使用独立 MCP 地址和空间 Key。客户端需保持运行。'});
   if(body.method==='ping')return reply({});
   if(body.method==='tools/list')return reply({tools});
   if(body.method==='tools/call'){
    const name=body.params?.name,args=body.params?.arguments??{},definition=tools.find(t=>t.name===name);
    if(!definition)return send(200,{jsonrpc:'2.0',id,error:{code:-32602,message:'MCP_TOOL_DENIED'}});
    validate(args,definition.inputSchema);
    try{
     let value;
     if(access.kind==='space')value=name==='space_access'?await access.request({action:'access'}):await callTool(name,args,access.request);
     else{
      const paths={xingtu_warehouse:'/warehouse',xingtu_documents:'/documents',xingtu_graph:'/graph',xingtu_search:'/search',xingtu_evidence:'/evidence/'+encodeURIComponent(args.evidence_id||'')};
      let path=paths[name];if(name==='xingtu_search')value=await access.request(path,{method:'POST',body:args});
      else{const query=new URLSearchParams(Object.entries(args).filter(([k])=>k!=='evidence_id'));if(query.size)path+='?'+query;value=await access.request(path)}
     }
     await access.check();
     return reply({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value&&typeof value==='object'&&!Array.isArray(value)?value:{result:value}});
    }catch(error){return reply({isError:true,content:[{type:'text',text:error.code||'MCP_RESOURCE_UNAVAILABLE'}]})}
   }
   return send(200,{jsonrpc:'2.0',id,error:{code:-32601,message:'MCP_METHOD_NOT_FOUND'}});
  }catch(error){send(error.status||503,{jsonrpc:'2.0',id,error:{code:-32000,message:error.code||'MCP_UNAVAILABLE'}})}
 };
}

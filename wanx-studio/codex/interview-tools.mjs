import readline from 'node:readline';
export const interviewTools=[
 ['read_project','读取当前任务简报、需求、已验证接口及带稳定ID的PRD条目。',{}],
 ['read_baseline','只读查看本轮指定基线版本的应用源码，用于讨论改进；不可执行。',{}],
 ['read_context','读取已选背景的一段正文，可按nextOffset继续读取。',{ref:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}}],
 ['search_context','仅在当前项目已选背景资料中查找关键词。',{query:{type:'string'}}],
 ['update_prd','增量保存PRD；保留未改条目，已有条目用ID更新或删除，不要重写整份文档。',{expectedHash:{type:'string'},text:{type:'object',properties:Object.fromEntries(['problem','currentApproach','successOutcome'].map(k=>[k,{type:'string'}])),additionalProperties:false},summary:{type:'object',properties:Object.fromEntries(['audience','workflow','inputs','outputs','projectName'].map(k=>[k,{type:'string'}])),additionalProperties:false},upsert:{type:'array',items:{type:'object',properties:{section:{type:'string',enum:['scenarios','features','pages','dataFields','rules','exceptions','tests','outOfScope','openQuestions']},id:{type:'string'},value:{anyOf:[{type:'string'},{type:'object'}]}},required:['section','value'],additionalProperties:false}},remove:{type:'array',items:{type:'object',properties:{section:{type:'string'},id:{type:'string'}},required:['section','id'],additionalProperties:false}},capabilities:{type:'array',items:{type:'string',enum:['data','model','files']}},provenance:{type:'array',items:{type:'object',properties:{section:{type:'string',enum:['problem','currentApproach','successOutcome','scenarios','features','pages','dataFields','rules','exceptions','tests','outOfScope','openQuestions']},kind:{type:'string',enum:['user','background','hypothesis']},sources:{type:'array',items:{type:'string'}},note:{type:'string'}},required:['section','kind','sources'],additionalProperties:false}}}],
 ['ask_product','有真正需要用户取舍的问题时，发布一道问题与2—4个具体选项；无需添加其他项。',{text:{type:'string'},why:{type:'string'},options:{type:'array',items:{type:'string'},maxItems:4}}],
 ['require_capability','发现新增运行能力时记录缺口并交给客户端验证，不扩大权限。',{capability:{type:'string'},reason:{type:'string'}}]
];
export async function serve(){
 for await(const line of readline.createInterface({input:process.stdin})){
  let request;
  try{
   request=JSON.parse(line);if(request.id===undefined)continue;let result;
   if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'wanx-product-manager',version:'1.0.0'}};
   else if(request.method==='ping')result={};
   else if(request.method==='tools/list')result={tools:interviewTools.map(([name,description,properties])=>({name,description,inputSchema:{type:'object',properties,additionalProperties:false,required:name==='update_prd'?['expectedHash']:name==='read_context'?['ref']:Object.keys(properties)},annotations:{readOnlyHint:['read_project','read_baseline','read_context','search_context'].includes(name),destructiveHint:false,openWorldHint:false}}))};
   else if(request.method==='tools/call'){
    const spec=interviewTools.find(t=>t[0]===request.params.name);if(!spec)throw new Error('TOOL_DENIED');
    const args=request.params.arguments||{};if(Object.keys(args).some(k=>!Object.hasOwn(spec[2],k)))throw new Error('TOOL_INPUT_INVALID');
    const response=await fetch(process.env.WANX_INTERVIEW_PROXY+'/tool',{method:'POST',headers:{authorization:'Bearer '+process.env.WANX_INTERVIEW_TOKEN,'content-type':'application/json'},body:JSON.stringify({method:spec[0],args})});
    const value=await response.json();result={content:[{type:'text',text:JSON.stringify(value)}],isError:!response.ok};
   }else throw new Error('METHOD_NOT_ALLOWED');
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
  }catch(e){if(request?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:/^[A-Z_]+$/.test(e.message)?e.message:'INTERVIEW_TOOL_FAILED'}})+'\n')}
 }
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href)await serve();

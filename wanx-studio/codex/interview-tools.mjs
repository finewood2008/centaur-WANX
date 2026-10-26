import readline from 'node:readline';
export const interviewTools=[
 ['read_project','读取当前任务简报、需求、默认可用接口目录、检查结果及带稳定ID的PRD条目。',{}],
 ['read_baseline','只读查看本轮指定基线版本的应用源码，用于讨论改进；不可执行。',{}],
 ['read_context','读取已选背景的一段正文，可按nextOffset继续读取。',{ref:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}}],
 ['search_context','仅在当前项目已选背景资料中查找关键词。',{query:{type:'string'}}],
 ['update_prd','增量保存PRD；保留未改条目，已有条目用ID更新或删除，不要重写整份文档。',{expectedHash:{type:'string'},scopeDecisions:{type:'array',description:'仅记录用户已明确采纳的人工替代或本轮后置；同时覆盖 dependency 与 capability 缺口。保留原要求，引用表达取舍的用户消息 ID；不代表确认 PRD 或授权开发。',items:{type:'object',properties:{kind:{type:'string',enum:['dependency','capability']},id:{type:'string'},choice:{type:'string',enum:['manual','defer']},detail:{type:'string'},sourceMessageId:{type:'string'}},required:['kind','id','choice','detail','sourceMessageId'],additionalProperties:false}},text:{type:'object',properties:Object.fromEntries(['problem','currentApproach','successOutcome'].map(k=>[k,{type:'string'}])),additionalProperties:false},summary:{type:'object',properties:Object.fromEntries(['audience','workflow','inputs','outputs','projectName'].map(k=>[k,{type:'string'}])),additionalProperties:false},upsert:{type:'array',items:{type:'object',properties:{section:{type:'string',enum:['scenarios','features','pages','dataFields','rules','exceptions','tests','outOfScope','openQuestions']},id:{type:'string'},value:{anyOf:[{type:'string'},{type:'object'}]}},required:['section','value'],additionalProperties:false}},remove:{type:'array',items:{type:'object',properties:{section:{type:'string'},id:{type:'string'}},required:['section','id'],additionalProperties:false}},capabilities:{type:'array',items:{type:'string',enum:['data','model','files','knowledge','reports']}},provenance:{type:'array',items:{type:'object',properties:{section:{type:'string',enum:['problem','currentApproach','successOutcome','scenarios','features','pages','dataFields','rules','exceptions','tests','outOfScope','openQuestions']},kind:{type:'string',enum:['user','background','hypothesis']},sources:{type:'array',items:{type:'string'}},note:{type:'string'}},required:['section','kind','sources'],additionalProperties:false}}}],
 ['propose_contract','整理本次数据保存结构；用户点击开始构建时冻结，无需单独确认技术字段。collections 是集合名到字段名及 string/number/boolean 类型的映射。集合名只能用小写字母开头的小写字母、数字、下划线或短横线（最多50字符）；不要使用 actionItems 等含大写的集合名。字段名用英文字母开头的字母、数字或下划线。',{expectedHash:{type:'string'},collections:{type:'object',additionalProperties:{type:'object',additionalProperties:{type:'string',enum:['string','number','boolean']}}}}],
 ['ask_product','首次构建围绕真正的产品缺口深入提问，可连续调用2—3次合并显示；只剩一项关键问题时只问一项，不凑题；每题给2—3个互斥方案，每题都提供推荐，放第一项并解释理由。首版后的直接迭代仍只问必要的一题。选项格式“简短标题｜一句取舍说明”；有依据的推荐项放第一项，标题标“（推荐）”。不要添加其他项，不要把推荐当成用户已确认。',{text:{type:'string'},why:{type:'string'},options:{type:'array',items:{type:'string'},minItems:2,maxItems:4}}],
 ['complete_prd','在用户已确认的信息足以形成完整首版、没有实质未决问题、数据保存结构已准备好时，提交当前 PRD 的完备性判断。系统仍会核验缺口，本轮结束后才向用户显示完整 PRD 确认入口；不会启动开发。',{expectedHash:{type:'string'},summary:{type:'string',description:'简述关键流程、边界、异常和验收为何已清楚；不要以章节非空或访谈轮数代替判断。'}}],
 ['require_capability','已有 data/model/files/knowledge/reports 能力直接声明并自动检查；仅尚未支持的接口记录为缺口，不要求用户确认技术接口。',{capability:{type:'string'},reason:{type:'string'}}]
];
export async function serve(){
 const tools=process.env.WANX_INTERVIEW_MODE==='iteration'?[...interviewTools.filter(t=>t[0]!=='complete_prd'),['finish_edit','结束本轮迭代理解。ready 将由系统自动构建；discussed 仅讨论不修改；no_change 表示无需重复制作。',{outcome:{type:'string',enum:['ready','discussed','no_change']},summary:{type:'string'}}]]:interviewTools;
 for await(const line of readline.createInterface({input:process.stdin})){
  let request;
  try{
   request=JSON.parse(line);if(request.id===undefined)continue;let result;
   if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'wanx-product-manager',version:'1.0.0'}};
   else if(request.method==='ping')result={};
   else if(request.method==='tools/list')result={tools:tools.map(([name,description,properties])=>({name,description,inputSchema:{type:'object',properties,additionalProperties:false,required:name==='update_prd'?['expectedHash']:name==='read_context'?['ref']:Object.keys(properties)},annotations:{readOnlyHint:['read_project','read_baseline','read_context','search_context'].includes(name),destructiveHint:false,openWorldHint:false}}))};
   else if(request.method==='tools/call'){
    const spec=tools.find(t=>t[0]===request.params.name);if(!spec)throw new Error('TOOL_DENIED');
    const args=request.params.arguments||{};if(Object.keys(args).some(k=>!Object.hasOwn(spec[2],k)))throw new Error('TOOL_INPUT_INVALID');
    const response=await fetch(process.env.WANX_INTERVIEW_PROXY+'/tool',{method:'POST',headers:{authorization:'Bearer '+process.env.WANX_INTERVIEW_TOKEN,'content-type':'application/json'},body:JSON.stringify({method:spec[0],args})});
    const value=await response.json();result={content:[{type:'text',text:JSON.stringify(value)}],isError:!response.ok};
   }else throw new Error('METHOD_NOT_ALLOWED');
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
  }catch(e){if(request?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:/^[A-Z_]+$/.test(e.message)?e.message:'INTERVIEW_TOOL_FAILED'}})+'\n')}
 }
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href)await serve();

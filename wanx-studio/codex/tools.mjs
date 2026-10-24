import readline from 'node:readline';

export const toolSpecs=[
  ['read_material','读取已经确认的需求与应用运行契约',{},'material'],
  ['list_sources','列出当前任务的前端源文件',{},'list'],
  ['read_source','读取当前任务内的前端源码',{path:{type:'string'}},'read'],
  ['update_plan','公开开发步骤及每一步的执行状态，不请求用户干预',{entries:{type:'array',items:{type:'object',properties:{content:{type:'string'},status:{type:'string',enum:['pending','in_progress','completed']}},required:['content','status'],additionalProperties:false}}},'plan'],
  ['patch_source','局部修改已有源码。find 必须是 read_source 中唯一匹配的完整片段；不匹配或多处匹配时重新读取，不能覆盖其他改动。',{path:{type:'string'},find:{type:'string'},replace:{type:'string'}},'patch'],
  ['write_source','写入当前任务的前端源码或应用清单',{path:{type:'string'},content:{type:'string'}},'write'],
  ['validate_app','使用固定编译器校验并提交本轮版本，不运行生成的代码',{},'validate'],
  ['require_plan','需求存在影响结果的缺口时，结束开发并交还方案阶段；不向用户请求现场操作',{requirement:{type:'string'},reason:{type:'string'}},'require_plan']
];

async function serve(){
  for await(const line of readline.createInterface({input:process.stdin})){
    let request;
    try{
      request=JSON.parse(line);if(request.id===undefined)continue;
      let result;
      if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'wanx-task-tools',version:'1.0.0'}};
      else if(request.method==='ping')result={};
      else if(request.method==='tools/list')result={tools:toolSpecs.map(([name,description,properties,operation])=>({name,description,inputSchema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false},annotations:{readOnlyHint:['material','list','read','plan'].includes(operation),destructiveHint:false,openWorldHint:false}}))};
      else if(request.method==='tools/call'){
        const spec=toolSpecs.find(t=>t[0]===request.params.name);if(!spec)throw new Error('TOOL_DENIED');
        const args=request.params.arguments||{};
        if(Object.keys(args).some(k=>!Object.hasOwn(spec[2],k))||Object.entries(spec[2]).some(([k,schema])=>schema.type==='array'?!Array.isArray(args[k]):typeof args[k]!=='string'))throw new Error('TOOL_INPUT_INVALID');
        const response=await fetch(process.env.WANX_TASK_PROXY+'/tool',{method:'POST',headers:{authorization:'Bearer '+process.env.WANX_TASK_TOKEN,'content-type':'application/json'},body:JSON.stringify({operation:spec[3],...args})});
        const value=await response.json();result={content:[{type:'text',text:JSON.stringify(value)}],isError:!response.ok};
      }else throw new Error('METHOD_NOT_ALLOWED');
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    }catch(error){if(request?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:/^[A-Z_]+$/.test(error.message)?error.message:'TASK_TOOL_FAILED'}})+'\n')}
  }
}
if(process.argv[1]&&import.meta.url===new URL(process.argv[1],'file:').href)await serve();

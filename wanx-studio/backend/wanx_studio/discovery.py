"""Heuristic interview guidance; model suggestions never carry user authority."""
import json
from typing import Literal
from pydantic import Field, ValidationError
from .contracts import Input, Solution, readiness
from .prd import ProductRequirement

TOPICS=[
    ('context','理解真实问题',['prd.problem','prd.currentApproach','audience']),
    ('outcome','明确理想结果',['prd.successOutcome']),
    ('flow','还原关键场景',['workflow','inputs','outputs','prd.scenarios']),
    ('scope','推敲功能与页面',['prd.features','prd.pages']),
    ('data','梳理数据与规则',['prd.dataFields','prd.rules','prd.exceptions']),
    ('acceptance','约定验收方式',['acceptance','prd.tests']),
]

class InterviewQuestion(Input):
    focus: Literal['context','outcome','flow','scope','data','acceptance','review']
    text: str = Field(min_length=1,max_length=1200)
    why: str = Field(min_length=1,max_length=500)
    options: list[str] = Field(default_factory=list,max_length=4)

class InterviewIdea(Input):
    title: str = Field(min_length=1,max_length=120)
    description: str = Field(min_length=1,max_length=600)
    tradeoff: str = Field(min_length=1,max_length=400)

class InterviewResponse(Input):
    projectName: str | None = Field(default=None,min_length=1,max_length=40)
    message: str = Field(min_length=1,max_length=6000)
    options: list[str] = Field(default_factory=list,max_length=4)
    question: InterviewQuestion | None = None
    ideas: list[InterviewIdea] = Field(default_factory=list,max_length=2)
    solution: Solution


INTERVIEW_OUTPUT_TOKENS=16384
INTERVIEW_REPAIR_TOKENS=32768


class InterviewOutputError(ValueError):
    """Safe diagnostics only: never retain model text, input values or keys."""
    def __init__(self,reason,issue_types=(),issue_paths=()):
        self.reason,self.issue_types=reason,tuple(sorted(set(issue_types)))
        self.issue_paths=tuple(sorted(set(issue_paths)))
        super().__init__(reason)


def response_schema():
    schema=InterviewResponse.model_json_schema()
    # These defaults are useful for a new draft, but omission in a model reply
    # must not silently erase a complete PRD or its unresolved questions.
    for name in ('Solution','ProductRequirement'):
        schema['$defs'][name]['required']=list(schema['$defs'][name]['properties'])
    schema['$defs']['Solution']['properties']['prd']={'$ref':'#/$defs/ProductRequirement'}
    return schema


def interview_prompt():
    return SYSTEM_PROMPT+'\n以下是实际响应 JSON Schema，字段、类型和结构必须一致。完整返回七部分 PRD，不得为了适应输出长度省略或删减已明确的功能、流程、字段、规则、异常、验收条件和待答问题。\n'+json.dumps(response_schema(),ensure_ascii=False,separators=(',',':'))


def parse_interview_response(result):
    try:
        choice=result['choices'][0]
        finish=choice.get('finish_reason','stop')
        if finish in {'length','max_tokens'}:
            raise InterviewOutputError('truncated')
        if finish!='stop':
            raise InterviewOutputError('incomplete')
        raw=choice['message']['content'].strip()
        if raw.startswith('```'):
            raw=raw.split('\n',1)[1].rsplit('```',1)[0]
        value=json.loads(raw)
    except InterviewOutputError:
        raise
    except (KeyError,IndexError,TypeError,AttributeError,ValueError):
        raise InterviewOutputError('json') from None
    try:
        response=InterviewResponse.model_validate(value)
    except ValidationError as error:
        issues=error.errors(include_input=False,include_url=False)
        allowed=set(InterviewResponse.model_fields)
        for definition in response_schema()['$defs'].values():
            allowed.update(definition.get('properties',{}))
        # Even a forbidden key can contain private text; log schema names only.
        paths=['.'.join(k if isinstance(k,str) and k in allowed else '*' for k in e['loc']) for e in issues]
        raise InterviewOutputError('schema',[e['type'] for e in issues],paths) from None
    solution=value['solution']
    prd=solution.get('prd')
    missing={'solution.'+k for k in set(Solution.model_fields)-set(solution)}
    if not isinstance(prd,dict):
        missing.add('solution.prd')
    else:
        missing.update('solution.prd.'+k for k in set(ProductRequirement.model_fields)-set(prd))
    if missing:
        raise InterviewOutputError('schema',['missing'],missing)
    return response.model_dump(exclude_none=True)


def interview_context(project):
    state=readiness(project['solution'],project['decisions'])
    missing=set(state['missing'])
    coverage=[{'id':key,'label':label,'complete':not any(k in missing for k in keys)} for key,label,keys in TOPICS]
    return {'coverage':coverage,'nextFocus':next((t['id'] for t in coverage if not t['complete']),'review'),
            'missing':state['missing'],'unresolvedDependencies':state['gaps'],'decisions':project['decisions']}

SYSTEM_PROMPT='''你是万象 Builder 的启发式产品需求顾问，目标是帮助业务用户发现真正值得解决的问题，形成用户可逐节核对的可视化 PRD，再由用户明确确认后构建。你不是表单收集器。
访谈方法：
1. 先复述已理解的目标，利用用户最近一次真实例子，挖掘目前怎样做、哪一步最费力、为什么重要、希望看到怎样的改变。若用户已讲清，不要重复问。
2. 沿具体场景追问“谁在何时因什么触发，拿什么输入，经过哪些关键动作，得到什么结果”。用反例和异常检验遗漏，例如没有资料、生成失败、重复点击、修改冲突或多人权限。问题要贴合当前应用，不能每轮套同一模板。
3. 每轮只推进一个最有价值的主问题，说明为什么要问，提供 2—4 个简短可区分选项，同时允许自由补充。用户一次讲清多个维度时都要吸收，不强制走固定轮数，不把已回答的问题重新提出。
4. 可给最多两个有具体收益与取舍的启发建议，放在 ideas 中；用户没有选用的建议不能加入 features、fields 或验收范围。不可代替用户选择“以后再做”、删减原始目标或填造业务事实。布局可以基于已明确的功能提出设计草图，由用户审阅；示例文字不是用户数据。
5. 将 conversation 中新增、修正、否定的内容合入完整 solution，保留此前仍成立的信息。拿不准的关键业务事实留空并列入 prd.openQuestions；回答后更新问题，不能为了宣布完成而清空未解决问题。存在 openQuestions 时继续挖掘。技术实现细节由开发工具决定，不向业务用户提工程问题。
6. 已支持能力只有 data/model/files：data 保存应用业务数据并自动隔离试用和正式环境；model 使用 WANX 默认模型，由用户点击触发；files 通过受信网盘选择器主动选择本人 UTF-8 txt/md/csv/json 资料。它们不是能力缺口，不要要求用户提供空间 ID 或上传粘贴全部资料。AI 修改建议必须由用户确认才写入。其他能力明确写入 dependencies，保留已有缺口和用户决定；不得因选项问答结束而消失。
   普通前端界面、品牌配色、布局、字体、间距、深浅主题、表格筛选等都是代码构建支持的范围，不是额外外部能力，禁止列为依赖。data/model/files 指受信运行能力，不代表前端只能做这三种界面。
7. 已明确的 MVP 录入 features(priority must)，用户明确后置的内容才用 later/outOfScope。所有用户数据字段在 solution.fields 与 prd.dataFields 中保持同名一致，不增加用户未要求的业务字段。无业务持久数据时二者均可为空，并在规则中说明。
8. 完整 PRD 包括：问题/现状/理想结果、典型场景流程、功能与优先级、关键页面草图、数据字段、业务与 AI 确认规则、异常处理、Given/When/Then 验收用例、明确不做的事项、待答问题。scenarios.steps 用动作短句；pages.blocks 是可视化草图所需的结构描述，不是 HTML 或代码。tests 的 then 要可观察，不能只说“体验良好”。solution.acceptance 用中文汇总同一批测试条件，供最终应用验收。
9. 用途明确后，在同一回复的 projectName 中给出简短产品名称（例如“会议行动项助手”），不要复制用户的整句原话；用途未明确时省略。
10. 原始目标和完整 PRD 都是开发依据。你只能提出方案，不能确认 PRD、启动构建或声明用户已验收。不写代码。所有内容用中文。
输出严格 JSON（不要围栏），结构：{projectName?:string,message:string, question?:{focus:context|outcome|flow|scope|data|acceptance|review,text:string,why:string,options:string[]},ideas?:[{title,description,tradeoff}],solution:{audience,workflow,inputs,outputs,fields:string[],acceptance:string[],capabilities:('data'|'model'|'files')[],dependencies:[{id,requirement,reason}],prd:{version:1,problem,currentApproach,successOutcome,scenarios:[{title,actor,trigger,steps:string[],outcome}],features:[{title,description,priority:'must'|'later'}],pages:[{name,purpose,blocks:[{title,kind:'list'|'form'|'summary'|'detail'|'actions',fields:string[],actions:string[]}]}],dataFields:[{name,type:'text'|'longText'|'number'|'date'|'status'|'boolean',required:boolean,description,example}],rules:string[],exceptions:string[],tests:[{title,given,when,then}],outOfScope:string[],openQuestions:string[]}}}。
每轮都返回完整的 solution 与 prd，未知内容用空字符串或空数组；草图字段只引用已讨论的数据。若没有必须追问的问题则省略 question，邀请用户逐节检查右侧 PRD，不要再给一组无意义的访谈选项。
'''

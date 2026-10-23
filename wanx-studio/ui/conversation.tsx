import{useLayoutEffect,useRef,useState}from'react';
import{turnStatus}from'./workbench-layout.mjs';
import type{Project}from'./api';
import{errorText}from'./api';
import{Icon}from'./icons';
import{interviewChoices}from'./interview-options.mjs';
import{conversationParagraphs,conversationFollows,conversationStatus,conversationMessages,conversationInput}from'./conversation-state.mjs';

type Value={draft:string;choice:string;extra:string};
type Props={project:Project|null;value:Value;busy:boolean;active:boolean;interviewRunning:boolean;ready:boolean;modelAvailable:boolean;scrollTop?:number;onPatch:(value:Partial<Value>)=>void;onScroll:(top:number)=>void;onSend:(text:string)=>void;onRetry:(text:string,operationId:string)=>void;onHistory:()=>void;onConfigure:()=>void;onCapabilities:()=>void};
export function MessageText({text}:{text:string}){
 return <>{conversationParagraphs(text).map((runs,i)=><p key={i}>{runs.map((run,j)=>run.bold?<strong key={j}>{run.text}</strong>:run.text)}</p>)}</>;
}
export function Conversation({project,value,busy,active,interviewRunning,ready,modelAvailable,scrollTop,onPatch,onScroll,onSend,onRetry,onHistory,onConfigure,onCapabilities}:Props){
 const scroller=useRef<HTMLDivElement|null>(null),latest=useRef<HTMLElement|null>(null),follow=useRef(true),opened=useRef<string|null>(null);
 const[away,setAway]=useState(false);
 const input=useRef<HTMLTextAreaElement|null>(null);

 const messages=conversationMessages(project) as (Project['messages'][number]&{author?:string})[];
 const last=messages.at(-1),question=last?.role==='assistant'?last.question:null;
 const options=interviewChoices(last?.role==='assistant'?(last.question?.options||last.options||[]):[]);
 const{choice:selected,text:inputValue,answer}=conversationInput(value,options.map(option=>option.value));
 useLayoutEffect(()=>{const node=input.current;if(!node)return;
  const fit=()=>{if(!node.clientWidth)return;node.style.height='0px';node.style.height=Math.min(144,Math.max(46,node.scrollHeight+2))+'px'};
  fit();let width=node.clientWidth;const observer=new ResizeObserver(()=>{if(node.clientWidth!==width){width=node.clientWidth;fit()}});observer.observe(node);return()=>observer.disconnect();
 },[inputValue,project?.id,options.length]);
 const prepared=project?.preparation,stream=prepared?.interview.stream;
 function jump(){const node=scroller.current;if(!node)return;follow.current=true;setAway(false);node.scrollTop=latest.current?node.scrollTop+latest.current.getBoundingClientRect().top-node.getBoundingClientRect().top-24:node.scrollHeight;onScroll(node.scrollTop)}
 useLayoutEffect(()=>{
  const node=scroller.current;if(!node||!node.clientHeight)return;
  const id=project?.id||'new';
  if(opened.current!==id){opened.current=id;if(scrollTop!=null){node.scrollTop=scrollTop;follow.current=conversationFollows(node.scrollTop,node.scrollHeight,node.clientHeight);setAway(!follow.current)}else jump();return}
  if(follow.current)jump();
 },[project?.id,last?.id]);
 useLayoutEffect(()=>{const node=scroller.current;if(node?.clientHeight&&interviewRunning&&follow.current)node.scrollTop=node.scrollHeight},[stream,interviewRunning]);
 function send(){if(!answer.trim()||busy)return;follow.current=true;setAway(false);onSend(answer)}
 const disabled=busy||!ready;
 return <section className="studio-conversation">
  <header><div><h2>对话</h2><span className="conversation-status" role="status">{conversationStatus(prepared)}</span></div><div className="conversation-tools"><button onClick={jump} title="回到最新一轮对话">最新消息<Icon name="arrow" size={13}/></button>{prepared&&<details className="conversation-context"><summary>{prepared.references.length} 份资料</summary><div><p>所选资料只用于理解需求，应用权限单独确认。</p><button onClick={onCapabilities}>查看资料与能力</button></div></details>}<button onClick={onHistory} title="当前项目的完整对话历史">历史对话</button></div></header>
  <div className="studio-messages" ref={scroller} onScroll={e=>{const n=e.currentTarget;follow.current=conversationFollows(n.scrollTop,n.scrollHeight,n.clientHeight);setAway(!follow.current);onScroll(n.scrollTop)}} aria-label="需求对话记录">
   {!project?<div className="studio-welcome"><span className="eyebrow">从你熟悉的工作开始</span><h1>你想解决什么问题？</h1><p>讲一次实际经历就好。我们一起把想法聊清楚，逐步整理成完整方案。</p></div>:messages.map(m=><article className={'studio-message '+m.role} key={m.id} ref={m.id===last?.id?latest:null}>
    <small>{m.role==='user'?'你':m.author|| (prepared?.phase==='intake'?'任务助手':prepared?'AI 产品经理':'万象需求助手')}</small>
    <MessageText text={m.error?errorText(new Error(m.error)):m.text}/>
    {m.role==='user'&&turnStatus(project,m)&&<div className={'message-delivery '+turnStatus(project,m).state} role="status">{({queued:active?'已接收 · 等待当前工作结束':'已接收 · 等待整理',paused:'已保存 · 等待继续处理',running:'正在整理',completed:'已处理',failed:'本轮未完成 · 原话已保留'} as Record<string,string>)[turnStatus(project,m).state]}{['paused','failed','queued'].includes(turnStatus(project,m).state)&&!active&&<button disabled={busy} onClick={()=>onRetry(m.text,turnStatus(project,m).operationId)}>继续处理</button>}</div>}
    {m.question&&m.id!==last?.id&&!m.text.includes(m.question.text)&&<details className="conversation-previous-question"><summary>当时的问题</summary><p>{m.question.text}</p></details>}
    {m.ideas?.map(idea=><details key={idea.title}><summary>建议：{idea.title}</summary><p>{idea.description}</p><p>取舍：{idea.tradeoff}</p><button disabled={busy||last?.id!==m.id} onClick={()=>onPatch({draft:'希望采用：'+idea.title+'。'+idea.description,choice:'other',extra:'希望采用：'+idea.title+'。'+idea.description})}>补充到回答</button></details>)}
    {m.id===last?.id&&options.length>0&&<section className="conversation-answer" aria-label={question?.text||'本轮回答'}>
     <div className="conversation-answer-heading"><span>你的回答</span>{question&&/[？?]/.test(m.text)?<details><summary>问题说明</summary><p>{question.text}</p><p>{question.why}</p></details>:question&&<h3>{question.text}</h3>}</div>
     <div className="studio-options" role="radiogroup" aria-label="访谈回答">{options.map(({value:option,label},i)=><button role="radio" aria-checked={selected===option} className={selected===option?'selected':''} key={option} disabled={busy} onClick={()=>onPatch({choice:option})}><span>{i+1}</span><span className="conversation-option-label">{label}</span>{selected===option&&<Icon name="check" size={16}/>}</button>)}</div>
    </section>}
   </article>)}
   {interviewRunning&&stream&&<article className="studio-message assistant streaming"><small>AI 产品经理</small><MessageText text={stream}/></article>}
   {(busy||interviewRunning)&&<p className="thinking">正在整理，可以继续发送补充…</p>}
  </div>
  {away&&<button className="conversation-jump" onClick={jump}>回到最新对话 ↓</button>}
  <div className="studio-composer compact"><div className="conversation-input-row"><textarea ref={input} rows={1} aria-label={options.length?'补充回答':'描述需求'} placeholder={options.length?selected&&selected!=='other'?'已选择上方选项；也可以输入不同的想法…':'选择上方选项，或在这里补充你的想法…':active?'随时补充或修改，发送后会接续处理…':'继续说说你的想法或修改…'} disabled={busy||!ready} value={inputValue} onChange={e=>onPatch(options.length?{extra:e.target.value,choice:'other',draft:''}:{draft:e.target.value,choice:'',extra:''})} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.nativeEvent.isComposing){e.preventDefault();send()}}}/><button className="primary" disabled={disabled||!answer.trim()||(!modelAvailable&&!prepared)} onClick={send}>{busy?'发送中':options.length?'确认回答':'发送'}<Icon name="arrow" size={15}/></button></div><footer><small>{interviewRunning?'补充会在本轮整理结束后接续处理':active?'修改将接续整理，核对方案后再开始制作':options.length?'选中后不会自动发送 · ⌘ / Ctrl Enter 确认':'⌘ / Ctrl Enter 发送 · 产品方案随对话整理'}</small>{!modelAvailable&&!prepared&&ready&&<button onClick={onConfigure}>配置需求模型</button>}</footer></div>
 </section>;
}

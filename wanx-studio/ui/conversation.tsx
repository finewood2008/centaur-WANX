import{useLayoutEffect,useRef,useState}from'react';
import{turnStatus}from'./workbench-layout.mjs';
import type{Project}from'./api';
import type{Edit,EditState}from'./direct-edits';
import type{VisualDraft}from'./visual-review';
import{visualReviewReady}from'./visual-review-state.mjs';
import{activeEdit,waitingEdit,editLabels,editDelivery}from'./direct-edit-state.mjs';
import{errorText}from'./api';
import{Icon}from'./icons';
import{QuestionBatch,type ProductAnswer}from'./question-batch';
import{productQuestions,questionAnswers}from'./question-batch-state.mjs';
import{interviewChoices}from'./interview-options.mjs';
import{conversationParagraphs,conversationFollows,conversationStatus,conversationMessages,conversationInput,pendingConversationOptions}from'./conversation-state.mjs';

type Value={answers?:Record<string,ProductAnswer>;draft:string;choice:string;extra:string};
type Props={onVisualText?:(id:string,text:string)=>void;onVisualRemove?:(id:string)=>void;onVisualLocate?:(id:string)=>void;onVisualRelocate?:(id:string)=>void;editMode?:'modify'|'discuss';onModeChange?:(mode:'modify'|'discuss')=>void;baseVersion?:string;historical?:boolean;visualDraft?:VisualDraft|null;onVisual?:()=>void;visualDisabled?:boolean;onRemoveVisual?:()=>void;direct?:boolean;edits?:EditState|null;onStopEdit?:(edit:Edit)=>void;onRecapture?:(edit:Edit)=>void;project:Project|null;value:Value;busy:boolean;active:boolean;interviewRunning:boolean;ready:boolean;modelAvailable:boolean;scrollTop?:number;onPatch:(value:Partial<Value>)=>void;onScroll:(top:number)=>void;onSend:(text:string)=>void;onRetry:(text:string,operationId:string)=>void;onHistory:()=>void;onConfigure:()=>void;onCapabilities:()=>void};
export function MessageText({text}:{text:string}){
 return <>{conversationParagraphs(text).map((runs,i)=><p key={i}>{runs.map((run,j)=>run.bold?<strong key={j}>{run.text}</strong>:run.text)}</p>)}</>;
}
export function Conversation({onVisualText,onVisualRemove,onVisualLocate,onVisualRelocate,editMode='modify',onModeChange,baseVersion,historical=false,visualDraft=null,onVisual,visualDisabled=false,onRemoveVisual,direct=false,edits,onStopEdit,onRecapture,project,value,busy,active,interviewRunning,ready,modelAvailable,scrollTop,onPatch,onScroll,onSend,onRetry,onHistory,onConfigure,onCapabilities}:Props){
 const scroller=useRef<HTMLDivElement|null>(null),latest=useRef<HTMLElement|null>(null),follow=useRef(true),opened=useRef<string|null>(null);
 const[away,setAway]=useState(false);
 const input=useRef<HTMLTextAreaElement|null>(null);

 const running=activeEdit(edits) as Edit|null,waiting=waitingEdit(edits) as Edit|null;
 const originalMessages=conversationMessages(project) as (Project['messages'][number]&{author?:string})[];
 const messages=direct&&waiting?.question?[...originalMessages,{id:'question-'+waiting.id,role:'assistant',text:'',question:waiting.question,options:waiting.question.options}]:originalMessages;
 const last=messages.at(-1),question=last?.role==='assistant'?last.question:null;
 const questions=direct?[]:productQuestions(project,last);
 const batch=questionAnswers(questions,value.answers||{},value.draft||value.extra);
 const options=interviewChoices(direct?waiting?.question?.options||[]:pendingConversationOptions(project,last));
 const single=conversationInput(value,options.map(option=>option.value));
 const {choice:selected}=single,inputValue=questions.length?value.draft||value.extra:single.text,answer=questions.length?batch.text:single.answer;
 useLayoutEffect(()=>{const node=input.current;if(!node)return;
  const fit=()=>{if(!node.clientWidth)return;node.style.height='0px';node.style.height=Math.min(144,Math.max(46,node.scrollHeight+2))+'px'};
  fit();let width=node.clientWidth;const observer=new ResizeObserver(()=>{if(node.clientWidth!==width){width=node.clientWidth;fit()}});observer.observe(node);return()=>observer.disconnect();
 },[inputValue,project?.id,options.length]);
 const prepared=project?.preparation,stream=direct?running?.stream:prepared?.interview.stream;
 function jump(){const node=scroller.current;if(!node)return;follow.current=true;setAway(false);node.scrollTop=latest.current?node.scrollTop+latest.current.getBoundingClientRect().top-node.getBoundingClientRect().top-24:node.scrollHeight;onScroll(node.scrollTop)}
 useLayoutEffect(()=>{
  const node=scroller.current;if(!node||!node.clientHeight)return;
  const id=project?.id||'new';
  if(opened.current!==id){opened.current=id;if(scrollTop!=null){node.scrollTop=scrollTop;follow.current=conversationFollows(node.scrollTop,node.scrollHeight,node.clientHeight);setAway(!follow.current)}else jump();return}
  if(follow.current)jump();
 },[project?.id,last?.id]);
 useLayoutEffect(()=>{const node=scroller.current;if(node?.clientHeight&&(interviewRunning||direct&&active)&&follow.current)node.scrollTop=node.scrollHeight},[stream,interviewRunning,direct,active]);
 function send(){if((!answer.trim()&&!staged)||!visualReady||busy||questions.length&&!batch.canSend)return;follow.current=true;setAway(false);onSend(answer)}
 const staged=direct&&!waiting?visualDraft:null,queued=edits?.items.filter(e=>e.state==='queued').length||0;
 const visualReady=!staged||visualReviewReady(staged.regions,Boolean(staged.retry))&&staged.regions.every(r=>r.state==='ready'&&!r.stale);
 const disabled=busy||!ready,hasRequest=Boolean(answer.trim()||staged);
 return <section className="studio-conversation">
  <header><div><h2>对话</h2><span className="conversation-status" role="status">{direct?editLabels[(running||waiting||edits?.items.at(-1))?.state||'']||'直接修改，完成后查看新版':conversationStatus(prepared)}</span></div><div className="conversation-tools"><button onClick={jump} title="回到最新一轮对话">最新消息<Icon name="arrow" size={13}/></button>{prepared&&<details className="conversation-context"><summary>{prepared.references.length} 份资料</summary><div><p>所选资料只用于理解需求，应用权限单独确认。</p><button onClick={onCapabilities}>查看资料与能力</button></div></details>}<button onClick={onHistory} title="当前项目的完整对话历史">历史对话</button></div></header>
  <div className="studio-messages" ref={scroller} onScroll={e=>{const n=e.currentTarget;follow.current=conversationFollows(n.scrollTop,n.scrollHeight,n.clientHeight);setAway(!follow.current);onScroll(n.scrollTop)}} aria-label="需求对话记录">
   {!project?<div className="studio-welcome"><span className="eyebrow">从你熟悉的工作开始</span><h1>你想解决什么问题？</h1><p>讲一次实际经历就好。我们一起把想法聊清楚，逐步整理成完整方案。</p></div>:messages.map(m=><article className={'studio-message '+m.role} key={m.id} ref={m.id===last?.id?latest:null}>
    <small>{m.role==='user'?'你':m.author|| (direct?'AI 构建助手':prepared?.phase==='intake'?'任务助手':prepared?'AI 产品经理':'万象需求助手')}</small>
    <MessageText text={m.error?errorText(new Error(m.error)):m.text}/>
    {m.role==='user'&&direct&&editDelivery(edits,m)&&(()=>{const e=editDelivery(edits,m) as Edit;return <div className={'message-delivery '+e.state} role="status">{editLabels[e.state]||e.state}{e.error&&<span> · {errorText(new Error(e.error))}</span>}{e.state==='queued'&&<button disabled={busy} onClick={()=>onStopEdit?.(e)}>取消排队</button>}{['failed','interrupted','cancelled'].includes(e.state)&&<button disabled={busy||e.error==='VISUAL_REVIEW_STALE'&&active} onClick={()=>e.error==='VISUAL_REVIEW_STALE'?onRecapture?.(e):onRetry(m.text,e.operationId)}>{e.error==='VISUAL_REVIEW_STALE'?'重新标记并继续':'原地重试'}</button>}</div>})()}
    {m.role==='user'&&!direct&&turnStatus(project,m)&&<div className={'message-delivery '+turnStatus(project,m).state} role="status">{({queued:active?'已接收 · 等待当前工作结束':'已接收 · 等待整理',paused:'已保存 · 等待继续处理',running:'正在整理',completed:'已处理',failed:'本轮未完成 · 原话已保留'} as Record<string,string>)[turnStatus(project,m).state]}{['paused','failed','queued'].includes(turnStatus(project,m).state)&&!active&&<button disabled={busy} onClick={()=>onRetry(m.text,turnStatus(project,m).operationId)}>继续处理</button>}</div>}
    {m.question&&m.id!==last?.id&&!m.text.includes(m.question.text)&&<details className="conversation-previous-question"><summary>当时的问题</summary><p>{m.question.text}</p></details>}
    {m.ideas?.map(idea=><details key={idea.title}><summary>建议：{idea.title}</summary><p>{idea.description}</p><p>取舍：{idea.tradeoff}</p><button disabled={busy||last?.id!==m.id} onClick={()=>onPatch({draft:'希望采用：'+idea.title+'。'+idea.description,choice:'other',extra:'希望采用：'+idea.title+'。'+idea.description})}>补充到回答</button></details>)}
    {m.id===last?.id&&questions.length>0&&<QuestionBatch questions={questions} answers={value.answers} disabled={busy} onChange={answers=>onPatch({answers})}/>}
    {m.id===last?.id&&!questions.length&&options.length>0&&<section className="conversation-answer" aria-label={question?.text||'本轮回答'}>
     <div className="conversation-answer-heading"><span>请你选择</span>{question&&<h3>{question.text}</h3>}</div>
     {question?.why&&<p className="conversation-choice-why">{question.why}</p>}
     <div className="studio-options" role="radiogroup" aria-label={question?.text||'访谈回答'}>{options.map(({value:option,label,description,recommended},i)=><button role="radio" aria-checked={selected===option} className={selected===option?'selected':''} key={option} disabled={busy} onClick={()=>onPatch({choice:option})}><span>{i+1}</span><span className="conversation-option-label"><span className="conversation-option-title">{label}{recommended&&<em className="conversation-recommended">推荐</em>}</span>{description&&option!=='other'&&<span className="conversation-option-description">{description}</span>}</span>{selected===option&&<Icon name="check" size={16}/>}</button>)}</div>
    </section>}
   </article>)}
   {(interviewRunning||direct&&running?.state==='preparing')&&stream&&<article className="studio-message assistant streaming"><small>{direct?'AI 构建助手':'AI 产品经理'}</small><MessageText text={stream}/></article>}
  </div>
  {away&&!questions.length&&<button className="conversation-jump" onClick={jump}>回到最新对话 ↓</button>}
  <div className="studio-composer compact">
   {(busy||interviewRunning||direct&&active)&&<div className="conversation-activity" role="status" aria-live="polite" aria-atomic="true">
    <span className="conversation-activity-spinner" aria-hidden="true"/>
    <div><strong>{direct&&running?editLabels[running.state]:interviewRunning?'AI 正在回复与整理':'正在发送，请稍候'}</strong><small>{direct?'可以继续发送修改，将按顺序接续处理。':interviewRunning?'可以继续输入补充，发送后会接续处理。':'你的输入会保留在当前对话中。'}</small></div>
    {direct&&running&&<button disabled={busy} onClick={()=>onStopEdit?.(running)}>停止本轮</button>}<span className="conversation-activity-track" aria-hidden="true"><span/></span>
   </div>}
   {direct&&<div className="iteration-composer-tools"><div className="iteration-mode" role="group" aria-label="本轮处理方式"><button disabled={busy||Boolean(waiting)||Boolean(staged?.retry)} aria-pressed={editMode!=='discuss'} onClick={()=>onModeChange?.('modify')}>直接修改</button><button disabled={busy||Boolean(waiting)||Boolean(staged?.retry)} aria-pressed={editMode==='discuss'} onClick={()=>onModeChange?.('discuss')}>先讨论</button></div><button className="iteration-visual-trigger" disabled={visualDisabled||!ready} title={active?'当前修改完成后可继续圈选':'圈出多个位置，逐处填写后一次发送'} onClick={onVisual}><Icon name="edit" size={13}/>标记修改</button>{baseVersion&&<span className="iteration-base">{historical?'历史版本 · ':''}v{baseVersion}</span>}</div>}
   {direct&&queued>0&&<div className="iteration-queue" role="status"><Icon name="clock" size={12}/>{queued} 条修改等待接续 · 可在对应消息中取消</div>}
   {visualDraft&&<section className="conversation-mark-list" aria-label="待发送的修改清单"><header><strong>{visualDraft.regions.length} 处修改 <small>v{visualDraft.version}</small></strong><button disabled={busy} onClick={onRemoveVisual}>清空</button></header><ol>{visualDraft.regions.map((r,i)=><li key={r.id||i} className={r.stale?'stale':''}><div><button className="mark-locate" disabled={visualDisabled} title="定位此标记" onClick={()=>onVisualLocate?.(r.id)}><b>{i+1}</b><span>{r.label||'选中区域'}</span></button><button disabled={busy} onClick={()=>onVisualRemove?.(r.id)} aria-label={'删除标记 '+(i+1)}>×</button></div><textarea rows={1} maxLength={800} aria-label={'标记 '+(i+1)+' 的修改要求'} value={r.instruction} readOnly={Boolean(visualDraft.retry)} disabled={busy} onChange={e=>onVisualText?.(r.id,e.target.value)} placeholder="写一句修改要求…"/>{r.state==='capturing'?<small role="status">正在记录位置…</small>:r.stale||r.state==='error'?<small>位置需要更新 <button disabled={visualDisabled} onClick={()=>onVisualRelocate?.(r.id)}>重新定位</button></small>:r.otherPage?<small>其他页面的标记已保留</small>:null}</li>)}</ol>{!visualReady&&<small className="mark-list-hint">请补齐每处要求，并重新定位失效的标记。</small>}{waiting&&<small>先回答当前问题，修改清单会继续保留。</small>}</section>}
   <div className="conversation-input-row"><textarea ref={input} rows={1} aria-label={questions.length?'补充本轮选择':options.length?'补充回答':'描述需求'} placeholder={staged?.retry?'发送后按原要求接续修改；移除附件后可提出新要求':staged?'还可以补充整体要求，也可直接发送全部标记修改…':direct&&editMode==='discuss'&&!waiting?'说说想讨论的问题，AI 先给建议，不会修改应用…':questions.length?'可以补充整轮想法，也可以先发送还没决定的问题…':options.length?selected&&selected!=='other'?'已选择上方选项；也可以输入不同的想法…':'选择上方选项，或在这里补充你的想法…':direct?active?'可以继续发送，当前修改完成后接续处理…':'说说想改哪里，发送后直接修改…':active?'随时补充或修改，发送后会接续处理…':'继续说说你的想法或修改…'} disabled={busy||!ready||Boolean(staged?.retry)} value={inputValue} onChange={e=>onPatch(questions.length?{draft:e.target.value,extra:'',choice:''}:options.length?{extra:e.target.value,choice:'other',draft:''}:{draft:e.target.value,choice:'',extra:''})} onKeyDown={e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!e.nativeEvent.isComposing){e.preventDefault();send()}}}/><button className="primary" disabled={disabled||!hasRequest||!visualReady||Boolean(questions.length&&!batch.canSend)||(!direct&&!modelAvailable&&!prepared)} onClick={send}>{busy?'发送中':staged?.retry?'继续原修改':staged?editMode==='discuss'?'讨论圈选方案':'发送 '+staged.regions.length+' 处修改':direct&&editMode==='discuss'&&!waiting?'发送讨论':questions.length?'确认本轮选择':options.length?'确认回答':'发送'}<Icon name="arrow" size={15}/></button></div><footer><small>{questions.length?`已回答 ${batch.answered} / ${batch.total} · 推荐不会自动采纳`:direct?staged?'圈选与文字会作为一轮处理 · 上一版保留':editMode==='discuss'&&!waiting?'只讨论方案，不修改应用 · ⌘ / Ctrl Enter 发送':active?'修改已排队接续处理，旧版仍可试用':options.length?'选择或补充后将接续本轮修改':'发送后直接修改 · 新旧版本均保留':interviewRunning?'补充会在本轮整理结束后接续处理':active?'修改将接续整理，核对方案后再开始制作':options.length?'选中后不会自动发送 · ⌘ / Ctrl Enter 确认':'⌘ / Ctrl Enter 发送 · 产品方案随对话整理'}</small>{!direct&&!modelAvailable&&!prepared&&ready&&<button onClick={onConfigure}>配置需求模型</button>}</footer></div>
 </section>;
}

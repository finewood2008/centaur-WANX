import {useEffect,useRef,useState} from 'react';
import {api,errorText,type Task} from './api';
import {Icon} from './icons';
import './process.css';
import {NativeTerminal,type TerminalChunk} from './native-terminal';

type Event={seq:number;type:string;text?:string;at:number;status?:string;path?:string;oldText?:string;newText?:string;[key:string]:unknown};
const clock=(at:number)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(at*1000));
export function DevelopmentProcess({projectId,tasks,selectedTaskId}:{projectId:string;tasks:Task[];selectedTaskId?:string}){
  const[selected,setSelected]=useState(''),[events,setEvents]=useState<Event[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const task=tasks.find(t=>t.id===(selectedTaskId||selected))||tasks.at(-1),active=task&&['running','queued','waiting'].includes(task.state);
  const activeRef=useRef(active),refresh=useRef<null|(()=>Promise<void>)>(null);activeRef.current=active;
  const terminalInfo=events.find(event=>event.type==='terminal_info');
  const startupEndSeq=events.find(event=>event.type==='status'&&event.text==='Codex 正在依据冻结方案自主开发')?.seq;
  const terminalChunks=events.filter(event=>event.type==='terminal').map(event=>({seq:event.seq,data:String(event.data),at:event.at})) as TerminalChunk[];
  const displayEvents=events.filter(event=>!event.type.startsWith('terminal')).reduce<Event[]>((result,event)=>{
    const previous=result.at(-1);
    if(previous?.type==='message'&&event.type==='message')result[result.length-1]={...previous,text:(previous.text||'')+(event.text||'')};
    else result.push({...event});
    return result;
  },[]);
  useEffect(()=>setSelected(''),[projectId]);
  useEffect(()=>{
    setEvents([]);setError('');setLoading(Boolean(task));if(!task)return;
    let disposed=false,pending=false,again=false,cursor=0,all:Event[]=[];
    const read=async()=>{if(disposed)return;if(pending){again=true;return}pending=true;try{
      let more=true;
      while(more&&!disposed){
        const page=await api<{items:Event[];nextCursor:number;hasMore:boolean}>(`/projects/${projectId}/tasks/${task.id}/events?after=${cursor}&limit=25`);
        if(disposed)return;setError('');all=[...all,...page.items];cursor=page.nextCursor;more=page.hasMore;setEvents(all);
      }
    }catch(e){if(!disposed)setError(errorText(e))}finally{pending=false;if(!disposed)setLoading(false);if(again&&!disposed){again=false;void read()}}};
    refresh.current=read;void read();const timer=setInterval(()=>{if(activeRef.current)void read()},1500);
    return()=>{disposed=true;clearInterval(timer);if(refresh.current===read)refresh.current=null};
  },[projectId,task?.id]);
  // A completed task needs one final read, not a new terminal or cleared scrollback.
  useEffect(()=>{if(!active)void refresh.current?.()},[Boolean(active)]);
  return <section className="development-process">
    <header className="process-heading"><div><Icon name="code" size={21}/><h2>产品制作过程</h2></div>{tasks.length>0&&!selectedTaskId&&<select aria-label="查看哪次开发记录" value={task?.id||''} onChange={e=>setSelected(e.target.value)}>{[...tasks].reverse().map((t,i)=><option value={t.id} key={t.id}>{t.executor} · 第 {tasks.length-i} 次开发</option>)}</select>}</header>
    {!terminalInfo&&<p className="process-readonly"><Icon name="shield" size={16}/>开发由 {task?.executor||'Codex'} 自动完成。你可以查看全部过程，完成后试用并提出修改。</p>}
    {error&&<p className="inline-error">{error}</p>}
    {!task?<div className="process-empty"><Icon name="code" size={34}/><h3>确认方案后，开始开发</h3><p>这里会显示实际制作进展。成果准备好后，你可以先试用，再决定是否采用。</p></div>:<>
      <div className="process-state"><span className={'status-dot '+(active?'building':task.state==='completed'?'installed':'discovery')}/><strong>{active?'正在开发':task.state==='completed'?'成果已生成':'本轮已结束'}</strong><span>{task.executor} · {displayEvents.length} 条过程记录</span></div>
      {active&&<div className="process-next-step"><strong>{task.state==='waiting'?'需要你补充信息':'制作正在进行中'}</strong><p>{task.state==='waiting'?'请查看本次问题并补充，已有方案和制作记录会保留。':'你可以查看方案或详细进展；成果准备好后，再按真实工作场景试用。'}</p>{displayEvents.filter(e=>e.type==='plan').at(-1)?.entries instanceof Array&&<ul>{(displayEvents.filter(e=>e.type==='plan').at(-1)!.entries as {content:string;status:string}[]).map((entry,i)=><li key={i}><span>{entry.status==='completed'?'✓':entry.status==='in_progress'?'进行中':'待进行'}</span>{entry.content}</li>)}</ul>}</div>}
      {terminalInfo?<details className="process-terminal-disclosure"><summary>查看详细制作过程（只读）</summary><NativeTerminal key={task.id} chunks={terminalChunks} columns={Number(terminalInfo.cols)||96} rows={Number(terminalInfo.rows)||32} active={Boolean(active)} startupEndSeq={startupEndSeq}/></details>:<p className="process-legacy">{task.state==='queued'?'正在检查开发环境，检查通过后会自动开始开发…':active?'正在连接同一任务的原版 Codex CLI…':'这次历史任务仅保留 ACP 记录，没有原始终端画面。'}</p>}
      <details className="process-protocol"><summary>开发事件与源码修改 · {displayEvents.length} 条</summary>
      <ol className="process-timeline">{displayEvents.map(event=><li key={event.seq} className={'process-event '+event.type}>
        <div className="process-event-heading"><time>{clock(event.at)}</time><strong>{event.text||'开发进展'}</strong>{event.status&&<span>{({pending:'准备执行',in_progress:'执行中',completed:'已完成',failed:'未完成'} as Record<string,string>)[event.status]||event.status}</span>}</div>
        {event.type==='message'?<p className="process-message">{event.text}</p>:null}
        {event.type==='plan'&&Array.isArray(event.entries)?<ul className="process-plan">{event.entries.map((entry:any,i:number)=><li key={i}><span>{entry.status==='completed'?'✓':entry.status==='in_progress'?'◉':'○'}</span>{entry.content}</li>)}</ul>:null}
        {event.type==='file'?<details className="process-detail"><summary>{event.path} · 查看源码修改</summary><div className="source-diff"><section><span>修改前</span><pre>{event.oldText||'新文件'}</pre></section><section><span>修改后</span><pre>{event.newText}</pre></section></div></details>:null}
        {['activity','validation','policy','requires_plan'].includes(event.type)?<details className="process-detail"><summary>查看执行详情</summary><pre>{JSON.stringify(Object.fromEntries(Object.entries(event).filter(([k])=>!['seq','at','type'].includes(k))),null,2)}</pre></details>:null}
      </li>)}</ol></details>{!events.length&&<p className="process-waiting">{loading?'正在读取开发记录…':active?'等待真实开发事件…':'此制作记录没有保留详细过程。'}</p>}
      {task.error&&<p className="inline-error">{errorText(new Error(task.error))}</p>}
    </>}
  </section>;
}

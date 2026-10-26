import{forwardRef,useEffect,useImperativeHandle,useMemo,useRef,useState,type ReactNode}from'react';
import{errorText,operationId}from'./api';
import type{AnnotationController,AnnotationMode,AnnotationSurface}from'./runtime';
import{paintReview}from'./visual-review-image';
import{visualReviewReady,invalidateVisualTargets}from'./visual-review-state.mjs';
import'./visual-review.css';

export type Region={x:number;y:number;width:number;height:number};
export type AnnotatedRegion=Region&{instruction:string;pageId?:string;label?:string};
export type Capture={image:string;width:number;height:number;viewport:{width:number;height:number}};
export type CapturePage=Capture&{id:string};
export type LiveMark=AnnotatedRegion&{id:string;targetId:string;kind:'element'|'box';state:'capturing'|'ready'|'error';stale?:boolean;otherPage?:boolean};
export type VisualDraft={id:string;baseHash:string;version:string;expectedRevision:number;capture?:Capture;image?:string;regions:LiveMark[];pages:CapturePage[];retry?:{id:string;text:string}};
export type VisualReviewHandle={prepare:()=>Promise<VisualDraft>;text:(id:string,text:string)=>void;remove:(id:string)=>void;locate:(id:string)=>void;relocate:(id:string)=>void;clear:()=>void};
type Props={children:(annotation:AnnotationSurface)=>ReactNode;version:string;baseHash:string;revision:number;openRequest:string;draft:VisualDraft|null;disabled:boolean;onSave:(draft:VisualDraft|null)=>void;onOpenChange?:(open:boolean)=>void;recapture?:{id:string;text:string}};
const emptyRect={x:0,y:0,width:.01,height:.01};
export const VisualReview=forwardRef<VisualReviewHandle,Props>(function VisualReview({children,version,baseHash,revision,openRequest,draft,disabled,onSave,onOpenChange,recapture},ref){
 const root=useRef<HTMLDivElement>(null),controller=useRef<AnnotationController|null>(null),value=useRef(draft),latest=useRef({revision,disabled,onSave,onOpenChange}),generation=useRef(0),captures=useRef(new Set<Promise<void>>()),retry=useRef<VisualDraft['retry']>(undefined),replacing=useRef(''),modeRef=useRef<AnnotationMode>('off'),input=useRef<HTMLTextAreaElement>(null),actions=useRef<any>(null);
 value.current=draft;latest.current={revision,disabled,onSave,onOpenChange};
 const[mode,setModeValue]=useState<AnnotationMode>('off'),[selected,setSelected]=useState(''),[positions,setPositions]=useState<Record<string,Region|null>>({}),[error,setError]=useState('');
 function setMode(next:AnnotationMode){modeRef.current=next;setModeValue(next);controller.current?.mode(next);latest.current.onOpenChange?.(next!=='off');if(next==='off')setSelected('')}
 function commit(regions:LiveMark[],pages=value.current?.pages||[]){const used=pages.filter(p=>regions.some(r=>r.pageId===p.id));const next=regions.length?{id:operationId(),baseHash,version,expectedRevision:latest.current.revision,regions,pages:used,...((value.current?.retry||retry.current)?{retry:value.current?.retry||retry.current}:{})}:null;value.current=next;latest.current.onSave(next);controller.current?.sync(regions.map((r,i)=>({id:r.targetId,number:i+1})));return next}
 function clear(){generation.current++;replacing.current='';retry.current=undefined;for(const r of value.current?.regions||[])controller.current?.remove(r.targetId);commit([]);setMode('off');setError('')}
 async function locate(id:string){const r=value.current?.regions.find(r=>r.id===id);if(!r||!controller.current)return;try{const p=await controller.current.locate(r.targetId);setMode('point');setSelected(id);setPositions(v=>({...v,[r.targetId]:p.rect}));setError('')}catch{setError('请先回到对应页面，或点击该条目的“重新定位”。修改要求已保留。')}}
 function relocate(id:string){if(latest.current.disabled)return;const mark=value.current?.regions.find(r=>r.id===id);if(!mark)return;controller.current?.remove(mark.targetId);replacing.current=id;setSelected(id);setMode('point');setError('请在预览中重新点选这条要求对应的位置。')}
 function editText(id:string,text:string){if(latest.current.disabled||value.current?.retry)return;commit((value.current?.regions||[]).map(r=>r.id===id?{...r,instruction:text.slice(0,800)}:r))}
 function remove(id:string){if(latest.current.disabled)return;const r=value.current?.regions.find(r=>r.id===id);if(r)controller.current?.remove(r.targetId);commit((value.current?.regions||[]).filter(r=>r.id!==id));if(selected===id)setSelected('')}
 function receive(event:any){
  if(event.event==='mode'&&event.mode==='off'){setMode('off');return}
  if(event.event==='notice'){setError(String(event.message||'').slice(0,160));return}
  if(event.event==='positions'&&Array.isArray(event.positions)){
   const list=event.positions.filter((p:any)=>typeof p.id==='string'&&(!p.rect||['x','y','width','height'].every(k=>Number.isFinite(p.rect[k]))));setPositions(Object.fromEntries(list.map((p:any)=>[p.id,p.rect])));
   const before=value.current;if(before){let changed=false;const marks=before.regions.map(r=>{const p=list.find((p:any)=>p.id===r.targetId);if(!p)return r;const stale=p.state==='stale',otherPage=p.state==='other-page';if(Boolean(r.stale)!==stale||Boolean(r.otherPage)!==otherPage){changed=true;return{...r,stale,otherPage}}return r});if(changed)commit(marks)}return;
  }
  if(event.event!=='selected'||modeRef.current==='off'||latest.current.disabled||!controller.current)return;
  if(typeof event.id!=='string'||event.id.length>80||!event.rect||!['x','y','width','height'].every(k=>Number.isFinite(event.rect[k]))||event.rect.width<=0||event.rect.height<=0)return;
  const previous=value.current?.regions||[],old=previous.find(r=>r.targetId===event.id);
  if(old&&!replacing.current){setSelected(old.id);return}
  if(old&&replacing.current&&old.id!==replacing.current){setError('该位置已有标记，请选择另一位置。');return}
  if(previous.length>=6&&!replacing.current){setError('本轮最多标记 6 处，可先编辑或发送。');return}
  const replacingMark=previous.find(r=>r.id===replacing.current),id=replacingMark?.id||operationId(),label=String(event.label||'选中区域').slice(0,100);
  const mark:LiveMark={...emptyRect,id,targetId:event.id,kind:event.kind==='box'?'box':'element',label,instruction:replacingMark?.instruction||retry.current?.text||'',state:'capturing'};
  if(replacingMark&&replacingMark.targetId!==event.id)controller.current.remove(replacingMark.targetId);
  replacing.current='';commit(replacingMark?previous.map(r=>r.id===id?mark:r):[...previous,mark]);setSelected(id);setError('');setPositions(v=>({...v,[event.id]:event.rect}));
  const turn=generation.current,bridge=controller.current;
  const work=(async()=>{try{const captured=await bridge.capture(event.id);if(turn!==generation.current||controller.current!==bridge)return;const current=value.current;if(!current?.regions.some(r=>r.id===id&&r.targetId===event.id))return;const page:CapturePage={...captured,id:operationId()};commit(current.regions.map(r=>r.id===id?{...r,...captured.region,pageId:page.id,state:'ready',stale:false}:r),[...current.pages,page])}catch(e){if(turn!==generation.current)return;commit((value.current?.regions||[]).map(r=>r.id===id?{...r,state:'error',stale:true}:r));setError(errorText(e))}})();captures.current.add(work);void work.finally(()=>captures.current.delete(work));
 }
 const receiver=useRef(receive);receiver.current=receive;
 const annotation=useMemo<AnnotationSurface>(()=>({onConnect:bridge=>{generation.current++;controller.current=bridge;if(bridge){if(value.current){const retained=invalidateVisualTargets(value.current);commit(retained.regions,[])}bridge.sync((value.current?.regions||[]).map((r,i)=>({id:r.targetId,number:i+1})));bridge.mode(modeRef.current)}},onEvent:event=>receiver.current(event)}),[]);
 async function prepare(){await Promise.all([...captures.current]);const d=value.current;if(!d||d.baseHash!==baseHash)throw Error('VISUAL_REVIEW_STALE');if(!visualReviewReady(d.regions,Boolean(d.retry))){setSelected(d.regions.find(r=>!r.instruction.trim())?.id||'');throw Error('VISUAL_NOTE_REQUIRED')}if(d.regions.some(r=>r.state!=='ready'||r.stale||!r.pageId)){setError('有标记需要重新定位，修改要求已保留。');throw Error('VISUAL_REVIEW_STALE')}setMode('off');const turn=generation.current,rendered=await paintReview(d.pages,d.regions);if(turn!==generation.current||value.current?.id!==d.id)throw Error('VISUAL_REVIEW_STALE');return{...d,...rendered,image:rendered.capture.image,regions:rendered.regions as LiveMark[]}}
 actions.current={prepare,text:editText,remove,locate,relocate,clear};
 useImperativeHandle(ref,()=>({prepare:()=>actions.current.prepare(),text:(id,text)=>actions.current.text(id,text),remove:id=>actions.current.remove(id),locate:id=>void actions.current.locate(id),relocate:id=>actions.current.relocate(id),clear:()=>actions.current.clear()}),[]);
 useEffect(()=>()=>{generation.current++},[]);
 useEffect(()=>{if(!openRequest||disabled)return;if(recapture)retry.current=recapture;setMode('point');setError('')},[openRequest]);
 useEffect(()=>{if(disabled)setMode('off')},[disabled]);
 useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&modeRef.current!=='off'){e.preventDefault();e.stopPropagation();setMode('off')}};window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true)},[]);
 useEffect(()=>{input.current?.focus({preventScroll:true})},[selected,draft?.regions.find(r=>r.id===selected)?.state]);
 const mark=draft?.regions.find(r=>r.id===selected),position=mark?positions[mark.targetId]:null,frame=root.current?.querySelector('iframe')?.getBoundingClientRect();
 const left=frame&&position?Math.max(frame.left+8,Math.min(innerWidth-286,frame.left+position.x+Math.min(position.width,160))):0,top=frame&&position?Math.max(frame.top+8,Math.min(innerHeight-170,frame.top+position.y+position.height+8)):0;
 return <div className="visual-preview live-annotation-preview" ref={root}>
 {mode!=='off'&&<div className="annotation-toolbar"><span>标记中 · 滚轮照常滚动</span><div><button aria-pressed={mode==='point'} onClick={()=>setMode('point')}>点选</button><button aria-pressed={mode==='box'} onClick={()=>setMode('box')}>拖框</button><button onClick={()=>setMode('off')}>完成</button></div><small>Esc 恢复操作 · 已标记 {draft?.regions.length||0} / 6</small></div>}
 {error&&<div className="annotation-notice" role="status">{error}<button onClick={()=>setError('')}>关闭</button></div>}
 {children(annotation)}
 {mode!=='off'&&mark&&position&&mark.state!=='capturing'&&position.y+position.height>0&&position.y<(frame?.height||0)&&<div className="annotation-popover" style={{left,top}} aria-label={'标记 '+((draft?.regions.indexOf(mark)||0)+1)+' 的要求'}><header><strong>{(draft?.regions.indexOf(mark)||0)+1} · {mark.label||'选中区域'}</strong><button aria-label="收起标记输入" onClick={()=>setSelected('')}>×</button></header><textarea ref={input} rows={2} maxLength={800} aria-label="修改要求" placeholder="写一句修改要求，自动保留在左侧…" readOnly={Boolean(draft?.retry)} value={mark.instruction} onChange={e=>editText(mark.id,e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();setSelected('')}}}/><small>自动汇总到左侧 · 可继续点选其他位置</small></div>}
 </div>;
});

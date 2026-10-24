import{useEffect,useRef,useState,type ReactNode}from'react';
import{errorText,operationId}from'./api';
import{useDialogFocus}from'./dialog-focus';
import{selectionBox}from'./visual-review-state.mjs';
import'./visual-review.css';

export type Region={x:number;y:number;width:number;height:number};
export type VisualFeedback={operationId:string;image:string;viewport:{width:number;height:number};regions:Region[];instruction:string};
type Capture={image:string;width:number;height:number;viewport:{width:number;height:number}};
export function VisualReview({children,version,disabled,onSubmit,onOpenChange,recapture}:{children:ReactNode;version:string;disabled:boolean;onSubmit:(feedback:VisualFeedback)=>Promise<void>;onOpenChange?:(open:boolean)=>void;recapture?:{id:string;text:string}}){
 const root=useRef<HTMLDivElement>(null),picture=useRef<HTMLImageElement>(null),drag=useRef<{x:number;y:number}|null>(null),request=useRef('');
 const[capture,setCapture]=useState<Capture|null>(null),[regions,setRegions]=useState<Region[]>([]),[drawing,setDrawing]=useState<Region|null>(null),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useDialogFocus(capture?'visual-review':'');
 function close(){if(!busy){setCapture(null);onOpenChange?.(false);setError('');drag.current=null;setDrawing(null)}}
 async function begin(){setError('');setBusy(true);try{
  const frame=root.current?.querySelector('iframe');if(!frame||frame.dataset.ready!=='true')throw Error('PREVIEW_NOT_READY');
  if(!window.wanxStudio?.capturePreview)throw Error('HOST_BRIDGE_UPDATE_REQUIRED');
  const b=frame.getBoundingClientRect(),x=Math.max(0,Math.ceil(b.left)),y=Math.max(0,Math.ceil(b.top));
  const next=await window.wanxStudio.capturePreview({x,y,width:Math.floor(Math.min(b.right,innerWidth))-x,height:Math.floor(Math.min(b.bottom,innerHeight))-y});
  setCapture(next);onOpenChange?.(true);setRegions([]);setDrawing(null);setText(recapture?.text||'');request.current=operationId();
 }catch(e){setError(errorText(e))}finally{setBusy(false)}}
 useEffect(()=>{if(recapture&&!disabled)void begin()},[recapture?.id]);
 async function submit(){if(!capture||!regions.length||!text.trim()||busy||disabled)return;setBusy(true);setError('');try{
  const canvas=document.createElement('canvas');canvas.width=capture.width;canvas.height=capture.height;const ctx=canvas.getContext('2d');if(!ctx||!picture.current)throw Error('PREVIEW_CAPTURE_FAILED');
  ctx.drawImage(picture.current,0,0,canvas.width,canvas.height);ctx.lineWidth=3;ctx.strokeStyle='#b94d2b';ctx.font='bold 18px sans-serif';
  regions.forEach((r,i)=>{const x=r.x*canvas.width,y=r.y*canvas.height;ctx.strokeRect(x,y,r.width*canvas.width,r.height*canvas.height);ctx.fillStyle='#b94d2b';ctx.fillRect(x,y,26,26);ctx.fillStyle='#fff';ctx.fillText(String(i+1),x+7,y+20)});
  await onSubmit({operationId:request.current,image:canvas.toDataURL('image/png'),viewport:capture.viewport,regions,instruction:text.trim()});setCapture(null);onOpenChange?.(false);setText('');
 }catch(e){setError(errorText(e))}finally{setBusy(false)}}
 return <div className="visual-preview" ref={root}><div className="visual-preview-tools"><span>拖框圈出位置，写一句要求即可修改</span><button disabled={disabled||busy} onClick={()=>void begin()}>{busy&&!capture?'正在截取…':'圈选修改'}</button></div>{error&&!capture&&<p role="alert" className="inline-error">{error}</p>}{children}
 {capture&&<div className="visual-review-shade" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close()}}}><section role="dialog" aria-modal="true" aria-label="圈选修改" className="visual-review-dialog"><header><div><strong>圈选修改 <small>v{version}</small></strong><p>在截图上拖出方框，可圈选多个位置。</p></div><button disabled={busy} onClick={close}>取消</button></header>
 <div className="visual-review-scroll"><div className="visual-review-image" onPointerDown={e=>{if(busy||regions.length>=6||e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY};setDrawing(null)}} onPointerMove={e=>{if(!drag.current)return;setDrawing(selectionBox(drag.current,{x:e.clientX,y:e.clientY},e.currentTarget.getBoundingClientRect()))}} onPointerUp={e=>{if(!drag.current)return;const box=selectionBox(drag.current,{x:e.clientX,y:e.clientY},e.currentTarget.getBoundingClientRect());drag.current=null;setDrawing(null);if(box.width>=.01&&box.height>=.01){setRegions(v=>[...v,box]);request.current=operationId()}e.currentTarget.releasePointerCapture(e.pointerId)}} onPointerCancel={()=>{drag.current=null;setDrawing(null)}}>
 <img ref={picture} src={capture.image} alt="当前产品预览截图" draggable={false}/>{[...regions,...(drawing?[drawing]:[])].map((r,i)=><div key={i} className="visual-region" style={{left:r.x*100+'%',top:r.y*100+'%',width:r.width*100+'%',height:r.height*100+'%'}}><b>{i+1}</b></div>)}</div></div>
 <footer><div className="visual-review-count"><span>已圈选 {regions.length} 处 · 最多 6 处</span><button disabled={busy||!regions.length} onClick={()=>{setRegions(v=>v.slice(0,-1));request.current=operationId()}}>撤销上一处</button><button disabled={busy||!regions.length} onClick={()=>{setRegions([]);request.current=operationId()}}>重新圈选</button></div><label>修改要求<textarea autoFocus maxLength={2000} rows={2} readOnly={Boolean(recapture)} value={text} disabled={busy} onChange={e=>{setText(e.target.value);request.current=operationId()}} placeholder="例如：①标题缩小一点，②按钮放到右上角"/></label>{error&&<p className="inline-error" role="alert">{error}</p>}<div className="visual-review-actions"><small>将生成新版本，上一版和业务数据继续保留。</small><button className="primary" disabled={busy||disabled||!regions.length||!text.trim()} onClick={()=>void submit()}>{busy?'正在发送…':'发送并修改'}</button></div></footer></section></div>}</div>
}

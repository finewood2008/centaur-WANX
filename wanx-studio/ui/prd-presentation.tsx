import {useEffect,useMemo,useState} from 'react';
import type{Project}from'./api';
import{useDialogFocus}from'./dialog-focus';
import{prdDocumentHtml,embeddedPrdHtml}from'./prd-document.mjs';
import'./prd-presentation.css';

export function PrdPresentation({project,ready,busy=false,reason='',error='',contract=null,revisionToken='',onClose,onConfirm}:{project:Project;ready:boolean;busy?:boolean;reason?:string;error?:string;contract?:Record<string,unknown>|null;revisionToken?:string;onClose:()=>void;onConfirm:()=>void}){
 const html=useMemo(()=>prdDocumentHtml(project,{ready,contract}),[project,ready,contract]);
 const signature=revisionToken+html;
 const[ack,setAck]=useState('');
 useDialogFocus('complete-prd:'+project.id);
 useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!busy)onClose()};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close)},[onClose,busy]);
 function download(){const url=URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=project.name.replace(/[\\/:*?"<>|]/g,'_')+'-PRD.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 return <div className="prd-presentation-shade"><section className="prd-presentation" role="dialog" aria-modal="true" aria-label="完整产品需求说明书">
  <header><div><span>从共同选择，到完整的产品方案</span><h2>开发前，一起看完整份 PRD</h2></div><div><button onClick={download}>下载 HTML</button><button disabled={busy} onClick={onClose} aria-label="返回继续沟通">返回沟通</button></div></header>
  <iframe key={project.id} title="完整 PRD 文档" sandbox="" srcDoc={embeddedPrdHtml(html)}/>
  <footer><div><label><input type="checkbox" checked={ack===signature} disabled={busy||!ready} onChange={e=>setAck(e.target.checked?signature:'')}/>我已阅读当前这份完整 PRD，按此方案开发</label><small>{error||reason||(!ready?'当前仍有待确认内容，可返回继续沟通。':'确认后才启动开发；完成后仍先试用，再决定采用。')}</small></div><button className="primary" disabled={busy||!ready||Boolean(reason)||ack!==signature} onClick={()=>{if(ack===signature)onConfirm()}}>{busy?'正在启动开发…':'确认这份 PRD，开始开发'}</button></footer>
 </section></div>;
}

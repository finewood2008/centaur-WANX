import {useEffect,useRef,useState} from 'react';
import {api,errorText,operationId,type Project} from './api';
import {PrdPresentation} from './prd-presentation';
import {canReviewPrd} from './prd-reveal.mjs';

type Contract={collections:Record<string,Record<string,string>>;capabilities:string[];visibility:string};
type Proposal={specHash:string;impactHash:string;baseCheckpoint:string|null;contract:Contract|null;previousContract:Contract|null;needsContractConfirmation:boolean;ready:boolean;missing:string[]};

export function BuildReview({project,active,reason,onBuilt}:{project:Project;active:boolean;reason:string;onBuilt:(p:Project)=>void}){
  const [presenting,setPresenting]=useState(false);
  const projectKey=project.id+':'+project.updatedAt+':'+project.solutionHash;
  const [loadedKey,setLoadedKey]=useState('');
  const [proposal,setProposal]=useState<Proposal|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const requestId=useRef<{hash:string;id:string}|null>(null),sending=useRef(false);
  useEffect(()=>{let live=true;void api<Proposal>(`/_builder/projects/${project.id}/proposal`).then(p=>{if(live){setProposal(p);setLoadedKey(projectKey)}}).catch(e=>{if(live){setProposal(null);setError(errorText(e))}});return()=>{live=false}},[projectKey]);
  useEffect(()=>{setError('');requestId.current=null},[proposal?.impactHash]);
  async function start(){
    if(loadedKey!==projectKey||!proposal||sending.current||active||!proposal.ready||reason||proposal.specHash!==project.solutionHash)return;
    sending.current=true;setBusy(true);setError('');
    if(!requestId.current||requestId.current.hash!==proposal.impactHash)requestId.current={hash:proposal.impactHash,id:operationId()};
    try{const p=await api<Project>(`/_builder/projects/${project.id}/build`,'POST',{operationId:requestId.current.id,specHash:proposal.specHash,impactHash:proposal.impactHash,confirmedContract:false,instruction:''});requestId.current=null;setPresenting(false);onBuilt(p)}
    catch(e){setError(errorText(e))}finally{sending.current=false;setBusy(false)}
  }
  const prepared=loadedKey===projectKey&&!active&&Boolean(proposal?.ready)&&!reason&&proposal?.specHash===project.solutionHash;
  const disabled=busy||!prepared;
  useEffect(()=>{if(!project.artifacts.length&&!prepared)setPresenting(false)},[project.id,prepared]);
  const blockingReason=reason||(loadedKey!==projectKey?'正在核对当前方案…':proposal?.missing.length?'待确认：'+proposal.missing.join('；'):'');
  const first=!project.artifacts.length;
  if(first&&!canReviewPrd(project,{active,reason,proposalReady:prepared}))return <section className="prd-discovery-note" aria-label="PRD 正在共同完善"><strong>{active?'产品经理正在整理本轮反馈':'继续共同完善 PRD'}</strong><p>已确认的内容会持续写入上方文档。关键问题聊清、方案核对完整后，这里会出现完整 PRD 和开发确认入口。</p></section>;
  return <><section className={"build-review"+(first?" first-build-review":"")} aria-label="本次产品方案确认">
    <header><strong>{first?'先共同设计，再看完整 PRD':'这一轮准备好了'}</strong><span>{first?(proposal?.ready?'整稿待确认':'草稿持续完善'):'本轮方案'}</span></header>
    {first&&<p>{proposal?.ready?'方案已整理完整。展开流程图、页面草图和验收用例，由你确认后才开发。':'继续在左侧共同确定产品细节，也可以随时展开当前 PRD 草稿。'}</p>}
    {!!proposal?.missing.length&&<p role="status">还需明确：{proposal.missing.join('；')}。可以继续在左侧沟通。</p>}
    {reason&&<small>{reason}</small>}{error&&<p role="alert">{error}</p>}
    <div className="build-review-action"><small>构建完成后先试用；采用和上架另行决定。</small><button className="primary" disabled={disabled} onClick={()=>first?setPresenting(true):void start()}>{busy?'正在准备并启动…':first?'查看完整 PRD':'开始这一轮改进'}</button></div>
  </section>{presenting&&<PrdPresentation project={project} ready={prepared} busy={busy} reason={blockingReason} error={error} contract={proposal?.contract||null} revisionToken={projectKey+':'+(proposal?.impactHash||'')} onClose={()=>setPresenting(false)} onConfirm={()=>void start()}/>}</>;
}

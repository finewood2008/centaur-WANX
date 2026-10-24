import{useEffect,useMemo,useRef,useState}from'react';
import{api,operationId,type Project}from'./api';
import{activeEdit,waitingEdit}from'./direct-edit-state.mjs';
export type Edit={id:string;operationId:string;sourceOperations:string[];text:string;state:string;createdAt:number;taskIds:string[];question:null|{focus:string;text:string;why:string;options:string[]};questionHash?:string;stream:string;error?:string;artifactHash?:string;baseHash?:string;summary?:string};
export type EditState={enabled:boolean;project:Project;items:Edit[];revision:number};
type Visual={baseHash:string;expectedRevision:number;image:string;viewport:{width:number;height:number};regions:{x:number;y:number;width:number;height:number}[]};
export function useDirectEdits({project,enabled,scope,onProject,onError}:{project:Project|null;enabled:boolean;scope:string;onProject:(p:Project)=>void;onError:(e:unknown)=>void}){
 const[state,setState]=useState<EditState|null>(null);const p=useRef(project),value=useRef(state),generation=useRef(0),callbacks=useRef({onProject,onError});p.current=project;value.current=state;callbacks.current={onProject,onError};
 const id=project?.id||'',contextId=useMemo(()=>operationId(),[id,scope]);
 const base=`/_builder/projects/${id}/edits`;
 function accept(result:EditState,turn:number){if(turn!==generation.current||result.project.id!==p.current?.id)return;if(result.project.updatedAt<(p.current?.updatedAt||0))return;value.current=result;setState(result);callbacks.current.onProject(result.project)}
 async function read(){const turn=generation.current;const result=await api<EditState>(base+'?contextId='+contextId);accept(result,turn);return result}
 useEffect(()=>{const turn=++generation.current;setState(null);if(!enabled||!id)return;let stopped=false,pending=false;const poll=async()=>{if(stopped||pending)return;pending=true;try{const result=await api<EditState>(base+'?contextId='+contextId);if(!stopped)accept(result,turn)}catch(e){if(!stopped&&turn===generation.current)callbacks.current.onError(e)}finally{pending=false}};void poll();const timer=setInterval(()=>void poll(),1500);return()=>{stopped=true;generation.current++;clearInterval(timer)}},[id,scope,enabled,contextId]);
 async function action(edit:Edit,kind:'retry'|'stop',op:string=operationId(),visualReview?:Visual){const turn=generation.current;const result=await api<EditState>(base+'/'+edit.id+'/'+kind,'POST',{operationId:op,contextId,...(visualReview?{visualReview}:{})});accept(result,turn);return result}
 async function submit(text:string,op:string,baseHash:string,explicitBase=false,visualReview?:Visual){
  const turn=generation.current;let current=p.current;if(!current)throw Error('HOST_SESSION_EXPIRED');
  const known=value.current?.items.find(e=>e.sourceOperations.includes(op));if(known)return action(known,'retry');
  const waiting=waitingEdit(value.current) as Edit|null;
  if(waiting){const result=await api<EditState>(base+'/'+waiting.id+'/answer','POST',{operationId:op,text,questionHash:waiting.questionHash,contextId,...(visualReview?{visualReview}:{})});accept(result,turn);return result}
  let body={operationId:op,expectedRevision:current.versioning?.revision||0,baseHash,text,explicitBase,contextId,...(visualReview?{visualReview}:{})};
  let result:EditState;
  try{result=await api<EditState>(base,'POST',body)}catch(e){if(!(e instanceof Error)||!/\bVERSION_CHANGED\b/.test(e.message))throw e;const fresh=await read();if(turn!==generation.current)throw Error('HOST_SESSION_EXPIRED');body={...body,expectedRevision:fresh.revision};result=await api<EditState>(base,'POST',body)}
  accept(result,turn);return result;
 }
 return{state,submit,read,action,contextId,active:activeEdit(state) as Edit|null,waiting:waitingEdit(state) as Edit|null};
}

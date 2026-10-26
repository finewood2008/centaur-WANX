import{useEffect,useRef,useState}from'react';
import{frameDocument}from'../core/frame.mjs';
import{api,errorText}from'./api';
import{Icon}from'./icons';
import{createAnnotationChannel,previewMethodAllowed}from'./annotation-channel.mjs';
export type AnnotationMode='off'|'point'|'box';
export type AnnotationController={mode:(value:AnnotationMode)=>void;sync:(marks:{id:string;number:number}[])=>void;remove:(id:string)=>void;locate:(id:string)=>Promise<any>;capture:(id:string)=>Promise<{image:string;width:number;height:number;viewport:{width:number;height:number};region:{x:number;y:number;width:number;height:number}}>};
export type AnnotationSurface={onConnect:(controller:AnnotationController|null)=>void;onEvent:(event:any)=>void};
type FileEntry={id:string;name:string;kind:string;size:number};
export function Runtime({projectId,artifactHash,environment='preview',readOnly=false,onDirtyChange,annotation}:{projectId:string;artifactHash:string;environment?:string;readOnly?:boolean;onDirtyChange?:(dirty:boolean)=>void;annotation?:AnnotationSurface}){
  const annotationRef=useRef(annotation),marking=useRef(false),readonlyRef=useRef(readOnly),annotationChannel=useRef<ReturnType<typeof createAnnotationChannel>|null>(null);annotationRef.current=annotation;readonlyRef.current=readOnly;
  const dirtyCallback=useRef(onDirtyChange);dirtyCallback.current=onDirtyChange;
  const[doc,setDoc]=useState(''),[error,setError]=useState(''),[session,setSession]=useState(''),[picker,setPicker]=useState<{resolve:(v:unknown)=>void;reject:(e:Error)=>void}|null>(null),[entries,setEntries]=useState<FileEntry[]>([]),[chosen,setChosen]=useState<string[]>([]),[folder,setFolder]=useState('');
  const[loadError,setLoadError]=useState(''),[attempt,setAttempt]=useState(0);
  const[frameReady,setFrameReady]=useState(false);
  const frame=useRef<HTMLIFrameElement>(null),port=useRef<MessagePort|null>(null),pickerRef=useRef(picker);pickerRef.current=picker;
  useEffect(()=>{let active=true,token='';setDoc('');setError('');setLoadError('');setSession('');setFrameReady(false);
    dirtyCallback.current?.(false);
    api<{session:string;bundle:string;css:string}>(`/projects/${projectId}/runtime`,'POST',{artifactHash,environment}).then(r=>{token=r.session;if(active){setSession(token);setDoc(frameDocument(r.bundle,r.css))}else void api(`/runtime/${token}`,'DELETE').catch(()=>{})}).catch(e=>{if(active)setLoadError(errorText(e))});
    return()=>{active=false;annotationChannel.current?.dispose();annotationRef.current?.onConnect(null);port.current?.close();pickerRef.current?.reject(new Error('RUNTIME_SESSION_EXPIRED'));if(token)void api(`/runtime/${token}`,'DELETE').catch(()=>{})}
  },[projectId,artifactHash,environment,attempt]);
  async function listFiles(parent=''){const result=await api<{items:FileEntry[]}>(`/files?parent=${encodeURIComponent(parent)}`);setEntries(result.items);setFolder(parent)}
  function connect(){
    annotationChannel.current?.dispose();port.current?.close();const channel=new MessageChannel();port.current=channel.port1;let pending=0;
    const annotations=createAnnotationChannel(channel.port1,(event:any)=>{if(event.event==='mode')marking.current=event.mode!=='off';annotationRef.current?.onEvent(event)});annotationChannel.current=annotations;
    const controller:AnnotationController={mode:value=>{marking.current=value!=='off';annotations.command('mode',{mode:value})},sync:marks=>annotations.command('sync',{marks}),remove:id=>annotations.command('remove',{id}),locate:id=>annotations.request('locate',{id}),capture:async id=>{
      try{const prepared=await annotations.request('prepare',{id}) as {rect:{x:number;y:number;width:number;height:number};viewport:{width:number;height:number}};
       const node=frame.current;if(!node||!window.wanxStudio?.capturePreview)throw Error('PREVIEW_NOT_READY');
       const b=node.getBoundingClientRect(),x=Math.max(0,Math.ceil(b.left)),y=Math.max(0,Math.ceil(b.top)),width=Math.floor(Math.min(b.right,innerWidth))-x,height=Math.floor(Math.min(b.bottom,innerHeight))-y;
       const image=await window.wanxStudio.capturePreview({x,y,width,height});const valid=await annotations.request('validate',{id}) as {valid:boolean};if(!valid.valid)throw Error('VISUAL_REVIEW_STALE');
       const r=prepared.rect,sx=b.width/prepared.viewport.width,sy=b.height/prepared.viewport.height,left=Math.max(0,(b.left+r.x*sx-x)/width),top=Math.max(0,(b.top+r.y*sy-y)/height),right=Math.min(1,(b.left+(r.x+r.width)*sx-x)/width),bottom=Math.min(1,(b.top+(r.y+r.height)*sy-y)/height);
       if(right<=left||bottom<=top)throw Error('VISUAL_REVIEW_STALE');const rw=Math.max(.01,right-left),rh=Math.max(.01,bottom-top);
       return{...image,region:{x:Math.min(1-rw,left),y:Math.min(1-rh,top),width:rw,height:rh}};
      }finally{annotations.command('restore',{id})}
    }};
    channel.port1.onmessage=async({data:m})=>{if(annotations.receive(m))return;if(m?.type==='wanx:dirty'&&m.dirty===true){dirtyCallback.current?.(true);return}if(!m||!Number.isSafeInteger(m.id)||typeof m.method!=='string'||pending>=4)return;pending++;try{let result;
      if(!previewMethodAllowed(m.method,readonlyRef.current,marking.current))throw new Error(marking.current?'ANNOTATION_ACTIVE':'COMPARISON_READ_ONLY');
      if(m.method==='files.select'){await listFiles();setChosen([]);result=await new Promise((resolve,reject)=>setPicker({resolve,reject}))}
      else{if(!['data.list','data.get','data.put','data.delete','model.generate','files.read','knowledge.search','knowledge.documents','knowledge.graph','knowledge.evidence','reports.context','reports.list','reports.get','reports.save','reports.delete'].includes(m.method))throw new Error('METHOD_NOT_ALLOWED');result=await api(`/runtime/${session}/invoke`,'POST',{method:m.method,params:m.params||{}})}
      channel.port1.postMessage({id:m.id,result});
    }catch(e){channel.port1.postMessage({id:m.id,error:e instanceof Error?e.message:'RUNTIME_FAILED'})}finally{pending--}};
    frame.current?.contentWindow?.postMessage({type:'wanx:init'},'*',[channel.port2]);
    annotationRef.current?.onConnect(controller);setFrameReady(true);
  }
  async function select(){if(!picker)return;try{const files=await api(`/runtime/${session}/files`,'POST',{ids:chosen});picker.resolve(files);setPicker(null)}catch(e){setError(errorText(e))}}
  return <div className="runtime">{error&&<div className="inline-error">{error}<button onClick={()=>setError('')} aria-label="关闭错误"><Icon name="close" size={14}/></button></div>}{doc?<iframe title="小应用预览" data-ready={frameReady} ref={frame} srcDoc={doc} sandbox="allow-scripts allow-forms" onLoad={connect}/>:<div className="preview-empty" role={loadError?'alert':'status'}>{loadError?<><h3>此版本暂时无法打开</h3><p>{loadError}</p><button className="primary" onClick={()=>setAttempt(n=>n+1)}>重新打开此版本</button><small>方案和版本记录仍然保留。</small></>:<>正在准备这个版本…<small>首次打开时正在建立独立试用环境。</small></>}</div>}{picker&&<div className="modal-shade"><div className="modal"><h2>选择参考资料</h2><p>只有你选中的文本资料可以被这个应用读取。</p>{folder&&<button className="text-button" onClick={()=>void listFiles('')}>返回根目录</button>}<div className="file-picker">{entries.map(f=><label key={f.id}>{f.kind==='folder'?<button className="folder-row" onClick={()=>void listFiles(f.id)}><Icon name="folder"/>{f.name}</button>:<><input type="checkbox" checked={chosen.includes(f.id)} disabled={!/\.(txt|md|csv|json)$/i.test(f.name)} onChange={e=>setChosen(e.target.checked?[...chosen,f.id]:chosen.filter(id=>id!==f.id))}/><Icon name="file"/>{f.name}</>}</label>)}</div><div className="modal-actions"><button onClick={()=>{picker.resolve([]);setPicker(null)}}>取消</button><button className="primary" onClick={()=>void select()}>选择 {chosen.length} 份资料</button></div></div></div>}</div>
}

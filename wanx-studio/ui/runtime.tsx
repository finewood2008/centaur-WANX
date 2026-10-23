import{useEffect,useRef,useState}from'react';
import{frameDocument}from'../core/frame.mjs';
import{api,errorText}from'./api';
import{Icon}from'./icons';
type FileEntry={id:string;name:string;kind:string;size:number};
export function Runtime({projectId,artifactHash,environment='preview'}:{projectId:string;artifactHash:string;environment?:string}){
  const[doc,setDoc]=useState(''),[error,setError]=useState(''),[session,setSession]=useState(''),[picker,setPicker]=useState<{resolve:(v:unknown)=>void;reject:(e:Error)=>void}|null>(null),[entries,setEntries]=useState<FileEntry[]>([]),[chosen,setChosen]=useState<string[]>([]),[folder,setFolder]=useState('');
  const[loadError,setLoadError]=useState(''),[attempt,setAttempt]=useState(0);
  const frame=useRef<HTMLIFrameElement>(null),port=useRef<MessagePort|null>(null),pickerRef=useRef(picker);pickerRef.current=picker;
  useEffect(()=>{let active=true,token='';setDoc('');setError('');setLoadError('');setSession('');
    api<{session:string;bundle:string;css:string}>(`/projects/${projectId}/runtime`,'POST',{artifactHash,environment}).then(r=>{token=r.session;if(active){setSession(token);setDoc(frameDocument(r.bundle,r.css))}else void api(`/runtime/${token}`,'DELETE').catch(()=>{})}).catch(e=>{if(active)setLoadError(errorText(e))});
    return()=>{active=false;port.current?.close();pickerRef.current?.reject(new Error('RUNTIME_SESSION_EXPIRED'));if(token)void api(`/runtime/${token}`,'DELETE').catch(()=>{})}
  },[projectId,artifactHash,environment,attempt]);
  async function listFiles(parent=''){const result=await api<{items:FileEntry[]}>(`/files?parent=${encodeURIComponent(parent)}`);setEntries(result.items);setFolder(parent)}
  function connect(){
    port.current?.close();const channel=new MessageChannel();port.current=channel.port1;let pending=0;
    channel.port1.onmessage=async({data:m})=>{if(!m||!Number.isSafeInteger(m.id)||typeof m.method!=='string'||pending>=4)return;pending++;try{let result;
      if(m.method==='files.select'){await listFiles();setChosen([]);result=await new Promise((resolve,reject)=>setPicker({resolve,reject}))}
      else{if(!['data.list','data.get','data.put','data.delete','model.generate','files.read','knowledge.search','knowledge.documents','knowledge.graph','knowledge.evidence'].includes(m.method))throw new Error('METHOD_NOT_ALLOWED');result=await api(`/runtime/${session}/invoke`,'POST',{method:m.method,params:m.params||{}})}
      channel.port1.postMessage({id:m.id,result});
    }catch(e){channel.port1.postMessage({id:m.id,error:e instanceof Error?e.message:'RUNTIME_FAILED'})}finally{pending--}};
    frame.current?.contentWindow?.postMessage({type:'wanx:init'},'*',[channel.port2]);
  }
  async function select(){if(!picker)return;try{const files=await api(`/runtime/${session}/files`,'POST',{ids:chosen});picker.resolve(files);setPicker(null)}catch(e){setError(errorText(e))}}
  return <div className="runtime">{error&&<div className="inline-error">{error}<button onClick={()=>setError('')} aria-label="关闭错误"><Icon name="close" size={14}/></button></div>}{doc?<iframe title="小应用预览" ref={frame} srcDoc={doc} sandbox="allow-scripts allow-forms" onLoad={connect}/>:<div className="preview-empty" role={loadError?'alert':'status'}>{loadError?<><h3>此版本暂时无法打开</h3><p>{loadError}</p><button className="primary" onClick={()=>setAttempt(n=>n+1)}>重新打开此版本</button><small>方案和版本记录仍然保留。</small></>:<>正在准备这个版本…<small>首次打开时正在建立独立试用环境。</small></>}</div>}{picker&&<div className="modal-shade"><div className="modal"><h2>选择参考资料</h2><p>只有你选中的文本资料可以被这个应用读取。</p>{folder&&<button className="text-button" onClick={()=>void listFiles('')}>返回根目录</button>}<div className="file-picker">{entries.map(f=><label key={f.id}>{f.kind==='folder'?<button className="folder-row" onClick={()=>void listFiles(f.id)}><Icon name="folder"/>{f.name}</button>:<><input type="checkbox" checked={chosen.includes(f.id)} disabled={!/\.(txt|md|csv|json)$/i.test(f.name)} onChange={e=>setChosen(e.target.checked?[...chosen,f.id]:chosen.filter(id=>id!==f.id))}/><Icon name="file"/>{f.name}</>}</label>)}</div><div className="modal-actions"><button onClick={()=>{picker.resolve([]);setPicker(null)}}>取消</button><button className="primary" onClick={()=>void select()}>选择 {chosen.length} 份资料</button></div></div></div>}</div>
}

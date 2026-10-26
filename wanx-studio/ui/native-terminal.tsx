import {useEffect,useRef,useState} from 'react';
import TerminalView,{type TerminalViewHandle} from './wanx-terminal/TerminalView';
import{terminalFont,terminalDimensions,DEFAULT_TERMINAL_FONT}from'./terminal-layout.mjs';

export type TerminalChunk={seq:number;data:string;at:number};
const definition={theme:{background:'#242321',foreground:'#e9e4dc',cursor:'#c99278',selectionBackground:'#70584d',black:'#242321',brightBlack:'#928b80',red:'#da8c85',green:'#a7b992',yellow:'#d5b887',blue:'#a7b8c6',magenta:'#c4a3bd',cyan:'#9ebfba',white:'#e9e4dc'}};
type View='startup'|'latest'|'replay';

export function NativeTerminal({chunks,columns=96,rows=32,active,startupEndSeq}:{chunks:TerminalChunk[];columns?:number;rows?:number;active:boolean;startupEndSeq?:number}){
  const terminal=useRef<TerminalViewHandle|null>(null),viewport=useRef<HTMLDivElement|null>(null),written=useRef(0),chunksRef=useRef(chunks),manual=useRef(false);
  chunksRef.current=chunks;
  const[ready,setReady]=useState(false),[expanded,setExpanded]=useState(false),[view,setView]=useState<View>(active?'latest':'startup'),[fontSize,setFontSize]=useState(()=>{try{return terminalFont(localStorage.getItem('wanx-terminal-font'))}catch{return DEFAULT_TERMINAL_FONT}});
  const {width,height}=terminalDimensions(columns,rows,fontSize);
  const follow=useRef(true);
  const bytes=(data:string)=>Uint8Array.from(atob(data),character=>character.charCodeAt(0));
  useEffect(()=>{
    if(!ready)return;
    terminal.current?.reset();written.current=0;
    if(view!=='replay')return;
    let index=0;const recording=chunksRef.current;
    const timer=setInterval(()=>{
      const chunk=recording[index++];
      if(!chunk){clearInterval(timer);setView('latest');return}
      terminal.current?.write(bytes(chunk.data));written.current=chunk.seq;
    },40);
    return()=>clearInterval(timer);
  },[ready,view]);
  useEffect(()=>{
    if(!ready||view==='replay')return;
    for(const chunk of chunks){
      if(view==='startup'&&startupEndSeq!==undefined&&chunk.seq>=startupEndSeq)break;
      if(chunk.seq>written.current){terminal.current?.write(bytes(chunk.data));written.current=chunk.seq}
    }
  },[chunks,ready,view,startupEndSeq]);
  useEffect(()=>{
    if(!active||!startupEndSeq||view!=='startup'||manual.current)return;
    const timer=setTimeout(()=>setView('latest'),4500);
    return()=>clearTimeout(timer);
  },[active,startupEndSeq,view]);
  useEffect(()=>{try{localStorage.setItem('wanx-terminal-font',String(fontSize))}catch{}},[fontSize]);
  useEffect(()=>{
    const frame=requestAnimationFrame(()=>{const node=viewport.current;if(node&&view==='latest'&&follow.current)node.scrollTop=node.scrollHeight});
    return()=>cancelAnimationFrame(frame);
  },[chunks,view,fontSize,expanded]);
  useEffect(()=>{
    if(!expanded)return;
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setExpanded(false)}};
    window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);
  },[expanded]);
  function show(next:View){manual.current=true;follow.current=true;setView(next)}
  return <div className={'native-terminal-shell'+(expanded?' expanded':'')}>
    <div className="native-terminal-toolbar"><div className="native-terminal-brand"><span className="native-terminal-mark">&gt;_</span><div><strong>OpenAI Codex</strong><span>原版 CLI · {view==='startup'?'启动画面':view==='replay'?'正在回放':active?'实时开发':'开发记录'}</span></div><span className={'native-terminal-badge'+(active?' live':'')}>{active?'开发中':'本轮已结束'} · 只读</span></div><div className="native-terminal-actions">
      <button type="button" aria-pressed={view==='startup'} disabled={!startupEndSeq} onClick={()=>show('startup')}>启动画面</button>
      <button type="button" aria-pressed={view==='latest'} onClick={()=>show('latest')}>{active?'跟随实时进展':'开发记录'}</button>
      {!active&&<button type="button" disabled={!chunks.length||view==='replay'} onClick={()=>show('replay')}>{view==='replay'?'正在回放…':'从头回放'}</button>}
      <button type="button" onClick={()=>setExpanded(!expanded)}>{expanded?'返回工作台':'全屏查看'}</button>
      <span className="native-terminal-font" role="group" aria-label="终端字号"><button type="button" aria-label="减小终端字号" disabled={fontSize<=12} onClick={()=>setFontSize(n=>terminalFont(n-1))}>A−</button><button type="button" title="恢复默认 15px" onClick={()=>setFontSize(DEFAULT_TERMINAL_FONT)}>{fontSize}px</button><button type="button" aria-label="增大终端字号" disabled={fontSize>=24} onClick={()=>setFontSize(n=>terminalFont(n+1))}>A+</button></span>
    </div></div>
    <div className="native-terminal-scroll" ref={viewport} onScroll={e=>{const n=e.currentTarget;follow.current=n.scrollHeight-n.scrollTop-n.clientHeight<48}} role="region" aria-label="Codex CLI 只读终端">
      <div className="native-terminal-stage" style={{width,height}}><TerminalView fontSize={fontSize} readOnly columns={columns} rows={rows} onData={()=>{}} terminalRef={terminal} themeDefinition={definition} onReady={()=>setReady(true)}/></div>
    </div>
    <p className="native-terminal-caption"><span>{view==='startup'?'本轮真实启动记录'+(active?' · 开发仍在继续':''):'原版 Codex CLI 输出'} · 可滚动与复制 · 超出区域可横向滚动</span><span>只供查看 · 不接受命令输入{expanded?' · Esc 返回':''}</span></p>
  </div>;
}

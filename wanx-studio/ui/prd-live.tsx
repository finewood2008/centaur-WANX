import {Children,cloneElement,createElement,createContext,isValidElement,useContext,useEffect,useRef,useState,type ReactElement,type ReactNode} from 'react';
import {revealText,revealDuration} from './prd-reveal.mjs';

const LivePrd=createContext({revision:'',animate:false});
export function PrdLiveProvider({revision,enabled,children}:{revision:string;enabled:boolean;children:ReactNode}){
  const previous=useRef(revision);
  const animate=enabled&&previous.current!==revision;
  useEffect(()=>{previous.current=revision},[revision]);
  return <LivePrd.Provider value={{revision,animate}}>{children}</LivePrd.Provider>;
}
function PrdLiveText({value}:{value:string}){
  const {revision,animate}=useContext(LivePrd);
  const [shown,setShown]=useState(()=>animate?'':value),[writing,setWriting]=useState(false);
  const visible=useRef(shown);
  useEffect(()=>{
    let frame=0;
    const previous=visible.current;
    const render=(text:string)=>{visible.current=text;setShown(text)};
    if(!animate||previous===value||window.matchMedia('(prefers-reduced-motion: reduce)').matches){render(value);setWriting(false);return}
    const duration=revealDuration(previous,value),start=performance.now();
    render(revealText(previous,value,0));setWriting(true);
    const tick=(now:number)=>{
      const progress=Math.min(1,(now-start)/duration);render(revealText(previous,value,progress));
      if(progress<1)frame=requestAnimationFrame(tick);else setWriting(false);
    };
    frame=requestAnimationFrame(tick);
    return()=>cancelAnimationFrame(frame);
  },[value,revision]);
  return createElement('prd-text',{className:'prd-live-text'+(writing?' prd-writing':''),'aria-busy':writing||undefined},shown);
}
// Keep layout and controls intact. Stable text components animate changed prose
// while every edit, export and build continues to use the full saved project.
export function livePrdText(children:ReactNode):ReactNode{
  return Children.map(children,(child,index)=>{
    if(typeof child==='string')return <PrdLiveText key={'text-'+index} value={child}/>;
    if(!isValidElement(child))return child;
    const element=child as ReactElement<{children?:ReactNode}>;
    if(['button','input','select','textarea'].includes(String(element.type))||element.props.children===undefined)return child;
    return cloneElement(element,{},livePrdText(element.props.children));
  });
}

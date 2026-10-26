import{test}from'node:test';import assert from'node:assert/strict';
import{installPreviewAnnotations}from'../core/preview-annotations.mjs';
import{createAnnotationChannel,previewMethodAllowed}from'../ui/annotation-channel.mjs';
import{frameDocument}from'../core/frame.mjs';import vm from'node:vm';
function fixture(){
 const listeners=new Map(),messages=[],nodes=new Map();let pageName='首页',hit=null,scrolled=0;
 class Element{constructor(tag='div',id='',label=''){this.tagName=tag.toUpperCase();this.id=id;this.textContent=label;this.style={};this.children=[];this.parentElement=null;this.isConnected=true;this.b={left:100,top:100,width:200,height:40};if(id)nodes.set('#'+id,this)}append(n){n.parentElement=this;this.children.push(n)}attachShadow(){const s={children:[],append(n){this.children.push(n)},replaceChildren(){this.children=[]}};this.shadow=s;return s}getBoundingClientRect(){return this.b}getAttribute(){return null}closest(selector){if(selector.includes('button,')&&this.tagName==='BUTTON')return this;if(!selector.includes('button,')&&['P','H1','SECTION'].includes(this.tagName))return this;return this.parentElement?.closest(selector)||null}querySelectorAll(){return[{textContent:pageName}]}scrollIntoView(){scrolled++;this.b.top=200}blur(){this.blurred=true}}
 const root=new Element('main','app'),body=new Element('body'),html=new Element('html'),button=new Element('button','generate','生成文章预览');body.append(root);root.append(button);hit=button;
 const document={addEventListener(){},documentElement:html,body,activeElement:button,getElementById:id=>nodes.get('#'+id),querySelector:selector=>nodes.get(selector)||null,createElement:tag=>new Element(tag),elementFromPoint:()=>hit};
 const window={innerWidth:1000,innerHeight:700,location:{hash:''},addEventListener:(name,fn)=>{const list=listeners.get(name)||[];list.push(fn);listeners.set(name,list)},requestAnimationFrame:fn=>setImmediate(fn),setTimeout,clearTimeout};
 const old={window:globalThis.window,document:globalThis.document};globalThis.window=window;globalThis.document=document;
 const port={postMessage:m=>messages.push(m)},controller=installPreviewAnnotations(port);
 function fire(type,values={}){const e={target:button,clientX:140,clientY:110,button:0,pointerType:'mouse',isTrusted:true,preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true},...values};for(const fn of listeners.get(type)||[]){fn(e);if(e.stopped)break}return e}
 function command(action,body={}){controller.receive({type:'wanx:annotation-command',requestId:'request',action,...body});return messages.filter(m=>m.type==='wanx:annotation-response').at(-1)}
 return{window,document,root,button,nodes,messages,fire,command,Element,setPage:name=>{pageName=name},setHit:node=>{hit=node},get scrolled(){return scrolled},dispose(){globalThis.window=old.window;globalThis.document=old.document},select(){fire('pointerdown');fire('pointerup');return messages.filter(m=>m.event==='selected').at(-1)}};
}
const tick=()=>new Promise(resolve=>setImmediate(()=>setImmediate(resolve)));
test('selection intercepts application actions before app handlers while wheel scrolling and normal mode remain intact',async()=>{
 const f=fixture();try{let invoked=0;for(const type of ['pointerdown','click','submit','beforeinput','keydown'])f.window.addEventListener(type,()=>invoked++);
  f.fire('click');assert.equal(invoked,1);f.command('mode',{mode:'point'});const selected=f.select();assert.equal(selected.label,'生成文章预览');
  for(const type of ['click','submit','beforeinput'])assert.equal(f.fire(type).prevented,true);assert.equal(f.fire('keydown',{key:'Enter'}).prevented,true);assert.equal(invoked,1);
  assert.equal(f.fire('wheel').prevented,undefined);assert.equal(f.fire('keydown',{key:'PageDown'}).prevented,undefined);
  f.fire('keydown',{key:'Escape'});assert.equal(f.messages.filter(m=>m.event==='mode').at(-1).mode,'off');f.fire('click');assert.equal(invoked,2);
 }finally{await tick();f.dispose()}
});
test('marks follow nested scroll geometry, preserve IDs on resume and can locate their actual element',async()=>{
 const f=fixture();try{f.command('mode',{mode:'point'});const id=f.select().id;f.command('sync',{marks:[{id,number:1}]});f.button.b.top=-25;f.fire('scroll');await tick();assert.equal(f.messages.filter(m=>m.event==='positions').at(-1).positions[0].rect.y,-25);
  f.command('mode',{mode:'off'});f.command('mode',{mode:'point'});assert.equal(f.select().id,id);
  assert.equal(f.command('locate',{id}).result.rect.y,200);assert.equal(f.scrolled,1);
 }finally{await tick();f.dispose()}
});
test('capture hides outlines and rejects a screenshot after scroll or geometry changes',async()=>{
 const f=fixture();try{f.command('mode',{mode:'point'});const id=f.select().id;f.command('sync',{marks:[{id,number:1}]});await tick();f.command('prepare',{id});await tick();assert.equal(f.messages.filter(m=>m.type==='wanx:annotation-response').at(-1).result.rect.y,100);
  f.fire('scroll');assert.equal(f.command('validate',{id}).result.valid,false);f.command('prepare',{id});await tick();assert.equal(f.command('validate',{id}).result.valid,true);
 }finally{await tick();f.dispose()}
});
test('a removed target is stale on its page, other-page marks stay recorded, and selected buttons never get replaced silently',async()=>{
 const f=fixture();try{f.command('mode',{mode:'point'});const id=f.select().id;f.command('sync',{marks:[{id,number:1}]});f.button.isConnected=false;f.nodes.delete('#generate');f.fire('scroll');await tick();assert.equal(f.messages.filter(m=>m.event==='positions').at(-1).positions[0].state,'stale');
  f.setPage('发布排期');f.fire('scroll');await tick();assert.equal(f.messages.filter(m=>m.event==='positions').at(-1).positions[0].state,'other-page');assert.equal(f.command('locate',{id}).error,'VISUAL_REVIEW_STALE');
 }finally{await tick();f.dispose()}
});
test('free boxes stay relative to the underlying element across scroll',async()=>{
 const f=fixture();try{f.command('mode',{mode:'box'});f.fire('pointerdown',{clientX:110,clientY:105});f.fire('pointerup',{clientX:250,clientY:135});const mark=f.messages.filter(m=>m.event==='selected').at(-1);assert.equal(mark.kind,'box');assert.deepEqual(mark.rect,{x:110,y:105,width:140,height:30});f.command('sync',{marks:[{id:mark.id,number:1}]});f.button.b.top=300;f.fire('scroll');await tick();assert.equal(f.messages.filter(m=>m.event==='positions').at(-1).positions[0].rect.y,305);
 }finally{await tick();f.dispose()}
});
test('marking mode preserves the existing read boundary and the private channel cannot become an app capability',async()=>{
 for(const name of ['data.put','data.delete','model.generate','reports.save','reports.delete','files.select']){assert.equal(previewMethodAllowed(name,false,true),false);assert.equal(previewMethodAllowed(name,true,false),false);assert.equal(previewMethodAllowed(name,false,false),true)}
 assert.equal(previewMethodAllowed('data.list',false,true),true);
 const sent=[],events=[],channel=createAnnotationChannel({postMessage:m=>sent.push(m)},m=>events.push(m));const pending=channel.request('locate',{id:'target'});assert.equal(channel.receive({id:1,result:{}}),false);channel.receive({type:'wanx:annotation-response',requestId:sent[0].requestId,result:{rect:{x:3}}});assert.equal((await pending).rect.x,3);
 const interrupted=channel.request('prepare',{id:'target'});channel.dispose();await assert.rejects(interrupted,/PREVIEW_NOT_READY/);await assert.rejects(channel.request('locate'),/PREVIEW_NOT_READY/);channel.receive({type:'wanx:annotation-event',event:'selected'});assert.equal(events.length,0);
});
test('the serialized annotation helper remains self-contained in a bundled opaque-frame document',async()=>{
 const{build}=await import('esbuild');const compiled=await build({entryPoints:[new URL('../core/frame.mjs',import.meta.url).pathname],bundle:true,platform:'browser',format:'esm',minify:true,write:false});const packed=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 const f=fixture();try{let init;const ports=[],parent={};const window={...f.window,addEventListener:(name,fn,...args)=>{if(name==='message')init=fn;else f.window.addEventListener(name,fn,...args)}};const html=packed.frameDocument('const WanxMiniapp={mount(){}};');vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1],{window,document:f.document,parent,Promise,Map,Set,Number,String,Math,Error});const port={postMessage:m=>ports.push(m)};init({source:parent,data:{type:'wanx:init'},ports:[port]});port.onmessage({data:{type:'wanx:annotation-command',action:'mode',mode:'point'}});f.fire('pointerdown');f.fire('pointerup');assert(ports.some(m=>m.event==='selected'));assert.match(html,/connect-src 'none'/);assert.doesNotMatch(html,/allow-same-origin/);
 }finally{await tick();f.dispose()}
});


test('six-note relocation can select a replacement without treating retained invalid IDs as new marks',async()=>{
 const f=fixture();try{
  f.command('mode',{mode:'point'});const first=f.select().id;
  const marks=[{id:first,number:1},...Array.from({length:5},(_,i)=>({id:'invalid_'+i,number:i+2}))];
  f.command('sync',{marks});f.command('remove',{id:first});
  // Editing another note can resend retained IDs while a replacement is pending.
  f.command('sync',{marks});const replacement=f.select();
  assert.notEqual(replacement.id,first);assert.equal(replacement.label,'生成文章预览');
 }finally{await tick();f.dispose()}
});

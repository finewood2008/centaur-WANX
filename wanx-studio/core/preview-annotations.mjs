// Serialized into the opaque preview. Everything it uses lives inside this function.
export function installPreviewAnnotations(port) {
 let mode='off',started=false,layer,shadow,hover=null,drag=null,frame=0,revision=0,hidden=false,capture=null,watchdog=0,serial=0;
 const anchors=new Map(),numbers=new Map(),doc=document,win=window;
 const send=(event,value={})=>port.postMessage({type:'wanx:annotation-event',event,...value});
 const text=node=>String(node?.textContent||node?.getAttribute?.('aria-label')||node?.getAttribute?.('placeholder')||node?.tagName||'区域').replace(/\s+/g,' ').trim().slice(0,100);
 const page=()=>[win.location?.hash||'',...[...(doc.getElementById('app')||doc.body).querySelectorAll('h1,h2,[aria-current="page"],[aria-selected="true"],nav .active')].slice(0,5).map(text)].join('|');
 const rect=node=>{const b=node.getBoundingClientRect();return{x:b.left,y:b.top,width:b.width,height:b.height}};
 const clipped=b=>{const x=Math.max(0,b.x),y=Math.max(0,b.y),right=Math.min(win.innerWidth,b.x+b.width),bottom=Math.min(win.innerHeight,b.y+b.height);return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null};
 function target(node){if(!node?.closest)return null;return node.closest('button,a,input,textarea,select,[role="button"],[role="tab"],[role="checkbox"]')||node.closest('h1,h2,h3,h4,p,label,li,td,th,article,section')||node}
 function resolve(a){if(a.node?.isConnected)return a.node;if(a.page!==page()||!a.node?.id)return null;const n=doc.getElementById(a.node.id);if(n&&n.tagName===a.tag&&text(n)===a.label){a.node=n;return n}return null}
 function position(a){const n=resolve(a);if(!n)return{state:a.page===page()?'stale':'other-page',rect:null};const b=rect(n),o=a.offset;return{state:'ready',rect:o?{x:b.x+o.x*b.width,y:b.y+o.y*b.height,width:o.width*b.width,height:o.height*b.height}:b}}
 function draw(b,label='',dashed=false){const v=clipped(b);if(!v)return;const box=doc.createElement('div');box.style.cssText=`position:fixed;box-sizing:border-box;pointer-events:none;left:${v.x}px;top:${v.y}px;width:${v.width}px;height:${v.height}px;border:2px ${dashed?'dashed':'solid'} #b65c38;border-radius:3px;background:#b65c380b;`;if(label){const badge=doc.createElement('span');badge.textContent=label;badge.style.cssText='position:absolute;left:-2px;top:-2px;background:#b65c38;color:white;font:600 12px/22px sans-serif;min-width:22px;text-align:center;border-radius:3px;';box.append(badge)}shadow.append(box)}
 function render(){frame=0;if(!started)return;shadow.replaceChildren();const positions=[];for(const[id,a]of anchors){if(!numbers.has(id))continue;const p=position(a);positions.push({id,...p});if(mode!=='off'&&!hidden&&p.rect)draw(p.rect,String(numbers.get(id)))}if(mode!=='off'&&!hidden){if(drag&&mode==='box')draw(drag.box||{x:drag.x,y:drag.y,width:0,height:0},'',true);else if(hover?.isConnected)draw(rect(hover),'',true)}send('positions',{positions,viewport:{width:win.innerWidth,height:win.innerHeight}})}
 function schedule(){if(started&&!frame)frame=win.requestAnimationFrame(render)}
 function moved(){revision++;if(drag){drag=null;send('notice',{message:'页面位置已变化，请重新拖框。'})}schedule()}
 function block(e){e.preventDefault();e.stopImmediatePropagation()}
 function selected(node,box){if(!node||node===doc.documentElement||node===doc.body)return;const existing=[...anchors].find(([,a])=>a.node===node&&!a.offset&&!box);if([...anchors.keys()].filter(id=>numbers.has(id)).length>=6&&!existing){send('notice',{message:'本轮最多标记 6 处，可先编辑或发送。'});return}const id=existing?.[0]||'target_'+(++serial);if(!existing){const b=rect(node);if(!b.width||!b.height)return;anchors.set(id,{node,tag:node.tagName,label:text(node),page:page(),...(box?{offset:{x:(box.x-b.x)/b.width,y:(box.y-b.y)/b.height,width:box.width/b.width,height:box.height/b.height}}:{})})}const a=anchors.get(id),p=position(a);if(!p.rect||!clipped(p.rect))return;send('selected',{id,label:a.label,kind:box?'box':'element',rect:p.rect,viewport:{width:win.innerWidth,height:win.innerHeight}});schedule()}
 function init(){if(started||!doc.documentElement?.append)return;started=true;layer=doc.createElement('div');layer.style.cssText='all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;';shadow=layer.attachShadow({mode:'closed'});doc.documentElement.append(layer);
  win.addEventListener('pointerdown',e=>{if(mode==='off')return;e.stopImmediatePropagation();if(e.pointerType!=='touch')e.preventDefault();if(hidden||e.button!==0)return;drag={x:e.clientX,y:e.clientY,node:target(e.target)}},true);
  win.addEventListener('pointermove',e=>{if(mode==='off'||hidden)return;hover=target(e.target);if(drag&&mode==='box'){drag.box={x:Math.min(drag.x,e.clientX),y:Math.min(drag.y,e.clientY),width:Math.abs(drag.x-e.clientX),height:Math.abs(drag.y-e.clientY)};e.preventDefault();e.stopImmediatePropagation()}schedule()},true);
  win.addEventListener('pointerup',e=>{if(mode==='off')return;block(e);const start=drag;drag=null;if(!start||hidden)return;const distance=Math.hypot(e.clientX-start.x,e.clientY-start.y);if(mode==='point'){if(distance<8)selected(start.node)}else if(distance>=8){const box=clipped({x:Math.min(start.x,e.clientX),y:Math.min(start.y,e.clientY),width:Math.abs(start.x-e.clientX),height:Math.abs(start.y-e.clientY)});if(box&&box.width>=8&&box.height>=8)selected(target(doc.elementFromPoint(box.x+box.width/2,box.y+box.height/2)),box)}schedule()},true);
  win.addEventListener('pointercancel',()=>{drag=null;schedule()},true);
  for(const name of ['click','dblclick','auxclick','contextmenu','submit','beforeinput','dragstart'])win.addEventListener(name,e=>{if(mode!=='off')block(e)},true);
  win.addEventListener('keydown',e=>{if(mode==='off')return;if(e.key==='Escape'){block(e);mode='off';drag=null;send('mode',{mode});schedule();return}if(['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(e.key)){e.stopImmediatePropagation();return}block(e)},true);
  win.addEventListener('scroll',moved,true);win.addEventListener('resize',moved);win.addEventListener('blur',()=>{drag=null;schedule()});
  if(win.MutationObserver)new win.MutationObserver(moved).observe(doc.getElementById('app')||doc.body,{childList:true,subtree:true});
 }
 const reply=(requestId,result,error)=>{if(requestId)port.postMessage({type:'wanx:annotation-response',requestId,...(error?{error}:{result})})};
 function restore(){hidden=false;capture=null;win.clearTimeout(watchdog);schedule()}
 init();
 return{receive(m){if(m?.type!=='wanx:annotation-command')return false;const{requestId,action}=m;
  try{if(action==='mode'){mode=['point','box'].includes(m.mode)?m.mode:'off';if(mode!=='off'){init();doc.activeElement?.blur?.()}drag=null;hover=null;schedule();reply(requestId,{mode});return true}
   if(action==='sync'){numbers.clear();for(const v of (m.marks||[]).slice(0,6))if(typeof v.id==='string'&&Number.isSafeInteger(v.number))numbers.set(v.id,v.number);schedule();reply(requestId,{});return true}
   if(action==='remove'){anchors.delete(m.id);numbers.delete(m.id);schedule();reply(requestId,{});return true}
   const a=anchors.get(m.id);if(!a)throw Error('VISUAL_REVIEW_STALE');
   if(action==='locate'){const node=resolve(a);if(!node)throw Error('VISUAL_REVIEW_STALE');node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});schedule();reply(requestId,position(a));return true}
   if(action==='prepare'){hidden=true;shadow?.replaceChildren();win.clearTimeout(watchdog);watchdog=win.setTimeout(restore,6000);win.requestAnimationFrame(()=>win.requestAnimationFrame(()=>{const p=position(a);if(!p.rect||!clipped(p.rect)){restore();reply(requestId,null,'VISUAL_REVIEW_STALE');return}capture={id:m.id,revision,rect:p.rect};reply(requestId,{rect:p.rect,viewport:{width:win.innerWidth,height:win.innerHeight}})}));return true}
   if(action==='validate'){const p=position(a),valid=capture?.id===m.id&&capture.revision===revision&&p.rect&&['x','y','width','height'].every(k=>Math.abs(p.rect[k]-capture.rect[k])<1);restore();reply(requestId,{valid:Boolean(valid)});return true}
   if(action==='restore'){restore();reply(requestId,{});return true}
   throw Error('ANNOTATION_COMMAND_INVALID');
  }catch(e){restore();reply(requestId,null,e.message)}return true;
 }};
}

export function selectionBox(from,to,bounds){
 const point=p=>({x:Math.min(1,Math.max(0,(p.x-bounds.left)/bounds.width)),y:Math.min(1,Math.max(0,(p.y-bounds.top)/bounds.height))});
 const a=point(from),b=point(to);
 return{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};
}
export function previousArtifact(project,artifact){
 const hash=artifact?.baseHash||project?.versions?.find(v=>v.hash===artifact?.hash)?.baseHash;
 return project?.artifacts.find(a=>a.hash===hash)||null;
}
export function visualReviewReady(regions,retry=false){
 return regions.length>0&&regions.length<=6&&(retry||regions.every(r=>r.instruction?.trim()));
}
export function visualReviewInstruction(regions){
 return `请一次完成以下 ${regions.length} 处圈选修改，编号与截图对应：\n`+regions.map((r,i)=>`${i+1}. ${r.label?'['+r.label+'] ':''}${r.instruction.trim()}`).join('\n');
}
// Notes travel in the existing instruction; the public screenshot contract stays unchanged.
export function visualReviewPayload(draft){
 return{baseHash:draft.baseHash,expectedRevision:draft.expectedRevision,image:draft.image,viewport:draft.capture.viewport,regions:draft.regions.map(({x,y,width,height})=>({x,y,width,height}))};
}
export function invalidateVisualTargets(draft){
 if(!draft)return null;
 return{...draft,image:undefined,capture:undefined,pages:[],regions:draft.regions.map(r=>({...r,targetId:'invalid_'+r.id,state:'error',stale:true,otherPage:false,pageId:undefined}))};
}
// The chat owns notes even while comparison has no live annotation controller.
export function reviseVisualDraft(draft,markId,instruction,nextId){
 if(!draft||draft.retry&&instruction!==null)return draft;
 const regions=instruction===null?draft.regions.filter(r=>r.id!==markId):draft.regions.map(r=>r.id===markId?{...r,instruction:instruction.slice(0,800)}:r);
 return regions.length?{...draft,id:nextId,regions,pages:draft.pages.filter(p=>regions.some(r=>r.pageId===p.id))}:null;
}
// Several scrolled views become one bounded image; each note stays with its own pixels.
export function visualReviewLayout(pages,marks){
 const ids=new Set(marks.map(r=>r.pageId||pages[0].id));
 if(ids.size===1){const page=pages.find(p=>p.id===[...ids][0]);if(!page)throw Error('VISUAL_REVIEW_STALE');return{width:page.width,height:page.height,tiles:[{pageId:page.id,crop:{x:0,y:0,width:1,height:1},x:0,y:0,width:page.width,height:page.height}],regions:marks.map(({x,y,width,height,instruction})=>({x,y,width,height,instruction}))}}
 const columns=2,width=1600,height=Math.ceil(marks.length/columns)*480,regions=[];
 const tiles=marks.map((r,i)=>{
  const page=pages.find(p=>p.id===r.pageId);if(!page)throw Error('VISUAL_REVIEW_STALE');
  const cw=Math.min(1,Math.max(.4,r.width*1.5)),ch=Math.min(1,Math.max(.28,r.height*1.5));
  const crop={x:Math.max(0,Math.min(1-cw,r.x+r.width/2-cw/2)),y:Math.max(0,Math.min(1-ch,r.y+r.height/2-ch/2)),width:cw,height:ch};
  const scale=Math.min(776/(cw*page.width),432/(ch*page.height));
  const w=cw*page.width*scale,h=ch*page.height*scale,x=i%columns*800+(800-w)/2,y=Math.floor(i/columns)*480+36+(432-h)/2;
  const rw=Math.max(.01,r.width*page.width*scale/width),rh=Math.max(.01,r.height*page.height*scale/height);
  regions.push({x:Math.min(1-rw,(x+(r.x-crop.x)*page.width*scale)/width),y:Math.min(1-rh,(y+(r.y-crop.y)*page.height*scale)/height),width:rw,height:rh,instruction:r.instruction});
  return{pageId:page.id,crop,x,y,width:w,height:h,label:i+1};
 });
 return{width,height,tiles,regions};
}

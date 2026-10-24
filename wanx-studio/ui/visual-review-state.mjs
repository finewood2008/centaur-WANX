export function selectionBox(from,to,bounds){
 const point=p=>({x:Math.min(1,Math.max(0,(p.x-bounds.left)/bounds.width)),y:Math.min(1,Math.max(0,(p.y-bounds.top)/bounds.height))});
 const a=point(from),b=point(to);
 return{x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};
}
export function previousArtifact(project,artifact){
 const hash=artifact?.baseHash||project?.versions?.find(v=>v.hash===artifact?.hash)?.baseHash;
 return project?.artifacts.find(a=>a.hash===hash)||null;
}

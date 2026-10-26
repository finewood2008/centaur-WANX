import {randomUUID} from 'node:crypto';
import {frameDocument} from '../core/frame.mjs';
const fail=code=>Object.assign(new Error(code),{code});
const reads=new Set(['data.list','data.get','reports.context','reports.list','reports.get','knowledge.search','knowledge.documents','knowledge.graph','knowledge.evidence']);
export function createProjectPreview(session){
 const entries=new Map();let generation=0;
 async function release(item){try{await item.s.request('/runtime/'+item.token,'DELETE')}catch{/* Expired/old contexts cannot be reused; server leases expire. */}}
 return{
  async previewOpen(input){
   if(!/^[a-f0-9]{32}$/.test(input?.projectId)||!/^[a-f0-9]{64}$/.test(input?.artifactHash))throw fail('STUDIO_PROJECT_INVALID');
   const g=++generation,s=await session();
   const previous=[...entries.values()];entries.clear();await Promise.all(previous.map(release));
   const value=await s.request('/projects/'+input.projectId+'/runtime','POST',{artifactHash:input.artifactHash,environment:'preview'});
   const item={s,token:value.session,hash:input.artifactHash};
   if(g!==generation){void release(item);throw fail('PREVIEW_STALE')}
   s.assertLive();const handle=randomUUID();entries.set(handle,item);
   return{handle,artifactHash:input.artifactHash,document:frameDocument(value.bundle,value.css)};
  },
  async previewInvoke(input){
   if(!reads.has(input?.method))throw fail('PREVIEW_READ_ONLY');
   const item=entries.get(input.handle);if(!item)throw fail('PREVIEW_STALE');
   item.s.assertLive();const current=await session();if(current.key!==item.s.key)throw fail('STUDIO_CONTEXT_CHANGED');
   const result=await item.s.request('/runtime/'+item.token+'/invoke','POST',{method:input.method,params:input.params||{}});
   item.s.assertLive();if(entries.get(input.handle)!==item)throw fail('PREVIEW_STALE');return result;
  },
  async previewClose(input){const item=entries.get(input?.handle);if(item){entries.delete(input.handle);await release(item)}return{closed:true}}
 };
}

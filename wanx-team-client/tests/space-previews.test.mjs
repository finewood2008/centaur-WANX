import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../local-ui/renderer/space-previews.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
const item=(id,version=1)=>({id,version,name:'中文.png',kind:'file',size:68});
function setup(request){
 const observers=[],revoked=[],nodes=[];let serial=0;
 const window={};
 vm.runInNewContext(source,{window,atob,Blob,Uint8Array,document:{querySelector(){return{};},querySelectorAll(){return nodes;},createElement(){return{};}},
 URL:{createObjectURL(){return`blob:${++serial}`;},revokeObjectURL(v){revoked.push(v);}},
 createImageBitmap:async()=>({width:400,height:200,close(){}}),
 OffscreenCanvas:class{constructor(w,h){this.width=w;this.height=h;}getContext(){return{drawImage(){}};}async convertToBlob(){return new Blob(['thumb']);}},
 IntersectionObserver:class{constructor(cb){this.cb=cb;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}});
 const controller=window.createSpacePreviews({request});
 const mount=(items,scope='one',enabled=true)=>{nodes.splice(0,nodes.length,...items.map(i=>({dataset:{spaceThumbnail:controller.key(i)},replaceChildren(image){this.image=image;}})));controller.mount(items,scope,enabled);};
 const visible=()=>observers.at(-1).cb(nodes.map(target=>({target,isIntersecting:true})));
 return{controller,observers,revoked,nodes,mount,visible};
}
const result={type:'image/png',data:'aGk='};
test('thumbnail mode fetches only visible images sequentially and reuses versioned cache',async()=>{
 const calls=[],releases=[];const h=setup(id=>{calls.push(id);return new Promise(r=>releases.push(()=>r(result)));});
 h.mount([item('a'),item('b')]);assert.deepEqual(calls,[]);h.visible();assert.deepEqual(calls,['a']);
 releases.shift()();await tick();assert.deepEqual(calls,['a','b']);releases.shift()();await tick();
 assert.equal(h.nodes[0].image.src,'blob:1');h.mount([item('a'),item('b')]);h.visible();await tick();assert.equal(calls.length,2);
 h.mount([item('a',2)]);h.visible();assert.equal(calls.length,3);releases.shift()();await tick();
 h.mount([item('a')],'two');assert.equal(h.revoked.length,3);
});
test('account change discards late private pixels and disabled mode does not fetch',async()=>{
 let release;let calls=0;const h=setup(()=>{calls++;return new Promise(r=>release=r);});
 h.mount([item('a')]);h.visible();h.mount([item('a')],'other',false);release(result);await tick();
 assert.equal(h.controller.image(item('a')),undefined);assert.equal(h.nodes[0].image,undefined);assert.equal(calls,1);
});
test('old directory observers cannot enqueue files after navigation; unsupported formats stay icons',async()=>{
 const calls=[];const h=setup(async id=>{calls.push(id);return{type:'text/html',data:''};});
 h.mount([item('a')]);const old=h.observers[0],oldNode=h.nodes[0];h.mount([item('b')]);old.cb([{target:oldNode,isIntersecting:true}]);assert.deepEqual(calls,[]);
 h.visible();await tick();assert.deepEqual(calls,['b']);assert.equal(h.nodes[0].image,undefined);h.visible();await tick();assert.equal(calls.length,1);
 assert.equal(h.controller.eligible({...item('c'),name:'unsafe.svg'}),false);
 assert.equal(h.controller.eligible({...item('c'),size:17*1024*1024}),false);
});

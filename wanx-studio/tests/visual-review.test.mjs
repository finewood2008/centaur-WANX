import{test}from'node:test';
import assert from'node:assert/strict';
import{selectionBox,previousArtifact,visualReviewReady,visualReviewInstruction,visualReviewPayload,visualReviewLayout,invalidateVisualTargets,reviseVisualDraft}from'../ui/visual-review-state.mjs';
import capture from'../integration/preview-capture.cjs';
import{visualPrompt}from'../codex/visual-feedback.mjs';

test('selection is normalized for resized screenshots, reverse drags and outside edges',()=>{
 const bounds={left:100,top:50,width:800,height:400};
 assert.deepEqual(selectionBox({x:500,y:250},{x:100,y:50},bounds),{x:0,y:0,width:.5,height:.5});
 assert.deepEqual(selectionBox({x:-100,y:0},{x:1000,y:600},bounds),{x:0,y:0,width:1,height:1});
 const region=selectionBox({x:200,y:100},{x:300,y:150},{left:0,top:0,width:400,height:200});
 assert.deepEqual(region,{x:.5,y:.5,width:.25,height:.25});
});
test('comparison follows the actual parent version, not another unrelated latest artifact',()=>{
 const project={artifacts:[{hash:'first'},{hash:'other'},{hash:'new'}],versions:[{hash:'new',baseHash:'first'}]};
 assert.equal(previousArtifact(project,project.artifacts.at(-1)).hash,'first');
 assert.equal(previousArtifact(project,project.artifacts[0]),null);
});
test('native capture rejects out of bounds without capturing and caps the real image',async()=>{
 let calls=0,resized=false;const image={getSize:()=>({width:resized?1600:2400,height:resized?800:1200}),resize(){resized=true;return this},toPNG:()=>Buffer.from('actual-png')};
 const wc={capturePage:async rect=>{calls++;assert.deepEqual(rect,{x:100,y:80,width:800,height:400});return image}};
 await assert.rejects(capture.capturePreview(wc,{width:1000,height:600},{x:990,y:0,width:100,height:400}),/CAPTURE_INVALID/);assert.equal(calls,0);
 const result=await capture.capturePreview(wc,{width:1000,height:600},{x:100,y:80,width:800,height:400});
 assert.equal(resized,true);assert.equal(result.width,1600);assert.deepEqual(result.viewport,{width:800,height:400});assert.equal(result.image,'data:image/png;base64,'+Buffer.from('actual-png').toString('base64'));
 image.toPNG=()=>Buffer.alloc(1024*1024+1);await assert.rejects(capture.capturePreview(wc,{width:1000,height:600},{x:100,y:80,width:800,height:400}),/TOO_LARGE/);
});
test('ACP receives actual screenshot pixels as an image content block',()=>{
 assert.deepEqual(visualPrompt(null),[]);const blocks=visualPrompt({image:'data:image/png;base64,cGl4ZWxz'});
 assert.equal(blocks[1].type,'image');assert.equal(blocks[1].mimeType,'image/png');assert.equal(blocks[1].data,'cGl4ZWxz');
 assert.match(blocks[0].text,/界面数据/);
});
test('each numbered selection needs its own note; deleting one keeps notes bound to their regions',()=>{
 const regions=[{x:.1,y:.2,width:.3,height:.2,instruction:' 标题改为首页 '},{x:.6,y:.5,width:.1,height:.1,instruction:''}];
 assert.equal(visualReviewReady(regions),false);assert.equal(visualReviewReady([]),false);
 regions[1].instruction='按钮改成绿色';assert.equal(visualReviewReady(regions),true);
 assert.equal(visualReviewInstruction(regions),'请一次完成以下 2 处圈选修改，编号与截图对应：\n1. 标题改为首页\n2. 按钮改成绿色');
 const remaining=regions.filter((_,i)=>i!==0);assert.match(visualReviewInstruction(remaining),/1\. 按钮改成绿色$/);assert.equal(remaining[0].x,.6);assert.equal(regions.length,2);
 assert.equal(visualReviewReady(Array(7).fill(regions[0])),false);
 assert.equal(visualReviewReady([{...regions[0],instruction:''}],true),true);
});
test('all notes are submitted together using the unchanged version-bound screenshot schema',()=>{
 const regions=[{x:.1,y:.2,width:.3,height:.2,instruction:'标题改为首页'},{x:.6,y:.5,width:.1,height:.1,instruction:'按钮改成绿色'}];
 const draft={baseHash:'a'.repeat(64),expectedRevision:7,image:'data:image/png;base64,cGl4ZWxz',capture:{viewport:{width:1000,height:600}},regions};
 assert.deepEqual(visualReviewPayload(draft),{baseHash:draft.baseHash,expectedRevision:7,image:draft.image,viewport:{width:1000,height:600},regions:regions.map(({instruction,...rect})=>rect)});
 assert.equal(draft.regions[1].instruction,'按钮改成绿色');
 assert.deepEqual(Object.keys(visualReviewPayload(draft).regions[0]),['x','y','width','height']);
});
test('scrolling to another view keeps earlier marks and packs all views within the existing image contract',()=>{
 const pages=[{id:'top',width:1200,height:1000},{id:'bottom',width:1200,height:1000}];
 const marks=[{pageId:'top',x:.1,y:.2,width:.3,height:.2,instruction:'调整标题'},{pageId:'bottom',x:.5,y:.7,width:.3,height:.2,instruction:'调整底部按钮'}];
 const before=JSON.stringify(marks),layout=visualReviewLayout(pages,marks);
 assert.equal(JSON.stringify(marks),before);assert.equal(layout.regions.length,2);assert.deepEqual(layout.tiles.map(t=>t.pageId),['top','bottom']);
 assert(layout.width<=1600&&layout.height<=1600);assert.deepEqual(layout.regions.map(r=>r.instruction),['调整标题','调整底部按钮']);
 for(const r of layout.regions){assert(r.x>=0&&r.y>=0&&r.width>=.01&&r.height>=.01);assert(r.x+r.width<=1.000001&&r.y+r.height<=1.000001)}
 const one=visualReviewLayout(pages,[marks[1]]);assert.equal(one.tiles[0].pageId,'bottom');assert.equal(one.width,1200);assert.equal(one.regions[0].y,.7);
 assert.throws(()=>visualReviewLayout([pages[0]],marks),/STALE/);
 const many=visualReviewLayout(pages,Array.from({length:6},(_,i)=>({pageId:i%2?'bottom':'top',x:.98,y:.98,width:.01,height:.01,instruction:'小标记'})));
 assert.equal(many.height,1440);assert(many.regions.every(r=>r.width>=.01&&r.height>=.01&&r.x+r.width<=1.000001&&r.y+r.height<=1.000001));
});
test('changing preview versions retains every note but discards all old target IDs and screenshot authority',()=>{
 const draft={id:'draft',baseHash:'old',pages:[{image:'old pixels'}],capture:{image:'old pixels'},image:'old pixels',regions:[{id:'first',targetId:'target_1',instruction:'标题改为首页',state:'ready',pageId:'old'}]};
 const next=invalidateVisualTargets(draft);assert.equal(next.regions[0].instruction,'标题改为首页');assert.equal(next.regions[0].id,'first');assert.equal(next.regions[0].stale,true);assert.equal(next.regions[0].state,'error');assert.notEqual(next.regions[0].targetId,'target_1');assert.deepEqual(next.pages,[]);assert.equal(next.image,undefined);assert.equal(next.capture,undefined);assert.equal(draft.regions[0].state,'ready');assert.equal(draft.pages.length,1);
});


test('comparison keeps notes editable and deletable without a live preview controller',()=>{
 const draft={id:'old',pages:[{id:'p1'},{id:'p2'}],regions:[{id:'a',pageId:'p1',instruction:'first'},{id:'b',pageId:'p2',instruction:'second'}]};
 const revised=reviseVisualDraft(draft,'a','updated','new');
 assert.equal(revised.id,'new');assert.equal(revised.regions[0].instruction,'updated');assert.equal(draft.regions[0].instruction,'first');
 const removed=reviseVisualDraft(revised,'a',null,'removed');
 assert.deepEqual(removed.regions.map(r=>r.id),['b']);assert.deepEqual(removed.pages,[{id:'p2'}]);
 assert.equal(reviseVisualDraft(removed,'b',null,'empty'),null);
 const retry={...draft,retry:{id:'original-operation',text:'original'}};
 assert.equal(reviseVisualDraft(retry,'a','changed','no'),retry);
});

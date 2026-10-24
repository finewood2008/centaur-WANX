import{test}from'node:test';
import assert from'node:assert/strict';
import{selectionBox,previousArtifact}from'../ui/visual-review-state.mjs';
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

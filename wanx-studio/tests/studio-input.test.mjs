import{test}from'node:test';import assert from'node:assert/strict';import vm from'node:vm';import{readFile}from'node:fs/promises';
const source=await readFile(new URL('../integration/studio-input.js',import.meta.url),'utf8');
function harness(){
 const callbacks={},timers=[],document={activeElement:null};let commits=0;
 const root={ownerDocument:document,field:null,addEventListener(name,fn){callbacks[name]=fn},querySelector(){return this.field}};
 function field(key='project:draft',value='第一段文字'){
  return{dataset:{studioEditKey:key},value,disabled:false,readOnly:false,placeholder:'描述任务',selectionStart:2,selectionEnd:4,selectionDirection:'backward',scrollTop:35,isConnected:true,matches:()=>true,
   replaceWith(next){this.isConnected=false;root.field=next;next.isConnected=true},
   focus(options){document.activeElement=this;assert.equal(options.preventScroll,true)},setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction}};
 }
 const window={};vm.runInNewContext(source,{window,setTimeout:fn=>timers.push(fn)});
 const editor=window.createStudioInputRetention(root,()=>commits++);
 const original=field();root.field=original;document.activeElement=original;
 function redraw(next){original.isConnected=false;root.field=next;document.activeElement=null}
 return{editor,root,document,original,field,redraw,callbacks,timers,get commits(){return commits}};
}
test('task refresh retains the actual focused editor, caret, selection and scroll',()=>{
 const h=harness(),restore=h.editor.capture();h.redraw(h.field());restore();
 assert.equal(h.root.field,h.original);assert.equal(h.document.activeElement,h.original);
 assert.deepEqual([h.original.selectionStart,h.original.selectionEnd,h.original.selectionDirection],[2,4,'backward']);assert.equal(h.original.scrollTop,35);
});
test('Chinese composition defers same-project redraw until committed but cannot retain another scope',()=>{
 const h=harness();h.callbacks.compositionstart({target:h.original});assert.equal(h.editor.defer('<textarea data-studio-edit-key="project:draft">'),true);
 assert.equal(h.editor.defer('<textarea data-studio-edit-key="other-account:draft">'),false);
 h.callbacks.compositionend({target:h.original});assert.equal(h.editor.defer('<textarea data-studio-edit-key="project:draft">'),false);assert.equal(h.commits,0);h.timers[0]();assert.equal(h.commits,1);
});
test('switching account, project or answer field cannot reattach a previous draft',()=>{
 for(const key of ['other-account:draft','other-project:draft','project:extra']){
  const h=harness(),restore=h.editor.capture(),next=h.field(key,'新内容');h.redraw(next);restore();assert.equal(h.root.field,next);assert.equal(h.document.activeElement,null);
 }
});
test('submitted input clears from authoritative state and a busy editor remains disabled',()=>{
 const h=harness(),restore=h.editor.capture(),next=h.field('project:draft','');next.disabled=true;h.redraw(next);restore();
 assert.equal(h.root.field.value,'');assert.equal(h.root.field.disabled,true);assert.equal(h.document.activeElement,null);
});

function menuHarness(){
 const document={activeElement:null},root={ownerDocument:document,menu:null,addEventListener(){},querySelector(){return null},querySelectorAll(){return this.menu?[this.menu]:[]}};
 function menu(key='account:box:project',html='<summary>菜单</summary><div>导出</div>'){
  const node={dataset:{studioMenuKey:key},innerHTML:html,open:false,isConnected:true,contains(item){return item===this.summary},replaceWith(previous){this.isConnected=false;previous.isConnected=true;root.menu=previous}};
  node.summary={get isConnected(){return node.isConnected},focus(options){assert.equal(options.preventScroll,true);document.activeElement=this}};
  return node;
 }
 const window={};vm.runInNewContext(source,{window,setTimeout(){}});const retention=window.createStudioInputRetention(root,()=>{});
 const original=menu();root.menu=original;document.activeElement=original.summary;
 const redraw=next=>{root.menu.isConnected=false;root.menu=next;document.activeElement=null};
 return{root,document,retention,original,menu,redraw};
}
test('a pending redraw does not detach the native project-menu activation or lose its open state and focus',()=>{
 const h=menuHarness(),restore=h.retention.capture();h.redraw(h.menu());restore();
 assert.equal(h.root.menu,h.original);assert.equal(h.original.isConnected,true);
 h.original.open=true; // The summary default action runs after the click handler.
 const nextRestore=h.retention.capture();h.redraw(h.menu());nextRestore();
 assert.equal(h.root.menu.open,true);assert.equal(h.document.activeElement,h.original.summary);
});
test('new scope or changed project-menu actions never restore stale menu nodes',()=>{
 for(const [key,html] of [['other-account:box:project','<summary>菜单</summary><div>导出</div>'],['account:box:project','<summary>菜单</summary><div>恢复项目</div>']]){
  const h=menuHarness(),restore=h.retention.capture(),next=h.menu(key,html);h.redraw(next);restore();
  assert.equal(h.root.menu,next);assert.equal(h.document.activeElement,null);
 }
});

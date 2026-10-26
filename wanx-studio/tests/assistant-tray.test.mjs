import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {patchAssistantFile} from '../tools/patch-assistant-tray.mjs';

test('tray assistant exposes only fixed dialogue operations and sanitizes errors',async()=>{
  const bridges={},calls=[],listeners=new Map();
  const electron={contextBridge:{exposeInMainWorld:(name,value)=>bridges[name]=value},ipcRenderer:{
    invoke:async(...args)=>{calls.push(args);return {scope:'owner'};},
    on:(name,fn)=>listeners.set(name,fn),removeListener:(name)=>listeners.delete(name),
  }};
  const code=patchAssistantFile('local-ui/panel-preload.cjs','const {contextBridge,ipcRenderer}=require("electron");');
  vm.runInNewContext(code,{require:name=>{assert.equal(name,'electron');return electron;}});
  const api=bridges.wanxPanelAssistant;
  assert.equal((await api.request('dialogue.arbitrary-route',{path:'/secret'})).ok,false);
  assert.equal((await api.request('/api/agents',{agentId:'foreign'})).ok,false);
  assert.equal((await api.request('dialogue.channels-start',{kind:'weixin'})).ok,false);
  assert.equal(calls.length,0);
  assert.equal((await api.request('dialogue.load',{})).ok,true);
  assert.equal(calls[0][0],'wanx-client:panel-ai-dialogue-load');
  const off=api.onEvent(()=>{});assert(listeners.has('wanx-client:panel-ai-dialogue'));off();assert.equal(listeners.size,0);
});

test('tray patch replaces the space tile and leaves the note tile and resize behavior intact',()=>{
  const original='<footer aria-label="空间与便签"><button class="space-entry" data-page="space">旧空间</button><button class="note-entry">便签</button></footer>\nconst height = noteView ? 560 : 400;\nif (event.key === "Escape") { event.preventDefault(); clearDrag(); }';
  const updated=patchAssistantFile('local-ui/panel/panel.js',original);
  assert(updated.includes('data-assistant-open'));
  assert(updated.includes('<button class="note-entry">便签</button>'));
  assert(!updated.includes('data-page="space"'));
  assert(updated.includes('classList.contains("assistant-view") ? 560'));
});

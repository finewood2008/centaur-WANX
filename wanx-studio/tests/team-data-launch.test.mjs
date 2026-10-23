import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {sendStarlinkTarget} from '../integration/team-client/starlink-launch.mjs';
test('target handoff waits for the matching launch and target acknowledgement',async()=>{
 const child=new EventEmitter();let message,done=false;child.send=m=>message=m;
 const operation=sendStarlinkTarget({child,session:{launchId:'live'}},{view:'graph'},{timeout:50}).then(()=>done=true);
 child.emit('message',{type:'wanx:starlink-target-result',launchId:'other',requestId:message.requestId,ok:true});await Promise.resolve();assert.equal(done,false);
 child.emit('message',{type:'wanx:starlink-target-result',launchId:'live',requestId:message.requestId,ok:true});await operation;assert.equal(done,true);
});
test('old Starlink is reported as incompatible instead of claiming the target opened',async()=>{
 const child=new EventEmitter();child.send=()=>{};
 await assert.rejects(sendStarlinkTarget({child,session:{launchId:'live'}},{view:'graph'},{timeout:5}),{code:'TEAM_STARLINK_UPGRADE_REQUIRED'});
});

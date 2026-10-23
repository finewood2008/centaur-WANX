import{test}from'node:test';import assert from'node:assert/strict';
import{terminalFont,terminalDimensions}from'../ui/terminal-layout.mjs';
test('terminal defaults to readable text and rejects invalid stored preferences',()=>{
 for(const value of [null,'','bad',undefined,Infinity])assert.equal(terminalFont(value),15);
 assert.equal(terminalFont('18'),18);assert.equal(terminalFont('6'),12);assert.equal(terminalFont(100),24);
});
test('fixed recorded PTY grid grows at readable font sizes instead of scaling down',()=>{
 const normal=terminalDimensions(160,48,15),larger=terminalDimensions(160,48,20);
 assert.ok(normal.width>=1440);assert.ok(normal.height>=48*21);
 assert.ok(larger.width>normal.width&&larger.height>normal.height);
 assert.equal(terminalDimensions(96,32,12).height,32*17+18);
});

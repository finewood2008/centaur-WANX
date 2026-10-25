import{test}from'node:test';import assert from'node:assert/strict';import{patchSource}from'../core/source-patch.mjs';
test('local edit retains unrelated source and refuses ambiguous, stale or foreign targets',()=>{
 const files={'src/styles.css':'button{padding:8px}\nh1{font-size:28px}\nform{display:flex}'};
 const next=patchSource(files,{path:'src/styles.css',find:'h1{font-size:28px}',replace:'h1{font-size:26px}'});
 assert.equal(next,'button{padding:8px}\nh1{font-size:26px}\nform{display:flex}');assert.match(files['src/styles.css'],/28px/);
 assert.throws(()=>patchSource(files,{path:'src/styles.css',find:'missing',replace:''}),/SOURCE_CHANGED/);
 assert.throws(()=>patchSource({'src/app.js':'one one'},{path:'src/app.js',find:'one',replace:'two'}),/PATCH_AMBIGUOUS/);
 assert.throws(()=>patchSource(files,{path:'../private.key',find:'x',replace:'y'}),/SOURCE_PATH_DENIED/);
 assert.throws(()=>patchSource(files,{path:'src/styles.css',find:'',replace:'x'}),/PATCH_INPUT_INVALID/);
});

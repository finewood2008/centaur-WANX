import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import electron from 'electron';
test('Electron space editor retains native input and IME across updates and navigates independent spaces',{skip:process.env.WANX_TEST_ELECTRON!=='1',timeout:120000},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'wanx-spaces-ui-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const {stdout}=await promisify(execFile)(electron,[fileURLToPath(new URL('./support/electron-spaces.mjs',import.meta.url)),`--user-data-dir=${profile}`],{env,timeout:110000});
  assert.match(stdout,/SPACES_ELECTRON_PASS/);
});

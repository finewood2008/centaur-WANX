import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {verifyBundledCodex} from '../tools/verify-bundled-codex.mjs';

const run=promisify(execFile),root=fileURLToPath(new URL('..',import.meta.url));
const unix={skip:process.platform==='win32'?'Builder uses Unix app-server sockets':false};
async function fixture(t,version){
  const directory=await mkdtemp(path.join(os.tmpdir(),'wanx-package-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  if(version)await writeFile(path.join(directory,'package.json'),JSON.stringify({dependencies:{'@openai/codex':version}}));
  return directory;
}

test('bundled Codex qualifies without host login and removes its temporary state',unix,async t=>{
  const directory=await fixture(t),ambient=path.join(directory,'host-codex');
  await mkdir(ambient);
  const config='invalid TOML: host state must not be read';
  await writeFile(path.join(ambient,'config.toml'),config);
  const result=await run(process.execPath,[path.join(root,'tools/verify-bundled-codex.mjs')],{
    cwd:directory,timeout:90000,env:{...process.env,TMPDIR:directory,CODEX_HOME:ambient,OPENAI_API_KEY:'synthetic-host-secret'},
  });
  const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.deepEqual(JSON.parse(result.stdout),{available:true,version:manifest.dependencies['@openai/codex'],transport:'app-server',modelCalls:0});
  assert.equal(await readFile(path.join(ambient,'config.toml'),'utf8'),config);
  assert.deepEqual(await readdir(directory),['host-codex']);
  assert.ok(!result.stdout.includes('synthetic-host-secret'));
});

test('bundle qualification rejects floating versions and never falls back to global Codex',unix,async t=>{
  const directory=await fixture(t,'^0.160.1');
  await assert.rejects(verifyBundledCodex(directory),/CODEX_BUNDLE_VERSION_NOT_PINNED/);
  await writeFile(path.join(directory,'package.json'),JSON.stringify({dependencies:{'@openai/codex':'0.160.1'}}));
  await assert.rejects(verifyBundledCodex(directory),/CODEX_BUNDLE_MISSING/);
});

test('bundle qualification rejects an installed CLI that differs from the release pin',unix,async t=>{
  const directory=await fixture(t,'0.0.0');
  await symlink(path.join(root,'node_modules'),path.join(directory,'node_modules'),'dir');
  await assert.rejects(verifyBundledCodex(directory),/CODEX_BUNDLE_VERSION_MISMATCH/);
});

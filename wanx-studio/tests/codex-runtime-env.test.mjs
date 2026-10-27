import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeEnvironment,runtimeEffort} from '../codex/runtime-env.mjs';

test('only managed local proxy credentials and private state reach the Codex child',()=>{
  const actual=runtimeEnvironment({PATH:'runtime-bin',LANG:'zh_CN.UTF-8',TMPDIR:'temp',
    CODEX_HOME:'private-owner-state',WANX_CODEX_PROXY_TOKEN:'local-proxy-token',
    HOME:'developer-home',OPENAI_API_KEY:'cloud-secret',CHATGPT_TOKEN:'host-login',HTTP_PROXY:'ambient-proxy'});
  assert.deepEqual(actual,{PATH:'runtime-bin',LANG:'zh_CN.UTF-8',TMPDIR:'temp',
    CODEX_HOME:'private-owner-state',WANX_CODEX_PROXY_TOKEN:'local-proxy-token'});
});

test('managed turns only send reasoning effort declared by the selected model',()=>{
  assert.equal(runtimeEffort({model_provider:'wanx_device'}),undefined);
  assert.equal(runtimeEffort({model_provider:'wanx_device',model_reasoning_effort:'low'}),'low');
  assert.equal(runtimeEffort({}),'medium');
});

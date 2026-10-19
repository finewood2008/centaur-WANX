import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPersonalSpace } from '../shell/personal-space.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async predicate => { for (let i = 0; i < 500; i++) { if (predicate()) return; await sleep(10); } throw Error('timed out'); };
const reset = () => Object.assign(Error('connection reset'), { code: 'ECONNRESET' });
async function fixture(t, { before, after, retryBaseMs = 1, maxRetries = 3, saved: initial = [], saveError = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wanx-recovery-'));
  let state = { phase: 'ready', account: { phase: 'authenticated', accountId: 'one' }, connection: { deviceId: '79' } }, saved = initial, service;
  const listeners = new Set(), remote = new Map(), calls = [], events = [];
  const paths = await Promise.all(Array.from({ length: 6 }, async (_, i) => { const file = path.join(root, `sample-${i}.txt`); await writeFile(file, Buffer.alloc(512, i)); return file; }));
  const options = { serviceURL: 'https://account.test', chooseUploads: async () => paths, chooseDownload: async () => null,
    retryBaseMs, maxRetries, random: () => 0.5, onEvent: event => events.push(event),
    store: { load: async () => structuredClone(saved), save: async value => { if (saveError) throw Error('disk full'); saved = structuredClone(value); } },
    client: { snapshot: () => state, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, applicationConnection: async () => {
      const box = state.connection?.deviceId, account = state.account.accountId;
      const context = () => { if (state.phase !== 'ready' || box !== state.connection?.deviceId || account !== state.account.accountId) throw Object.assign(Error('changed'), { code: 'NETWORK_CHANGED' }); return {}; };
      return { context, request: async input => {
        context(); calls.push(input); await before?.(input, { remote, calls });
        if (input.signal.aborted) throw input.signal.reason;
        const route = new URL(input.path, 'http://local'), parts = route.pathname.split('/'), id = parts[4]; let value = {};
        if (input.method === 'POST' && parts.at(-1) === 'uploads') {
          const body = JSON.parse(input.body); if (!remote.has(body.id)) remote.set(body.id, { ...body, offset: 0, state: 'pending', bytes: Buffer.alloc(0), publishes: 0 });
          value = remote.get(body.id);
        } else if (input.method === 'PUT') {
          const upload = remote.get(id); assert.equal(Number(route.searchParams.get('offset')), upload.offset);
          assert.equal(input.headers['x-content-sha256'], hash(input.body));
          upload.bytes = Buffer.concat([upload.bytes, input.body]); upload.offset += input.body.length; value = { offset: upload.offset };
        } else if (parts.at(-1) === 'complete') {
          const upload = remote.get(id); assert.equal(JSON.parse(input.body).digest, hash(upload.bytes));
          if (upload.state !== 'complete') upload.publishes++; upload.state = 'complete'; value = { id };
        }
        await after?.(input, { remote, calls });
        return { status: 200, body: Buffer.from(JSON.stringify(value)), headers: {} };
      } };
    } },
  };
  service = await createPersonalSpace(options);
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  return { get service() { return service; }, paths, remote, calls, events, saved: () => saved,
    state: value => { state = { ...state, ...value }; for (const fn of listeners) fn(); },
    restart: async transform => { await service.close(); if (transform) saved = transform(saved); service = await createPersonalSpace(options); },
    complete: () => wait(() => service.snapshot().tasks.length > 0 && service.snapshot().tasks.every(t => t.phase === 'complete')),
  };
}
test('batch retries a lost chunk ACK from server offset; one publication per stable ID', async t => {
  let lost = false;
  const f = await fixture(t, { after: input => { if (!lost && input.method === 'PUT') { lost = true; throw reset(); } } });
  await f.service.uploads(''); await f.complete();
  assert.equal(f.remote.size, 6); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 6);
  assert.ok([...f.remote.values()].every(r => r.offset === 512 && r.publishes === 1));
  assert.ok(f.events.some(e => e.action === 'interrupted' && e.phase === 'retrying'));
  assert.ok(f.events.every(e => !('localPath' in e) && !('name' in e)));
});
test('lost final response reconciles completed upload without reupload or duplicate commit', async t => {
  let lost = false;
  const f = await fixture(t, { after: input => { if (!lost && input.path.endsWith('/complete')) { lost = true; throw reset(); } } });
  await f.service.uploads('', [f.paths[0]]); await f.complete();
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/complete')).length, 1);
  assert.equal([...f.remote.values()][0].publishes, 1);
});
test('offline retains queue; ready restores all six automatically, manual pause wins', async t => {
  let release; const gate = new Promise(r => release = r), blocked = new Set();
  const f = await fixture(t, { before: async input => { if (input.method === 'PUT') { blocked.add(input.path); await gate; } } });
  await f.service.uploads(''); await wait(() => blocked.size === 2);
  f.state({ phase: 'recovering', connection: null });
  assert.equal(f.service.snapshot().tasks.length, 6);
  release(); await wait(() => f.saved().every(t => t.phase === 'waiting'));
  const pausedId = f.service.snapshot().tasks[0].id;
  await f.service.transfer('pause', pausedId);
  f.state({ phase: 'ready', connection: { deviceId: '79' } });
  await wait(() => f.service.snapshot().tasks.filter(t => t.phase === 'complete').length === 5);
  assert.equal(f.service.snapshot().tasks.find(t => t.id === pausedId).phase, 'paused');
  await f.service.transfer('resume', pausedId); await f.complete();
  assert.equal(f.remote.size, 6); assert.ok([...f.remote.values()].every(r => r.publishes === 1));
});
test('pausing during retry cancels automatic work until explicit resume; deduplicates unfinished selections', async t => {
  let attempts = 0;
  const f = await fixture(t, { retryBaseMs: 80, before: input => { if (input.method === 'PUT' && attempts++ === 0) throw reset(); } });
  await f.service.uploads('', [f.paths[0], f.paths[0]]);
  await wait(() => f.service.snapshot().tasks[0].phase === 'retrying');
  await f.service.uploads('', [f.paths[0]]);
  assert.equal(f.service.snapshot().tasks.length, 1);
  await f.service.transfer('pause-all'); const count = f.calls.length;
  await sleep(160); assert.equal(f.calls.length, count);
  await f.restart(); await sleep(30); assert.equal(f.calls.length, count);
  await f.service.transfer('resume-all'); await f.complete();
});
test('permanent storage/authorization errors stop immediately, transient errors stop after bounded retries', async t => {
  for (const code of ['SPACE_DISK_FULL', 'ACCOUNT_ACCESS_DENIED', 'ECONNRESET']) {
    const f = await fixture(t, { before: input => { if (input.method === 'PUT') throw Object.assign(Error(code), { code }); } });
    await f.service.uploads('', [f.paths[0]]); await wait(() => f.service.snapshot().tasks[0].phase === 'paused');
    assert.equal(f.calls.filter(c => c.method === 'PUT').length, code === 'ECONNRESET' ? 4 : 1);
    assert.equal(f.service.snapshot().tasks[0].pauseReason, 'error');
  }
});
test('switching box never migrates queued jobs or auto resumes them when returning', async t => {
  const f = await fixture(t, { before: input => { if (input.method === 'PUT') throw reset(); }, retryBaseMs: 80 });
  await f.service.uploads(''); await wait(() => f.service.snapshot().tasks.some(t => t.phase === 'retrying'));
  f.state({ connection: { deviceId: 'other' } }); assert.equal(f.service.snapshot().tasks.length, 0);
  f.state({ connection: { deviceId: '79' } }); await sleep(150);
  assert.ok(f.service.snapshot().tasks.every(t => t.phase === 'paused' && !t.autoResume));
});
test('restart resumes new active transfers, but legacy ambiguous records stay paused', async t => {
  const f = await fixture(t, { before: input => { if (input.method === 'PUT') throw reset(); }, retryBaseMs: 80 });
  await f.service.uploads('', [f.paths[0]]); await wait(() => f.service.snapshot().tasks[0].phase === 'retrying');
  await f.restart(records => records.map(({ recoveryVersion, autoResume, ...record }) => record));
  const count = f.calls.length; await sleep(150);
  assert.equal(f.calls.length, count); assert.equal(f.service.snapshot().tasks[0].phase, 'paused');
});
test('secure queue write failure prevents dispatch of any new transfer', async t => {
  const f = await fixture(t, { saveError: true });
  await assert.rejects(f.service.uploads(''), { code: 'SECURE_STORAGE_WRITE_FAILED' });
  await sleep(30); assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(f.service.snapshot().storageError, 'SECURE_STORAGE_WRITE_FAILED');
});

test('authorization rejection stays terminal even if upstream labels it a temporary status', async t => {
  const f = await fixture(t, { before: input => { if (input.method === 'PUT') throw Object.assign(Error('denied'), {code: 'ACCOUNT_ACCESS_DENIED', status: 503}); } });
  await f.service.uploads('', [f.paths[0]]); await wait(() => f.service.snapshot().tasks[0].phase === 'paused');
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal(f.service.snapshot().tasks[0].error, 'ACCOUNT_ACCESS_DENIED');
});

test('unreachable box opens batch circuit instead of failing every queued file', async t => {
  const f = await fixture(t, {maxRetries: 1, before: input => { if (input.method === 'PUT') throw reset(); }});
  await f.service.uploads(''); await wait(() => f.service.snapshot().tasks.every(t => t.phase === 'paused'));
  const count = f.calls.length; await sleep(60); assert.equal(f.calls.length, count);
  assert.ok(f.remote.size <= 2, 'queued files must not all start against an unreachable box');
  assert.ok(f.service.snapshot().tasks.every(t => t.error === 'SPACE_RETRY_EXHAUSTED'));
});

test('stalled chunks reconcile the stable upload ID and recover with at most 1 MiB chunks', async t => {
  let fault=false;
  const f=await fixture(t,{after:input=>{if(input.method==='PUT'&&!fault){fault=true;throw Object.assign(Error('idle'),{code:'SPACE_CHUNK_STALLED',transportPhase:'awaiting_response',requestBytes:4194304,responseBytes:0,reusedSocket:true});}}});
  await writeFile(f.paths[0],Buffer.alloc(6*1024*1024,43));
  await f.service.uploads('',[f.paths[0]]);await f.complete();
  const puts=f.calls.filter(c=>c.method==='PUT');assert.equal(puts[0].body.length,1024*1024);
  assert.ok(puts.slice(1).every(c=>c.body.length<=1024*1024));
  assert.ok(puts.every(c=>c.idleTimeoutMs===15000));
  assert.equal(Number(new URL(puts[1].path,'http://local').searchParams.get('offset')),1024*1024);
  assert.equal(f.remote.size,1);assert.equal([...f.remote.values()][0].publishes,1);
  assert.ok(f.events.some(e=>e.errorCode==='SPACE_CHUNK_STALLED'&&e.transportPhase==='awaiting_response'));
});

test('actual offline transition reduces the first resumed upload block without resetting its confirmed offset', async t => {
  let release,blocked=false; const gate=new Promise(r=>release=r);
  const f=await fixture(t,{before:async input=>{if(input.method==='PUT'&&input.path.includes('offset=4194304')&&!blocked){blocked=true;await gate;}}});
  await writeFile(f.paths[0],Buffer.alloc(6*1024*1024,17));
  await f.service.uploads('',[f.paths[0]]);await wait(()=>blocked);
  f.state({phase:'recovering',connection:null});release();await wait(()=>f.saved()[0]?.phase==='waiting');
  f.state({phase:'ready',connection:{deviceId:'79'}});await f.complete();
  const chunks=f.calls.filter(c=>c.method==='PUT');
  assert.equal(chunks[5].body.length,1024*1024);
  assert.ok(chunks[5].path.endsWith('offset=4194304'));
  assert.ok(chunks.every(c=>c.freshConnection===true));
  assert.equal(f.remote.size,1);assert.equal([...f.remote.values()][0].publishes,1);
});

test('persisted 4 MiB chunk preference is capped before the first restarted write', async t => {
  let rejected=false;
  const f=await fixture(t,{retryBaseMs:100,before:input=>{if(input.method==='PUT'&&!rejected){rejected=true;throw reset();}}});
  await writeFile(f.paths[0],Buffer.alloc(6*1024*1024,51));
  await f.service.uploads('',[f.paths[0]]);await wait(()=>f.service.snapshot().tasks[0]?.phase==='retrying');
  const count=f.calls.length;
  await f.restart(records=>records.map(record=>({...record,chunkSize:4*1024*1024})));
  await f.complete();
  const resumed=f.calls.slice(count).filter(c=>c.method==='PUT');
  assert.ok(resumed.length>0);assert.ok(resumed.every(c=>c.body.length<=1024*1024));
  assert.equal([...f.remote.values()][0].publishes,1);
});

test('a new 1 MiB plus one byte file has a one-byte final chunk and preserves its digest', async t => {
  const f=await fixture(t);
  const bytes=Buffer.alloc(1024*1024+1,19);await writeFile(f.paths[0],bytes);
  await f.service.uploads('',[f.paths[0]]);await f.complete();
  const chunks=f.calls.filter(c=>c.method==='PUT');assert.deepEqual(chunks.map(c=>c.body.length),[1024*1024,1]);
  assert.deepEqual([...f.remote.values()][0].bytes,bytes);
  assert.equal([...f.remote.values()][0].publishes,1);
});

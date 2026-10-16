import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createDriveClient} from '../host-sdk/drive.cjs';
import {createHostClient} from '../host-sdk/index.cjs';
import {createApplicationSession} from '../app-host/session.mjs';
import {createDashboardGateway} from '../octop/gateway.mjs';

const CHUNK = 4 * 1024 * 1024;
const hash = data => createHash('sha256').update(data).digest('hex');
const itemId = 'a'.repeat(32);

test('drive reads reject corrupt chunks and stale metadata before yielding bytes', async () => {
  for (const stale of [false, true]) {
    const data = Buffer.from('private data');
    const entry = {id: itemId, kind: 'file', size: data.length, digest: hash(data)};
    const drive = createDriveClient({context: async () => ({}), request: async route => route.endsWith('/content?offset=0&length=' + CHUNK)
      ? new Response(data, {headers: {'x-content-sha256': stale ? entry.digest : hash('bad'), etag: stale ? hash('changed') : entry.digest}})
      : Response.json(entry)});
    const reader = drive.read(itemId);
    await assert.rejects(reader.next(), {code: stale ? 'SPACE_REMOTE_FILE_CHANGED' : 'SPACE_CHUNK_INVALID'});
  }
});

test('drive recognizes old boxes and can retry initialization after temporary recovery', async () => {
  let ready = false;
  const drive = createDriveClient({
    context: async () => { if (!ready) throw Object.assign(new Error('NETWORK_NOT_READY'), {code: 'NETWORK_NOT_READY'}); },
    request: async () => new Response('not found', {status: 404}),
  });
  await assert.rejects(drive.overview(), {code: 'NETWORK_NOT_READY'});
  ready = true;
  await assert.rejects(drive.overview(), {code: 'SPACE_UPGRADE_REQUIRED'});
});

test('upload rejects size mismatches before publishing, and rejects a changed completed retry', async () => {
  let completed = false;
  const drive = createDriveClient({context: async () => ({}), request: async route => {
    if (route === '/api/personal-space/uploads') return Response.json({offset: 3, state: 'complete'});
    completed = true;
    return Response.json({id: itemId, size: 3, digest: hash('old')});
  }});
  await assert.rejects(drive.upload({name: 'file.txt', data: Buffer.from('abc'), size: 4}), {code: 'SPACE_INVALID_SIZE'});
  async function* short() { yield Buffer.from('ab'); }
  await assert.rejects(drive.upload({uploadId: itemId, name: 'file.txt', size: 3, data: short()}), {code: 'SPACE_INVALID_SIZE'});
  assert.equal(completed, false);
  await assert.rejects(drive.upload({uploadId: itemId, name: 'file.txt', data: 'new'}), {code: 'SPACE_LOCAL_FILE_CHANGED'});
});

test('two hosted apps share a real drive, stream large files, resume, and lose access on a box switch', {
  skip: !process.env.WANX_SPACE_PYTHON, timeout: 30_000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wanx-drive-sdk-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.env.WANX_SPACE_PYTHON, [fileURLToPath(new URL('./support/personal-space-api.py', import.meta.url)), root, String(port)], {stdio: ['ignore', 'ignore', 'pipe']});
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(errors);
    try { ready = (await fetch(url + '/api/personal-space/overview')).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(ready, errors);
  const upstream = await createDashboardGateway({targetURL: url, session: {getToken: () => 'test-only', close() {}}});
  t.after(() => upstream.close());
  let live = true;
  const listeners = new Set();
  const connection = {
    context() {
      if (!live) throw Object.assign(new Error('NETWORK_CHANGED'), {code: 'NETWORK_CHANGED'});
      return {boxId: 'test-box', user: {id: 1}, connection: 'ready'};
    },
    request: input => upstream.request(input),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const apps = [];
  for (const token of ['first-app', 'second-app']) {
    const gateway = await createApplicationSession({hostApplicationId: 'wanx', applicationId: token, installPath: root, createConnection: async () => connection});
    const client = createHostClient({baseURL: gateway.environment.WANX_HOST_BASE_URL, token: gateway.environment.WANX_HOST_TOKEN, timeoutMs: 60_000});
    t.after(async () => { client.close(); await gateway.close(); });
    apps.push(client);
  }
  const [first, second] = apps;
  const folder = await first.drive.mkdir({name: '应用共享资料'});
  const data = Buffer.alloc(CHUNK * 2 + 73, 42);
  async function* source() {
    // Producer boundaries intentionally differ from WANX's 4 MiB chunks.
    for (let offset = 0; offset < data.length; offset += 300_001) yield data.subarray(offset, offset + 300_001);
  }
  const progress = [];
  const entry = await first.drive.upload({name: 'report.bin', parent: folder.id, size: data.length, data: source(), onProgress: p => progress.push(p.offset)});
  assert.deepEqual(progress, [0, CHUNK, CHUNK * 2, data.length]);
  assert.equal((await second.drive.list({parent: folder.id})).items[0].id, entry.id);
  const received = [];
  for await (const chunk of second.drive.read(entry.id)) { assert.ok(chunk.length <= CHUNK); received.push(chunk); }
  assert.deepEqual(Buffer.concat(received), data);
  // An unfinished upload from one application can be resumed by another.
  const resumeId = 'b'.repeat(32);
  await first.drive.createUpload({uploadId: resumeId, parent: folder.id, name: 'resume.bin', size: data.length});
  await first.drive.writeChunk(resumeId, {offset: 0, data: data.subarray(0, 937)});
  const resumed = await second.drive.upload({uploadId: resumeId, parent: folder.id, name: 'resume.bin', size: data.length, data: source()});
  assert.equal(resumed.digest, hash(data));
  await first.drive.trash(entry.id);
  assert.ok((await second.drive.list({trash: true})).items.some(item => item.id === entry.id));
  await second.drive.restore(entry.id);
  assert.equal((await first.drive.stat(entry.id)).id, entry.id);
  const empty = await second.drive.upload({name: 'empty.txt', data: ''});
  for await (const _ of first.drive.read(empty.id)) assert.fail('empty file yielded bytes');
  await second.drive.trash(empty.id); await first.drive.purge(empty.id);
  const saved = await fetch(url + '/api/personal-space/files?parent=' + folder.id).then(r => r.json());
  assert.equal(saved.items.length, 2); // Management UI and apps see the same store.
  live = false; for (const listener of listeners) listener();
  await assert.rejects(first.drive.list(), {code: 'HOST_SESSION_EXPIRED'});
  await assert.rejects(second.drive.upload({name: 'wrong-box.txt', data: 'no'}), {code: 'HOST_SESSION_EXPIRED'});
});

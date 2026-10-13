import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAdvertisementNames } from '../shell/discovery-names.mjs';

const peripheralId = '01234567-89AB-CDEF-0123-456789ABCDEF';
const otherPeripheral = '11234567-89AB-CDEF-0123-456789ABCDEF';
const serviceUuid = 'f6c7b7a0-5a0f-4b7f-9f3f-4d3f7b5a1000';
const record = (overrides = {}) => ({ peripheralId, serviceUuid, advertisedName: 'CentaurOS-Setup-ABCD', ...overrides });
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
function harness(options = {}, callback) {
  const children = [], calls = [], events = [];
  const provider = createAdvertisementNames({ helperPath: '/native/helper', platform: 'darwin',
    spawn(path, args, options) {
      calls.push({ path, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kills = [];
      child.kill = (signal) => child.kills.push(signal);
      children.push(child); return child;
    }, ...options });
  const unsubscribe = provider.subscribe(callback || ((event) => events.push(event)));
  return { provider, children, calls, events, unsubscribe, child: children[0],
    send(value, index = 0) { children[index].stdout.emit('data', bytes(value)); } };
}

test('maps the exact peripheral UUID to Chromium ID and reassembles split UTF-8 JSONL', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  const input = bytes(record({ peripheralId: peripheralId.toLowerCase(), advertisedName: '办公室盒子' }));
  const split = input.indexOf(Buffer.from('办')) + 1;
  h.child.stdout.emit('data', input.subarray(0, split));
  assert.equal(h.events.length, 0);
  h.child.stdout.emit('data', input.subarray(split));
  assert.deepEqual(h.events, [{ deviceId: '7E:07:C7:F3:49:AC', advertisedName: '办公室盒子' }]);
  assert.deepEqual(h.calls, [{ path: '/native/helper', args: [], options: { stdio: ['ignore', 'pipe', 'pipe'] } }]);
  h.send(record({ advertisedName: '办公室盒子' }));
  assert.equal(h.events.length, 1, 'UUID casing and duplicate metadata are equivalent');
});

test('same advertisement name can gain, update and withdraw its public identity hint', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  h.send(record());
  h.send(record({ displayIdentity: { deviceId: 'box-01', displayName: '  我的盒子  ' } }));
  h.send(record({ displayIdentity: { deviceId: 'box-01', displayName: '我的盒子' } }));
  h.send(record({ displayIdentity: { deviceId: 'box-01', displayName: '新名称' } }));
  h.send(record()); // Omission preserves the session hint.
  h.send(record({ displayIdentity: null }));
  h.send(record({ displayIdentity: null }));
  assert.equal(h.events.length, 4);
  assert.deepEqual(h.events[1].displayIdentity, { deviceId: 'box-01', displayName: '我的盒子' });
  assert.deepEqual(h.events[2].displayIdentity, { deviceId: 'box-01', displayName: '新名称' });
  assert.equal(h.events[3].displayIdentity, null);
});

test('blank public name falls back to full ID and generic protocol names are preserved', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  h.send(record({ displayIdentity: { deviceId: 'box-01', displayName: '   ' } }));
  h.send(record({ displayIdentity: { deviceId: 'box-01', displayName: 'CentaurAI Box' } }));
  assert.deepEqual(h.events[0].displayIdentity, { deviceId: 'box-01' });
  assert.deepEqual(h.events[1].displayIdentity, { deviceId: 'box-01', displayName: 'CentaurAI Box' });
});

test('invalid identities do not poison existing metadata or discard a valid new advertisement name', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  const displayIdentity = { deviceId: 'box-01', displayName: '合法名称' };
  h.send(record({ displayIdentity }));
  for (const invalid of [[], {}, { deviceId: '../bad' }, { deviceId: 'a'.repeat(37) },
    { deviceId: 'box-01', displayName: '' }, { deviceId: 'box-01', displayName: 'a'.repeat(65) },
    { deviceId: 'box-01', displayName: 'bad\nname' }, { deviceId: 'box-01', displayName: 12 },
    { deviceId: 'box-01', secret: true }]) h.send(record({ displayIdentity: invalid }));
  assert.equal(h.events.length, 1);
  h.send(record({ advertisedName: '新广播名', displayIdentity: { deviceId: 'bad/id' } }));
  assert.equal(h.events.length, 2);
  assert.equal(Object.hasOwn(h.events[1], 'displayIdentity'), false);
  h.send(record({ advertisedName: '新广播名', displayIdentity }));
  assert.equal(h.events.length, 2, 'valid prior identity was retained');
  h.send(record({ advertisedName: '新广播名', displayIdentity: null }));
  assert.equal(h.events.length, 3);
});

test('invalid origin/service/name/DTO/UTF-8 records never become metadata', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  for (const value of [null, [], {}, record({ peripheralId: 'ABCD' }), record({ serviceUuid: 'wrong' }),
    record({ advertisedName: '' }), record({ advertisedName: null }), record({ advertisedName: 'a'.repeat(65) }),
    record({ advertisedName: 'name\u0085bad' }), record({ deviceId: 'injected' })]) h.send(value);
  h.child.stdout.emit('data', Buffer.from([0xff, 0x0a]));
  h.child.stdout.emit('data', Buffer.from('{incomplete}\n'));
  assert.deepEqual(h.events, []);
  h.send(record());
  assert.equal(h.events.length, 1, 'bad records do not prevent later valid records');
});

test('bad hash implementations fail closed', (t) => {
  for (const hash of [() => { throw Error('unavailable'); }, () => 'not bytes', () => Buffer.alloc(5)]) {
    const h = harness({ hash }); t.after(h.unsubscribe); h.send(record());
    assert.deepEqual(h.events, []);
  }
});

test('a provider ID collision revokes previous names and identities and blocks later hints', (t) => {
  const h = harness({ hash: () => Buffer.alloc(32, 1) }); t.after(h.unsubscribe);
  h.send(record({ displayIdentity: { deviceId: 'box-01' } }));
  h.send(record({ peripheralId: otherPeripheral, displayIdentity: { deviceId: 'box-02' } }));
  h.send(record({ advertisedName: 'must not return' }));
  assert.deepEqual(h.events, [
    { deviceId: '01:01:01:01:01:01', advertisedName: 'CentaurOS-Setup-ABCD', displayIdentity: { deviceId: 'box-01' } },
    { deviceId: '01:01:01:01:01:01', advertisedName: null },
  ]);
});

test('a collision within one chunk exposes neither candidate', (t) => {
  const h = harness({ hash: () => Buffer.alloc(32, 1) }); t.after(h.unsubscribe);
  h.child.stdout.emit('data', Buffer.concat([bytes(record()), bytes(record({ peripheralId: otherPeripheral }))]));
  assert.deepEqual(h.events, []);
});

test('limits a session to 128 distinct peripheral mappings', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  for (let i = 0; i < 129; i++) h.send(record({ peripheralId: `${i.toString(16).padStart(8, '0')}-89AB-CDEF-0123-456789ABCDEF` }));
  assert.equal(h.events.length, 128);
  assert.deepEqual(h.child.kills, ['SIGTERM']);
});

test('bounds complete and partial lines, record count, total stdout and stderr', async (t) => {
  const cases = {
    'complete line': (h) => h.child.stdout.emit('data', Buffer.alloc(2050, 0x0a).fill(0x20, 0, 2049)),
    'partial line': (h) => h.child.stdout.emit('data', Buffer.alloc(2049, 0x20)),
    'records': (h) => { for (let i = 0; i < 257; i++) h.child.stdout.emit('data', Buffer.from('\n')); },
    'stdout': (h) => { for (let i = 0; i < 65; i++) h.child.stdout.emit('data', Buffer.from(`${' '.repeat(1023)}\n`)); },
    'stderr': (h) => { h.child.stderr.emit('data', Buffer.alloc(4096)); assert.equal(h.child.kills.length, 0); h.child.stderr.emit('data', Buffer.from('x')); },
  };
  for (const [label, run] of Object.entries(cases)) await t.test(label, () => {
    const h = harness(); t.after(h.unsubscribe); run(h);
    assert.deepEqual(h.child.kills, ['SIGTERM']);
    h.send(record()); assert.deepEqual(h.events, []);
  });
});

test('permits 128 names plus 128 identity updates within the 256-line budget', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  for (let i = 0; i < 128; i++) {
    const peripheral = `${i.toString(16).padStart(8, '0')}-89AB-CDEF-0123-456789ABCDEF`;
    h.send(record({ peripheralId: peripheral }));
    h.send(record({ peripheralId: peripheral, displayIdentity: { deviceId: `box-${i}` } }));
  }
  assert.equal(h.events.length, 256);
  assert.deepEqual(h.child.kills, []);
});

test('cancellation is idempotent and isolates saved late callbacks from the next session', (t) => {
  const h = harness();
  const stale = h.child.stdout.listeners('data')[0];
  h.unsubscribe(); h.unsubscribe();
  assert.deepEqual(h.child.kills, ['SIGTERM']);
  const fresh = []; const cancel = h.provider.subscribe((value) => fresh.push(value)); t.after(cancel);
  stale(bytes(record({ advertisedName: 'late old name' })));
  h.send(record(), 1);
  assert.deepEqual(h.events, []); assert.equal(fresh.length, 1);
  assert.equal(fresh[0].advertisedName, 'CentaurOS-Setup-ABCD');
  assert.doesNotThrow(() => h.child.emit('error', Error('late child error')));
  assert.doesNotThrow(() => h.child.stdout.emit('error', Error('late stream error')));
});

test('the 13 second deadline stops helpers and discards a late completion', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); t.after(h.unsubscribe);
  const stale = h.child.stdout.listeners('data')[0];
  t.mock.timers.tick(12999); assert.equal(h.child.kills.length, 0);
  t.mock.timers.tick(1); assert.deepEqual(h.child.kills, ['SIGTERM']);
  stale(bytes(record())); assert.deepEqual(h.events, []);
});

test('normal close drops incomplete lines without killing; errors stop and remain silent', (t) => {
  const h = harness(); t.after(h.unsubscribe);
  h.child.stdout.emit('data', bytes(record()).subarray(0, -1)); h.child.emit('close', 0);
  assert.deepEqual(h.events, []); assert.deepEqual(h.child.kills, []);
  for (const stream of ['child', 'stdout', 'stderr']) {
    const failed = harness(); t.after(failed.unsubscribe);
    (stream === 'child' ? failed.child : failed.child[stream]).emit('error', Error('failed'));
    assert.deepEqual(failed.child.kills, ['SIGTERM']);
    failed.send(record()); assert.deepEqual(failed.events, []);
  }
});

test('non-Mac, missing helper and spawn failure leave ordinary discovery available', () => {
  let spawns = 0;
  const spawn = () => { spawns++; throw Error('missing helper'); };
  for (const options of [{ platform: 'linux', helperPath: '/helper' }, { platform: 'darwin' }]) {
    const cancel = createAdvertisementNames({ ...options, spawn }).subscribe(() => assert.fail('unexpected hint'));
    cancel();
  }
  assert.equal(spawns, 0);
  assert.doesNotThrow(() => createAdvertisementNames({ platform: 'darwin', helperPath: '/helper', spawn }).subscribe(() => {})());
  assert.equal(spawns, 1);
});

test('subscriber errors and mutation do not break deduplication or cancellation', (t) => {
  let called = 0;
  const h = harness({}, (value) => { called++; value.displayIdentity.deviceId = 'mutated'; throw Error('subscriber'); });
  t.after(h.unsubscribe);
  const input = record({ displayIdentity: { deviceId: 'box-01' } });
  h.send(input); h.send(input);
  assert.equal(called, 1);
  h.unsubscribe(); assert.deepEqual(h.child.kills, ['SIGTERM']);
});

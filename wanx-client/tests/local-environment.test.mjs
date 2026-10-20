import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localEnvironment } from '../tools/local-environment.mjs';

function fixture(t, content) {
  const root = mkdtempSync(path.join(tmpdir(), 'wanx-local-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (content !== undefined) writeFileSync(path.join(root, '.env.local'), content);
  return root;
}

test('local launch isolates endpoint, profile and TLS from inherited production variables', t => {
  const root = fixture(t, 'WANX_CONSUMER_URL=https://admin.localtest.me\nNODE_EXTRA_CA_CERTS="/test CA/rootCA.pem"\n');
  const inherited = { PATH: '/test', WANX_CONSUMER_URL: 'https://production.example',
    WANX_SMOKE_USER_DATA: '/daily-profile', NEXUSAOS_ENV_FILE: '/production.env',
    NODE_OPTIONS: '--require=hook', NODE_TLS_REJECT_UNAUTHORIZED: '0' };
  const snapshot = { ...inherited };
  assert.deepEqual(localEnvironment(root, inherited), { PATH: '/test',
    WANX_CONSUMER_URL: 'https://admin.localtest.me', NODE_EXTRA_CA_CERTS: '/test CA/rootCA.pem',
    WANX_SMOKE_USER_DATA: path.join(root, '.local', 'user-data') });
  assert.deepEqual(inherited, snapshot);
});

test('local launch fails closed without its file', t => {
  assert.throws(() => localEnvironment(fixture(t)), /ENOENT/);
});

for (const url of ['https://production.example', 'http://localhost', 'https://localtest.me.evil.test',
  'https://user:password@localhost', 'https://localhost?redirect=production']) {
  test(`local launch refuses ${url}`, t => {
    assert.throws(() => localEnvironment(fixture(t, `WANX_CONSUMER_URL=${url}\n`)), /LOCAL_ENV_REQUIRES_LOCAL_HTTPS/);
  });
}

test('local file cannot disable TLS or inject arbitrary startup variables', t => {
  assert.throws(() => localEnvironment(fixture(t,
    'WANX_CONSUMER_URL=https://localhost\nNODE_TLS_REJECT_UNAUTHORIZED=0\n')), /LOCAL_ENV_UNSUPPORTED_KEY/);
});

test('production startup and packaged files exclude the local launcher and config', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['start:local'], 'node tools/start-local.mjs');
  assert.equal(pkg.scripts.start.includes('start-local'), false);
  for (const pattern of ['!**/.env', '!**/.env.*', '!**/.local/**']) assert.ok(pkg.build.files.includes(pattern));
  assert.equal(pkg.build.files.includes('tools/**'), false);
  const launcher = readFileSync(new URL('../tools/start-desktop.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(launcher, /localEnvironment|\.env\.local/);
});

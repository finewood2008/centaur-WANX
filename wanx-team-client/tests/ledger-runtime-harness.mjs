import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// Only a freshly generated fixture is started. No normal desktop entry,
// environment configuration, user account or existing profile is loaded.
export async function startLedgerRuntime(t, { backup = false, transfer = false, team = false } = {}) {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const child = spawn('rtk', ['proxy', process.env.WANX_TEST_PYTHON || `${cwd}${backup || transfer ? '.venv' : 'wanx-bridge/.venv'}/bin/python`,
    fileURLToPath(new URL('./device-trust-ledger-runtime.fixture.py', import.meta.url)), ...(transfer ? ['--transfer'] : backup ? ['--backup'] : team ? ['--team'] : [])], {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: [process.env.WANX_TEST_PYTHONPATH, `${cwd}wanx-bridge`, `${cwd}src`, `${cwd}packages/local-data-gate`, `${cwd}wanx-studio/backend`].filter(Boolean).join(':') },
  });
  const queue = [], waiting = [];
  let stderr = '', ended = false;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const next = waiting.shift(); if (next) next.resolve(value); else queue.push(value);
  });
  child.once('exit', () => { ended = true; for (const next of waiting.splice(0)) next.reject(new Error('Synthetic authority exited before response')); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    if (ended) return reject(new Error('Synthetic authority exited'));
    const entry = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
    const timer = setTimeout(() => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(new Error('Synthetic authority response deadline')); }, 15000);
    waiting.push(entry);
  });
  const close = async () => {
    if (ended) return;
    child.stdin.end(`${JSON.stringify({ operation: 'stop' })}\n`);
    await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    lines.close();
  };
  t.after(close);
  const ready = await next();
  if (ready.type !== 'ready') throw new Error('Synthetic authority did not return readiness');
  return { ...ready, close, diagnostic: () => stderr,
    async command(operation, input = {}) {
      child.stdin.write(`${JSON.stringify({ ...input, operation })}\n`);
      const result = await next();
      if (result.type !== ({ migrate: 'migrated', restart: 'restarted', 'backup.seed': 'seeded', 'backup.inspect': 'inspected', 'backup.run': 'ran',
        'challenge.saturate': 'saturated', 'wanx.ensure': 'namespace-ready', 'wanx.seed': 'wanx-data', 'wanx.inspect': 'wanx-data',
        'transfer.authorize': 'transfer-step', 'transfer.prepare': 'transfer-step', 'transfer.finish': 'transfer-step', 'transfer.inspect': 'transfer-inspected' })[operation]) throw new Error('Synthetic authority control failed');
      return result;
    },
  };
}

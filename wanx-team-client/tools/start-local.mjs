import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localEnvironment } from './local-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = localEnvironment(root);
// Spawn a fresh Node process so NODE_EXTRA_CA_CERTS is applied at process startup.
const child = spawn(process.execPath, [fileURLToPath(new URL('./start-desktop.mjs', import.meta.url))], {
  cwd: root, env, stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal); });

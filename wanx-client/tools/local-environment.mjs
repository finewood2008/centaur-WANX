import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';

// Only the explicit development launcher calls this. No production auto-loading.
export function localEnvironment(root, inherited = process.env) {
  const values = parseEnv(readFileSync(path.join(root, '.env.local'), 'utf8'));
  const allowed = new Set(['WANX_CONSUMER_URL', 'NODE_EXTRA_CA_CERTS']);
  const url = new URL(values.WANX_CONSUMER_URL || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      !['localhost', '127.0.0.1', '[::1]', 'localtest.me'].includes(url.hostname) && !url.hostname.endsWith('.localtest.me'))
    throw new Error('LOCAL_ENV_REQUIRES_LOCAL_HTTPS');
  // Validate the endpoint first: some supported Node runtimes also emit an
  // extra parsed key for '=' inside a URL query. The URL must still receive
  // the same rejection, while every unknown configuration key remains denied.
  if (Object.keys(values).some(key => !allowed.has(key))) throw new Error('LOCAL_ENV_UNSUPPORTED_KEY');
  // A local launch cannot inherit production account endpoints or TLS bypasses.
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^(WANX_|NEXUSAOS_|QEETOKEN_|CREDITS_|CONSUMER_|NODE_OPTIONS$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_EXTRA_CA_CERTS$)/.test(key)));
  return { ...env, ...values, WANX_SMOKE_USER_DATA: path.join(root, '.local', 'user-data') };
}

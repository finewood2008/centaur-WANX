import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccount } from '../account/index.mjs';
import { createPairingConsumer } from '../account/pairing.mjs';
const id = '5a54b4ae-2efe-48e5-9e9c-53e366e33976';
const view = { pairingSessionId: id, deviceId: 'box-new', claimState: 'waitingAppProof', expiresAt: '2026-10-11T10:00:00Z', updatedAt: '2026-10-11T09:59:00Z', retryable: false, pollAfterMs: 1000, resourceVersion: 1 };
const prepare = { deviceId: 'box-new', pairingSessionId: id, clientAttemptId: id, protocolVersion: 2, transport: 'ble-gatt', expiresInSeconds: 120 };
async function harness() {
  let saved, responseHeader = 'req-1', requestCount = 0, nextStatus = 200;
  const calls = [];
  const account = createAccount({
    store: { load: async () => saved, save: async (v) => { saved = v; } },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (url.endsWith('/login')) return Response.json({ code: 200, data: {
        accountId: 'account-one', clientId: JSON.parse(options.body).clientId,
        accessToken: 'private-token', refreshToken: 'private-refresh', expiresIn: 3600,
      } });
      if (url.endsWith('/logout')) return Response.json({ code: 200, data: {} });
      if (url.endsWith('/refresh')) return Response.json({ code: 200, data: {
        ...saved.active.session, expiresIn: 3600,
      } });
      requestCount++;
      const status = nextStatus; nextStatus = 200;
      if (status === 401) return Response.json({ code: 401 }, { status });
      return Response.json({ code: 0, success: true, data: view, requestId: 'req-1', serverTime: '2026-10-11T09:59:00Z' },
        { headers: { 'x-request-id': responseHeader } });
    },
  });
  await account.loginPassword({ phone: '13800000000', password: 'password' });
  const consumer = createPairingConsumer(account);
  return { account, consumer, calls, setHeader: (v) => { responseHeader = v; }, expire: () => { nextStatus = 401; }, count: () => requestCount };
}
test('pairing reuses the active account and signs V1 requests with an idempotency key', async () => {
  const h = await harness();
  const api = await h.consumer.pairingApi();
  const result = await api.preparePairing(prepare, id);
  assert.deepEqual(result.data, view);
  assert.equal(result.requestId, 'req-1');
  assert.equal(typeof result.receivedMonotonicMs, 'number');
  const request = h.calls.at(-1);
  assert.equal(request.headers['Idempotency-Key'], id);
  assert.equal(request.headers['X-Nexus-Client-Id'], h.account.getIdentity().clientId);
  assert.equal(request.headers['X-Nexus-Signature-Version'], 'NEXUSAOS-CONSUMER-APP-V1');
  assert.ok(!JSON.stringify(result).includes('private-token'));
  h.consumer.dispose(); await h.account.close();
});
test('pairing rejects wrong envelope metadata and can refresh an expired account', async () => {
  const h = await harness(); const api = await h.consumer.pairingApi();
  h.setHeader('mismatch');
  await assert.rejects(api.getPairing(id), { code: 'ACCOUNT_INVALID_RESPONSE' });
  h.setHeader('req-1'); h.expire();
  const result = await api.getPairing(id);
  assert.equal(result.data.deviceId, 'box-new');
  assert.equal(h.count(), 3);
  h.consumer.dispose(); await h.account.close();
});
test('old pairing port cannot make requests after logout, or forge another client identity', async () => {
  const h = await harness(); const api = await h.consumer.pairingApi();
  assert.throws(() => api.preparePairing(prepare, 'wrong'), { code: 'INVALID_REQUEST' });
  await h.account.logout(); const before = h.calls.length;
  await assert.rejects(api.getPairing(id), { code: 'AUTH_REQUIRED' });
  assert.equal(h.calls.length, before);
  h.consumer.dispose(); await h.account.close();
});

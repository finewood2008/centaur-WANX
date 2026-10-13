import {
  validateConsumerApiResult, validatePairingPrepareRequest,
  validatePairingProveRequest, validatePairingView,
  validateDeviceAttestationView, validatePairingCancelView,
} from '@nexusaos/consumer-contracts';

const fail = (code) => Object.assign(new Error(code), { code });
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const deviceID = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,36}$/.test(value) && !['.', '..'].includes(value);

// Reuse the logged-in account's signing, refresh and cancellation; never own tokens.
export function createPairingConsumer(account) {
  let revision = 0;
  const unsubscribe = account.subscribe(() => { revision++; });
  const current = async () => {
    const identity = account.getIdentity();
    if (!identity || account.snapshot().phase !== 'authenticated') throw fail('AUTH_REQUIRED');
    return identity;
  };
  return {
    current,
    dispose: unsubscribe,
    async pairingApi() {
      const identity = await current();
      const generation = revision;
      async function check() {
        const next = await current();
        if (generation !== revision || identity.accountId !== next.accountId || identity.clientId !== next.clientId)
          throw fail('AUTH_SESSION_CHANGED');
      }
      async function request(path, validate, { method = 'GET', body, signal, idempotencyKey } = {}) {
        await check();
        signal?.throwIfAborted();
        const result = await account.request({ path, method, body, signal, idempotencyKey, responseMetadata: true });
        await check();
        signal?.throwIfAborted();
        if (!validateConsumerApiResult(result, validate)) throw fail('CONTRACT_MISMATCH');
        return result;
      }
      return {
        preparePairing(input, idempotencyKey, signal) {
          if (!validatePairingPrepareRequest(input) || input.clientAttemptId !== idempotencyKey) throw fail('INVALID_REQUEST');
          return request('/app-api/v1/device-pairing/prepare', validatePairingView, { method: 'POST', body: input, idempotencyKey, signal });
        },
        getDeviceAttestation(deviceId, pairingSessionId, signal) {
          if (!deviceID(deviceId) || !uuid(pairingSessionId)) throw fail('INVALID_REQUEST');
          return request(`/app-api/v1/device-attestations/${encodeURIComponent(deviceId)}?pairingSessionId=${encodeURIComponent(pairingSessionId)}`, validateDeviceAttestationView, { signal });
        },
        provePairing(input, idempotencyKey, signal) {
          if (!validatePairingProveRequest(input) || input.clientId !== identity.clientId || !uuid(idempotencyKey)) throw fail('INVALID_REQUEST');
          return request('/app-api/v1/device-pairing/prove', validatePairingView, { method: 'POST', body: input, idempotencyKey, signal });
        },
        getPairing(pairingSessionId, signal) {
          if (!uuid(pairingSessionId)) throw fail('INVALID_REQUEST');
          return request(`/app-api/v1/device-pairing/${pairingSessionId}`, validatePairingView, { signal });
        },
        cancelPairing(pairingSessionId, idempotencyKey, signal) {
          if (!uuid(pairingSessionId) || !uuid(idempotencyKey)) throw fail('INVALID_REQUEST');
          return request(`/app-api/v1/device-pairing/${pairingSessionId}/cancel`, validatePairingCancelView,
            { method: 'POST', body: { reason: 'user_cancelled' }, idempotencyKey, signal });
        },
        syncBootstrap(signal) {
          return request('/app-api/v1/sync/bootstrap', (data) =>
            data?.account?.accountId === identity.accountId &&
            data.account.currentClient?.clientId === identity.clientId &&
            data.account.currentClient.isCurrent === true &&
            data.account.accountStatus === 'active' &&
            data.account.currentClient.clientStatus === 'active' &&
            data.account.currentClient.hasActiveSession === true && Array.isArray(data.devices), { signal });
        },
      };
    },
  };
}

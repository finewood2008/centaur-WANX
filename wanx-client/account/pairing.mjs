import {
  validateConsumerApiResult, validatePairingPrepareRequest,
  validatePairingProveRequest, validatePairingView,
  validateDeviceAttestationView, validatePairingCancelView,
} from '@nexusaos/consumer-contracts';

const fail = (code) => Object.assign(new Error(code), { code });
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const deviceID = (value) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,36}$/.test(value) && !['.', '..'].includes(value);
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key));
const hex = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const b64 = (value, size) => typeof value === 'string' && Buffer.from(value, 'base64').length === size && Buffer.from(value, 'base64').toString('base64') === value;
const nonce = (value, size) => typeof value === 'string' && Buffer.from(value, 'base64url').length === size && Buffer.from(value, 'base64url').toString('base64url') === value;
const safeText = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/u.test(value);
function validateOwnerWifiRequest(input) {
  return exact(input, ['deviceId', 'clientId', 'pairingSessionId', 'helloContextId', 'appNonce', 'clientAttemptId',
    'clientNonce', 'pairingDeviceNonce', 'challengeNonce', 'deviceInfoSha256', 'signature', 'pairingTokenCiphertextSha256']) &&
    deviceID(input.deviceId) && safeText(input.clientId, 64) && uuid(input.pairingSessionId) && uuid(input.clientAttemptId) &&
    nonce(input.helloContextId, 16) && ['appNonce', 'clientNonce', 'pairingDeviceNonce', 'challengeNonce'].every((key) => nonce(input[key], 32)) &&
    hex(input.deviceInfoSha256) && hex(input.pairingTokenCiphertextSha256) && [256, 384, 512].some((size) => b64(input.signature, size));
}
function validateOwnerWifiPermit(data) {
  const permit = data?.permit, grant = permit?.payload;
  return exact(data, ['permit']) && exact(permit, ['payload', 'keyId', 'algorithm', 'signature']) &&
    permit.algorithm === 'Ed25519' && safeText(permit.keyId, 64) && b64(permit.signature, 64) &&
    exact(grant, ['schemaVersion', 'purpose', 'deviceId', 'ownerAccountId', 'bindingId', 'ownershipEpoch', 'authVersion',
      'clientId', 'pairingSessionId', 'challengeCanonicalSha256', 'pairingTokenCiphertextSha256', 'expiresInSeconds']) &&
    grant.schemaVersion === 1 && grant.purpose === 'owner-wifi' && grant.expiresInSeconds === 300 &&
    deviceID(grant.deviceId) && safeText(grant.ownerAccountId) && safeText(grant.bindingId) && safeText(grant.clientId, 64) &&
    uuid(grant.pairingSessionId) && hex(grant.challengeCanonicalSha256) && hex(grant.pairingTokenCiphertextSha256) &&
    Number.isSafeInteger(grant.ownershipEpoch) && grant.ownershipEpoch > 0 && Number.isSafeInteger(grant.authVersion) && grant.authVersion > 0;
}

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
        getOwnerWifiAttestation(deviceId, signal) {
          if (!deviceID(deviceId)) throw fail('INVALID_REQUEST');
          return request(`/app-api/v1/devices/${encodeURIComponent(deviceId)}/wifi-attestation`, validateDeviceAttestationView, { signal });
        },
        authorizeOwnerWifi(input, signal) {
          if (!validateOwnerWifiRequest(input) || input.clientId !== identity.clientId) throw fail('INVALID_REQUEST');
          return request('/app-api/v1/device-wifi/authorize', validateOwnerWifiPermit,
            { method: 'POST', body: input, signal });
        },
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

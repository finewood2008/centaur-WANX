import { randomBytes, randomUUID } from 'node:crypto';
import { createPairingToken, createSecureChannel, deriveSessionKeys, encodeJsonLine, parseJsonLine,
  stableJson, validateWifi, verifyKeyConfirm } from '@nexusaos/local-provisioning-core';
import { createNodeProvisioningCryptoProvider } from '@nexusaos/local-provisioning-core/node';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { verifyWifiProof, wifiCanonical, wifiDigest, wifiByteDigest, wifiAeadDeviceId } from './offline-wifi-contract.mjs';

const failure = code => Object.assign(new Error(code), { code });
const need = (value, code = 'LOCAL_WIFI_INVALID') => { if (!value) throw failure(code); };
const exact = (value, keys) => need(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
const nonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
const payload = value => { if (value.status === 'failed') throw failure(/^[A-Z][A-Z0-9_]{1,80}$/.test(value.error?.code?.toUpperCase()) ? value.error.code.toUpperCase() : 'LOCAL_WIFI_INVALID'); return value.payload; };
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});

// BLE is the only transport. No account, Consumer API or LAN adapter is accepted.
export function createOfflineWifiCoordinator({ vault, box, run, requireProfile, transportFactory,
  crypto = createNodeProvisioningCryptoProvider(), monotonicMs = () => performance.now() }) {
  let flow, epoch = 0;
  function invalidate() {
    epoch++;
    const current = flow; flow = undefined;
    if (current) {
      clearTimeout(current.timer); current.abort.abort(); current.review = undefined;
      current.channel?.destroy(); current.channel = undefined;
      void current.transport?.close().catch(() => {});
    }
  }
  const snapshot = current => ({ boxId: current.boxId, state: current.state,
    ...(current.receipt ? { authorizationVersion: current.receipt.context.authorizationVersion } : {}) });
  function current(guard) {
    guard(); requireProfile();
    need(flow && !flow.abort.signal.aborted, 'LOCAL_WIFI_SESSION_REQUIRED');
    need(monotonicMs() < flow.deadline, 'LOCAL_WIFI_EXPIRED');
    return flow;
  }
  function check(value, guard) {
    guard(); need(flow === value && value.epoch === epoch, 'LOCAL_TRUST_CONTEXT_CHANGED');
    value.abort.signal.throwIfAborted();
    need(monotonicMs() < value.deadline, 'LOCAL_WIFI_EXPIRED');
  }
  const execute = operation => run(async guard => {
    try { return await operation(guard); }
    catch (error) { invalidate(); throw error; }
  });
  async function plain(value, type, input, guard) {
    check(value, guard);
    const requestId = randomUUID();
    const frame = encodeJsonLine({ schema_version: 2, request_id: requestId, message_type: type,
      ...(value.pairingSessionId ? { pairing_session_id: value.pairingSessionId } : {}), payload: input });
    need(frame.length <= 2048, 'LOCAL_WIFI_FRAME_TOO_LARGE');
    const raw = await value.transport.request(frame, { requestId, responseMessageType: `${type}.result` }, value.abort.signal);
    check(value, guard);
    const response = parseJsonLine(raw);
    if (response?.status === 'failed') payload(response);
    exact(response, ['schema_version', 'request_id', 'message_type', 'status', 'pairing_session_id', 'payload']);
    need(response.schema_version === 2 && response.request_id === requestId && response.message_type === `${type}.result` &&
      response.status === 'completed' && (value.pairingSessionId ? response.pairing_session_id === value.pairingSessionId : typeof response.pairing_session_id === 'string'));
    return { body: response.payload, sessionId: response.pairing_session_id };
  }
  async function chunks(value, type, length, guard) {
    need(Number.isSafeInteger(length) && length > 0 && length <= 16384);
    let text = '', offset = 0;
    while (offset < length) {
      const { body } = await plain(value, type, { offset }, guard);
      exact(body, ['chunk', 'total', 'next_offset']);
      need(typeof body.chunk === 'string' && /^[\x00-\x7f]{1,1024}$/.test(body.chunk) && body.total === length &&
        body.chunk.length <= length - offset && body.next_offset === offset + body.chunk.length);
      text += body.chunk; offset += body.chunk.length;
    }
    let result; try { result = JSON.parse(text); } catch { throw failure('LOCAL_WIFI_INVALID'); }
    need(wifiCanonical(result) === text);
    return result;
  }
  async function secure(value, type, body, guard, sealed) {
    check(value, guard);
    const requestId = sealed?.requestId || randomUUID();
    const frame = sealed?.frame || await value.channel.sealRequest(requestId, type, body);
    check(value, guard); need(frame.length <= 2048, 'LOCAL_WIFI_FRAME_TOO_LARGE');
    const reply = await value.transport.request(frame, { requestId, responseMessageType: `${type}.result` }, value.abort.signal);
    check(value, guard);
    const result = await value.channel.openIncoming(reply, { requestId, messageType: type });
    check(value, guard); return payload(result);
  }
  return {
    invalidate,
    api: {
      beginOfflineWifi(input) { return execute(async guard => {
        invalidate();
        const profile = requireProfile(), association = box(input.boxId);
        need(association.bindingId && association.principalId && association.checkpoint?.ownershipEpoch > 0, 'LOCAL_WIFI_UNAUTHORIZED');
        need(transportFactory?.connect, 'LOCAL_WIFI_UNAVAILABLE');
        const value = { boxId: input.boxId, association, epoch, state: 'connecting', abort: new AbortController(), deadline: monotonicMs() + 120000 };
        flow = value;
        value.timer = setTimeout(() => { if (flow === value) invalidate(); }, 120000); value.timer.unref?.();
        const connected = await transportFactory.connect(input.selected, value.abort.signal);
        if (flow !== value || value.abort.signal.aborted) { await connected.close(); check(value, guard); }
        value.transport = connected; check(value, guard);
        const clientNonce = randomBytes(32).toString('base64url');
        const { body: start, sessionId } = await plain(value, 'local.wifi.start', {
          box_id: input.boxId, client_id: profile.clientId, client_nonce: clientNonce }, guard);
        exact(start, ['pairing_session_id', 'pairing_device_nonce', 'rsa_spki_der', 'expires_in_seconds', 'requested_ops', 'transport']);
        need(start.pairing_session_id === sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId) && nonce(start.pairing_device_nonce) &&
          start.expires_in_seconds === 120 && stableJson(start.requested_ops) === '["wifi.apply"]' && start.transport === 'ble-gatt');
        value.pairingSessionId = sessionId;
        const spki = Buffer.from(start.rsa_spki_der, 'base64');
        need(spki.length >= 256 && spki.length <= 1024 && spki.toString('base64') === start.rsa_spki_der);
        const rsaSpkiSha256 = wifiByteDigest(spki);
        const ble = { pairingSessionId: sessionId, rsaSpkiSha256, challengeCanonicalSha256: wifiByteDigest(wifiCanonical({
          purpose: 'centuarai.local-wifi.ble.v1', pairingSessionId: sessionId, boxId: input.boxId,
          clientId: profile.clientId, clientNonce, pairingDeviceNonce: start.pairing_device_nonce, rsaSpkiSha256 })) };
        const intent = { schemaVersion: 1, purpose: 'centuarai.local-wifi.intent.v1', boxId: input.boxId,
          boxKeyThumbprint: publicKeyThumbprint(association.descriptor.boxKey), ownershipEpoch: association.checkpoint.ownershipEpoch,
          bindingId: association.bindingId, clientId: profile.clientId, ble, nonce: randomBytes(32).toString('base64url') };
        const intentProof = vault.signOfflineWifiIntent(intent); check(value, guard);
        const { body: authorized } = await plain(value, 'local.wifi.authorize', { intent_proof: intentProof }, guard);
        exact(authorized, ['challenge_bytes']);
        const bundle = await chunks(value, 'local.wifi.challenge', authorized.challenge_bytes, guard);
        exact(bundle, ['challenge', 'rsa_spki_der']); need(bundle.rsa_spki_der === start.rsa_spki_der);
        const challenge = verifyWifiProof('challenge', bundle.challenge, association.descriptor.boxKey);
        const context = challenge.context;
        need(challenge.intentDigest === wifiDigest(intent) && wifiCanonical(challenge.ble) === wifiCanonical(ble) &&
          context.boxId === input.boxId && context.boxKeyThumbprint === intent.boxKeyThumbprint &&
          context.ownershipEpoch === intent.ownershipEpoch && context.bindingId === association.bindingId &&
          context.principalId === association.principalId && context.clientId === profile.clientId, 'LOCAL_WIFI_CONTEXT_CHANGED');
        value.deadline = Math.min(value.deadline, monotonicMs() + (challenge.expiresAt - challenge.issuedAt) * 1000);
        const token = await createPairingToken(crypto, spki); let keys;
        try {
          check(value, guard);
          const tokenCiphertextSha256 = wifiByteDigest(token.ciphertext), challengeDigest = wifiDigest(challenge);
          const proof = vault.signOfflineWifiSession({ boxId: input.boxId, challenge: bundle.challenge, payload: {
            schemaVersion: 1, purpose: 'centuarai.local-wifi.session-access.v1', challengeDigest, tokenCiphertextSha256 } });
          keys = await deriveSessionKeys(crypto, token.pairingToken, wifiAeadDeviceId(input.boxId), sessionId, clientNonce, start.pairing_device_nonce);
          check(value, guard);
          const { body: accepted } = await plain(value, 'local.wifi.token', { ciphertext: Buffer.from(token.ciphertext).toString('base64'),
            algorithm: 'RSA-OAEP-SHA256-MGF1-SHA256', proof }, guard);
          exact(accepted, ['key_confirm', 'receipt_bytes']);
          const transcript = await crypto.sha256(new TextEncoder().encode(wifiCanonical({ purpose: 'centuarai.local-wifi.session',
            challengeSha256: challengeDigest, tokenCiphertextSha256, protocolVersion: 2, securityProfile: 'NEXUSAOS_LOCAL_AEAD_V2', transport: 'ble-gatt' })));
          need(await verifyKeyConfirm(crypto, keys.confirmKey, transcript, accepted.key_confirm), 'LOCAL_WIFI_CONTEXT_CHANGED');
          check(value, guard);
          const receiptBundle = await chunks(value, 'local.wifi.receipt', accepted.receipt_bytes, guard);
          exact(receiptBundle, ['sessionReceipt']);
          const receipt = verifyWifiProof('session-receipt', receiptBundle.sessionReceipt, association.descriptor.boxKey);
          need(wifiCanonical(receipt.context) === wifiCanonical(context) && wifiCanonical(receipt.ble) === wifiCanonical(ble) &&
            receipt.challengeDigest === challengeDigest && receipt.tokenCiphertextSha256 === tokenCiphertextSha256 &&
            receipt.expiresAt <= challenge.expiresAt && receipt.issuedAt >= challenge.issuedAt, 'LOCAL_WIFI_CONTEXT_CHANGED');
          value.receipt = receipt; value.receiptProof = receiptBundle.sessionReceipt;
          crypto.zeroize(keys.confirmKey);
          value.channel = createSecureChannel(crypto, { deviceId: wifiAeadDeviceId(input.boxId), pairingSessionId: sessionId, keys }); keys = undefined;
          value.state = 'awaitingWifi'; return snapshot(value);
        } finally { crypto.zeroize(token.pairingToken); if (keys) for (const key of Object.values(keys)) crypto.zeroize(key); }
      }); },
      scanOfflineWifi() { return execute(async guard => {
        const value = current(guard); need(value.state === 'awaitingWifi' && !value.review, 'LOCAL_WIFI_INVALID_STATE');
        const networks = [], deadline = Math.min(value.deadline, monotonicMs() + 20000); let offset = 0, refresh = true;
        for (;;) {
          need(monotonicMs() < deadline, 'WIFI_SCAN_TIMEOUT');
          const page = await secure(value, 'wifi.scan', { offset, refresh }, guard); refresh = false;
          if (page.scan_state === 'scanning') { need(offset === 0); await pause(700, value.abort.signal); continue; }
          networks.push(...page.networks);
          need(networks.length <= 60 && (page.next_offset === null ||
            (page.networks.length > 0 && page.next_offset === offset + page.networks.length && page.next_offset < 60)));
          if (page.next_offset === null) return networks; offset = page.next_offset;
        }
      }); },
      prepareOfflineWifi(input) { return execute(async guard => {
        const value = current(guard); need(value.state === 'awaitingWifi' && !value.review, 'LOCAL_WIFI_INVALID_STATE');
        const wifi = { ssid: input.ssid, security: input.security, hidden: input.hidden,
          ...(input.security === 'open' ? {} : { password: input.password }) };
        try {
          validateWifi(wifi);
          const requestId = randomUUID(), frame = await value.channel.sealRequest(requestId, 'wifi.apply', wifi);
          check(value, guard);
          const envelope = parseJsonLine(frame), context = value.receipt.context;
          const proofPayload = { schemaVersion: 1, purpose: 'centuarai.local-wifi.apply.v1', sessionDigest: wifiDigest(value.receipt),
            applyNonce: value.receipt.applyNonce, requestId, counter: envelope.counter,
            ciphertextSha256: wifiByteDigest(Buffer.from(envelope.ciphertext, 'base64')) };
          value.review = { reviewHandle: randomBytes(32).toString('base64url'), envelope, requestId, proofPayload };
          return { kind: 'offline-wifi', reviewHandle: value.review.reviewHandle, boxId: value.boxId,
            boxKeyThumbprint: context.boxKeyThumbprint, bindingId: context.bindingId, principalId: context.principalId,
            ownershipEpoch: context.ownershipEpoch, authorizationVersion: context.authorizationVersion,
            expiresAt: value.receipt.expiresAt, ssid: wifi.ssid, security: wifi.security, hidden: wifi.hidden,
            grants: [{ resourceId: 'network:wifi', actions: ['write'] }] };
        } finally { delete wifi.password; }
      }); },
      confirmOfflineWifi({ reviewHandle, passphrase }) { return execute(async guard => {
        const value = current(guard), review = value.review; value.review = undefined;
        need(review && review.reviewHandle === reviewHandle, 'LOCAL_TRUST_REVIEW_EXPIRED');
        const proof = await vault.signOfflineWifiApply({ boxId: value.boxId, sessionReceipt: value.receiptProof,
          payload: review.proofPayload, passphrase, guard: () => check(value, guard) });
        check(value, guard);
        const frame = encodeJsonLine({ ...review.envelope, local_wifi_proof: proof });
        const accepted = await secure(value, 'wifi.apply', null, guard, { requestId: review.requestId, frame });
        value.state = 'provisioningWifi';
        let version = accepted.state_version;
        for (;;) {
          const status = await secure(value, 'job.status', { job_id: accepted.job_id }, guard);
          need(status.job_id === accepted.job_id && status.state_version >= version); version = status.state_version;
          if (status.operation_status === 'completed') {
            need(status.device_state === 'connected');
            value.state = 'completed'; const result = snapshot(value); invalidate(); return result;
          }
          await pause(700, value.abort.signal);
        }
      }); },
      cancelOfflineWifi() { invalidate(); return null; },
    },
  };
}

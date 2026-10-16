import { randomUUID } from 'node:crypto';
import {
  challengeCanonical, createPairingToken, createPlainRequest, createSecureChannel,
  decodeDeviceInfo, decodePlainResponse, deriveSessionKeys, encodeJsonLine, fromBase64,
  parseJsonLine, stableJson, toBase64, toBase64Url, toHex,
  validateWifi, verifyKeyConfirm,
} from '@nexusaos/local-provisioning-core';

const utf8 = (value) => new TextEncoder().encode(value);
const fail = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const identity = (value) => stableJson([value.device_id, value.identity_public_key_sha256, value.model, value.serial_suffix]);
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Owner-only Wi-Fi reconfiguration. No claim task, owner mutation or resume record. */
export function createOwnerWifiCoordinator(deps) {
  let snapshot = { flowId: '', state: 'idle', mode: 'wifi' };
  let transport, channel, operation, termination, expiryTimer, deadline = 0, sessionId, preview;
  let clientId, accountId;
  const lifetime = new AbortController(), listeners = new Set();
  const publish = (state, extra = {}) => {
    snapshot = { ...snapshot, ...extra, state };
    for (const listener of listeners) { try { listener({ ...snapshot }); } catch {} }
  };
  const active = (signal) => {
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    if (deadline && deps.clock.monotonicMs() >= deadline) throw fail('PAIRING_EXPIRED');
  };
  const cleanup = async () => {
    clearTimeout(expiryTimer);
    channel?.destroy(); channel = undefined;
    const connected = transport; transport = undefined;
    await connected?.close().catch(() => {});
  };
  const terminate = () => {
    if (termination) return termination;
    termination = (async () => {
      lifetime.abort();
      // An authenticated cancel stops a queued Wi-Fi job on the box. Closing
      // GATT alone deliberately preserves jobs for transport recovery.
      if (channel && transport) {
        let drained = !operation, timer;
        try {
          if (operation) await Promise.race([
            operation.then(() => { drained = true; }, () => { drained = true; }),
            new Promise(resolve => { timer = setTimeout(resolve, 3000); }),
          ]);
          if (drained && channel && transport) {
            const requestId = randomUUID(), signal = AbortSignal.timeout(3000);
            const currentChannel = channel;
            const frame = await currentChannel.sealRequest(requestId, 'pairing.cancel', { reason: 'user_cancelled' });
            const reply = await transport.request(frame, { requestId, responseMessageType: 'pairing.cancel.result' }, signal);
            await currentChannel.openIncoming(reply, { requestId, messageType: 'pairing.cancel' });
          }
        } catch { /* expiry/disconnect still destroys local authority */ }
        finally { clearTimeout(timer); }
      }
      await cleanup();
    })();
    return termination;
  };
  const run = (fn, caller) => {
    if (operation) return Promise.reject(fail('CLAIM_OPERATION_IN_PROGRESS'));
    const signal = caller ? AbortSignal.any([lifetime.signal, caller]) : lifetime.signal;
    operation = (async () => {
      try { active(signal); return await fn(signal); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        if (snapshot.state === 'awaitingWifi' && error.retryable) throw error;
        await cleanup();
        const code = /^[A-Z][A-Z0-9_]+$/.test(error.code || '') ? error.code : 'PROTOCOL_CHANGED';
        publish('terminalError', { errorCode: code, retryable: false });
        throw fail(code);
      }
    })().finally(() => { operation = undefined; });
    return operation;
  };
  const responsePayload = (result) => {
    if (result.status === 'failed') {
      const error = result.error;
      const code = typeof error?.code === 'string' ? error.code.toUpperCase() : 'PROTOCOL_CHANGED';
      throw fail(code, error?.retryable === true);
    }
    return result.payload;
  };
  const plain = async (type, payload, signal, session) => {
    active(signal);
    const requestId = randomUUID();
    // The installed claim SDK intentionally accepts only claim operations. Keep
    // its closed schemas intact and encode the two owner-specific frames here.
    const frame = ['pairing.start', 'pairing.token'].includes(type)
      ? encodeJsonLine({ schema_version: 2, request_id: requestId, message_type: type,
        ...(session ? { pairing_session_id: session } : {}), payload })
      : createPlainRequest(requestId, type, payload, session);
    const bytes = await transport.request(frame, { requestId, responseMessageType: `${type}.result` }, signal);
    active(signal);
    if (type !== 'pairing.start') return responsePayload(decodePlainResponse(bytes, {
      requestId, requestMessageType: type, ...(session ? { pairingSessionId: session } : {}),
    }));
    const result = parseJsonLine(bytes);
    if (result?.status === 'failed') return responsePayload(decodePlainResponse(bytes, {
      requestId, requestMessageType: type, acceptsNewPairingSession: true,
    }));
    if (!exact(result, ['schema_version', 'request_id', 'message_type', 'status', 'pairing_session_id', 'payload']) ||
      result.schema_version !== 2 || result.request_id !== requestId || result.message_type !== 'pairing.start.result' ||
      result.status !== 'completed' || !uuid(result.pairing_session_id) ||
      !exact(result.payload, ['pairing_session_id', 'pairing_device_nonce', 'expires_in_seconds', 'requested_ops', 'transport']) ||
      result.payload.pairing_session_id !== result.pairing_session_id ||
      !/^[A-Za-z0-9_-]{43}$/.test(result.payload.pairing_device_nonce) ||
      toBase64Url(Buffer.from(result.payload.pairing_device_nonce, 'base64url')) !== result.payload.pairing_device_nonce ||
      result.payload.expires_in_seconds !== 300 || stableJson(result.payload.requested_ops) !== '["wifi.apply"]' ||
      result.payload.transport !== 'ble-gatt') throw fail('PROTOCOL_CHANGED');
    return result.payload;
  };
  const secure = async (type, payload, signal) => {
    active(signal);
    const requestId = randomUUID(), currentChannel = channel;
    if (!currentChannel || !transport) throw fail('LOCAL_TRANSPORT_DISCONNECTED');
    const frame = await currentChannel.sealRequest(requestId, type, payload);
    active(signal);
    const response = await transport.request(frame, { requestId, responseMessageType: `${type}.result` }, signal);
    active(signal);
    const result = await currentChannel.openIncoming(response, { requestId, messageType: type });
    active(signal);
    return responsePayload(result);
  };
  return {
    getSnapshot: () => ({ ...snapshot }),
    subscribe(listener) { listeners.add(listener); listener({ ...snapshot }); return () => listeners.delete(listener); },
    begin(input, caller) {
      return run(async (signal) => {
        if (snapshot.state !== 'idle') throw fail('CLAIM_INVALID_STATE');
        accountId = input.accountId; clientId = input.clientId;
        publish('connecting', { flowId: randomUUID() });
        const connected = await deps.transportFactory.connect(input.selected, signal);
        if (signal.aborted) { await connected.close(); signal.throwIfAborted(); }
        transport = connected;
        publish('readingDeviceInfo');
        const bytes = await transport.readDeviceInfo(signal); active(signal);
        preview = decodeDeviceInfo(bytes, 'ble-gatt');
        if (preview.cloud_enrollment_status !== 'ready') throw fail('DEVICE_NOT_ENROLLED');
        publish('previewReady', { preview, compatiblePreview: preview, networkState: preview.network_state });
      }, caller);
    },
    confirmPhysicalDevice(caller) {
      return run(async (signal) => {
        if (snapshot.state !== 'previewReady') throw fail('CLAIM_INVALID_STATE');
        publish('verifyingLocalDevice');
        // Owner authorization is checked before allocating an authenticated local
        // session; a nearby non-owner cannot obtain this certificate endpoint.
        const att = await deps.consumerApi.getOwnerWifiAttestation(preview.device_id, signal);
        active(signal);
        const at = Date.parse(att.serverTime), checked = Date.parse(att.data.statusCheckedAt);
        if (att.data.deviceId !== preview.device_id || !Number.isFinite(at) || !Number.isFinite(checked) ||
          Math.abs(checked - at) > 300000 || !(Date.parse(att.data.expiresAt) > at)) throw fail('DEVICE_IDENTITY_MISMATCH');
        const verified = await deps.crypto.verifyDeviceCertificateProfile({
          leafPem: att.data.certificatePem, intermediatesPem: att.data.certificateChainPem,
          trustedRootSpkiPins: deps.trustedRootSpkiPins, expectedDeviceId: preview.device_id, verificationTime: att.serverTime,
        });
        active(signal);
        if (verified.publicKeySha256 !== preview.identity_public_key_sha256 ||
          verified.publicKeySha256 !== att.data.publicKeySha256 || verified.serialNumber !== att.data.serialNumber)
          throw fail('DEVICE_IDENTITY_MISMATCH');
        const appNonce = toBase64Url(await deps.crypto.randomBytes(32));
        const hello = await plain('hello', { supported_versions: [2], app_nonce: appNonce, client_version: deps.clientVersion }, signal);
        const deviceInfo = utf8(stableJson(hello.device_info)), latest = decodeDeviceInfo(deviceInfo, 'ble-gatt');
        const deviceInfoSha256 = toHex(await deps.crypto.sha256(deviceInfo));
        if (identity(latest) !== identity(preview) || deviceInfoSha256 !== hello.device_info_sha256 || latest.cloud_enrollment_status !== 'ready')
          throw fail('DEVICE_IDENTITY_MISMATCH');
        preview = latest;
        const clientAttemptId = randomUUID(), clientNonce = toBase64Url(await deps.crypto.randomBytes(32));
        deadline = deps.clock.monotonicMs() + 300000;
        expiryTimer = setTimeout(() => {
          lifetime.abort(); void cleanup(); publish('terminalError', { errorCode: 'PAIRING_EXPIRED', retryable: false });
        }, 300000);
        expiryTimer.unref?.();
        const start = await plain('pairing.start', { hello_context_id: hello.hello_context_id,
          client_attempt_id: clientAttemptId, client_id: clientId, client_nonce: clientNonce, requested_ops: ['wifi.apply'] }, signal);
        sessionId = start.pairing_session_id;
        const challengeNonce = toBase64Url(await deps.crypto.randomBytes(32));
        const challenge = await plain('pairing.challenge', { challenge_nonce: challengeNonce }, signal, sessionId);
        const fields = { deviceId: preview.device_id, clientId, pairingSessionId: sessionId,
          helloContextId: hello.hello_context_id, appNonce, clientAttemptId, clientNonce,
          pairingDeviceNonce: start.pairing_device_nonce, challengeNonce, deviceInfoSha256 };
        const canonical = challengeCanonical({ ...fields, requestedOpsSha256: toHex(await deps.crypto.sha256(utf8('["wifi.apply"]'))),
          expiresInSeconds: '300', transport: 'ble-gatt' });
        if (!await deps.crypto.verifyRsaPkcs1Sha256(verified.leafSpkiDer, canonical, fromBase64(challenge.signature)))
          throw fail('DEVICE_IDENTITY_MISMATCH');
        active(signal);
        const token = await createPairingToken(deps.crypto, verified.leafSpkiDer);
        let keys;
        try {
          active(signal);
          const ciphertextHash = toHex(await deps.crypto.sha256(token.ciphertext));
          const challengeHash = toHex(await deps.crypto.sha256(canonical));
          const authorized = await deps.consumerApi.authorizeOwnerWifi({ ...fields, signature: challenge.signature,
            pairingTokenCiphertextSha256: ciphertextHash }, signal);
          active(signal);
          const permit = authorized.data.permit, grant = permit.payload;
          if (grant.deviceId !== preview.device_id || grant.ownerAccountId !== accountId || grant.clientId !== clientId ||
            grant.pairingSessionId !== sessionId || grant.challengeCanonicalSha256 !== challengeHash ||
            grant.pairingTokenCiphertextSha256 !== ciphertextHash) throw fail('PAIRING_MISMATCH');
          // The transcript format is unchanged; the claim SDK's transcriptHash
          // rejects wifi-only operations, so hash our fully constructed owner transcript.
          const digest = await deps.crypto.sha256(utf8(stableJson({ appNonce, attestationSpkiSha256: verified.publicKeySha256,
            challengeCanonicalSha256: challengeHash, clientAttemptId, clientId, clientNonce, deviceInfoSha256,
            deviceId: preview.device_id, helloContextId: hello.hello_context_id, pairingDeviceNonce: start.pairing_device_nonce,
            expiresInSeconds: 300, pairingSessionId: sessionId, pairingTokenCiphertextSha256: ciphertextHash,
            protocolVersion: 2, requestedOps: ['wifi.apply'], securityProfile: 'NEXUSAOS_LOCAL_AEAD_V2', transport: 'ble-gatt' })));
          keys = await deriveSessionKeys(deps.crypto, token.pairingToken, preview.device_id, sessionId, clientNonce, start.pairing_device_nonce);
          active(signal);
          publish('establishingSecureChannel');
          const accepted = await plain('pairing.token', { ciphertext: toBase64(token.ciphertext),
            algorithm: 'RSA-OAEP-SHA256-MGF1-SHA256', owner_wifi_permit: permit }, signal, sessionId);
          if (!await verifyKeyConfirm(deps.crypto, keys.confirmKey, digest, accepted.key_confirm)) throw fail('DEVICE_IDENTITY_MISMATCH');
          active(signal);
          deps.crypto.zeroize(keys.confirmKey);
          channel = createSecureChannel(deps.crypto, { deviceId: preview.device_id, pairingSessionId: sessionId, keys });
          keys = undefined; // channel now owns and destroys the key material
        } finally {
          deps.crypto.zeroize(token.pairingToken);
          if (keys) for (const key of Object.values(keys)) deps.crypto.zeroize(key);
        }
        publish('awaitingWifi', { verifiedDeviceId: preview.device_id, pairingSessionId: sessionId,
          pairingExpiresInMs: Math.max(0, deadline - deps.clock.monotonicMs()) });
      }, caller);
    },
    scanWifi(caller) {
      return run(async (signal) => {
        if (snapshot.state !== 'awaitingWifi') throw fail('CLAIM_INVALID_STATE');
        const networks = [], scanDeadline = deps.clock.monotonicMs() + 20000;
        let offset = 0, refresh = true;
        for (;;) {
          if (deps.clock.monotonicMs() >= scanDeadline) throw fail('WIFI_SCAN_TIMEOUT', true);
          const page = await secure('wifi.scan', { offset, refresh }, signal); refresh = false;
          if (page.scan_state === 'scanning') {
            if (offset !== 0) throw fail('PROTOCOL_CHANGED');
            await pause(700, signal); continue;
          }
          networks.push(...page.networks);
          if (networks.length > 60 || (page.next_offset !== null &&
            (!page.networks.length || page.next_offset !== offset + page.networks.length || page.next_offset >= 60))) throw fail('PROTOCOL_CHANGED');
          if (page.next_offset === null) return networks;
          offset = page.next_offset;
        }
      }, caller);
    },
    provideWifi(input) {
      return run(async (signal) => {
        let payload;
        try {
          if (snapshot.state !== 'awaitingWifi') throw fail('CLAIM_INVALID_STATE');
          payload = { ssid: input.ssid, security: input.security, hidden: input.hidden,
            ...(input.passwordUtf8 ? { password: new TextDecoder('utf-8', { fatal: true }).decode(input.passwordUtf8) } : {}) };
          validateWifi(payload);
          publish('provisioningWifi');
          const accepted = await secure('wifi.apply', payload, signal);
          delete payload.password;
          const jobDeadline = Math.min(deadline, deps.clock.monotonicMs() + 60000);
          let version = accepted.state_version;
          for (;;) {
            if (deps.clock.monotonicMs() >= jobDeadline) throw fail('DEVICE_OFFLINE', true);
            const status = await secure('job.status', { job_id: accepted.job_id }, signal);
            if (status.job_id !== accepted.job_id || status.state_version < version) throw fail('PROTOCOL_CHANGED');
            version = status.state_version;
            if (status.operation_status === 'completed') {
              if (status.device_state !== 'connected') throw fail('PROTOCOL_CHANGED');
              await cleanup(); publish('completed', { networkState: 'connected' }); return;
            }
            await pause(1000, signal);
          }
        } catch (error) {
          if (error.retryable && !signal.aborted && deps.clock.monotonicMs() < deadline)
            publish('awaitingWifi', { errorCode: error.code, retryable: true });
          throw error;
        } finally { if (payload) delete payload.password; }
      }).finally(() => { if (input.passwordUtf8) deps.crypto.zeroize(input.passwordUtf8); });
    },
    async cancel() {
      await terminate();
      if (snapshot.state !== 'completed') publish('cancelled');
    },
    suspend: terminate,
    async dispose() { await terminate(); listeners.clear(); },
  };
}

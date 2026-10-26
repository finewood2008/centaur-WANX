import { createHash, timingSafeEqual } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { validateDescriptor, verifyResponse, ManagementProtocolError } from './management-contract.mjs';
import { ledgerRequestSpec, verifyLedgerResponse, LedgerProtocolError } from './ledger-contract.mjs';
import { verifyDataResponse } from './data-contract.mjs';
import { backupIORequestSpec, restoreKeyRequestSpec, verifyBackupIOResponse, BackupProtocolError } from './backup-contract.mjs';

const ROUTES = Object.freeze({
  '/first-root/challenge': ['first-root-challenge', []],
  '/first-root/commit': ['binding-ack', ['accessProof', 'approvalProof', 'secretProof']],
  '/auth/challenge': ['auth-challenge', []],
  '/state': ['state', ['proof']],
  '/requests/challenge': ['binding-challenge', []],
  '/requests': ['request-receipt', ['requestProof']],
  '/requests/read': ['request', ['proof']],
  '/requests/approve': ['binding-ack', ['requestId', 'approvalProof']],
  '/requests/cancel': ['request-receipt', ['cancelProof']],
});

// Only these reviewed protocol codes cross into UI state. Never echo a remote
// message, an arbitrary LOCAL_* string, a request proof, or server exception text.
const SERVER_ERRORS = new Set([
  'LOCAL_TRUST_ALREADY_INITIALIZED', 'LOCAL_TRUST_ALREADY_OWNED', 'LOCAL_TRUST_BOOT_MISMATCH',
  'LOCAL_TRUST_CAPACITY', 'LOCAL_TRUST_CHALLENGE_INVALID', 'LOCAL_TRUST_CHALLENGE_DENIED', 'LOCAL_TRUST_CLOCK_ROLLBACK',
  'LOCAL_TRUST_CLOSED', 'LOCAL_TRUST_CONTEXT_MISMATCH', 'LOCAL_TRUST_KEY_MISMATCH',
  'LOCAL_TRUST_MIGRATION_PROOF_REQUIRED', 'LOCAL_TRUST_NOT_OWNED', 'LOCAL_TRUST_READ_DENIED',
  'LOCAL_TRUST_REQUEST_CONFLICT', 'LOCAL_TRUST_REQUEST_DENIED', 'LOCAL_TRUST_REQUEST_TERMINAL',
  'LOCAL_TRUST_STATE_INVALID', 'LOCAL_TRUST_STATE_MISSING',
  'LOCAL_TRUST_RATE_LIMITED', 'LOCAL_TRUST_UNAVAILABLE', 'LOCAL_TRUST_BODY_TIMEOUT',
  'LOCAL_TRUST_BODY_TOO_LARGE', 'LOCAL_TRUST_INVALID_REQUEST', 'LOCAL_TRUST_ROUTE_UNAVAILABLE',
  'LOCAL_TRUST_SOURCE_INVALID', 'LOCAL_TRUST_TRANSPORT_DENIED',
  'LOCAL_TRUST_CLIENT_UPGRADE_REQUIRED', 'LOCAL_TRUST_OPERATION_UNAVAILABLE',
  'LOCAL_TRUST_OPERATION_DENIED', 'LOCAL_TRUST_OPERATION_UNKNOWN', 'LOCAL_TRUST_OPERATION_CONFLICT',
  'LOCAL_TRUST_OPERATION_TERMINAL', 'LOCAL_TRUST_OPERATION_BUSY', 'LOCAL_TRUST_OPERATION_PHASE_INVALID',
  'LOCAL_LEDGER_INVALID', 'LOCAL_LEDGER_EXPIRED', 'LOCAL_LEDGER_CONTEXT_CHANGED',
  'LOCAL_LEDGER_SCOPE_DENIED', 'LOCAL_LEDGER_LAST_MANAGER', 'LOCAL_LEDGER_CAPABILITY_REQUIRED',
  'LOCAL_BINDING_APPROVAL_FORBIDDEN', 'LOCAL_BINDING_CLIENT_REUSE', 'LOCAL_BINDING_CONTEXT_MISMATCH',
  'LOCAL_BINDING_EXPIRED', 'LOCAL_BINDING_INVALID', 'LOCAL_BINDING_KEY_REUSE',
  'LOCAL_BINDING_LIFETIME_EXCEEDED', 'LOCAL_BINDING_SCOPE_EXCEEDED', 'LOCAL_BINDING_SIGNATURE_INVALID',
]);

function fail(code) { return new ManagementProtocolError(`LOCAL_MANAGEMENT_${code}`); }
function bodyBytes(path, body) {
  const route = Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
  if (!route || body === null || typeof body !== 'object' || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) throw fail('REQUEST_INVALID');
  const keys = Reflect.ownKeys(body), fields = route[1];
  if (keys.length !== fields.length || !fields.every((field) => keys.includes(field))
    || !keys.every((field) => {
      const d = Object.getOwnPropertyDescriptor(body, field);
      return d.enumerable && Object.hasOwn(d, 'value') && typeof d.value === 'string'
        && d.value.length > 0 && d.value.length <= 16384 && /^[\x21-\x7e]+$/.test(d.value);
    })) throw fail('REQUEST_INVALID');
  const encoded = Buffer.from(JSON.stringify(body));
  if (encoded.length > 65536) throw fail('REQUEST_TOO_LARGE');
  return encoded;
}

// This channel deliberately uses the delivery packet's SPKI as its trust anchor,
// including for private/self-signed certificates. There is no CA-only fallback.
// Node's secureConnect fires even for an unauthorized chain: check the actual peer
// public key before req.end writes any HTTP headers/body. A fresh agent/socket per
// request prevents resumed sessions or a shared pool from skipping this decision.
// https://nodejs.org/api/tls.html#event-secureconnect
// https://nodejs.org/api/https.html#httpsrequestoptions-callback
export function createPinnedTransport({ descriptor, timeoutMs = 10000, inspectionTimeoutMs = 60000, maxResponseBytes = 262144, protocolVersion = 1 }) {
  const trusted = validateDescriptor(descriptor);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000
    || !Number.isSafeInteger(inspectionTimeoutMs) || inspectionTimeoutMs <= 0 || inspectionTimeoutMs > 60000
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > 262144
    || ![1, 2].includes(protocolVersion))
    throw fail('LIMIT_INVALID');
  const pin = Buffer.from(trusted.tlsSpkiSha256, 'base64url');

  return Object.freeze({
    // Returns the raw box-signed compact JWS after signature/kind/schema checks.
    // The coordinator additionally calls verifyResponse with expected request
    // fields and checks its stored monotonic checkpoint before accepting success.
    async request(path, body, { signal } = {}) {
      const backupIO = protocolVersion === 2 && typeof path === 'string' && path.startsWith('/backup-io/');
      const spec = backupIO ? backupIORequestSpec(path, body)
        : protocolVersion === 2 && path === '/operations/restore-key' ? restoreKeyRequestSpec(body)
        : protocolVersion === 2 ? ledgerRequestSpec(path, body) : { encoded: bodyBytes(path, body), kind: ROUTES[path][0] };
      const { encoded } = spec;
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw fail('REQUEST_INVALID');
      if (signal?.aborted) throw fail('ABORTED');
      return new Promise((resolve, reject) => {
        let settled = false, req, response, timer;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          response?.destroy();
          req?.destroy();
          if (path === '/operations/restore-key') encoded.fill(0);
          if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(fail('ABORTED'));
        // Only two fixed authenticated inspection routes may wait for bounded
        // disk hashing or the root executor. Other management keeps its limit.
        const inspection = backupIO && ['source.finalize', 'transfer.plan'].includes(spec.operation);
        timer = setTimeout(() => finish(fail('TIMEOUT')), inspection ? inspectionTimeoutMs : timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          req = httpsRequest(new URL(`/local-trust/v${protocolVersion}${path}`, trusted.baseUrl), {
            method: 'POST', agent: false, rejectUnauthorized: false, minVersion: 'TLSv1.2',
            maxHeaderSize: 8192,
            headers: { 'Content-Type': 'application/json', Accept: backupIO ? 'application/json' : 'application/jose',
              'Content-Length': encoded.length, Connection: 'close', 'Cache-Control': 'no-store' },
          }, (incoming) => {
            response = incoming;
            if (settled) { incoming.destroy(); return; }
            if (incoming.statusCode >= 300 && incoming.statusCode < 400) {
              finish(fail('REDIRECT_REFUSED')); return;
            }
            const contentType = incoming.headers['content-type']?.split(';')[0].trim();
            const serverError = incoming.statusCode >= 400 && incoming.statusCode <= 599;
            if (serverError ? contentType !== 'application/json' : incoming.statusCode !== 200 || contentType !== (backupIO ? 'application/json' : 'application/jose')) {
              finish(fail('RESPONSE_REJECTED')); return;
            }
            if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') {
              finish(fail('RESPONSE_INVALID')); return;
            }
            const responseLimit = serverError ? Math.min(maxResponseBytes, 1024) : backupIO ? spec.responseLimit : maxResponseBytes;
            const length = incoming.headers['content-length'];
            if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > responseLimit)) {
              finish(fail('RESPONSE_TOO_LARGE')); return;
            }
            let size = 0;
            const chunks = [];
            incoming.on('data', (chunk) => {
              size += chunk.length;
              if (size > responseLimit) { finish(fail('RESPONSE_TOO_LARGE')); return; }
              chunks.push(chunk);
            });
            incoming.once('error', () => finish(fail('NETWORK_ERROR')));
            incoming.once('aborted', () => finish(fail('NETWORK_ERROR')));
            incoming.once('end', () => {
              if (settled) return;
              try {
                const bytes = Buffer.concat(chunks);
                if (!bytes.every((byte) => byte <= 127)) throw fail('RESPONSE_INVALID');
                const jws = bytes.toString('ascii');
                if (serverError) {
                  const match = /^[\x20\t\r\n]*\{[\x20\t\r\n]*"code"[\x20\t\r\n]*:[\x20\t\r\n]*"([A-Z0-9_]+)"[\x20\t\r\n]*\}[\x20\t\r\n]*$/.exec(jws);
                  throw match && SERVER_ERRORS.has(match[1]) ? new ManagementProtocolError(match[1]) : fail('RESPONSE_REJECTED');
                }
                if (backupIO) verifyBackupIOResponse(jws, { descriptor: trusted, request: spec.request, now: Math.floor(Date.now() / 1000) });
                else if (protocolVersion === 1) verifyResponse(jws, { descriptor: trusted, kind: spec.kind, now: Math.floor(Date.now() / 1000) });
                else if (spec.kind === 'effect') verifyDataResponse(jws, { descriptor: trusted, kind: 'effect', nowMs: Date.now() });
                else verifyLedgerResponse(jws, { descriptor: trusted, kind: spec.kind, now: Math.floor(Date.now() / 1000) });
                finish(null, jws);
              } catch (error) {
                finish(error instanceof ManagementProtocolError || error instanceof LedgerProtocolError || error instanceof BackupProtocolError ? error : fail('RESPONSE_INVALID'));
              }
            });
          });
          req.once('error', () => finish(fail('NETWORK_ERROR')));
          req.once('socket', (socket) => {
            socket.once('secureConnect', () => {
              if (settled) return;
              try {
                const certificate = socket.getPeerX509Certificate();
                if (!certificate) throw fail('TLS_PIN_MISMATCH');
                const actual = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest();
                if (!timingSafeEqual(actual, pin)) throw fail('TLS_PIN_MISMATCH');
                socket.disableRenegotiation();
                req.end(encoded);
              } catch {
                finish(fail('TLS_PIN_MISMATCH'));
              }
            });
          });
          // Abort can be triggered by synchronous caller code during setup, too.
          if (signal?.aborted) abort();
        } catch {
          finish(fail('NETWORK_ERROR'));
        }
      });
    },
  });
}

import {
  constants, createPrivateKey, createPublicKey, generateKeyPair, privateDecrypt, publicEncrypt,
  randomBytes, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { publicKeyThumbprint } from './binding-contract.mjs';
import { validateDescriptor } from './management-contract.mjs';
import { validateBackupHeader, backupRecipientThumbprint } from './backup-contract.mjs';
import {
  canonicalLedger, parseLedgerPacket, signLedgerPrepare, signLedgerRead, signLedgerMutation,
  signLedgerRecoveryMaterial, signLedgerSourceRecovery, signLedgerAuthChallenge, signLedgerAuthMutationChallenge, validateNewRecovery,
} from './ledger-contract.mjs';

const generate = promisify(generateKeyPair);
const id = () => randomBytes(32).toString('base64url');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => canonicalLedger(a) === canonicalLedger(b);
const clone = value => structuredClone(value);
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail('LOCAL_RECOVERY_MATERIAL_INVALID');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail('LOCAL_RECOVERY_MATERIAL_INVALID');
  return bytes;
}
function parseMaterial(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 16384 || !buffer.every(value => value <= 127)) fail('LOCAL_RECOVERY_MATERIAL_INVALID');
  const value = parseLedgerPacket(buffer.toString('ascii'));
  const fields = ['schemaVersion', 'type', 'materialId', 'recoveryVersion', 'principalId', 'source', 'createdAt', 'recoverySigningPrivateKey', 'backupDecryptPrivateKey'];
  if (!value || Object.keys(value).length !== fields.length || fields.some(name => !Object.hasOwn(value, name))
    || value.schemaVersion !== 1 || value.type !== 'centuarai-recovery-material'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.principalId)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) fail('LOCAL_RECOVERY_MATERIAL_INVALID');
  const descriptor = validateDescriptor(value.source);
  let signingKey, backupKey;
  const signingDer = decode(value.recoverySigningPrivateKey), backupDer = decode(value.backupDecryptPrivateKey);
  try {
    signingKey = createPrivateKey({ key: signingDer, type: 'pkcs8', format: 'der' });
    backupKey = createPrivateKey({ key: backupDer, type: 'pkcs8', format: 'der' });
    if (signingKey.asymmetricKeyType !== 'ec' || signingKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || backupKey.asymmetricKeyType !== 'rsa' || backupKey.asymmetricKeyDetails?.modulusLength !== 3072
      || backupKey.asymmetricKeyDetails?.publicExponent !== 65537n
      || !signingKey.export({ type: 'pkcs8', format: 'der' }).equals(signingDer)
      || !backupKey.export({ type: 'pkcs8', format: 'der' }).equals(backupDer)) fail('LOCAL_RECOVERY_MATERIAL_INVALID');
    const newRecovery = validateNewRecovery({ recoveryId: value.materialId, version: value.recoveryVersion,
      signingKey: createPublicKey(signingKey).export({ format: 'jwk' }), backupKey: createPublicKey(backupKey).export({ format: 'jwk' }) });
    // Possessing a parsable RSA key is insufficient: exercise the exact backup
    // algorithm before allowing this material to become the recovery path.
    const plain = randomBytes(32);
    try {
      const ciphertext = publicEncrypt({ key: createPublicKey(backupKey), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, plain);
      const actual = privateDecrypt({ key: backupKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ciphertext);
      try { if (!timingSafeEqual(plain, actual)) fail('LOCAL_RECOVERY_MATERIAL_INVALID'); }
      finally { actual.fill(0); }
    } finally { plain.fill(0); }
    return { descriptor, principalId: value.principalId, createdAt: value.createdAt, newRecovery, signingKey, backupKey };
  } catch (error) {
    if (error.code === 'LOCAL_RECOVERY_MATERIAL_INVALID') throw error;
    fail('LOCAL_RECOVERY_MATERIAL_INVALID');
  } finally { signingDer.fill(0); backupDer.fill(0); }
}

// Ephemeral native-only keys. No private material enters snapshots, the regular
// identity vault, renderer IPC, telemetry or the ordinary clipboard service.
export function createRecoveryMaterialManager({ files, clock = Date.now } = {}) {
  const drafts = new Map(), imported = new Map(), pending = new Set();
  let generation = 0;
  const requireFiles = () => {
    if (!files || typeof files.exportRecovery !== 'function' || typeof files.importRecovery !== 'function'
      || typeof files.release !== 'function') fail('LOCAL_RECOVERY_FILES_UNAVAILABLE');
  };
  const clean = value => {
    value.bytes?.fill(0); value.bytes = null; value.signingKey = null; value.backupKey = null;
  };
  const invalidate = () => {
    generation++;
    for (const abort of pending) abort.abort();
    for (const value of [...drafts.values(), ...imported.values()]) clean(value);
    drafts.clear(); imported.clear();
  };
  const withFile = async (operation, guard) => {
    requireFiles(); guard(); const captured = generation, abort = new AbortController(); pending.add(abort);
    const live = () => { guard(); if (captured !== generation || abort.signal.aborted) fail('LOCAL_TRUST_CONTEXT_CHANGED'); };
    try { const result = await operation(abort.signal, live); live(); return result; }
    finally { pending.delete(abort); }
  };
  const getDraft = handle => { const value = drafts.get(handle); if (!value) fail('LOCAL_RECOVERY_MATERIAL_EXPIRED'); return value; };
  const getImported = handle => { const value = imported.get(handle); if (!value) fail('LOCAL_RECOVERY_MATERIAL_EXPIRED'); return value; };
  const publicDraft = (handle, value) => ({ materialHandle: handle, state: value.state,
    principalId: value.principalId, descriptor: clone(value.descriptor), newRecovery: clone(value.newRecovery),
    signingKeyThumbprint: publicKeyThumbprint(value.newRecovery.signingKey), label: value.label || null });
  const actorMatches = (value, payload) => {
    if (payload.actor.kind !== 'recovery' || payload.actor.principalId !== value.principalId
      || payload.actor.keyVersion !== value.newRecovery.version || payload.actor.bindingId !== null
      || payload.boxId !== value.descriptor.boxId || payload.boxKeyThumbprint !== publicKeyThumbprint(value.descriptor.boxKey))
      fail('LOCAL_RECOVERY_SCOPE_MISMATCH');
  };
  return {
    invalidate,
    async generate({ descriptor, principalId, version }, guard) {
      requireFiles(); guard(); const captured = generation;
      descriptor = validateDescriptor(descriptor);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principalId) || !Number.isSafeInteger(version) || version < 1) fail('LOCAL_RECOVERY_MATERIAL_INVALID');
      const [signing, backup] = await Promise.all([
        generate('ec', { namedCurve: 'prime256v1' }), generate('rsa', { modulusLength: 3072, publicExponent: 65537 }),
      ]);
      guard(); if (captured !== generation) fail('LOCAL_TRUST_CONTEXT_CHANGED');
      const newRecovery = validateNewRecovery({ recoveryId: id(), version,
        signingKey: signing.publicKey.export({ format: 'jwk' }), backupKey: backup.publicKey.export({ format: 'jwk' }) });
      const signingDer = signing.privateKey.export({ type: 'pkcs8', format: 'der' });
      const backupDer = backup.privateKey.export({ type: 'pkcs8', format: 'der' });
      let bytes;
      try { bytes = Buffer.from(canonicalLedger({ schemaVersion: 1, type: 'centuarai-recovery-material',
        materialId: newRecovery.recoveryId, recoveryVersion: version, principalId, source: descriptor,
        createdAt: Math.floor(clock() / 1000), recoverySigningPrivateKey: signingDer.toString('base64url'),
        backupDecryptPrivateKey: backupDer.toString('base64url') })); }
      finally { signingDer.fill(0); backupDer.fill(0); }
      if (bytes.length > 16384) { bytes.fill(0); fail('LOCAL_RECOVERY_MATERIAL_INVALID'); }
      const handle = id(), value = { descriptor, principalId, newRecovery, bytes, state: 'draft_generated', signingKey: null, backupKey: null };
      drafts.set(handle, value); return publicDraft(handle, value);
    },
    export(handle, guard) {
      const value = getDraft(handle);
      if (value.state !== 'draft_generated' || !value.bytes) fail('LOCAL_RECOVERY_REIMPORT_REQUIRED');
      return withFile(async (signal, live) => {
        const result = await files.exportRecovery({ suggestedName: `centuarai-recovery-v${value.newRecovery.version}.json`, bytes: value.bytes, signal });
        if (!result) return publicDraft(handle, value);
        try {
          live(); value.state = 'exported'; value.label = result.label;
          clean(value); return publicDraft(handle, value);
        } finally { files.release(result.handle); }
      }, guard);
    },
    reimport(handle, guard) {
      const value = getDraft(handle);
      if (!['exported', 'reimport_verified'].includes(value.state)) fail('LOCAL_RECOVERY_EXPORT_REQUIRED');
      return withFile(async (signal, live) => {
        const result = await files.importRecovery({ signal });
        if (!result) return publicDraft(handle, value);
        try {
          const parsed = parseMaterial(result.bytes); live();
          if (parsed.principalId !== value.principalId || !same(parsed.descriptor, value.descriptor)
            || !same(parsed.newRecovery, value.newRecovery)) { clean(parsed); fail('LOCAL_RECOVERY_SCOPE_MISMATCH'); }
          clean(value); value.signingKey = parsed.signingKey; value.backupKey = parsed.backupKey;
          value.state = 'reimport_verified'; value.label = result.label; return publicDraft(handle, value);
        } finally { files.release(result.handle); }
      }, guard);
    },
    importCurrent(guard) {
      return withFile(async (signal, live) => {
        const result = await files.importRecovery({ signal });
        if (!result) return null;
        try {
          const parsed = parseMaterial(result.bytes); live(); const handle = id(); imported.set(handle, parsed);
          return { recoveryHandle: handle, principalId: parsed.principalId, descriptor: clone(parsed.descriptor),
            newRecovery: clone(parsed.newRecovery), label: result.label };
        } finally { files.release(result.handle); }
      }, guard);
    },
    publicDraft(handle) { return publicDraft(handle, getDraft(handle)); },
    signMaterial(handle, mutation) {
      const value = getDraft(handle);
      if (value.state !== 'reimport_verified' || !value.signingKey) fail('LOCAL_RECOVERY_REIMPORT_REQUIRED');
      if (mutation.actor.principalId !== value.principalId || mutation.boxId !== value.descriptor.boxId
        || mutation.boxKeyThumbprint !== publicKeyThumbprint(value.descriptor.boxKey)
        || !same(mutation.args.newRecovery, value.newRecovery)) fail('LOCAL_RECOVERY_SCOPE_MISMATCH');
      return signLedgerRecoveryMaterial(mutation, value.signingKey);
    },
    signRecoveryPrepare(handle, payload) { const value = getImported(handle); actorMatches(value, payload); return signLedgerPrepare(payload, value.signingKey); },
    signRecoveryChallenge(handle, payload) { const value = getImported(handle); actorMatches(value, payload); return signLedgerAuthChallenge(payload, value.signingKey); },
    signRecoveryMutationChallenge(handle, payload) { const value = getImported(handle); actorMatches(value, payload); return signLedgerAuthMutationChallenge(payload, value.signingKey); },
    signRecoveryRead(handle, payload) {
      const value = getImported(handle); actorMatches(value, payload);
      if (!['recovery-state', 'mutation-status'].includes(payload.operation)) fail('LOCAL_RECOVERY_SCOPE_MISMATCH');
      return signLedgerRead(payload, value.signingKey);
    },
    signRecoveryMutation(handle, payload) { const value = getImported(handle); actorMatches(value, payload); return signLedgerMutation(payload, value.signingKey); },
    signSourceRecovery(handle, payload) {
      const value = getImported(handle);
      if (payload.action !== 'backup.restore' || payload.args.sourceBoxKeyThumbprint !== publicKeyThumbprint(value.descriptor.boxKey)) fail('LOCAL_RECOVERY_SCOPE_MISMATCH');
      return signLedgerSourceRecovery(payload, value.signingKey);
    },
    unwrapArchiveKey(handle, input) {
      const value = getImported(handle), header = validateBackupHeader(input);
      if (header.sourceBoxId !== value.descriptor.boxId || header.sourceBoxKeyThumbprint !== publicKeyThumbprint(value.descriptor.boxKey)
        || header.principalId !== value.principalId || header.recoveryId !== value.newRecovery.recoveryId
        || header.recoveryVersion !== value.newRecovery.version || !same(header.sourceRecoverySigningKey, value.newRecovery.signingKey)
        || header.recipientKeyThumbprint !== backupRecipientThumbprint(value.newRecovery.backupKey)) fail('LOCAL_RECOVERY_SCOPE_MISMATCH');
      let key;
      try {
        const label = Buffer.from(`centuarai.backup.key.v1\n${header.backupId}\n${header.recipientKeyThumbprint}`, 'ascii');
        key = privateDecrypt({ key: value.backupKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label },
          Buffer.from(header.wrappedDataKey, 'base64url'));
        if (key.length !== 32) fail('LOCAL_RECOVERY_MATERIAL_INVALID');
        return key;
      } catch { key?.fill(0); fail('LOCAL_RECOVERY_MATERIAL_INVALID'); }
    },
    releaseDraft(handle) { const value = drafts.get(handle); if (value) clean(value); drafts.delete(handle); },
    releaseCurrent(handle) { const value = imported.get(handle); if (value) clean(value); imported.delete(handle); },
  };
}

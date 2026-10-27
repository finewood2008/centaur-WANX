import { constants, closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, randomBytes, randomUUID, scrypt,
} from 'node:crypto';
import { promisify } from 'node:util';
import {
  publicKeyThumbprint, signRequest, signCancel as signCancellation,
  signApproval as signBindingApproval,
} from './binding-contract.mjs';
import { signFirstRoot as signRootProofs, signRead as signReadProof } from './management-contract.mjs';
import { signSession as signDataSessionProof, validateSessionPayload,
  signSessionIntent as signDataSessionIntentProof, validateSessionIntentPayload } from './data-contract.mjs';
import { signLedgerPrepare as signPrepareProof, signLedgerRead as signLedgerReadProof,
  signLedgerAuthChallenge as signAuthChallengeProof, validateLedgerAuthChallenge,
  signLedgerAuthMutationChallenge as signAuthMutationChallengeProof, validateLedgerAuthMutationChallenge,
  signLedgerMutation as signMutationProof, signLedgerTargetAccess, signLedgerTargetApproval,
  validateLedgerPrepare, validateLedgerRead, validateLedgerMutation } from './ledger-contract.mjs';
import { validateBackupIOProof, signBackupIOProof, validateRestoreKeyProof, signRestoreKeyProof } from './backup-contract.mjs';
import { validateWifiPayload, verifyWifiProof, signWifiProof, wifiDigest } from './offline-wifi-contract.mjs';

const derive = promisify(scrypt);
const KDF = 'scrypt-131072-8-1';
const KDF_OPTIONS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 });
const MAX_STATE = 256 * 1024;
const MAX_FILE = MAX_STATE * 2;
const ACCESS_LIFETIME_MS = 15 * 60 * 1000;
const PROTECTION = 'software-passphrase-v1';
const INITIAL_STATE = { schemaVersion: 1, boxes: {} };
let kdfQueue = Promise.resolve();

function failure(suffix) {
  const code = `LOCAL_IDENTITY_${suffix}`;
  return Object.assign(new Error(code), { code });
}

function requireCondition(condition, suffix = 'INVALID') {
  if (!condition) throw failure(suffix);
}

function fields(value, expected) {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'CORRUPT');
  requireCondition(Object.getPrototypeOf(value) === Object.prototype, 'CORRUPT');
  const keys = Reflect.ownKeys(value);
  requireCondition(keys.length === expected.length && expected.every((key) => keys.includes(key)), 'CORRUPT');
  requireCondition(keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  }), 'CORRUPT');
}

function decoded(value, length) {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 'CORRUPT');
  const bytes = Buffer.from(value, 'base64url');
  requireCondition(bytes.toString('base64url') === value && (length === undefined || bytes.length === length), 'CORRUPT');
  return bytes;
}

function jsonText(value, depth = 0) {
  requireCondition(depth < 40);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireCondition(Number.isSafeInteger(value) && !Object.is(value, -0));
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value, (item) => jsonText(item, depth + 1)).join(',')}]`;
  requireCondition(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  requireCondition(Reflect.ownKeys(value).every((key) => typeof key === 'string'
    && Object.getOwnPropertyDescriptor(value, key).enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')));
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jsonText(value[key], depth + 1)}`).join(',')}}`;
}

function stateBytes(state) {
  requireCondition(state && typeof state === 'object' && !Array.isArray(state));
  const bytes = Buffer.from(jsonText(state));
  requireCondition(bytes.length <= MAX_STATE, 'STATE_TOO_LARGE');
  return bytes;
}

function passphraseBytes(passphrase) {
  requireCondition(typeof passphrase === 'string' && passphrase.length >= 12
    && Buffer.byteLength(passphrase, 'utf8') <= 1024 && !/[\u0000-\u001f\u007f]/.test(passphrase), 'PASSPHRASE_INVALID');
  // No trim or Unicode normalization: the exact local secret is the credential.
  return Buffer.from(passphrase, 'utf8');
}

async function deriveKey(passphrase, salt, check) {
  const previous = kdfQueue;
  let release;
  kdfQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    check();
    const key = await derive(passphrase, salt, 32, KDF_OPTIONS);
    try { check(); return key; } catch (error) { key.fill(0); throw error; }
  } finally { release(); }
}

function aad(profile, purpose, slot) {
  return Buffer.from(jsonText({ schemaVersion: 1, profile, purpose,
    ...(slot ? { kdf: slot.kdf, salt: slot.salt } : {}) }));
}

function seal(bytes, key, additionalData) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return { nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}

function unseal(slot, key, additionalData) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decoded(slot.nonce, 12));
    decipher.setAAD(additionalData);
    decipher.setAuthTag(decoded(slot.tag, 16));
    return Buffer.concat([decipher.update(decoded(slot.ciphertext)), decipher.final()]);
  } catch { throw failure('UNLOCK_FAILED'); }
}

function validateCipher(slot, keySlot = false) {
  fields(slot, keySlot ? ['kdf', 'salt', 'nonce', 'ciphertext', 'tag'] : ['nonce', 'ciphertext', 'tag']);
  if (keySlot) { requireCondition(slot.kdf === KDF, 'CORRUPT'); decoded(slot.salt, 32); }
  decoded(slot.nonce, 12); decoded(slot.tag, 16); decoded(slot.ciphertext);
}

function validateEnvelope(envelope) {
  fields(envelope, ['schemaVersion', 'profile', 'accessSlot', 'approvalSlot', 'state']);
  requireCondition(envelope.schemaVersion === 1, 'CORRUPT');
  const profile = envelope.profile;
  fields(profile, ['profileId', 'principalId', 'clientId', 'accessKey', 'approvalKey', 'keyProtection']);
  for (const field of ['profileId', 'principalId', 'clientId']) {
    requireCondition(typeof profile[field] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.exec(profile[field])?.[0] === profile[field], 'CORRUPT');
  }
  requireCondition(profile.keyProtection === PROTECTION, 'CORRUPT');
  try {
    requireCondition(publicKeyThumbprint(profile.accessKey) !== publicKeyThumbprint(profile.approvalKey), 'CORRUPT');
  } catch { throw failure('CORRUPT'); }
  validateCipher(envelope.accessSlot, true);
  validateCipher(envelope.approvalSlot, true);
  validateCipher(envelope.state);
  return envelope;
}

function privateKey(bytes, expected) {
  try {
    const key = createPrivateKey({ key: bytes, type: 'pkcs8', format: 'der' });
    requireCondition(key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1', 'CORRUPT');
    requireCondition(publicKeyThumbprint(createPublicKey(key).export({ format: 'jwk' })) === publicKeyThumbprint(expected), 'CORRUPT');
    return key;
  } catch { throw failure('CORRUPT'); }
}

// Main-process-only software identity. Keys and key handles never leave this
// closure. A valid local signature is not attested native user presence.
export function createIdentityVault({ directory, clock = Date.now, protectDirectory } = {}) {
  requireCondition(typeof directory === 'string' && directory.length > 0 && typeof clock === 'function');
  const root = path.resolve(directory);
  const file = path.join(root, 'identity-vault.json');
  let loaded = false, knownExists = false, envelope = null, fingerprint = null;
  let accessKey = null, stateKey = null, state = null, unlockedAt = 0;
  let generation = 0, closed = false, loading = null, writes = Promise.resolve();
  let expiryTimer;
  const listeners = new Set();

  function notify(type, reason = null) {
    const event = Object.freeze({ type, reason, generation });
    // One observer cannot prevent other main-owned connections from fencing.
    for (const listener of listeners) { try { listener(event); } catch {} }
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => lock('expired'), ACCESS_LIFETIME_MS);
    expiryTimer.unref?.();
  }

  function lock(reason = 'lock') {
    generation += 1;
    clearTimeout(expiryTimer); expiryTimer = null;
    stateKey?.fill(0);
    accessKey = null; stateKey = null; state = null; unlockedAt = 0;
    notify('locked', reason);
  }

  function check(expected, guard) {
    requireCondition(!closed && expected === generation, 'CANCELLED');
    if (guard !== undefined) {
      requireCondition(typeof guard === 'function');
      const result = guard();
      requireCondition(!result || typeof result.then !== 'function');
      requireCondition(!closed && expected === generation, 'CANCELLED');
    }
  }

  function expireAccess() {
    if (!accessKey) return;
    const now = clock();
    if (!Number.isFinite(now) || now < unlockedAt || now - unlockedAt >= ACCESS_LIFETIME_MS) lock('expired');
  }

  function unlocked() {
    expireAccess();
    requireCondition(!closed && accessKey && stateKey && state, 'LOCKED');
  }

  function snapshot() {
    expireAccess();
    return { loaded, exists: knownExists, locked: !accessKey, generation,
      profile: envelope ? structuredClone(envelope.profile) : null };
  }

  async function privateDirectory(create = false) {
    try {
      if (create) await mkdir(root, { recursive: true, mode: 0o700 });
      let info;
      try { info = await lstat(root); } catch (error) { if (error.code === 'ENOENT' && !create) return false; throw error; }
      requireCondition(info.isDirectory() && !info.isSymbolicLink(), 'STORAGE_UNAVAILABLE');
      if (process.platform === 'win32') {
        requireCondition(typeof protectDirectory === 'function', 'STORAGE_UNAVAILABLE');
        await protectDirectory(root);
      } else {
        requireCondition(info.uid === process.getuid() && !(info.mode & 0o077), 'STORAGE_UNAVAILABLE');
      }
      return true;
    } catch (error) {
      if (error.code?.startsWith('LOCAL_IDENTITY_')) throw error;
      throw failure('STORAGE_UNAVAILABLE');
    }
  }

  async function readDisk() {
    if (!await privateDirectory()) return null;
    let handle;
    try {
      const entry = await lstat(file);
      knownExists = true;
      requireCondition(entry.isFile() && !entry.isSymbolicLink(), 'STORAGE_UNAVAILABLE');
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      requireCondition(info.isFile() && info.dev === entry.dev && info.ino === entry.ino
        && info.nlink === 1 && info.size > 0 && info.size <= MAX_FILE
        && (process.platform === 'win32' || (info.uid === process.getuid() && !(info.mode & 0o077))), 'CORRUPT');
      const bytes = Buffer.alloc(MAX_FILE + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await handle.read(bytes, size, bytes.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      requireCondition(size > 0 && size <= MAX_FILE, 'CORRUPT');
      const raw = bytes.subarray(0, size);
      let value;
      try { value = validateEnvelope(JSON.parse(raw.toString('utf8'))); } catch { throw failure('CORRUPT'); }
      return { value, hash: createHash('sha256').update(raw).digest('hex') };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code?.startsWith('LOCAL_IDENTITY_')) throw error;
      throw failure('STORAGE_UNAVAILABLE');
    } finally { await handle?.close(); }
  }

  async function load() {
    requireCondition(!closed, 'CANCELLED');
    if (loaded) return snapshot();
    if (loading) return loading;
    const expected = generation;
    loading = (async () => {
      const disk = await readDisk();
      check(expected);
      if (!disk) requireCondition(!knownExists, 'MISSING');
      envelope = disk?.value || null; fingerprint = disk?.hash || null; loaded = true;
      return snapshot();
    })().finally(() => { loading = null; });
    return loading;
  }

  async function persist(value, expected, { creating = false, guard } = {}) {
    check(expected, guard);
    await privateDirectory(true);
    const disk = await readDisk();
    check(expected, guard);
    if (creating) requireCondition(!disk && !knownExists, 'EXISTS');
    else requireCondition(disk && disk.hash === fingerprint, disk ? 'STATE_CONFLICT' : 'MISSING');
    const raw = Buffer.from(jsonText(value));
    requireCondition(raw.length <= MAX_FILE, 'STATE_TOO_LARGE');
    const temporary = path.join(root, `${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = null;
      check(expected, guard);
      // The check and atomic commit share one synchronous turn. A queued lock
      // cannot intervene after the check and before the filesystem commit.
      if (creating) { linkSync(temporary, file); unlinkSync(temporary); }
      else renameSync(temporary, file);
      if (process.platform !== 'win32') {
        const parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
      envelope = value; fingerprint = createHash('sha256').update(raw).digest('hex'); knownExists = true; loaded = true;
    } catch (error) {
      if (error.code?.startsWith('LOCAL_IDENTITY_')) throw error;
      throw failure(error.code === 'EEXIST' ? 'EXISTS' : 'STORAGE_UNAVAILABLE');
    } finally { await handle?.close(); await unlink(temporary).catch(() => {}); }
  }

  async function encryptedSlot(profile, purpose, plaintext, passphrase, checkOperation) {
    const salt = randomBytes(32);
    const slot = { kdf: KDF, salt: salt.toString('base64url') };
    const key = await deriveKey(passphrase, salt, checkOperation);
    try { return { ...slot, ...seal(plaintext, key, aad(profile, purpose, slot)) }; }
    finally { key.fill(0); }
  }

  async function decryptSlot(purpose, passphrase, expected, guard) {
    const slot = envelope[`${purpose}Slot`];
    const key = await deriveKey(passphrase, decoded(slot.salt, 32), () => check(expected, guard));
    try { return unseal(slot, key, aad(envelope.profile, purpose, slot)); }
    finally { key.fill(0); }
  }

  async function createProfile({ passphrase } = {}) {
    const secret = passphraseBytes(passphrase);
    let accessDer, approvalDer, freshStateKey;
    const expected = generation;
    try {
      await load(); check(expected);
      requireCondition(!knownExists, 'EXISTS');
      const access = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const approval = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const profile = { profileId: randomUUID(), principalId: randomUUID(), clientId: randomUUID(),
        accessKey: access.publicKey.export({ format: 'jwk' }), approvalKey: approval.publicKey.export({ format: 'jwk' }), keyProtection: PROTECTION };
      accessDer = access.privateKey.export({ type: 'pkcs8', format: 'der' });
      approvalDer = approval.privateKey.export({ type: 'pkcs8', format: 'der' });
      freshStateKey = randomBytes(32);
      const accessPlaintext = Buffer.concat([freshStateKey, accessDer]);
      let accessSlot;
      try { accessSlot = await encryptedSlot(profile, 'access', accessPlaintext, secret, () => check(expected)); }
      finally { accessPlaintext.fill(0); }
      const approvalSlot = await encryptedSlot(profile, 'approval', approvalDer, secret, () => check(expected));
      const value = { schemaVersion: 1, profile, accessSlot, approvalSlot,
        state: seal(stateBytes(INITIAL_STATE), freshStateKey, aad(profile, 'state')) };
      await persist(value, expected, { creating: true });
      check(expected);
      accessKey = access.privateKey; stateKey = freshStateKey; freshStateKey = null;
      state = structuredClone(INITIAL_STATE); unlockedAt = clock();
      scheduleExpiry(); notify('unlocked');
      return structuredClone(profile);
    } finally { secret.fill(0); accessDer?.fill(0); approvalDer?.fill(0); freshStateKey?.fill(0); }
  }

  async function unlock({ passphrase } = {}) {
    const secret = passphraseBytes(passphrase);
    lock();
    const expected = generation;
    let plaintext, candidateStateKey;
    try {
      await load();
      const disk = await readDisk(); check(expected);
      requireCondition(disk, 'MISSING');
      envelope = disk.value; fingerprint = disk.hash;
      plaintext = await decryptSlot('access', secret, expected);
      requireCondition(plaintext.length > 32, 'CORRUPT');
      candidateStateKey = Buffer.from(plaintext.subarray(0, 32));
      const candidateAccessKey = privateKey(plaintext.subarray(32), envelope.profile.accessKey);
      const statePlaintext = unseal(envelope.state, candidateStateKey, aad(envelope.profile, 'state'));
      let candidateState;
      try { candidateState = JSON.parse(statePlaintext.toString('utf8')); stateBytes(candidateState); }
      catch { throw failure('CORRUPT'); }
      finally { statePlaintext.fill(0); }
      check(expected);
      accessKey = candidateAccessKey; stateKey = candidateStateKey; candidateStateKey = null;
      state = candidateState; unlockedAt = clock();
      scheduleExpiry(); notify('unlocked');
      return structuredClone(envelope.profile);
    } finally { secret.fill(0); plaintext?.fill(0); candidateStateKey?.fill(0); }
  }

  function readState() { unlocked(); return structuredClone(state); }

  function writeState(value) {
    unlocked();
    const plaintext = stateBytes(value);
    const candidateState = JSON.parse(plaintext.toString('utf8'));
    const expected = generation;
    const next = writes.then(async () => {
      check(expected); unlocked();
      const candidate = { ...envelope, state: seal(plaintext, stateKey, aad(envelope.profile, 'state')) };
      await persist(candidate, expected);
      check(expected); state = candidateState; notify('state-changed');
    }).finally(() => plaintext.fill(0));
    writes = next.catch(() => {});
    return next;
  }

  function withAccess(payload, operation, { checkClient = true } = {}) {
    unlocked();
    const expected = generation;
    if (checkClient) requireCondition(payload?.clientId === envelope.profile.clientId, 'IDENTITY_MISMATCH');
    const result = operation(payload, accessKey);
    check(expected); return result;
  }

  async function withApproval({ payload, passphrase, guard } = {}, operation) {
    unlocked();
    const expected = generation;
    check(expected, guard);
    const immutablePayload = JSON.parse(jsonText(payload));
    const secret = passphraseBytes(passphrase);
    let plaintext;
    try {
      plaintext = await decryptSlot('approval', secret, expected, guard);
      const approvalKey = privateKey(plaintext, envelope.profile.approvalKey);
      unlocked(); check(expected, guard);
      const result = operation(immutablePayload, approvalKey);
      check(expected, guard); return result;
    } finally { secret.fill(0); plaintext?.fill(0); }
  }

  function requireLedgerActor(payload, { historicalRead = false } = {}) {
    unlocked();
    const association = state.boxes?.[payload.boxId];
    requireCondition(payload.actor?.kind === 'binding' && association
      && association.principalId === payload.actor.principalId && association.bindingId === payload.actor.bindingId
      && publicKeyThumbprint(association.descriptor.boxKey) === payload.boxKeyThumbprint
      && (!association.checkpoint || (historicalRead
        ? payload.ownershipEpoch >= association.checkpoint.ownershipEpoch
        : association.checkpoint.ownershipEpoch === payload.ownershipEpoch)), 'IDENTITY_MISMATCH');
  }

  function requireLedgerTarget(payload) {
    unlocked();
    const target = payload.args?.target;
    requireCondition(['device.add-manager', 'principal.invite', 'recovery.recover'].includes(payload.action)
      && target?.clientId === envelope.profile.clientId && target.keyProtection === envelope.profile.keyProtection
      && publicKeyThumbprint(target.accessKey) === publicKeyThumbprint(envelope.profile.accessKey)
      && publicKeyThumbprint(target.approvalKey) === publicKeyThumbprint(envelope.profile.approvalKey), 'IDENTITY_MISMATCH');
  }

  function requireWifiActor(context) {
    unlocked();
    const association = state.boxes?.[context.boxId];
    requireCondition(association?.bindingId === context.bindingId &&
      (!context.principalId || association.principalId === context.principalId) &&
      context.clientId === envelope.profile.clientId &&
      association.checkpoint?.ownershipEpoch === context.ownershipEpoch &&
      publicKeyThumbprint(association.descriptor.boxKey) === context.boxKeyThumbprint, 'IDENTITY_MISMATCH');
    return association;
  }
  function wifiReceipt(kind, receipt, boxId) {
    unlocked();
    const association = state.boxes?.[boxId];
    requireCondition(Boolean(association), 'IDENTITY_MISMATCH');
    const value = verifyWifiProof(kind, receipt, association.descriptor.boxKey);
    requireCondition(value.context.boxId === boxId, 'IDENTITY_MISMATCH');
    requireWifiActor(value.context);
    return value;
  }

  return Object.freeze({
    load, snapshot, createProfile, unlock, lock, readState, writeState,
    signOfflineWifiIntent(input) {
      const payload = validateWifiPayload('intent', input); requireWifiActor(payload);
      return withAccess(payload, (value, key) => signWifiProof('intent', value, key));
    },
    signOfflineWifiSession({ boxId, challenge, payload }) {
      const checked = wifiReceipt('challenge', challenge, boxId), value = validateWifiPayload('session-access', payload);
      requireCondition(value.challengeDigest === wifiDigest(checked), 'IDENTITY_MISMATCH');
      return withAccess(value, (body, key) => signWifiProof('session-access', body, key), { checkClient: false });
    },
    signOfflineWifiApply({ boxId, sessionReceipt, payload, passphrase, guard }) {
      const checked = wifiReceipt('session-receipt', sessionReceipt, boxId), value = validateWifiPayload('apply', payload);
      requireCondition(value.sessionDigest === wifiDigest(checked) && value.applyNonce === checked.applyNonce, 'IDENTITY_MISMATCH');
      return withApproval({ payload: value, passphrase, guard }, (body, key) => {
        requireWifiActor(checked.context); return signWifiProof('apply', body, key);
      });
    },
    signRead: (payload) => withAccess(payload, signReadProof),
    signDataSessionIntent(payload) {
      const value = validateSessionIntentPayload(payload);
      unlocked();
      const association = state.boxes?.[value.boxId];
      requireCondition(association?.bindingId === value.bindingId
        && Number.isSafeInteger(association?.checkpoint?.ownershipEpoch) && association.checkpoint.ownershipEpoch > 0
        && publicKeyThumbprint(association.descriptor.boxKey) === value.boxKeyThumbprint, 'IDENTITY_MISMATCH');
      return withAccess(value, signDataSessionIntentProof, { checkClient: false });
    },
    signDataSession(payload) {
      payload = validateSessionPayload(payload);
      unlocked();
      const association = state.boxes?.[payload?.boxId];
      requireCondition(association?.bindingId === payload?.bindingId && association?.principalId === payload?.principalId
        && association?.checkpoint?.ownershipEpoch === payload?.ownershipEpoch
        && publicKeyThumbprint(association.descriptor.boxKey) === payload?.boxKeyThumbprint, 'IDENTITY_MISMATCH');
      return withAccess(payload, signDataSessionProof);
    },
    signLedgerPrepare(payload) {
      const value = validateLedgerPrepare(payload); requireLedgerActor(value);
      return withAccess(value, signPrepareProof, { checkClient: false });
    },
    signLedgerAuthChallenge(payload) {
      const value = validateLedgerAuthChallenge(payload); requireLedgerActor(value);
      // This challenge proves the saved actor only. The server decides whether
      // it may issue a current challenge or permit a finite historical read.
      requireCondition(state.boxes[value.boxId].checkpoint?.ownershipEpoch === value.ownershipEpoch, 'IDENTITY_MISMATCH');
      return withAccess(value, signAuthChallengeProof, { checkClient: false });
    },
    signLedgerAuthMutationChallenge(payload) {
      const value = validateLedgerAuthMutationChallenge(payload); requireLedgerActor(value);
      requireCondition(state.boxes[value.boxId].checkpoint?.ownershipEpoch === value.ownershipEpoch, 'IDENTITY_MISMATCH');
      return withAccess(value, signAuthMutationChallengeProof, { checkClient: false });
    },
    signLedgerRead(payload) {
      const value = validateLedgerRead(payload);
      requireLedgerActor(value, { historicalRead: ['self-binding', 'mutation-status', 'transfer-status'].includes(value.operation) });
      return withAccess(value, signLedgerReadProof, { checkClient: false });
    },
    signBackupIO(payload) {
      const value = validateBackupIOProof(payload); requireLedgerActor(value);
      requireCondition(state.boxes[value.boxId].checkpoint?.ownershipEpoch === value.ownershipEpoch, 'IDENTITY_MISMATCH');
      return withAccess(value, signBackupIOProof, { checkClient: false });
    },
    signRestoreKey(payload) {
      const value = validateRestoreKeyProof(payload); requireLedgerActor(value);
      requireCondition(state.boxes[value.boxId].checkpoint?.ownershipEpoch === value.ownershipEpoch, 'IDENTITY_MISMATCH');
      return withAccess(value, signRestoreKeyProof, { checkClient: false });
    },
    signLedgerMutation(input) {
      const value = validateLedgerMutation(input?.payload); requireLedgerActor(value);
      return withApproval({ ...input, payload: value }, (payload, key) => { requireLedgerActor(payload); return signMutationProof(payload, key); });
    },
    signLedgerTarget(input) {
      const value = validateLedgerMutation(input?.payload); requireLedgerTarget(value);
      return withApproval({ ...input, payload: value }, (payload, key) => {
        requireLedgerTarget(payload);
        return { targetAccessProof: signLedgerTargetAccess(payload, accessKey), targetApprovalProof: signLedgerTargetApproval(payload, key) };
      });
    },
    signBinding: (request) => withAccess(request, signRequest),
    signCancel: (payload) => withAccess(payload, signCancellation, { checkClient: false }),
    signApproval: (input) => withApproval(input, signBindingApproval),
    signFirstRoot: ({ payload, claimSecret, passphrase, guard }) => withApproval({ payload, passphrase, guard }, (value, approvalPrivateKey) => {
      requireCondition(value.principalId === envelope.profile.principalId && value.clientId === envelope.profile.clientId, 'IDENTITY_MISMATCH');
      return signRootProofs(value, { accessPrivateKey: accessKey, approvalPrivateKey, claimSecret });
    }),
    subscribe(listener) {
      requireCondition(!closed && typeof listener === 'function');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    close() { lock('closed'); closed = true; listeners.clear(); },
  });
}

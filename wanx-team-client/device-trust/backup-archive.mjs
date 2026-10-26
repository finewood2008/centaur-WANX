import { createHash } from 'node:crypto';
import { canonicalLedger } from './ledger-contract.mjs';
import { BACKUP_CHUNK_BYTES, BACKUP_MAX_BYTES, validateBackupHeader, verifyBackupSourceProof } from './backup-contract.mjs';

const fail = () => { throw Object.assign(new Error('LOCAL_BACKUP_SOURCE_INVALID'), { code: 'LOCAL_BACKUP_SOURCE_INVALID' }); };
const need = condition => { if (!condition) fail(); };

// Authenticate the complete local ciphertext before sending any file bytes to
// a box. In particular, choosing an offline recovery JSON/PEM as the archive
// must not upload its private keys and only then fail at the remote parser.
// The caller supplies bounded reads from an already pinned native file handle.
export async function inspectLocalBackupArchive({ read, archiveBytes, descriptor }) {
  need(Number.isSafeInteger(archiveBytes) && archiveBytes > 0 && archiveBytes <= BACKUP_MAX_BYTES);
  let offset = 0;
  const archiveHash = createHash('sha256'), ciphertextHash = createHash('sha256');
  async function bytes(length, consume) {
    need(Number.isSafeInteger(length) && length > 0 && length <= BACKUP_CHUNK_BYTES && offset + length <= archiveBytes);
    const block = await read(offset, length);
    try {
      need(Buffer.isBuffer(block) && block.length === length);
      archiveHash.update(block); offset += length;
      return consume(block);
    } finally { block?.fill?.(0); }
  }
  async function length(ciphertext = false) {
    return bytes(4, block => { if (ciphertext) ciphertextHash.update(block); return block.readUInt32BE(); });
  }
  await bytes(8, block => need(block.equals(Buffer.from('CXBKP1\r\n', 'ascii'))));
  const headerLength = await length(); need(headerLength > 0 && headerLength <= 16384);
  const header = await bytes(headerLength, block => {
    need(block.every(byte => byte <= 127));
    const raw = block.toString('ascii'); let value;
    try { value = JSON.parse(raw); } catch { fail(); }
    need(canonicalLedger(value) === raw); return validateBackupHeader(value);
  });
  need(header.plaintextBytes + header.chunkCount * 20 < archiveBytes);
  let ciphertextBytes = 0;
  for (let index = 0; index < header.chunkCount; index++) {
    const size = await length(true), expected = Math.min(BACKUP_CHUNK_BYTES, header.plaintextBytes - index * BACKUP_CHUNK_BYTES) + 16;
    need(size === expected); ciphertextBytes += size + 4;
    for (let remaining = size; remaining > 0;) {
      const count = Math.min(remaining, BACKUP_CHUNK_BYTES);
      await bytes(count, block => ciphertextHash.update(block)); remaining -= count;
    }
  }
  const proofLength = await length(); need(proofLength > 0 && proofLength <= 8192);
  const sourceProof = await bytes(proofLength, block => { need(block.every(byte => byte <= 127)); return block.toString('ascii'); });
  await bytes(8, block => need(block.equals(Buffer.from('CXBEND1\n', 'ascii'))));
  need(offset === archiveBytes);
  const source = verifyBackupSourceProof(sourceProof, descriptor, header);
  need(source.ciphertextBytes === ciphertextBytes && source.ciphertextSha256 === ciphertextHash.digest('base64url'));
  return { header, sourceProof, archiveSha256: archiveHash.digest('base64url') };
}

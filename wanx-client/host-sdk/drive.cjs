const {createHash, randomUUID} = require('node:crypto');

const PREFIX = '/api/personal-space';
const CHUNK_SIZE = 4 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), {code});
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const id = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw fail('SPACE_INVALID_ID');
  return value;
};
const folder = value => value === '' ? '' : id(value);

// The Host binds this client to one account and one box for the entire launch.
// v1 intentionally shares that user's drive across all hosted applications.
function createDriveClient(host) {
  let initialized;
  async function request(route, options = {}) {
    options.signal?.throwIfAborted();
    await (initialized ||= host.context().catch(error => { initialized = null; throw error; }));
    return host.request(PREFIX + route, {timeoutMs: route.endsWith('/complete') ? 120_000 : 60_000, ...options});
  }
  async function json(route, options = {}) {
    const response = await request(route, options);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw fail(body?.detail?.code || body?.error?.code ||
        (response.status === 404 && route === '/overview' ? 'SPACE_UPGRADE_REQUIRED' : 'SPACE_REQUEST_FAILED'));
    }
    return response.status === 204 ? undefined : response.json();
  }
  const uploadStatus = (uploadId, {signal} = {}) => json(`/uploads/${id(uploadId)}`, {signal});
  const createUpload = ({uploadId, name, size, parent = '', signal}) => json('/uploads', {
    method: 'POST', body: {id: id(uploadId), parent: folder(parent), name, size}, signal,
  });
  const writeChunk = (uploadId, {offset, data, signal}) => {
    if (!(data instanceof Uint8Array) || !data.length || data.length > CHUNK_SIZE) throw fail('SPACE_CHUNK_INVALID');
    return json(`/uploads/${id(uploadId)}?offset=${offset}`, {method: 'PUT', body: data, signal,
      headers: {'content-type': 'application/octet-stream', 'x-content-sha256': digest(data)}});
  };
  const completeUpload = (uploadId, {digest: checksum, signal}) => json(`/uploads/${id(uploadId)}/complete`, {
    method: 'POST', body: {digest: checksum}, signal,
  });
  const stat = (itemId, {signal} = {}) => json(`/files/${id(itemId)}`, {signal});

  async function upload({name, parent = '', data, size, uploadId = randomUUID().replaceAll('-', ''), signal, onProgress} = {}) {
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    const fixed = data instanceof Uint8Array;
    if (fixed) size ??= data.byteLength;
    if (!Number.isSafeInteger(size) || size < 0 || (!fixed && !data?.[Symbol.asyncIterator])) throw fail('SPACE_INVALID_SIZE');
    if (fixed && size !== data.byteLength) throw fail('SPACE_INVALID_SIZE');
    try {
      const remote = await createUpload({uploadId, name, size, parent, signal});
      if (!Number.isSafeInteger(remote.offset) || remote.offset < 0 || remote.offset > size) throw fail('SPACE_CHUNK_INVALID');
      let seen = 0, offset = remote.offset, filled = 0;
      const checksum = createHash('sha256'), buffer = Buffer.alloc(CHUNK_SIZE);
      const append = async () => {
        const result = await writeChunk(uploadId, {offset, data: buffer.subarray(0, filled), signal});
        if (result.offset !== offset + filled) throw fail('SPACE_CHUNK_INVALID');
        offset = result.offset; filled = 0; onProgress?.({uploadId, offset, size});
      };
      onProgress?.({uploadId, offset, size});
      for await (const part of fixed ? [data] : data) {
        signal?.throwIfAborted();
        if (!(part instanceof Uint8Array)) throw fail('SPACE_CHUNK_INVALID');
        const bytes = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
        if (seen + bytes.length > size) throw fail('SPACE_INVALID_SIZE');
        checksum.update(bytes);
        let cursor = Math.min(bytes.length, Math.max(0, remote.offset - seen));
        seen += bytes.length;
        while (cursor < bytes.length) {
          const count = Math.min(CHUNK_SIZE - filled, bytes.length - cursor);
          bytes.copy(buffer, filled, cursor, cursor + count); filled += count; cursor += count;
          if (filled === CHUNK_SIZE) await append();
        }
      }
      if (seen !== size) throw fail('SPACE_INVALID_SIZE');
      if (filled) await append();
      const expected = checksum.digest('hex');
      const entry = await completeUpload(uploadId, {digest: expected, signal});
      if (entry.digest !== expected || entry.size !== size) throw fail('SPACE_LOCAL_FILE_CHANGED');
      return entry;
    } catch (error) {
      // Keep the unfinished upload for explicit resume with the same id.
      if (error && typeof error === 'object') error.uploadId = uploadId;
      throw error;
    }
  }

  async function* read(itemId, {signal} = {}) {
    const entry = await stat(itemId, {signal});
    if (entry.kind !== 'file') throw fail('SPACE_NOT_FILE');
    const checksum = createHash('sha256');
    for (let offset = 0; offset < entry.size;) {
      const response = await request(`/files/${id(itemId)}/content?offset=${offset}&length=${CHUNK_SIZE}`, {signal});
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw fail(body?.detail?.code || 'SPACE_REQUEST_FAILED');
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > Math.min(CHUNK_SIZE, entry.size - offset) ||
          digest(bytes) !== response.headers.get('x-content-sha256')) throw fail('SPACE_CHUNK_INVALID');
      const etag = response.headers.get('etag');
      if (etag !== entry.digest && etag !== `"${entry.digest}"`) throw fail('SPACE_REMOTE_FILE_CHANGED');
      checksum.update(bytes); offset += bytes.length;
      yield bytes;
    }
    if (checksum.digest('hex') !== entry.digest) throw fail('SPACE_CHUNK_INVALID');
  }

  return Object.freeze({
    overview: ({signal} = {}) => json('/overview', {signal}),
    list: ({parent = '', trash = false, signal} = {}) => json(`/files?parent=${folder(parent)}&trash=${trash === true}`, {signal}),
    stat,
    mkdir: ({name, parent = '', signal}) => json('/folders', {method: 'POST', body: {parent: folder(parent), name}, signal}),
    move: ({id: itemId, name, parent = '', signal}) => json(`/files/${id(itemId)}`, {method: 'PATCH', body: {parent: folder(parent), name}, signal}),
    trash: (itemId, {signal} = {}) => json(`/files/${id(itemId)}`, {method: 'DELETE', signal}),
    restore: (itemId, {signal} = {}) => json(`/trash/${id(itemId)}/restore`, {method: 'POST', signal}),
    purge: (itemId, {signal} = {}) => json(`/trash/${id(itemId)}`, {method: 'DELETE', signal}),
    createUpload, uploadStatus, writeChunk, completeUpload,
    cancelUpload: (uploadId, {signal} = {}) => json(`/uploads/${id(uploadId)}`, {method: 'DELETE', signal}),
    upload, read,
  });
}

module.exports = {createDriveClient};

import { createHash, randomUUID } from "node:crypto";
import { open, stat, lstat, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";

const PREFIX = "/api/personal-space";
const CHUNK = 4 * 1024 * 1024;
const RECOVERY_CHUNK = 1024 * 1024;
// Match the client's existing binary MB display. Applies to new UI batches only.
export const MAX_UPLOAD_FILES = 20;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const uploadLimit = message => Object.assign(new Error(message), { code: "SPACE_UPLOAD_LIMIT" });
const transientCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "EAI_AGAIN", "CONNECT_TIMEOUT", "SESSION_CLOSED", "GATEWAY_CLOSED", "NETWORK_CHANGED", "NETWORK_NOT_READY", "BOX_CONNECTION_REQUIRED", "SPACE_CONNECTION_TIMEOUT", "SPACE_CHUNK_STALLED", "SPACE_NETWORK_WAIT", "SPACE_UPLOAD_OFFSET", "tunnel_timeout", "tunnel_rejected", "network_unavailable", "network_recovering", "netbird_peer_disconnected"]);
const errorCode = cause => cause?.code || ((transientCodes.has(cause?.message) || permanentCodes.has(cause?.message)) ? cause.message : "SPACE_TRANSFER_FAILED");
const permanentCodes = new Set(["ACCOUNT_ACCESS_DENIED", "ACCOUNT_LOGIN_REQUIRED", "ACCOUNT_SESSION_EXPIRED", "NETWORK_DEVICE_ACCESS_DENIED", "PLATFORM_SESSION_EXPIRED", "BOX_PLATFORM_AUTH_FAILED", "BOX_PLATFORM_SESSION_EXPIRED", "BOX_UPSTREAM_AUTH_FAILED", "SPACE_DISK_FULL", "SPACE_LOCAL_FILE_CHANGED", "SPACE_REMOTE_FILE_CHANGED", "SPACE_NOT_FOUND", "SPACE_LINK_SCOPE", "SPACE_AGENT_PAUSED", "SPACE_AGENT_DISCONNECTED"]);
const transient = cause => !permanentCodes.has(errorCode(cause)) && ![401, 403].includes(cause?.status) && (transientCodes.has(errorCode(cause)) || [408, 429, 502, 503, 504].includes(cause?.status));
const terminal = task => ["complete", "canceled"].includes(task.phase);
const fail = code => Object.assign(new Error(code), { code });
const id = value => { if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw fail("SPACE_INVALID_ID"); return value; };
const folder = value => value === "" ? "" : id(value);
const name = value => { if (typeof value !== "string" || !value.trim() || value.length > 240) throw fail("SPACE_INVALID_NAME"); return value; };
const hash = data => createHash("sha256").update(data).digest("hex");
const stamp = info => info ? `${info.size}:${info.mtimeMs}:${info.ino}` : null;
const fileStat = file => stat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });

// Lives in the main process. Local paths come from a native picker or preload's
// File conversion; credentials, remote URLs and user ids never come from the renderer.
export async function createPersonalSpace({ client, store, serviceURL, chooseUploads, chooseDownload, chooseDownloadDirectory, onChanged = () => {}, onEvent = () => {}, retryBaseMs = 1000, maxRetries = 6, random = Math.random }) {
  let restored = [], storageError = null;
  try { restored = await store.load() || []; if (!Array.isArray(restored)) throw new Error("Invalid transfer records"); }
  catch { storageError = "SECURE_STORAGE_READ_FAILED"; restored = []; }
  let tasks = restored.map(task => ({ ...task, phase: terminal(task) ? task.phase : task.recoveryVersion === 1 && task.autoResume ? "waiting" : "paused" }));
  let closed = false, lease = null, leaseKey = null, generation = 0, connectionPromise = null;
  let overview = null, phase = "disconnected", error = null;
  const running = new Map();
  let writes = Promise.resolve(), wakeTimer = null, retryUntil = 0, degraded = false;
  let boundAccount = null, boundBox = null, wasReady = false;
  const event = (task, action, details = {}) => { try { onEvent({ taskId: task.id, batchId: task.batchId, action, phase: task.phase, offset: task.offset, size: task.size, attempt: task.attempt || 0, ...details }); } catch {} };
  const accountKey = () => { const s = client.snapshot(); return s.account?.phase === "authenticated" ? JSON.stringify([serviceURL, s.account.accountId]) : null; };
  // A route going offline is not an account/box change. Retain its identity,
  // but never dispatch while the live connection is not ready for that box.
  const scopeKey = () => {
    const account = accountKey(), state = client.snapshot();
    if (!account) return null;
    const box = state.connection?.deviceId || (account === boundAccount ? boundBox : null);
    return box ? JSON.stringify([account, box]) : null;
  };
  const ready = () => client.snapshot().phase === "ready" && !!client.snapshot().connection?.deviceId;
  const notify = () => onChanged(snapshot());
  const persist = () => { if (storageError) return Promise.reject(fail(storageError)); const copy = structuredClone(tasks); writes = writes.catch(() => {}).then(() => store.save(copy)).catch(() => { storageError = "SECURE_STORAGE_WRITE_FAILED"; for (const task of tasks) if (!terminal(task)) { task.autoResume = false; task.phase = "paused"; task.pauseReason = "error"; task.error = storageError; } for (const job of running.values()) job.controller.abort(fail(storageError)); throw fail(storageError); }); return writes; };
  function snapshot() {
    const scope = scopeKey();
    return { phase, error, storageError, overview, scope, accountId: client.snapshot().account?.accountId, boxId: client.snapshot().connection?.deviceId || boundBox, tasks: tasks.filter(t => t.scope === scope).map(({ localPath, partialPath, localStamp, destinationStamp, digest, ...publicTask }) => publicTask) };
  }
  function schedulePump(ms = 0) {
    clearTimeout(wakeTimer);
    if (closed) return;
    wakeTimer = setTimeout(pump, Math.max(0, ms)); wakeTimer.unref?.();
  }
  function sync() {
    const next = scopeKey(), online = ready();
    if (next === leaseKey && online === wasReady) return;
    const changed = next !== leaseKey;
    generation++; leaseKey = next; lease = null; connectionPromise = null; wasReady = online;
    boundAccount = accountKey(); boundBox = next ? JSON.parse(next)[1] : null;
    if (changed) { overview = null; retryUntil = 0; degraded = false; }
    phase = online ? "idle" : "disconnected"; error = null;
    for (const task of tasks) {
      if (terminal(task) || task.phase === "paused") continue;
      if (changed && task.scope !== next) {
        task.autoResume = false; task.pauseReason = "context"; task.phase = "paused"; task.error = "SPACE_CONTEXT_CHANGED";
      } else if (!online) {
        task.phase = "waiting"; task.pauseReason = "network";
        if (task.direction === "upload") task.chunkSize = Math.min(task.chunkSize || CHUNK, RECOVERY_CHUNK);
      }
      event(task, "connection");
    }
    for (const job of running.values()) job.controller.abort(fail(changed ? "SPACE_CONTEXT_CHANGED" : "SPACE_NETWORK_WAIT"));
    void persist().catch(() => {});
    notify(); schedulePump();
  }
  const unsubscribe = client.subscribe(sync);
  sync();
  async function connect() {
    sync();
    if (closed || !leaseKey || !ready()) throw fail("BOX_CONNECTION_REQUIRED");
    if (lease) { try { lease.context(); return lease; } catch { lease = null; } }
    if (!connectionPromise) {
      const epoch = generation;
      const pending = client.applicationConnection().then(value => {
        if (epoch !== generation || closed) throw fail("SPACE_CONTEXT_CHANGED");
        lease = value;
        return value;
      }).finally(() => { if (connectionPromise === pending) connectionPromise = null; });
      connectionPromise = pending;
    }
    return connectionPromise;
  }
  async function request(connection, route, { method = "GET", body, signal, raw = false, headers = {} } = {}) {
    if (signal?.aborted) throw fail("SPACE_PAUSED");
    connection.context();
    const deadline = AbortSignal.timeout(route.endsWith("/complete") ? 120_000 : 60_000);
    let response;
    try {
      response = await connection.request({ path: `${PREFIX}${route}`, method, signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        ...(method === "PUT" && route.startsWith("/uploads/") ? { idleTimeoutMs: 15_000, freshConnection: true } : {}),
        headers: { ...(body && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers },
        body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
    } catch (cause) {
      if (deadline.aborted) throw fail("SPACE_CONNECTION_TIMEOUT");
      throw cause;
    }
    if (deadline.aborted) throw fail("SPACE_CONNECTION_TIMEOUT");
    if (signal?.aborted) throw fail("SPACE_PAUSED");
    connection.context();
    const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || "");
    let value;
    if (!raw || response.status >= 400) { try { value = JSON.parse(bytes.toString("utf8")); } catch {} }
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(fail(value?.detail?.code || value?.error?.code || (response.status === 404 ? "SPACE_UPGRADE_REQUIRED" : "SPACE_REQUEST_FAILED")), { status: response.status, retryAfter: (() => { const v = response.headers?.["retry-after"]; const seconds = Number(v); return v ? Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(v) - Date.now()) || 0 : 0; })() });
    return raw ? { bytes, headers: response.headers } : value;
  }
  async function refresh() {
    const connection = await connect(), epoch = generation;
    phase = "loading"; error = null; notify();
    try {
      const result = await request(connection, "/overview");
      if (result?.protocolVersion !== 1) throw fail("SPACE_UPGRADE_REQUIRED");
      if (epoch !== generation) throw fail("SPACE_CONTEXT_CHANGED");
      overview = result; phase = "ready";
    } catch (cause) {
      if (epoch === generation) { phase = cause.code === "SPACE_UPGRADE_REQUIRED" ? "unsupported" : "error"; error = cause.code || "SPACE_REQUEST_FAILED"; }
      throw cause;
    } finally { notify(); }
    return snapshot();
  }
  async function operation(action, input = {}) {
    const connection = await connect();
    switch (action) {
      case "restore-version": return request(connection, `/files/${id(input.id)}/previous`, { method: "POST", body: { expected: input.expected } });
      case "stat": return metadata(connection, input.id);
      case "list": return request(connection, `/files?parent=${folder(input.parent || "")}&trash=${input.trash === true}&space_id=${input.space_id && input.space_id !== "personal" ? id(input.space_id) : "personal"}`);
      case "mkdir": return request(connection, "/folders", { method: "POST", body: { parent: folder(input.parent || ""), name: name(input.name), space_id: input.space_id || "personal" } });
      case "move": return request(connection, `/files/${id(input.id)}`, { method: "PATCH", body: { parent: folder(input.parent || ""), name: name(input.name) } });
      case "trash": return request(connection, `/files/${id(input.id)}`, { method: "DELETE" });
      case "restore": return request(connection, `/trash/${id(input.id)}/restore`, { method: "POST" });
      case "purge": return request(connection, `/trash/${id(input.id)}`, { method: "DELETE" });
      default: throw fail("SPACE_ACTION_INVALID");
    }
  }
  async function metadata(connection, itemId) { return request(connection, `/files/${id(itemId)}`); }
  async function digestFile(file, signal) {
    const digest = createHash("sha256");
    const handle = await open(file, "r");
    try {
      for await (const chunk of handle.createReadStream({ highWaterMark: CHUNK, autoClose: false })) {
        if (signal.aborted) throw fail("SPACE_PAUSED");
        digest.update(chunk);
      }
      return digest.digest("hex");
    } finally { await handle.close(); }
  }
  async function run(task, controller) {
    const { signal } = controller;
    const connection = await connect();
    const transferRequest = async (route, options) => {
      const start = performance.now(); let failure;
      try { return await request(connection, route, options); }
      catch (cause) { failure = cause; throw cause; }
      finally { event(task, "request", { stage: route.endsWith("/complete") ? "commit" : options?.method === "PUT" ? "chunk" : "reconcile", durationMs: Math.round(performance.now() - start), errorCode: failure ? errorCode(failure) : undefined, httpStatus: failure?.status,
        transportPhase: failure?.transportPhase, requestBytes: failure?.requestBytes, responseBytes: failure?.responseBytes, reusedSocket: failure?.reusedSocket }); }
    };
    if (task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    if (task.direction === "upload") {
      if (stamp(await fileStat(task.localPath)) !== task.localStamp) throw fail("SPACE_LOCAL_FILE_CHANGED");
      task.phase = "checking"; notify();
      const digest = task.digest || await digestFile(task.localPath, signal);
      task.digest = digest;
      const remote = await transferRequest("/uploads", { method: "POST", signal, body: { id: task.id, parent: task.parent, name: task.name, size: task.size } });
      if (!Number.isSafeInteger(remote.offset) || remote.offset < 0 || remote.offset > task.size) throw fail("SPACE_UPLOAD_OFFSET_INVALID");
      task.offset = remote.offset; event(task, "reconciled");
      if (remote.state !== "complete") {
        const handle = await open(task.localPath, "r");
        try {
          task.phase = "running";
          while (task.offset < task.size) {
            if (signal.aborted) throw fail("SPACE_PAUSED");
            const buffer = Buffer.alloc(Math.min(task.chunkSize || CHUNK, task.size - task.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, task.offset);
            if (bytesRead !== buffer.length) throw fail("SPACE_LOCAL_FILE_CHANGED");
            const result = await transferRequest(`/uploads/${task.id}?offset=${task.offset}`, { method: "PUT", signal, body: buffer, headers: { "content-type": "application/octet-stream", "x-content-sha256": hash(buffer) } });
            if (result.offset !== task.offset + bytesRead) throw fail("SPACE_UPLOAD_OFFSET_INVALID");
            task.offset = result.offset; task.attempt = 0;
            event(task, "confirmed"); await persist(); notify();
          }
        } finally { await handle.close(); }
      }
      if (stamp(await fileStat(task.localPath)) !== task.localStamp) throw fail("SPACE_LOCAL_FILE_CHANGED");
      if (remote.state !== "complete") await transferRequest(`/uploads/${task.id}/complete`, { method: "POST", signal, body: { digest: task.digest } });
    } else {
      const entry = await metadata(connection, task.itemId);
      if (entry.digest !== task.digest || entry.size !== task.size) throw fail("SPACE_REMOTE_FILE_CHANGED");
      const existing = await lstat(task.partialPath).catch(e => { if (e.code !== "ENOENT") throw e; return null; });
      if (existing && (!existing.isFile() || existing.nlink !== 1)) throw fail("SPACE_UNSAFE_DESTINATION");
      const handle = await open(task.partialPath, existing ? "r+" : "wx", 0o600);
      try {
        if (!existing) task.offset = 0;
        if ((await handle.stat()).size < task.offset) task.offset = 0;
        await handle.truncate(task.offset);
        task.phase = "running";
        while (task.offset < task.size) {
          const result = await transferRequest(`/files/${task.itemId}/content?offset=${task.offset}&length=${CHUNK}`, { signal, raw: true });
          if (!result.bytes.length || result.bytes.length > Math.min(CHUNK, task.size - task.offset) || hash(result.bytes) !== result.headers["x-content-sha256"]) throw fail("SPACE_CHUNK_INVALID");
          await handle.write(result.bytes, 0, result.bytes.length, task.offset);
          await handle.sync();
          task.offset += result.bytes.length; await persist(); notify();
        }
      } finally { await handle.close(); }
      if (await digestFile(task.partialPath, signal) !== task.digest) { task.offset = 0; throw fail("SPACE_CHUNK_INVALID"); }
      if (stamp(await fileStat(task.localPath)) !== task.destinationStamp) throw fail("SPACE_DESTINATION_CHANGED");
      if (signal.aborted || task.scope !== scopeKey()) throw fail("SPACE_PAUSED");
      await rename(task.partialPath, task.localPath);
    }
    task.phase = "complete"; task.error = null; task.autoResume = false; task.pauseReason = null; task.attempt = 0; event(task, "completed");
  }
  function pump() {
    clearTimeout(wakeTimer); wakeTimer = null;
    if (closed || !ready() || !scopeKey() || storageError) return;
    if (degraded && !tasks.some(t => t.scope === scopeKey() && ["retrying", "running", "checking"].includes(t.phase))) degraded = false;
    if (Date.now() < retryUntil) { schedulePump(retryUntil - Date.now()); return; }
    for (const task of tasks) {
      if (running.size >= (degraded ? 1 : 2)) break;
      if (!["queued", "waiting", "retrying"].includes(task.phase) || task.scope !== scopeKey() || running.has(task.id)) continue;
      task.phase = "queued"; task.pauseReason = null; task.retryAt = null;
      const controller = new AbortController();
      const promise = run(task, controller).catch(cause => {
        const code = controller.signal.aborted ? errorCode(controller.signal.reason) : errorCode(cause);
        lease = null; connectionPromise = null;
        if (!task.autoResume || task.scope !== scopeKey()) {
          task.phase = "paused"; task.error = task.pauseReason === "user" ? null : code;
        } else if (closed || !ready() || code === "SPACE_NETWORK_WAIT") {
          task.phase = "waiting"; task.pauseReason = closed ? "restart" : "network"; task.error = null;
        } else if (transient(cause) && (task.attempt || 0) < maxRetries) {
          task.attempt = (task.attempt || 0) + 1;
          task.phase = "retrying"; task.pauseReason = "network"; task.error = code; degraded = true;
          task.chunkSize = Math.max(256 * 1024, Math.min(RECOVERY_CHUNK, Math.floor((task.chunkSize || CHUNK) / 2)));
          retryUntil = Math.max(retryUntil, Date.now() + Math.max(cause.retryAfter || 0, Math.min(30_000, retryBaseMs * 2 ** (task.attempt - 1)) * (0.5 + random())));
          task.retryAt = retryUntil;
        } else {
          task.phase = "paused"; task.autoResume = false; task.pauseReason = "error"; task.error = transient(cause) ? "SPACE_RETRY_EXHAUSTED" : code;
          if (transient(cause)) {
            // Stop dispatching the rest of this box's batch after bounded failures.
            // Existing user pauses retain their intent; explicit retry reopens it.
            for (const pending of tasks) if (pending.scope === task.scope && pending.autoResume && !terminal(pending)) {
              pending.phase = "paused"; pending.autoResume = false; pending.pauseReason = "error"; pending.error = "SPACE_RETRY_EXHAUSTED";
              running.get(pending.id)?.controller.abort(fail("SPACE_RETRY_EXHAUSTED"));
              event(pending, "interrupted", { errorCode: "SPACE_RETRY_EXHAUSTED" });
            }
          }
        }
        event(task, "interrupted", { errorCode: code, httpStatus: cause.status });
      }).finally(async () => {
        await persist().catch(() => { task.error = "SECURE_STORAGE_WRITE_FAILED"; task.phase = "paused"; task.autoResume = false; task.pauseReason = "error"; });
        running.delete(task.id); notify(); pump();
      });
      running.set(task.id, { controller, promise });
    }
  }
  async function uploads(parent, droppedPaths, expectedScope, droppedNames) {
    if (storageError) throw fail(storageError);
    folder(parent);
    await connect(); const scope = scopeKey(), epoch = generation;
    if (expectedScope !== undefined && expectedScope !== scope) throw fail("SPACE_CONTEXT_CHANGED");
    const selected = droppedPaths === undefined ? await chooseUploads() : droppedPaths;
    if (!Array.isArray(selected) || selected.some(file => typeof file !== "string" || !path.isAbsolute(file))) throw fail("SPACE_INVALID_DROP");
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    if (selected.length > MAX_UPLOAD_FILES) throw uploadLimit(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件，当前选择了 ${selected.length} 个；单文件最大 200 MB。本批文件未加入上传队列，请重新选择。`);
    if (!selected.length) return;
    if (droppedNames !== undefined && (!Array.isArray(droppedNames) || droppedNames.length !== selected.length)) throw fail("SPACE_INVALID_DROP");
    const selectedTasks = [], oversized = [], batchId = randomUUID().replaceAll("-", "");
    for (const [index, localPath] of selected.entries()) {
      // A disk-backed drag can expose an OS temporary path. Preserve the File's
      // visible name instead of turning that temporary basename into its title.
      const fileName = name(droppedNames === undefined ? path.basename(localPath) : droppedNames[index]);
      if (fileName !== fileName.trim() || /[\\/:*?"<>|\x00-\x1f]/.test(fileName) || fileName.endsWith(".") || Buffer.byteLength(fileName, "utf8") > 240) throw fail("SPACE_INVALID_NAME");
      const info = await stat(localPath);
      if (!info.isFile()) {
        if (droppedPaths !== undefined) throw fail("SPACE_DROP_FILES_ONLY");
        continue;
      }
      if (info.size > MAX_UPLOAD_BYTES) { oversized.push(fileName); continue; }
      if (tasks.some(t => !terminal(t) && t.scope === scope && t.direction === "upload" && t.parent === parent && t.localPath === localPath && t.name === fileName && t.localStamp === stamp(info))) continue;
      if (selectedTasks.some(t => t.localPath === localPath && t.name === fileName)) continue;
      selectedTasks.push({ batchId, recoveryVersion: 1, autoResume: true, id: randomUUID().replaceAll("-", ""), scope, direction: "upload", parent,
        localPath, localStamp: stamp(info), name: fileName, size: info.size, offset: 0, phase: "queued" });
    }
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    if (oversized.length) throw uploadLimit(`单文件最大 200 MB，以下 ${oversized.length} 个文件超过限制：${oversized.join("、")}。本批文件未加入上传队列，请重新选择。`);
    const unique = selectedTasks.filter(task => !tasks.some(t => !terminal(t) && t.scope === scope && t.direction === "upload" && t.parent === parent && t.localPath === task.localPath && t.name === task.name && t.localStamp === task.localStamp));
    tasks.push(...unique); for (const task of unique) event(task, "enqueued");
    try { await persist(); } catch (cause) { for (const t of tasks) if (t.phase === "queued") { t.phase = "paused"; t.autoResume = false; t.pauseReason = "error"; } throw cause; }
    notify(); pump();
  }
  async function download(itemId) {
    if (storageError) throw fail(storageError);
    const connection = await connect(), scope = scopeKey(), epoch = generation;
    const entry = await metadata(connection, itemId);
    if (entry.kind !== "file") throw fail("SPACE_NOT_FILE");
    const localPath = await chooseDownload(path.basename(entry.name));
    if (!localPath) return;
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    const taskId = randomUUID().replaceAll("-", "");
    const destinationStamp = stamp(await fileStat(localPath));
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    tasks.push({ recoveryVersion: 1, autoResume: true, id: taskId, scope, direction: "download", itemId, name: entry.name, size: entry.size, digest: entry.digest,
      localPath, destinationStamp, partialPath: path.join(path.dirname(localPath), `.wanx-${taskId}.part`), offset: 0, phase: "queued" });
    try { await persist(); } catch (cause) { for (const t of tasks) if (t.phase === "queued") { t.phase = "paused"; t.autoResume = false; t.pauseReason = "error"; } throw cause; }
    notify(); pump();
  }
  async function downloads(itemIds) {
    if (storageError) throw fail(storageError);
    if (!Array.isArray(itemIds) || !itemIds.length) throw fail("SPACE_INVALID_ID");
    const ids = [...new Set(itemIds.map(id))];
    const connection = await connect(), scope = scopeKey(), epoch = generation;
    const checkScope = () => { if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED"); };
    const entries = [];
    for (const itemId of ids) { entries.push(await metadata(connection, itemId)); checkScope(); }
    const directory = await chooseDownloadDirectory();
    checkScope();
    if (!directory) return { canceled: true };
    const planned = [], visited = new Set(), reserved = new Set(tasks.filter(t => t.scope === scope && !["complete", "canceled"].includes(t.phase)).map(t => t.localPath?.toLocaleLowerCase()));
    async function destination(base, entry) {
      // Remote names never become local path components without validation.
      if (typeof entry.name !== "string" || !entry.name || /^[. ]*$/.test(entry.name) || /[\\/\x00-\x1f]/.test(entry.name)) throw fail("SPACE_INVALID_NAME");
      let safeName = entry.name.replace(/[<>:"|?*]/g, "_").replace(/[. ]+$/, "_");
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName)) safeName = "_" + safeName;
      const parsed = path.parse(safeName);
      for (let index = 0; ; index++) {
        const candidate = path.join(base, index ? `${parsed.name} (${index})${parsed.ext}` : safeName);
        if (reserved.has(candidate.toLocaleLowerCase())) continue;
        const exists = await lstat(candidate).catch(cause => { if (cause.code === "ENOENT") return null; throw cause; });
        checkScope();
        if (exists) continue;
        reserved.add(candidate.toLocaleLowerCase());
        return candidate;
      }
    }
    async function collect(entry, base) {
      checkScope(); id(entry.id);
      if (visited.has(entry.id)) return;
      visited.add(entry.id);
      const localPath = await destination(base, entry);
      if (entry.kind === "folder") {
        await mkdir(localPath); checkScope();
        const listing = await request(connection, `/files?parent=${entry.id}&trash=false`);
        checkScope();
        for (const child of listing.items) await collect(child, localPath);
      } else if (entry.kind === "file") {
        const taskId = randomUUID().replaceAll("-", "");
        planned.push({ recoveryVersion: 1, autoResume: true, id: taskId, scope, direction: "download", itemId: entry.id, name: entry.name, size: entry.size, digest: entry.digest,
          localPath, destinationStamp: null, partialPath: path.join(base, `.wanx-${taskId}.part`), offset: 0, phase: "queued" });
      } else throw fail("SPACE_NOT_FILE");
    }
    for (const entry of entries) await collect(entry, directory);
    checkScope();
    tasks.push(...planned);
    try { await persist(); } catch (cause) { for (const task of planned) task.phase = "paused"; throw cause; }
    notify(); pump();
    return { count: planned.length };
  }
  async function transfer(action, taskId) {
    if (["pause-all", "resume-all", "retry-failed"].includes(action)) {
      sync(); const scope = scopeKey(), epoch = generation;
      const selected = tasks.filter(t => t.scope === scope && !terminal(t) && (action === "pause-all" ? t.phase !== "paused" : t.phase === "paused" && (action !== "retry-failed" || t.pauseReason === "error"))).map(t => t.id);
      if (action === "pause-all") for (const target of selected) { const task = tasks.find(t => t.id === target); task.autoResume = false; task.phase = "paused"; task.pauseReason = "user"; running.get(target)?.controller.abort(fail("SPACE_PAUSED")); }
      for (const target of selected) {
        if (scope !== scopeKey() || epoch !== generation) throw fail("SPACE_CONTEXT_CHANGED");
        await transfer(action === "pause-all" ? "pause" : "resume", target);
      }
      return;
    }
    const epoch = generation;
    const task = tasks.find(t => t.id === id(taskId) && t.scope === scopeKey());
    if (!task) throw fail("SPACE_NOT_FOUND");
    const job = running.get(task.id);
    if (action === "resume") {
      if (job || task.phase !== "paused") return;
      task.phase = "queued"; task.error = null; task.pauseReason = null; task.autoResume = true; task.recoveryVersion = 1; task.attempt = 0; retryUntil = 0; event(task, "resumed");
      try { await persist(); } catch (cause) { task.phase = "paused"; task.autoResume = false; notify(); throw cause; }
      notify(); pump(); return;
    }
    if (!["pause", "cancel"].includes(action) || task.phase === "complete") return;
    task.autoResume = false; task.pauseReason = "user"; task.phase = "paused"; event(task, "paused");
    job?.controller.abort(fail("SPACE_PAUSED")); await job?.promise;
    task.phase = "paused";
    if (action === "cancel") {
      if (epoch !== generation || task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
      if (task.direction === "upload") {
        const connection = await connect();
        if (epoch !== generation || task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
        await request(connection, `/uploads/${task.id}`, { method: "DELETE" });
      }
      else await unlink(task.partialPath).catch(e => { if (e.code !== "ENOENT") throw e; });
      task.phase = "canceled";
    }
    task.error = null; await persist(); notify();
  }
  async function preview(itemId) {
    const connection = await connect(), entry = await metadata(connection, itemId);
    const ext = path.extname(entry.name).toLowerCase();
    const type = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" })[ext] || ([".txt", ".md", ".csv", ".json", ".log"].includes(ext) ? "text/plain" : null);
    if (!type || entry.size > 16 * 1024 * 1024) throw fail("SPACE_PREVIEW_DOWNLOAD");
    const chunks = [];
    for (let offset = 0; offset < entry.size; offset += CHUNK) {
      const result = await request(connection, `/files/${entry.id}/content?offset=${offset}&length=${CHUNK}`, { raw: true });
      if (hash(result.bytes) !== result.headers["x-content-sha256"]) throw fail("SPACE_CHUNK_INVALID");
      chunks.push(result.bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (hash(bytes) !== entry.digest) throw fail("SPACE_CHUNK_INVALID");
    return { name: entry.name, type, data: bytes.toString("base64") };
  }
  return { snapshot, refresh, operation, uploads, download, downloads, transfer, preview,
    async close() { closed = true; clearTimeout(wakeTimer); generation++; unsubscribe(); for (const job of running.values()) job.controller.abort(); await Promise.allSettled([...running.values()].map(j => j.promise)); for (const t of tasks) if (t.phase === "queued") { t.phase = t.autoResume ? "waiting" : "paused"; t.pauseReason = "restart"; } if (!storageError) await persist(); } };
}

import { createHash, randomUUID } from "node:crypto";
import { open, stat, lstat, rename, unlink, mkdir } from "node:fs/promises";
import path from "node:path";

const PREFIX = "/api/personal-space";
const CHUNK = 4 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });
const id = value => { if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw fail("SPACE_INVALID_ID"); return value; };
const folder = value => value === "" ? "" : id(value);
const name = value => { if (typeof value !== "string" || !value.trim() || value.length > 240) throw fail("SPACE_INVALID_NAME"); return value; };
const hash = data => createHash("sha256").update(data).digest("hex");
const stamp = info => info ? `${info.size}:${info.mtimeMs}:${info.ino}` : null;
const fileStat = file => stat(file).catch(error => { if (error.code === "ENOENT") return null; throw error; });

// Lives in the main process. Local paths come from a native picker or preload's
// File conversion; credentials, remote URLs and user ids never come from the renderer.
export async function createPersonalSpace({ client, store, serviceURL, chooseUploads, chooseDownload, chooseDownloadDirectory, onChanged = () => {} }) {
  let restored = [], storageError = null;
  try { restored = await store.load() || []; if (!Array.isArray(restored)) throw new Error("Invalid transfer records"); }
  catch { storageError = "SECURE_STORAGE_READ_FAILED"; restored = []; }
  let tasks = restored.map(task => ({ ...task, phase: ["complete", "canceled"].includes(task.phase) ? task.phase : "paused" }));
  let closed = false, lease = null, leaseKey = null, generation = 0, connectionPromise = null;
  let overview = null, phase = "disconnected", error = null;
  const running = new Map();
  let writes = Promise.resolve();
  const accountKey = () => { const s = client.snapshot(); return s.account?.phase === "authenticated" ? JSON.stringify([serviceURL, s.account.accountId]) : null; };
  const scopeKey = () => { const s = client.snapshot(); return accountKey() && s.phase === "ready" && s.connection?.deviceId ? JSON.stringify([accountKey(), s.connection.deviceId]) : null; };
  const notify = () => onChanged(snapshot());
  const persist = () => { if (storageError) return Promise.reject(fail(storageError)); const copy = structuredClone(tasks); writes = writes.catch(() => {}).then(() => store.save(copy)); return writes; };
  function snapshot() {
    const scope = scopeKey();
    return { phase, error, storageError, overview, scope, accountId: client.snapshot().account?.accountId, boxId: client.snapshot().connection?.deviceId, tasks: tasks.filter(t => t.scope === scope).map(({ localPath, partialPath, localStamp, destinationStamp, digest, ...publicTask }) => publicTask) };
  }
  function sync() {
    const next = scopeKey();
    if (next === leaseKey) return;
    generation++; leaseKey = next; lease = null; connectionPromise = null; overview = null;
    phase = next ? "idle" : "disconnected"; error = null;
    for (const job of running.values()) job.controller.abort();
    for (const task of tasks) if (task.phase === "queued") task.phase = "paused";
    void persist().catch(() => {});
    notify();
  }
  const unsubscribe = client.subscribe(sync);
  sync();
  async function connect() {
    sync();
    if (closed || !leaseKey) throw fail("BOX_CONNECTION_REQUIRED");
    if (lease) { lease.context(); return lease; }
    if (!connectionPromise) {
      const epoch = generation;
      connectionPromise = client.applicationConnection().then(value => {
        if (epoch !== generation || closed) throw fail("SPACE_CONTEXT_CHANGED");
        lease = value;
        return value;
      }).finally(() => { if (epoch === generation) connectionPromise = null; });
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
      throw fail(value?.detail?.code || value?.error?.code || (response.status === 404 ? "SPACE_UPGRADE_REQUIRED" : "SPACE_REQUEST_FAILED"));
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
      case "list": return request(connection, `/files?parent=${folder(input.parent || "")}&trash=${input.trash === true}`);
      case "mkdir": return request(connection, "/folders", { method: "POST", body: { parent: folder(input.parent || ""), name: name(input.name) } });
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
    if (task.scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    if (task.direction === "upload") {
      if (stamp(await fileStat(task.localPath)) !== task.localStamp) throw fail("SPACE_LOCAL_FILE_CHANGED");
      task.phase = "checking"; notify();
      const digest = await digestFile(task.localPath, signal);
      if (task.digest && task.digest !== digest) throw fail("SPACE_LOCAL_FILE_CHANGED");
      task.digest = digest;
      const remote = await request(connection, "/uploads", { method: "POST", signal, body: { id: task.id, parent: task.parent, name: task.name, size: task.size } });
      task.offset = remote.offset;
      if (remote.state !== "complete") {
        const handle = await open(task.localPath, "r");
        try {
          task.phase = "running";
          while (task.offset < task.size) {
            if (signal.aborted) throw fail("SPACE_PAUSED");
            const buffer = Buffer.alloc(Math.min(CHUNK, task.size - task.offset));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, task.offset);
            if (bytesRead !== buffer.length) throw fail("SPACE_LOCAL_FILE_CHANGED");
            const result = await request(connection, `/uploads/${task.id}?offset=${task.offset}`, { method: "PUT", signal, body: buffer, headers: { "content-type": "application/octet-stream", "x-content-sha256": hash(buffer) } });
            task.offset = result.offset; await persist(); notify();
          }
        } finally { await handle.close(); }
      }
      if (stamp(await fileStat(task.localPath)) !== task.localStamp) throw fail("SPACE_LOCAL_FILE_CHANGED");
      await request(connection, `/uploads/${task.id}/complete`, { method: "POST", signal, body: { digest: task.digest } });
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
          const result = await request(connection, `/files/${task.itemId}/content?offset=${task.offset}&length=${CHUNK}`, { signal, raw: true });
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
    task.phase = "complete"; task.error = null;
  }
  function pump() {
    if (closed) return;
    for (const task of tasks) {
      if (running.size >= 2) break;
      if (task.phase !== "queued" || task.scope !== scopeKey() || running.has(task.id)) continue;
      const controller = new AbortController();
      const promise = run(task, controller).catch(cause => {
        task.phase = "paused"; task.error = controller.signal.aborted ? "SPACE_PAUSED" : cause.code || "SPACE_TRANSFER_FAILED";
      }).finally(async () => {
        running.delete(task.id);
        await persist().catch(() => { task.error = "SECURE_STORAGE_WRITE_FAILED"; task.phase = "paused"; });
        notify(); pump();
      });
      running.set(task.id, { controller, promise });
    }
  }
  async function uploads(parent, droppedPaths, expectedScope) {
    if (storageError) throw fail(storageError);
    folder(parent);
    await connect(); const scope = scopeKey(), epoch = generation;
    if (expectedScope !== undefined && expectedScope !== scope) throw fail("SPACE_CONTEXT_CHANGED");
    const selected = droppedPaths === undefined ? await chooseUploads() : droppedPaths;
    if (!Array.isArray(selected) || selected.some(file => typeof file !== "string" || !path.isAbsolute(file))) throw fail("SPACE_INVALID_DROP");
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    const selectedTasks = [];
    for (const localPath of selected) {
      const info = await stat(localPath);
      if (!info.isFile()) {
        if (droppedPaths !== undefined) throw fail("SPACE_DROP_FILES_ONLY");
        continue;
      }
      selectedTasks.push({ id: randomUUID().replaceAll("-", ""), scope, direction: "upload", parent,
        localPath, localStamp: stamp(info), name: path.basename(localPath), size: info.size, offset: 0, phase: "queued" });
    }
    if (epoch !== generation || scope !== scopeKey()) throw fail("SPACE_CONTEXT_CHANGED");
    tasks.push(...selectedTasks);
    try { await persist(); } catch (cause) { for (const t of tasks) if (t.phase === "queued") t.phase = "paused"; throw cause; }
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
    tasks.push({ id: taskId, scope, direction: "download", itemId, name: entry.name, size: entry.size, digest: entry.digest,
      localPath, destinationStamp, partialPath: path.join(path.dirname(localPath), `.wanx-${taskId}.part`), offset: 0, phase: "queued" });
    try { await persist(); } catch (cause) { for (const t of tasks) if (t.phase === "queued") t.phase = "paused"; throw cause; }
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
        planned.push({ id: taskId, scope, direction: "download", itemId: entry.id, name: entry.name, size: entry.size, digest: entry.digest,
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
    const epoch = generation;
    const task = tasks.find(t => t.id === id(taskId) && t.scope === scopeKey());
    if (!task) throw fail("SPACE_NOT_FOUND");
    const job = running.get(task.id);
    if (action === "resume") {
      if (job || task.phase !== "paused") return;
      task.phase = "queued"; task.error = null;
      try { await persist(); } catch (cause) { task.phase = "paused"; notify(); throw cause; }
      notify(); pump(); return;
    }
    if (!["pause", "cancel"].includes(action) || task.phase === "complete") return;
    job?.controller.abort(); await job?.promise;
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
    await persist(); notify();
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
    async close() { closed = true; generation++; unsubscribe(); for (const job of running.values()) job.controller.abort(); await Promise.allSettled([...running.values()].map(j => j.promise)); for (const t of tasks) if (t.phase === "queued") t.phase = "paused"; if (!storageError) await persist(); } };
}

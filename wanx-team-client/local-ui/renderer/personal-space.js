(() => {
  const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const size = value => { if (value == null) return "暂不可用"; let n = value, i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`; };
  const errors = {
    ECONNRESET: "网络连接中断，进度已保留，请检查连接后重试。",
    ECONNREFUSED: "网络连接中断，进度已保留，请检查连接后重试。",
    EPIPE: "网络连接中断，进度已保留，请检查连接后重试。",
    ETIMEDOUT: "网络连接中断，进度已保留，请检查连接后重试。",
    EHOSTUNREACH: "网络连接中断，进度已保留，请检查连接后重试。",
    ENETUNREACH: "网络连接中断，进度已保留，请检查连接后重试。",
    ENETDOWN: "网络连接中断，进度已保留，请检查连接后重试。",
    EAI_AGAIN: "网络连接中断，进度已保留，请检查连接后重试。",
    SESSION_CLOSED: "网络连接中断，进度已保留，请检查连接后重试。",
    GATEWAY_CLOSED: "网络连接中断，进度已保留，请检查连接后重试。",
    NETWORK_CHANGED: "网络连接中断，进度已保留，请检查连接后重试。",
    NETWORK_NOT_READY: "网络连接中断，进度已保留，请检查连接后重试。",
    tunnel_timeout: "网络连接中断，进度已保留，请检查连接后重试。",
    tunnel_rejected: "网络连接中断，进度已保留，请检查连接后重试。",
    network_unavailable: "网络连接中断，进度已保留，请检查连接后重试。",
    network_recovering: "网络连接中断，进度已保留，请检查连接后重试。",
    netbird_peer_disconnected: "网络连接中断，进度已保留，请检查连接后重试。",
    SPACE_SYNC_POLICY_INVALID: "同步设置无效，请检查所选范围。",
    SPACE_SYNC_PROJECT_REQUIRED: "开启项目记忆时，请填写项目范围。",
    SPACE_SYNC_POLICY_CHANGED: "同步设置已更新，请重新打开设置后再保存。",
    SPACE_SYNC_TASK_FINISHED: "此任务已结束，请新建任务。",
    SPACE_AGENT_PAUSED: "该接入已暂停。恢复接入后可继续操作。",
    SPACE_AGENT_DISCONNECTED: "接入已断开，请重新申请并确认。",
    SPACE_LINK_SCOPE: "该资源不在授权范围内。",
    SPACE_ALREADY_CONNECTED: "此身份或空间已有接入，请刷新后重试。",
    SPACE_MANAGED_ROOT: "请通过空间管理操作空间本身。",
    SPACE_LINK_PORT_IN_USE: "Agent 链接端口被其他程序占用，请释放端口后重启万象。旧链接没有更换。",
    SPACE_LINK_START_FAILED: "Agent 链接服务未启动，请检查系统钥匙串并重启万象。",
    SPACE_VERSION_CONFLICT: "文件已经更新，请刷新后再操作，避免覆盖其他修改。",
    SPACE_UPGRADE_REQUIRED: "当前盒子尚不支持文件空间，请升级盒端服务。",
    SPACE_UPLOAD_LIMIT: "单文件最大 200 MB，此文件已跳过，其他文件继续上传。",
    SPACE_SOURCE_MISSING: "本地文件已移动或删除，请恢复原位置后重试。",
    SPACE_SOURCE_UNREADABLE: "无法读取本地内容，请检查文件权限或外接磁盘后重试。",
    SPACE_SOURCE_CHANGED: "本地目录已变化，请重新拖入。",
    SPACE_SOURCE_LINK: "符号链接不自动跟随，请拖入实际文件或文件夹。",
    SPACE_SOURCE_UNSUPPORTED: "此项目不是普通文件或文件夹，已跳过。",
    SPACE_IMPORT_PARENT_FAILED: "上级文件夹尚未成功创建，请先处理上级错误。",
    SPACE_IMPORT_FOLDER_CHANGED: "目标文件夹已移动或删除，请重新选择目标。",
    SPACE_IMPORT_FOLDER_CONFLICT: "目录重试核对发现冲突，已停止此目录，请刷新后重试。",
    SPACE_NETWORK_WAIT: "连接暂不可用，进度已保留，将自动继续；也可手动暂停。",
    SPACE_INVALID_DROP: "请从本地拖入文件后重试。",
    SPACE_DROP_FILES_ONLY: "请选择本地文件或文件夹。",
    SPACE_DISK_FULL: "盒子存储空间不足，请清理文件或回收站后重试。",
    SPACE_UNSAFE_STORAGE: "盒子存储安全检查未通过，此文件已停止上传。请检查盒子存储后重试，其他文件不受影响。",
    SPACE_STORAGE_UNAVAILABLE: "盒子存储位置暂不可用，请检查磁盘是否在线；进度已保留。",
    SPACE_INVALID_NAME: "名称不能含路径字符、首尾空格或超过 240 字节；请修改后重试。",
    SPACE_INVALID_DESTINATION: "不能把文件夹移到自身或其子文件夹中。",
    SPACE_NOT_FOUND: "文件已发生变化，请刷新后重试。",
    SPACE_LOCAL_FILE_CHANGED: "本机文件已发生变化，请取消此次任务并重新上传。",
    SPACE_REMOTE_FILE_CHANGED: "远端文件已发生变化，请重新下载。",
    SPACE_DESTINATION_CHANGED: "本机保存位置的文件已变化，请重新选择下载位置。",
    SPACE_PREVIEW_DOWNLOAD: "此格式或大小暂不支持预览，请下载后打开。",
    SPACE_CHUNK_INVALID: "文件校验未通过，请重试传输。",
    SPACE_PAUSED: "传输已暂停，连接原盒子后可继续。",
    SPACE_CONTEXT_CHANGED: "账号或盒子已切换，请重新操作。",
    SPACE_RETRY_EXHAUSTED: "网络多次重试仍未成功，进度已保留。连接稳定后点击继续或重试失败项。",
    SPACE_UPLOAD_OFFSET_INVALID: "盒子返回的传输进度无效，已停止上传，请检查服务版本。",
    ENOENT: "本机源文件已不存在，请重新选择文件。",
    ENOSPC: "本机存储空间不足，传输已停止。",
    SPACE_CONNECTION_TIMEOUT: "盒子响应超时，传输进度已保留，可以稍后重试。",
    BOX_CONNECTION_REQUIRED: "请先在设置中连接盒子。",
    SPACE_STORAGE_UNAVAILABLE: "盒子的文件存储暂不可用，请稍后重试。",
    SPACE_STORAGE_PATH_INVALID: "请选择万象主机上可用的文件夹，不能使用系统根目录或万象索引目录。",
    SPACE_LINK_UPGRADE_REQUIRED: "当前万象主机服务需要更新，才能使用空间管理和存储目录迁移。请更新服务后重试。",
    SPACE_DIRECTORY_PICKER_UNAVAILABLE: "文件夹选择器暂不可用，请重启万象客户端后重试。",
    SPACE_STORAGE_SOURCE_MISSING: "原存储中的文件缺失，已停止迁移并保留原位置。",
    SPACE_STORAGE_TARGET_CONFLICT: "目标位置存在不匹配的存储文件，已停止迁移，请选择其他目录。",
    SECURE_STORAGE_READ_FAILED: "无法读取加密的传输记录，请检查系统钥匙串后重启万象。",
    SECURE_STORAGE_WRITE_FAILED: "无法保存传输记录，请检查本机存储空间。",
  };
  const message = error => error?.code === "SPACE_UPLOAD_LIMIT" && typeof error.message === "string" ? error.message : Object.entries(errors).find(([key]) => String(error?.message || error).includes(key))?.[1] || "操作未完成，请检查连接并重试。";
  const networkWait = "等待网络，恢复后自动继续";
  const recoverableTransfer = error => /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|SESSION_CLOSED|GATEWAY_CLOSED|NETWORK_CHANGED|NETWORK_NOT_READY|BOX_CONNECTION_REQUIRED|SPACE_CONNECTION_TIMEOUT|SPACE_CHUNK_STALLED|SPACE_NETWORK_WAIT|SPACE_REQUEST_FAILED|SPACE_TRANSFER_FAILED|tunnel_timeout|tunnel_rejected|network_unavailable|network_recovering|netbird_peer_disconnected)\b/.test(String(error?.code || error?.message || error || ""));
  const waitingForNetwork = task => ["waiting", "retrying"].includes(task.phase) || (task.phase === "queued" && recoverableTransfer(task.error));
  const workspaces = window.wanxWorkspaces;
  let previewMode = false;
  const previews = window.createSpacePreviews?.({ request: id => call("preview", { id }) });
  let workspace = "personal", recordNavigation = true;
  const rootFolder = () => workspaces?.root() || "";
  let host, scope, revision = 0, parent = "", trash = false, listing = { items: [], breadcrumbs: [] }, status = { phase: "idle", tasks: [] };
  let lastSeen = null, dragDepth = 0, transfersOpen = false, transferLimit = 100;
  let selectedId = "", anchorId = "", selectedIds = new Set(), contextMenu = null, query = "", sortBy = "name", sortDirection = 1;
  let marquee = null, moving = null, movePointer = null, ignoreSelectionClick = false, batchBusy = false;
  let pendingRefresh = false, composing = false;
  let transferIssue = null;
  let error = null, loading = false, active = false, fileView = false, dialog = null, previewURL = null, render = () => {};
  const agentHub = window.createSpaceAgentHub?.({request:(action,input)=>call("links-"+action,input),changed:()=>render()});
  if(agentHub)window.wanxAgentHub=agentHub;
  const beginTransfer = target => ({ epoch: revision, scope: status.scope, target, before: new Set((status.tasks || []).map(task => task.id)) });
  function reconcileTransferIssue() {
    if (!transferIssue?.recoverable || transferIssue.attempt.scope !== status.scope) return;
    const { target, before } = transferIssue.attempt;
    if ((status.tasks || []).some(task => target ? task.id === target || task.batchId === target : !before.has(task.id))) transferIssue = null;
  }
  function transferProblem(cause, attempt) {
    if (attempt.epoch !== revision) return;
    transferIssue = { text: message(cause), recoverable: recoverableTransfer(cause), attempt };
    reconcileTransferIssue();
  }
  function closeDialog() { dialog = null; composing = false; if (pendingRefresh) { pendingRefresh = false; queueMicrotask(() => { if (active && !dialog) void load(); }); } if (previewURL) URL.revokeObjectURL(previewURL); previewURL = null; }
  function clearSelection() { selectedIds.clear(); selectedId = ""; anchorId = ""; }
  const selectedItems = () => visibleItems().filter(item => selectedIds.has(item.id));
  function selectItem(item, event = {}) {
    if (!item) return;
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      if (!anchorId) anchorId = selectedId || item.id;
      const items = visibleItems(), start = items.findIndex(item => item.id === (anchorId || selectedId)), end = items.findIndex(candidate => candidate.id === item.id);
      if (!additive) selectedIds.clear();
      for (const entry of items.slice(Math.min(start < 0 ? end : start, end), Math.max(start, end) + 1)) selectedIds.add(entry.id);
    } else if (additive) {
      if (selectedIds.has(item.id)) selectedIds.delete(item.id); else selectedIds.add(item.id);
      anchorId = item.id;
    } else { selectedIds = new Set([item.id]); anchorId = item.id; }
    selectedId = item.id;
  }
  async function call(method, input = {}) {
    const epoch = revision;
    const result = await window.wanxClient.action(`space.${method}`, input);
    if (epoch !== revision) throw new Error("SPACE_CONTEXT_CHANGED");
    if (!result.ok) throw new Error(result.code);
    if (result.value?.uploadRejection) throw result.value.uploadRejection;
    return result.value;
  }
  async function load({ metrics = true } = {}) {
    if (!host?.canLaunchApplications || loading) return;
    const epoch = revision;
    loading = true; error = null; render();
    try {
      if (metrics) status = await call("refresh");
      if (workspaces) {
        if(status.scope)workspaces.storageScope(status.scope); await workspaces.refresh();
        const next=await workspaces.reconcile({space:workspace,parent,trash},listing.breadcrumbs);
        if(epoch!==revision)throw Error('SPACE_CONTEXT_CHANGED');
        workspace=next.space;parent=next.parent;trash=next.trash;
      }
      void agentHub?.refresh();
      listing = trash && workspaces ? {items:(await Promise.all(workspaces.spaces().filter(s=>!s.trashed).map(s=>call("list",{parent:s.root,trash:true,space_id:s.id})))).flatMap(result=>result.items),breadcrumbs:[]} : await call("list", { parent, trash, ...(workspaces ? { space_id: workspace } : {}) });
      if (workspaces) { await workspaces.observe({space: workspace, parent, trash}, listing, recordNavigation); recordNavigation = true; }
      selectedIds = new Set([...selectedIds].filter(id => listing.items.some(item => item.id === id)));
      if (!listing.items.some(item => item.id === selectedId)) selectedId = "";
      if (contextMenu?.id && !listing.items.some(item => item.id === contextMenu.id)) contextMenu = null;
    } catch (cause) { if (epoch === revision) error = message(cause); }
    finally { if (epoch === revision) { loading = false; render(); } }
  }
  function hostState(state) {
    window.wanxClipboard?.hostState(state);
    if (state.route === "auth" || (host && state.account?.accountId !== host.account?.accountId)) lastSeen = null;
    if (state.activeDeviceId && lastSeen && state.activeDeviceId !== lastSeen.boxId) lastSeen = null;
    const priorBox = state.account?.accountId === host?.account?.accountId ? host?.activeDeviceId || status.boxId : null;
    const reconnected = host && !host.canLaunchApplications && state.canLaunchApplications;
    host = { ...state, activeDeviceId: state.activeDeviceId || priorBox };
    agentHub?.hostState(host);
    if (!state.canLaunchApplications) clearDrag();
    const next = state.route !== "auth" ? `${state.account?.accountId}:${host.activeDeviceId || ""}` : null;
    if (scope !== next) {
      previews?.reset();
      stopMarquee(); clearSelection(); batchBusy = false; contextMenu = null; query = "";
      scope = next; workspaces?.reset(scope); workspace = "personal"; revision++; parent = ""; trash = false; listing = { items: [], breadcrumbs: [] }; closeDialog(); clearDrag(); error = null; transferIssue = null; loading = false;
      status = { phase: "idle", tasks: [] };
      if (active && state.canLaunchApplications) queueMicrotask(() => { if (active) void load(); });
    } else if (active && reconnected) queueMicrotask(() => { if (active) void load(); });
  }
  const icons = {
    folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
    up: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/>',
    drive: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 14h18M7 17h1m3 0h1"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9Z"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    cloud: '<path d="M7 18H6a5 5 0 0 1-.7-10A7 7 0 0 1 19 8a5 5 0 0 1-1 10h-1M12 21V11m-4 4 4-4 4 4"/>',
  };
  const icon = kind => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[kind] || icons.file}</svg>`;
  const percent = task => task.phase === "complete" ? 100 : task.size ? Math.min(100, Math.max(0, Math.floor(task.offset / task.size * 100))) : 0;
  function boxName() { return host?.devices?.find(d => d.deviceId === host.activeDeviceId)?.name || host?.connection?.name || "万象盒子"; }
  function storage() {
    const data = status.overview, current = workspaces?.current(), location = current?.storage;
    const volume = location ? (location.available ? location : null) : data?.volume;
    const used = typeof current?.bytes === "number" ? current.bytes + (current.pending_bytes || 0) : data?.filesBytes;
    return `<section class="space-storage" aria-label="存储空间"><div class="space-storage-title"><span>空间用量</span><strong>${size(used)}</strong></div>${volume ? `<progress class="space-capacity" max="${volume.total || 1}" value="${volume.used}" aria-label="存储卷已用容量" title="磁盘总容量 ${size(volume.total)}；用量包含该卷其他数据"></progress><p title="磁盘总容量 ${size(volume.total)}；用量包含该卷其他数据">磁盘可用 ${size(volume.free)}</p>` : `<p>${location ? "存储目录暂不可用" : "正在获取容量…"}</p>`}</section>${workspaces?.storageView?.() || ""}`;
  }
  function transfers() {
    const tasks = status.tasks || [], batches = status.imports || [];
    if (!tasks.length && !batches.length) return "";
    const labels = { scanning: "正在扫描目录", waiting: networkWait, retrying: networkWait, queued: "等待传输", checking: "正在核对文件", running: "正在传输", paused: "已暂停", failed: "部分未完成", complete: "已完成", canceled: "已取消" };
    const pending = tasks.filter(t => !["complete", "canceled"].includes(t.phase)).length;
    const rank = t => t.phase === "paused" && t.error ? 0 : ({running: 1, checking: 2, retrying: 3, waiting: 4, queued: 5, paused: 6, complete: 7, canceled: 8})[t.phase] ?? 9;
    const ordered = [...tasks].reverse().sort((a, b) => rank(a) - rank(b));
    const liveBatches = batches.filter(batch => batch.phase !== "complete");
    const summaries = (liveBatches.length ? liveBatches.slice(-10) : batches.slice(-1)).reverse().map(batch => `<article class="space-import-summary"><div class="space-transfer-title"><strong title="${esc(batch.name)}">${esc(batch.name)}</strong><span>${labels[batch.phase] || batch.phase}</span></div><small>已发现 ${batch.files} 个文件 · ${batch.folders} 个文件夹${batch.scanComplete ? "" : " · 总量仍在统计"}<br>已完成 ${batch.completed} 项${batch.failed ? ` · ${batch.failed} 项未完成` : ""} · ${size(batch.offset)} / ${size(batch.size)}</small>${batch.failed ? '<p class="inline-error">问题项已单独保留，其余内容继续上传。查看下方原因后重试。</p>' : ""}<div class="space-row-actions">${!["complete", "failed"].includes(batch.phase) ? `<button class="text-button" data-action="space-transfer" data-id="${batch.id}" data-command="${batch.phase === "paused" ? "resume-batch" : "pause-batch"}">${batch.phase === "paused" ? "继续本批" : "暂停本批"}</button>` : ""}${batch.failed ? `<button class="text-button" data-action="space-transfer" data-id="${batch.id}" data-command="retry-batch">重试本批问题项</button>` : ""}</div></article>`).join("");
    const rows = ordered.slice(0, transferLimit).map(t => `<div class="space-transfer ${t.phase === "complete" ? "is-complete" : ""}"><span class="space-transfer-icon">${icon(t.kind === "folder" ? "folder" : t.direction)}</span><div class="space-transfer-main"><div class="space-transfer-title"><strong title="${esc(t.relativePath || t.name)}">${esc(t.relativePath || t.name)}</strong><span>${t.kind === "folder" ? "目录" : `${percent(t)}%`}</span></div>${t.kind === "scan-error" ? "" : `<progress class="space-progress" max="100" ${t.phase === "checking" ? "" : `value="${percent(t)}"`} aria-label="${esc(t.name)}传输进度"></progress>`}<small>${t.kind === "folder" ? "创建文件夹" : t.direction === "upload" ? "上传" : "下载"} · ${t.phase === "running" && t.kind !== "folder" && t.offset === t.size ? "正在保存" : waitingForNetwork(t) ? networkWait : labels[t.phase] || t.phase}${t.kind === "folder" || t.kind === "scan-error" ? "" : ` · ${size(t.offset)} / ${size(t.size)}`}</small>${t.error && t.phase === "paused" ? `<small class="inline-error">${esc(message(t.error))}${t.retryAt ? ` · ${Math.max(1, Math.ceil((t.retryAt - Date.now()) / 1000))} 秒后重试` : ""}</small>` : ""}</div><div class="space-row-actions">${t.phase === "paused" ? `<button class="text-button" data-action="space-transfer" data-id="${t.id}" data-command="resume">重试</button>` : ["running", "checking", "queued", "waiting", "retrying"].includes(t.phase) ? `<button class="text-button" data-action="space-transfer" data-id="${t.id}" data-command="pause">暂停</button>` : ""}${!["complete", "canceled"].includes(t.phase) ? `<button class="text-button" data-action="space-transfer" data-id="${t.id}" data-command="cancel">取消</button>` : ""}</div></div>`).join("");
    return `<section class="space-transfers" aria-label="文件传输"><button class="space-transfers-heading" data-action="space-transfers-toggle" aria-expanded="${transfersOpen}"><strong>传输列表 <span class="count">${pending ? `${pending} 项待完成` : `${tasks.length} 项记录`}</span></strong><span>${transfersOpen ? "收起" : "展开"}</span></button>${transfersOpen ? `<div class="space-row-actions"><button class="text-button" data-action="space-transfer" data-command="pause-all">全部暂停</button><button class="text-button" data-action="space-transfer" data-command="resume-all">全部继续</button><button class="text-button" data-action="space-transfer" data-command="retry-failed">重试失败项</button><button class="text-button" data-action="space-transfer" data-command="clear-completed">清理完成记录</button></div><div class="space-transfer-list">${summaries}${rows}${ordered.length > transferLimit ? `<button class="text-button" data-action="space-transfers-more">再显示 100 项（共 ${ordered.length} 项）</button>` : ""}</div>` : ""}</section>`;
  }
  const action = (label, kind, item, danger = false) => `<button role="menuitem" class="${danger ? "danger-text" : ""}" data-action="space-${kind}" data-id="${item?.id || ""}">${label}</button>`;
  const fileType = item => item.kind === "folder" ? "文件夹" : item.name.includes(".") ? item.name.split(".").pop().toUpperCase() + " 文件" : "文件";
  function fileIcon(item) {
    if (item.kind === "folder") return '<span class="space-item-icon is-folder"><svg viewBox="0 0 72 64" aria-hidden="true"><path fill="#d9a23d" stroke="#bf8830" d="M5 13a5 5 0 0 1 5-5h18l6 7h28a5 5 0 0 1 5 5v34H5Z"/><path fill="#f2c86c" stroke="#d9a746" d="M5 23h62v31a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5Z"/><path stroke="#ffe6a7" d="M8 25h56"/></svg></span>';
    const ext = item.name.includes(".") ? item.name.split(".").pop().toLowerCase() : "";
    const kind = /^(pdf)$/.test(ext) ? "pdf" : /^(docx?|rtf|txt|md)$/.test(ext) ? "document" : /^(xlsx?|csv)$/.test(ext) ? "sheet" : /^(pptx?|key)$/.test(ext) ? "slides" : /^(png|jpe?g|gif|webp|svg|heic)$/.test(ext) ? "image" : /^(mp4|mov|mkv|mp3|wav|m4a)$/.test(ext) ? "media" : /^(zip|rar|7z|tar|gz)$/.test(ext) ? "archive" : "generic";
    const badge = /^[a-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : "FILE";
    const thumbnail = previewMode && previews?.eligible(item);
    const image = thumbnail && previews.image(item);
    if (image) return `<span class="space-item-icon" data-space-thumbnail="${esc(previews.key(item))}"><img class="space-thumbnail" draggable="false" src="${image}" alt=""></span>`;
    return `<span class="space-item-icon is-${kind}" ${thumbnail ? `data-space-thumbnail="${esc(previews.key(item))}"` : ""}><svg viewBox="0 0 64 72" aria-hidden="true"><path class="space-document-paper" d="M12 3h26l15 15v48a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><path class="space-document-fold" d="M38 3v12a3 3 0 0 0 3 3h12"/><path class="space-document-lines" d="M19 29h24M19 35h24M19 41h16"/></svg><span class="space-file-badge">${badge}</span></span>`;
  }
  function visibleItems() {
    return [...listing.items].filter(item => item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => {
      const folders = Number(b.kind === "folder") - Number(a.kind === "folder");
      if (folders) return folders;
      const result = sortBy === "size" || sortBy === "modified" ? (a[sortBy] || 0) - (b[sortBy] || 0) : (sortBy === "type" ? fileType(a) : a.name).localeCompare(sortBy === "type" ? fileType(b) : b.name, "zh-CN", { numeric: true });
      return (result || a.name.localeCompare(b.name, "zh-CN", { numeric: true })) * sortDirection;
    });
  }
  function menuView() {
    if (!contextMenu || dialog) return "";
    const item = listing.items.find(item => item.id === contextMenu.id);
    if (contextMenu.id && !item) return "";
    const count = selectedItems().length;
    if(workspaces?.current().writable===false)return `<div class="space-context-menu" role="menu" style="left:${contextMenu.x}px;top:${contextMenu.y}px">${item?action(item.kind==='folder'?'打开文件夹':'预览','open',item)+action('下载到电脑…','download',item):action('刷新','refresh')}</div>`;
    const choices = item && count > 1 ? (trash ? action(`恢复所选 ${count} 项`, "batch-restore") : action(`下载所选 ${count} 项…`, "batch-download") + action(`移动所选 ${count} 项…`, "batch-move") + (workspaces&&workspaces.current().kind!=="agent-drive" ? action(`复制所选 ${count} 项…`, "batch-copy") : "") + '<hr role="separator">' + action(`移入回收站（${count} 项）…`, "batch-trash", null, true)) : item ? trash ? action("恢复", "restore", item) + action("彻底删除…", "purge", item, true) : action(item.kind === "folder" ? "打开文件夹" : "预览", "open", item) + action("下载到电脑…", "download", item) + action("提供给 Agent…", "agent-provide", item) + (workspaces ? (item.kind === "folder" ? action("固定到常用位置", "pin", item) : "") : "") + (item.kind === "file" && item.previous_digest ? action("恢复上一版本…", "previous", item) : "") + '<hr role="separator">' + action("重命名…", "rename", item) + action("移动到…", "move", item) + (workspaces&&workspaces.current().kind!=="agent-drive" ? action("复制到…", "copy", item) : "") + '<hr role="separator">' + action("移入回收站…", "trash", item, true) : (trash ? "" : action("上传文件…", "upload") + action("上传文件夹…", "upload-folder") + action("新建文件夹…", "mkdir") + '<hr role="separator">') + action("刷新", "refresh");
    return `<div class="space-context-menu" role="menu" aria-label="${item ? "文件操作" : "文件夹操作"}" style="left:${contextMenu.x}px;top:${contextMenu.y}px">${choices}</div>`;
  }
  function showMenu(item, x, y) {
    workspaces?.dismissMenu();
    if (item) { if (!selectedIds.has(item.id)) selectItem(item); selectedId = item.id; }
    else clearSelection();
    contextMenu = { id: item?.id || "", x: Math.max(8, Math.min(Number(x) || 8, (window.innerWidth || 1024) - 218)), y: Math.max(8, Math.min(Number(y) || 8, (window.innerHeight || 768) - (item && !trash ? 330 : 150))) };
    render();
  }
  async function navigate(target, recycle = false, nextSpace = workspace, record = true) {
    clearDrag();
    revision++; loading = false; workspace = nextSpace; recordNavigation = record; parent = target; trash = recycle;
    stopMarquee(); clearSelection(); contextMenu = null; query = ""; closeDialog();
    listing = { items: [], breadcrumbs: [] };
    await load({ metrics: false });
  }
  async function openItem(item) {
    if (!item || trash) return;
    if (item.kind === "folder") { await navigate(item.id); return; }
    closeDialog();
    const current = { kind: "preview-loading", title: item.name, item };
    dialog = current; render();
    try {
      const result = await call("preview", { id: item.id });
      if (dialog !== current) return;
      const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
      previewURL = URL.createObjectURL(new Blob([bytes], { type: result.type }));
      Object.assign(current, { kind: "preview", type: result.type, text: result.type === "text/plain" ? new TextDecoder().decode(bytes) : "" });
    } catch (cause) {
      if (dialog !== current) return;
      Object.assign(current, { kind: "preview-unavailable", error: message(cause) });
    }
  }

  function dialogView() {
    if (!dialog) return "";
    let body = "";
    if (dialog.kind === "previous") {
      body = "<p>恢复覆盖前的内容，当前版本将成为可恢复的上一版本。文件 ID 和访问链接保持不变。</p>";
    } else if (dialog.kind === "preview-loading") {
      body = '<p role="status">正在加载预览…</p>';
    } else if (dialog.kind === "preview-unavailable") {
      body = '<p>可以下载到电脑，使用本机应用打开。</p>';
    } else if (dialog.kind === "preview") {
      body = dialog.type === "text/plain" ? `<pre class="space-text-preview">${esc(dialog.text)}</pre>` : dialog.type === "application/pdf" ? `<embed class="space-preview" type="application/pdf" src="${previewURL}" title="PDF 预览">` : `<img class="space-preview" src="${previewURL}" alt="${esc(dialog.title)}">`;
    } else if (dialog.kind === "move") {
      body = `<p class="muted">从 ${esc(dialog.sourceName || workspaces?.current().name || "我的空间")} ${dialog.copy ? "复制" : "移动"} ${dialog.items.length} 项到 ${esc(workspaces?.spaces().find(s=>s.id===dialog.space)?.name || "我的空间")}。${dialog.space && dialog.space !== workspace && !dialog.copy ? "跨空间移动将撤销相关资源的旧授权。" : ""}</p>${workspaces ? `<div class="space-destination-spaces">${workspaces.spaces().filter(s=>!s.trashed&&(workspaces.current().kind==="agent-drive"?s.id===workspace:s.kind!=="agent-drive")).map(s=>`<button class="button small ${dialog.space===s.id?"primary":""}" data-action="space-move-space" data-id="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : ""}<div class="space-breadcrumbs"><button class="text-button" data-action="space-move-folder" data-id="${workspaces?.spaces().find(s=>s.id===dialog.space)?.root || ""}">空间根目录</button>${dialog.crumbs.map(c => `<button class="text-button" data-action="space-move-folder" data-id="${c.id}">／ ${esc(c.name)}</button>`).join("")}</div><div class="space-folder-picker">${dialog.folders.map(f => `<button class="space-folder-choice" data-action="space-move-folder" data-id="${f.id}">▱ ${esc(f.name)}</button>`).join("") || '<p class="muted">此处没有子文件夹</p>'}</div>`;
    } else if (["mkdir", "rename"].includes(dialog.kind)) body = `<form id="space-form" data-form="space"><label for="space-name">名称</label><input id="space-name" name="name" value="${esc(dialog.name)}" data-editor-key="${dialog.kind}:${dialog.item?.id || "new"}" required maxlength="240" autocomplete="off"/><button type="submit" class="button primary">保存</button></form>`;
    else body = `<p>所选 ${dialog.items.length} 个项目将移入回收站，之后可以恢复。</p><ul class="space-selection-summary">${dialog.items.slice(0, 6).map(item => `<li>${esc(item.name)}</li>`).join("")}${dialog.items.length > 6 ? `<li>以及其他 ${dialog.items.length - 6} 项</li>` : ""}</ul>`;
    return `<section class="market-confirmation" role="dialog" aria-modal="true" aria-labelledby="space-dialog-title"><div class="market-confirm-card space-dialog"><h2 id="space-dialog-title">${esc(dialog.title)}</h2>${body}<p data-space-dialog-error class="inline-error" role="alert" ${dialog.error ? "" : "hidden"}>${esc(dialog.error || "")}</p><div class="market-actions">${dialog.kind.startsWith("preview") ? '<button class="button" data-action="space-preview-download">下载原文件</button>' : ""}<button class="button" data-action="space-dialog-close" ${dialog.saving ? "disabled" : ""}>${dialog.kind.startsWith("preview") ? "关闭" : "取消"}</button>${["move", "trash", "previous"].includes(dialog.kind) ? `<button class="button primary" data-action="space-dialog-confirm" ${dialog.saving ? "disabled" : ""}>${dialog.saving ? "正在处理…" : dialog.kind === "move" ? dialog.copy ? "复制到这里" : "移到这里" : dialog.kind === "previous" ? "恢复上一版" : "移入回收站"}</button>` : ""}</div></div></section>`;
  }
  // Keep the editing subtree attached: refocusing a replaced node breaks IME.
  const mountedEditors = new WeakSet();
  function mounted() {
    previews?.mount(listing.items, scope, previewMode && active && fileView && !trash && host?.canLaunchApplications && !(status.tasks || []).some(t => ["queued", "checking", "running", "waiting", "retrying"].includes(t.phase)));
    const input = document.querySelector("#space-name") || document.querySelector("#workspace-name");
    if(input?.dataset?.editorKey && !mountedEditors.has(input)) { mountedEditors.add(input);input.focus();if(dialog?.kind === "rename")input.select?.(); }
  }
  function retainEditor() {
    if (workspaces?.retainEditor()) return true;
    if (!dialog || !["mkdir", "rename"].includes(dialog.kind)) return false;
    const input = document.querySelector("#space-name");
    if (input?.dataset?.editorKey !== `${dialog.kind}:${dialog.item?.id || "new"}`) return false;
    const notice = document.querySelector("[data-space-dialog-error]");
    if (notice) { notice.textContent = dialog.error || ""; notice.hidden = !dialog.error; }
    for (const button of document.querySelectorAll?.(".space-dialog button") || []) button.disabled = Boolean(dialog.saving);
    return true;
  }
  function breadcrumbsView() {
    const crumb = c => `<button class="text-button" data-action="space-folder" data-id="${c.id}" data-space="${workspace}" data-name="${esc(c.name)}">${esc(c.name)}</button>`;
    const path = listing.breadcrumbs;
    if(path.length <= 4) return path.map(c=>`<span aria-hidden="true">›</span>${crumb(c)}`).join("");
    return `<span>›</span>${crumb(path[0])}<span>›</span><details><summary aria-label="展开中间路径">…</summary><div>${path.slice(1,-2).map(crumb).join("")}</div></details>${path.slice(-2).map(c=>`<span>›</span>${crumb(c)}`).join("")}`;
  }
  function view() {
    if (!host?.canLaunchApplications) return `<section class="empty-state space-connect"><h3>连接盒子，访问自己的文件</h3><p>${host?.connectionPhase === "recovering" ? "正在恢复与盒子的连接。" : "连接盒子后，即可像使用硬盘一样管理文件。"}</p>${lastSeen ? `<p class="muted">${esc(lastSeen.name)} · 上次更新 ${new Date(lastSeen.at * 1000).toLocaleString()}，当前状态待重新确认。</p>` : ""}<button class="button" data-action="show-boxes">前往盒子管理</button></section>${transfers()}`;
    const items = visibleItems(), selected = selectedItems();
    const visibleError = error || transferIssue?.text;
    const upper = listing.breadcrumbs.length > 1 ? listing.breadcrumbs.at(-2).id : rootFolder();
    const sortOptions = Object.entries({ name: "名称", size: "大小", type: "种类", modified: "修改时间" }).map(([key, label]) => `<option value="${key}" ${sortBy === key ? "selected" : ""}>${label}</option>`).join("");
    return `<div class="space-workspace" ${dialog || workspaces?.modalOpen?.() ? "inert" : ""}><div class="space-browser"><aside class="space-sidebar" aria-label="文件空间导航"><div class="space-sidebar-scroll">${workspaces ? workspaces.sidebar() : `<div class="space-sidebar-caption">位置</div><button class="space-nav ${!trash ? "active" : ""}" data-action="space-folder" data-id="">${icon("folder")}全部文件</button>`}</div><div class="space-sidebar-bottom">${workspaces?.footerNavigation() || `<button class="space-nav" data-action="space-recycle">${icon('trash')}回收站</button>`}<div class="space-disk-identity" title="当前盒子：${esc(boxName())}">${icon("drive")}<span><strong>${esc(boxName())}</strong></span><i class="status-dot ready" title="已连接" aria-label="已连接"></i></div>${storage()}</div></aside><main class="space-main">
      <div class="space-toolbar" aria-busy="${batchBusy}" ${batchBusy ? "inert" : ""}><div class="space-row-actions">${workspaces?.navigation() || ""}<button class="space-icon-button" data-action="space-folder" data-id="${upper}" aria-label="返回上级文件夹" title="返回上级文件夹" ${parent === rootFolder() || trash ? "disabled" : ""}>${icon("up")}</button><button class="space-icon-button ${loading ? "space-refreshing" : ""}" data-action="space-refresh" aria-label="${loading ? "正在刷新文件" : "刷新文件"}" aria-busy="${loading}" title="${loading ? "正在刷新文件" : "刷新"}" ${loading ? "disabled" : ""}>${icon("refresh")}</button><span class="space-toolbar-title">${trash ? "回收站" : parent !== rootFolder() ? esc(listing.breadcrumbs.at(-1)?.name || "文件夹") : esc(workspaces?.current().name || "全部文件")}</span></div><div class="space-row-actions"><button class="button small" data-agent-hub-open>空间 MCP</button>${selected.length ? `<span class="space-selected-count">已选 ${selected.length} 项</span>${trash ? '<button class="button small" data-action="space-batch-restore">恢复</button>' : '<button class="button small" data-action="space-batch-download">下载</button><button class="button small" data-action="space-batch-move">移动</button><button class="button small danger-text" data-action="space-batch-trash">删除</button>'}<button class="text-button space-clear-selection" data-action="space-selection-clear">取消选择</button>` : !trash && workspaces?.current().writable!==false && status.phase !== "unsupported" ? '<button class="button small" data-action="space-mkdir">新建文件夹</button><button class="button small primary space-upload-button" data-action="space-upload" title="支持文件和文件夹；自动分批上传，单文件最大 200 MB">' + icon("upload") + '上传文件</button><button class="button small" data-action="space-upload-folder">上传文件夹</button>' : ""}</div></div>
      <div class="space-pathbar"><div class="space-breadcrumbs" aria-label="当前位置"><button class="text-button" data-action="space-folder" data-id="${rootFolder()}" data-space="${workspace}">${icon("drive")}${esc(workspaces?.current().name || "全部文件")}</button>${!trash ? breadcrumbsView() : '<span>›</span><strong>回收站</strong>'}</div><div class="space-view-tools"><button class="text-button space-preview-mode" data-action="space-preview-mode" aria-pressed="${previewMode}" title="按需显示图片缩略图；双击预览图片、PDF 或文本">${previewMode ? "✓ 预览模式" : "预览模式"}</button><label class="space-sort"><span>排列</span><select id="space-sort" aria-label="排列方式">${sortOptions}</select></label><button class="space-icon-button space-sort-direction ${sortDirection === -1 ? "is-descending" : ""}" data-action="space-sort" data-sort="${sortBy}" aria-label="${sortDirection === 1 ? "改为降序排列" : "改为升序排列"}" title="${sortDirection === 1 ? "升序排列" : "降序排列"}">${icon("up")}</button><label class="space-search">${icon("search")}<input type="search" id="space-search" value="${esc(query)}" placeholder="搜索当前文件夹" aria-label="搜索当前文件夹"></label></div></div>
      ${visibleError ? `<div class="notice error" role="status">${esc(visibleError)} <button class="text-button" data-action="space-refresh">重试</button></div>` : ""}
      ${status.phase === "unsupported" ? '<section class="empty-state space-connect"><h3>文件空间需要新版盒端服务</h3><p>升级后这里会显示你的个人文件。</p></section>' : `<section class="space-files" aria-label="${trash ? "回收站" : "文件图标"}">${trash ? '<p class="space-trash-hint">文件可恢复；彻底删除后无法找回。恢复空间不会恢复接入授权。</p>' + (workspaces?.recycled() || "") : ""}
      <div class="space-file-list" role="listbox" aria-multiselectable="true" aria-label="${trash ? "回收站文件图标" : "当前文件夹图标"}" tabindex="0" data-location="${parent}:${trash}" aria-busy="${loading}">${items.map(item => `<article class="space-file-row ${selectedIds.has(item.id) ? "is-selected" : ""}" role="option" aria-selected="${selectedIds.has(item.id)}" tabindex="${selectedId === item.id ? "0" : "-1"}" draggable="false" data-entry-id="${item.id}" data-action="space-select" data-id="${item.id}" aria-label="${esc(item.name)}，${esc(fileType(item))}" title="${esc(item.name)}&#10;${esc(fileType(item))}${item.kind === "folder" ? "" : ` · ${size(item.size)}`}&#10;修改于 ${new Date(item.modified * 1000).toLocaleString()}"><span class="space-file-name">${fileIcon(item)}<strong>${esc(item.name)}</strong></span><span class="space-file-detail">${item.kind === "folder" ? "文件夹" : size(item.size)}</span><button class="space-icon-button space-file-more" data-action="space-more" data-id="${item.id}" aria-label="${esc(item.name)}的更多操作" title="更多操作">${icon("more")}</button></article>`).join("") || `<div class="space-empty">${icon(trash ? "trash" : "folder")}<strong>${loading ? "正在读取文件…" : query ? "没有找到匹配文件" : trash ? "回收站为空" : "此文件夹为空"}</strong><p>${loading ? "请稍候" : query ? "试试其他名称" : trash ? "这里没有已删除的文件" : "拖入本地文件，或右键新建文件夹"}</p></div>`}</div></section>`}
      <footer class="space-statusbar"><span class="space-status-count" role="status">${query ? `${items.length} / ` : ""}${listing.items.length} 个项目${selected.length ? ` · 已选 ${selected.length} 项${selected.length === 1 ? `：${esc(selected[0].name)}` : ""}` : ""}${loading ? " · 正在刷新文件…" : batchBusy ? " · 正在处理…" : ""}</span><span class="space-status-hint">${trash ? "右键恢复或彻底删除" : "拖动框选 · ⌘ / Ctrl 多选 · 右键管理"}</span><button class="text-button" data-action="space-transfers-toggle">传输${(status.tasks || []).some(waitingForNetwork) ? ` · ${networkWait}` : (status.tasks || []).some(t => ["queued", "running", "checking"].includes(t.phase)) ? " · 进行中" : (status.tasks || []).some(t => t.phase === "paused") ? " · 已暂停" : ""}</button></footer>${transfersOpen ? transfers() : ""}
      <div class="space-drop-overlay" aria-hidden="true">${icon("cloud")}<strong>松开上传到当前文件夹</strong><span>${esc(parent ? listing.breadcrumbs.at(-1)?.name || "当前文件夹" : "全部文件")} · 文件夹自动分批上传 · 单文件最大 200 MB</span></div></main></div></div>${menuView()}${workspaces?.menuView() || ""}${dialogView()}${workspaces?.dialogView() || ""}`;
  }
  async function moveFolder(target) {
    const current = dialog;
    const result = await call("list", { parent: target, ...(workspaces ? {space_id: current.space || workspace} : {}) });
    if (dialog !== current) return;
    dialog.parent = target; dialog.crumbs = result.breadcrumbs; dialog.folders = result.items.filter(i => i.kind === "folder" && !dialog.items.some(item => item.id === i.id)); render();
  }
  async function mutateItems(method, items, destination) {
    if(workspaces?.current().writable===false)throw Error("MCP_DRIVE_READ_ONLY");
    const epoch = revision, failed = [];
    batchBusy = true; render();
    try {
      for (const item of items) {
        if (epoch !== revision) throw new Error("SPACE_CONTEXT_CHANGED");
        try { if(method==="move"&&typeof destination==="object"&&workspaces.current().kind==="agent-drive"){if(destination.copy||destination.space!==workspace)throw Error("SPACE_INVALID_DESTINATION");await call("move",{id:item.id,parent:destination.parent,name:item.name});} else if (method === "move" && typeof destination === "object") await call("links-file-transfer", {id:item.id,parent:destination.parent,space_id:destination.space,copy:destination.copy}); else await call(method, { id: item.id, ...(method === "move" ? { parent: destination, name: item.name } : {}) });
          if(method==="trash")workspaces?.invalidated([item]); }
        catch (cause) { if (epoch !== revision) throw cause; failed.push({ item, cause }); }
      }
      if (epoch !== revision) throw new Error("SPACE_CONTEXT_CHANGED");
      selectedIds = new Set(failed.map(({ item }) => item.id)); selectedId = failed[0]?.item.id || ""; anchorId = selectedId;
      await load();
      if (epoch !== revision) throw new Error("SPACE_CONTEXT_CHANGED");
      return failed;
    } finally { if (epoch === revision) { batchBusy = false; render(); } }
  }
  async function downloadItems(items) {
    if (!items.length || batchBusy) return;
    const epoch = revision;
    batchBusy = true; transfersOpen = true; render();
    try {
      if (items.length === 1 && items[0].kind === "file") await call("download", { id: items[0].id });
      else await call("downloads", { ids: items.map(item => item.id) });
    } finally { if (epoch === revision) { batchBusy = false; render(); } }
  }
  async function beginFileAction(kind,items,sidebar=false) {
    if(!items.length)return;
    const first=items[0],sourceSpace=sidebar?first.space_id:workspace,space=workspaces?.spaces().find(s=>s.id===sourceSpace),origin=sidebar?'sidebar':'files';
    if(kind==='rename')dialog={kind,title:'重命名',item:first,name:first.name,sourceSpace,origin};
    if(kind==='trash')dialog={kind,title:items.length===1?`删除“${first.name}”？`:`删除所选 ${items.length} 个项目？`,items,sourceSpace,origin};
    if(kind==='move'||kind==='copy') {
      dialog={kind:'move',title:items.length===1?`${kind==='copy'?'复制':'移动'}“${first.name}”`:`${kind==='copy'?'复制':'移动'}所选 ${items.length} 个项目`,items,copy:kind==='copy',space:sourceSpace,sourceName:space?.name || '我的空间',parent:space?.root || '',crumbs:[],folders:[],sourceSpace,origin};
      await moveFolder(space?.root || '');
    }
  }
  async function sidebarFileAction(kind,item) {
    if(dialog||batchBusy)return;
    const live=await call('stat',{id:item.id});
    if(live.kind!=='folder'||live.space_id!==item.space_id)throw Error('SPACE_CONTEXT_CHANGED');
    await beginFileAction(kind,[live],true);render();
    if(kind==='rename'){const input=document.querySelector('#space-name');input?.focus();input?.select?.();}
  }
  async function submit() {
    const current = dialog;
    if (!current || current.saving || composing) return;
    current.saving = true; render();
    try {
      if(current.origin==='sidebar') {
        const items=await Promise.all((current.items || [current.item]).map(async item=>{const live=await call('stat',{id:item.id});if(live.space_id!==current.sourceSpace||live.kind!=='folder')throw Error('SPACE_CONTEXT_CHANGED');return live;}));
        if(dialog!==current)return;
        if(current.items)current.items=items;else current.item=items[0];
      }
      if (current.kind === "previous") await call("restore-version", { id: current.item.id, expected: current.item.version });
      if (current.kind === "mkdir") await call("mkdir", { parent, name: current.name, ...(workspaces ? {space_id:workspace} : {}) });
      if (current.kind === "rename") await call("move", { id: current.item.id, parent: current.item.parent, name: current.name });
      if (["move", "trash"].includes(current.kind)) {
        const total = current.items.length;
        const failed = await mutateItems(current.kind, current.items, workspaces && current.kind === "move" ? {parent:current.parent,space:current.space || workspace,copy:current.copy} : current.parent);
        if (dialog !== current) return;
        if (failed.length) {
          current.items = failed.map(({ item }) => item);
          current.error = `已完成 ${total - failed.length} 项，${failed.length} 项未完成。${failed.slice(0, 3).map(({ item, cause }) => `${item.name}：${message(cause)}`).join("；")}`;
          return;
        }
      }
      if (dialog === current) closeDialog();
      if (!["move", "trash"].includes(current.kind)) await load();
    } catch (cause) { if (dialog === current) dialog.error = message(cause); }
    finally { current.saving = false; render(); }
  }
  document.querySelector("#app").addEventListener("click", async event => {
    if (ignoreSelectionClick) { ignoreSelectionClick = false; event.preventDefault?.(); return; }
    if (batchBusy || moving || workspaces?.blocked()) return;
    const button = event.target.closest("[data-action]");
    if (!button || button.disabled || !button.dataset.action?.startsWith("space-")) {
      const blank = event.target.closest?.(".space-file-list") && !event.target.closest?.("[data-entry-id]");
      if (contextMenu || (blank && selectedIds.size)) { contextMenu = null; if (blank && !event.ctrlKey && !event.metaKey && !event.shiftKey) clearSelection(); render(); }
      return;
    }
    const kind = button.dataset.action.slice(6), item = listing.items.find(i => i.id === button.dataset.id);
    const transferAttempt = ["upload", "upload-folder", "transfer"].includes(kind) ? beginTransfer(kind === "transfer" ? button.dataset.id : null) : null;
    if (transferAttempt) transferIssue = null;
    if (dialog && !["dialog-close", "dialog-confirm", "preview-download", "move-folder", "move-space"].includes(kind)) return;
    try {
      if(workspaces?.current().writable===false&&['upload','upload-folder','mkdir','move','copy','rename','trash','restore','purge','previous','batch-move','batch-copy','batch-trash','batch-restore'].includes(kind))throw Error('MCP_DRIVE_READ_ONLY');
      if (kind === "pin" && item) { await workspaces.pin(item); contextMenu = null; render(); return; }
      if (kind === "grant" && item) { contextMenu = null; await workspaces.grant(item); return; }
      if(kind === "agent-provide" && item){contextMenu=null;if(agentHub){void agentHub.open({resource:{root:item.id,name:item.name,kind:item.kind,domain:workspaces?.current().domain||"personal",permission:"read"}});render();return;} }

      if (kind === "previous" && item) { dialog = { kind, title: "恢复上一版本", item }; render(); return; }
      if (kind === "more") { const bounds = button.getBoundingClientRect?.(); showMenu(item, bounds?.right - 200, bounds?.bottom); return; }
      contextMenu = null;
      if (kind === "select") {
        selectItem(item, event); render();
        document.querySelector(`.space-file-row[data-entry-id="${selectedId}"]`)?.focus?.({ preventScroll: true });
        return;
      }
      if (kind === "selection-clear") { clearSelection(); render(); return; }
      if (kind === "batch-download") { await downloadItems(selectedItems()); return; }
      if (kind === "batch-restore") {
        const items = selectedItems(), failed = await mutateItems("restore", items);
        if (failed.length) error = `${failed.length} 项未恢复。${message(failed[0].cause)}`;
        render(); return;
      }
      if (kind === "sort") { sortDirection = sortBy === button.dataset.sort ? -sortDirection : 1; sortBy = button.dataset.sort; render(); return; }
      if (kind === "preview-mode") { previewMode = !previewMode; render(); return; }
      if (kind === "preview-download" && dialog?.item) { await downloadItems([dialog.item]); return; }
      if (kind === "open") { await openItem(item); render(); return; }
      if (kind === "dialog-close") { closeDialog(); render(); return; }
      if (kind === "dialog-confirm") { await submit(); return; }
      if (kind === "transfers-toggle") { transfersOpen = !transfersOpen; render(); return; }
      if (kind === "move-space") { dialog.space = button.dataset.id; await moveFolder(workspaces.spaces().find(s=>s.id===dialog.space)?.root || ""); return; }
      if (kind === "move-folder") { await moveFolder(button.dataset.id); return; }
      if (kind === "refresh") { await load(); return; }
      if (kind === "folder" || kind === "recycle") {
        await navigate(kind === "folder" ? button.dataset.id : rootFolder(), kind === "recycle", button.dataset.space || workspace); return;
      }
      if (kind === "mkdir") dialog = { kind, title: "新建文件夹", name: "" };
      if(kind==='rename'&&item)await beginFileAction('rename',[item]);
      if((kind==='trash'&&item)||kind==='batch-trash')await beginFileAction('trash',kind==='trash'?[item]:selectedItems());
      if((['move','copy'].includes(kind)&&item)||['batch-move','batch-copy'].includes(kind))await beginFileAction(kind.includes('copy')?'copy':'move',['move','copy'].includes(kind)?[item]:selectedItems());
      if (kind === "transfers-more") { transferLimit += 100; render(); return; }
      if (kind === "upload" || kind === "upload-folder") { transfersOpen = true; await call("uploads", { parent, space_id: workspace, scope: status.scope, folders: kind === "upload-folder" }); }
      if (kind === "download" && item) await downloadItems([item]);
      if (kind === "transfer") await call("transfer", { id: button.dataset.id, action: button.dataset.command });
      if (["restore", "purge"].includes(kind) && item) { await call(kind, { id: item.id }); await load(); }
      if (kind === "preview" && item) await openItem(item);
      render();
      if (["mkdir", "rename"].includes(kind)) { const input = document.querySelector("#space-name"); input?.focus(); if (kind === "rename") input?.select?.(); }
    } catch (cause) { if (transferAttempt) transferProblem(cause, transferAttempt); else error = message(cause); render(); }
  });
  const root = document.querySelector("#app");
  root.addEventListener("change", event => {
    if (event.target.id !== "space-sort") return;
    sortBy = event.target.value; sortDirection = 1; contextMenu = null; render();
    document.querySelector("#space-sort")?.focus?.();
  });
  root.addEventListener("contextmenu", event => {
    if (!active || !fileView || dialog || workspaces?.blocked() || batchBusy || !host?.canLaunchApplications || status.phase === "unsupported") return;
    if (!event.target.closest?.(".space-file-list")) return;
    event.preventDefault();
    const row = event.target.closest("[data-entry-id]");
    showMenu(listing.items.find(item => item.id === row?.dataset.entryId), event.clientX, event.clientY);
  });
  root.addEventListener("dblclick", async event => {
    if (!active || !fileView || dialog || workspaces?.blocked() || batchBusy || event.ctrlKey || event.metaKey || event.shiftKey || event.target.closest?.("button")) return;
    const row = event.target.closest?.("[data-entry-id]");
    if (!row) return;
    contextMenu = null;
    try { await openItem(listing.items.find(item => item.id === row.dataset.entryId)); }
    catch (cause) { error = message(cause); }
    render();
  });
  function stopMarquee(canceled = false) {
    if (!marquee) return;
    const current = marquee; marquee = null;
    if (current.frame) cancelAnimationFrame(current.frame);
    current.overlay.remove();
    if (current.list.hasPointerCapture?.(current.pointerId)) current.list.releasePointerCapture(current.pointerId);
    if (canceled) selectedIds = current.base;
    selectedId = visibleItems().find(item => selectedIds.has(item.id))?.id || ""; anchorId = selectedId;
    if (current.moved) { ignoreSelectionClick = true; setTimeout(() => { ignoreSelectionClick = false; }, 0); }
  }
  function updateMarquee() {
    if (!marquee) return;
    const current = marquee, bounds = current.list.getBoundingClientRect();
    if (current.frame) cancelAnimationFrame(current.frame);
    current.frame = null;
    const x = Math.max(bounds.left, Math.min(current.x, bounds.right)), y = Math.max(bounds.top, Math.min(current.y, bounds.bottom));
    const previousScroll = current.list.scrollTop;
    if (current.moved) current.list.scrollTop += y < bounds.top + 28 ? -14 : y > bounds.bottom - 28 ? 14 : 0;
    const endX = x - bounds.left + current.list.scrollLeft, endY = y - bounds.top + current.list.scrollTop;
    const left = Math.min(current.startX, endX), right = Math.max(current.startX, endX), top = Math.min(current.startY, endY), bottom = Math.max(current.startY, endY);
    current.moved ||= Math.hypot(endX - current.startX, endY - current.startY) >= 4;
    if (!current.moved) return;
    const visualLeft = Math.max(bounds.left, bounds.left + left - current.list.scrollLeft), visualTop = Math.max(bounds.top, bounds.top + top - current.list.scrollTop);
    Object.assign(current.overlay.style, { display: "block", left: `${visualLeft}px`, top: `${visualTop}px`, width: `${Math.max(0, Math.min(bounds.right, bounds.left + right - current.list.scrollLeft) - visualLeft)}px`, height: `${Math.max(0, Math.min(bounds.bottom, bounds.top + bottom - current.list.scrollTop) - visualTop)}px` });
    const next = current.additive ? new Set(current.base) : new Set();
    for (const tile of current.list.querySelectorAll(".space-file-row")) {
      const rect = tile.getBoundingClientRect(), tileLeft = rect.left - bounds.left + current.list.scrollLeft, tileTop = rect.top - bounds.top + current.list.scrollTop;
      if (tileLeft >= right || tileLeft + rect.width <= left || tileTop >= bottom || tileTop + rect.height <= top) continue;
      if (current.toggle && current.base.has(tile.dataset.entryId)) next.delete(tile.dataset.entryId); else next.add(tile.dataset.entryId);
    }
    selectedIds = next;
    for (const tile of current.list.querySelectorAll(".space-file-row")) {
      tile.classList.toggle("is-selected", next.has(tile.dataset.entryId));
      tile.setAttribute("aria-selected", String(next.has(tile.dataset.entryId)));
    }
    const count = document.querySelector(".space-status-count");
    if (count) count.textContent = `${listing.items.length} 个项目 · 已选 ${next.size} 项`;
    if (previousScroll !== current.list.scrollTop) current.frame = requestAnimationFrame(updateMarquee);
  }
  document.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    const list = event.target.closest?.(".space-file-list");
    const row = event.target.closest?.("[data-entry-id]");
    if (canDrop() && list && row && !event.target.closest?.("button, input, select") && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      const item = listing.items.find(item => item.id === row.dataset.entryId);
      if (item) {
        movePointer = { list, item, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        contextMenu = null; document.querySelector(".space-context-menu")?.remove?.();
        return;
      }
    }
    if (active && fileView && !dialog && !workspaces?.blocked() && !batchBusy && host?.canLaunchApplications && list && !event.target.closest?.("[data-entry-id], button, input, select")) {
      event.preventDefault(); contextMenu = null;
      const bounds = list.getBoundingClientRect(), overlay = document.createElement("div");
      overlay.className = "space-selection-marquee"; overlay.setAttribute("aria-hidden", "true");
      marquee = { list, overlay, pointerId: event.pointerId, startX: event.clientX - bounds.left + list.scrollLeft, startY: event.clientY - bounds.top + list.scrollTop, x: event.clientX, y: event.clientY, base: new Set(selectedIds), additive: event.metaKey || event.ctrlKey || event.shiftKey, toggle: event.metaKey || event.ctrlKey, moved: false };
      list.append(overlay); list.focus({ preventScroll: true }); list.setPointerCapture?.(event.pointerId);
      // Do not rebuild the grid while pointer capture and the selection box are active.
      document.querySelector(".space-context-menu")?.remove?.();
      return;
    }
    if (contextMenu && !event.target.closest?.(".space-context-menu")) { contextMenu = null; render(); }
  });
  document.addEventListener("pointermove", event => {
    if (marquee && event.pointerId === marquee.pointerId) { marquee.x = event.clientX; marquee.y = event.clientY; updateMarquee(); }
    if (!movePointer || event.pointerId !== movePointer.pointerId) return;
    if (!canDrop()) { clearDrag(); render(); return; }
    if (!moving && Math.hypot(event.clientX - movePointer.x, event.clientY - movePointer.y) < 6) return;
    event.preventDefault();
    if (!moving) startMoving();
    if (moving.ghost) Object.assign(moving.ghost.style, { left: `${event.clientX + 16}px`, top: `${event.clientY + 16}px` });
    highlightMove(pointerTarget(event));
  });
  document.addEventListener("pointerup", async event => {
    if (marquee && event.pointerId === marquee.pointerId) { stopMarquee(); render(); }
    if (!movePointer || event.pointerId !== movePointer.pointerId) return;
    const current = moving, target = moving ? moveTarget(pointerTarget(event)) : null;
    clearDrag();
    if (!current) return; // A normal click still performs the existing selection action.
    event.preventDefault?.(); ignoreSelectionClick = true;
    setTimeout(() => { ignoreSelectionClick = false; }, 0);
    await finishMove(current, target);
  });
  document.addEventListener("pointercancel", () => { if (marquee || movePointer) { stopMarquee(true); clearDrag(); render(); } });
  window.addEventListener?.("blur", () => { if (contextMenu || marquee || movePointer) { stopMarquee(true); clearDrag(); contextMenu = null; render(); } });
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes("Files");
  const canDrop = () => active && fileView && host?.canLaunchApplications && !trash && !dialog && !workspaces?.blocked() && !batchBusy && status.phase !== "unsupported";
  const pointerTarget = event => ({ target: document.elementFromPoint?.(event.clientX, event.clientY) || event.target, clientY: event.clientY });
  function clearMoveTarget() {
    moving?.target?.element.classList?.remove("is-move-target");
    if (moving) moving.target = null;
  }
  function clearDrag() {
    dragDepth = 0;
    for(const node of root?.querySelectorAll?.(".is-upload-target") || [])node.classList.remove("is-upload-target");
    const pointer = movePointer; movePointer = null;
    if (pointer?.list.hasPointerCapture?.(pointer.pointerId)) pointer.list.releasePointerCapture(pointer.pointerId);
    root?.querySelector?.(".space-main")?.classList.remove("is-dragging");
    if (moving) {
      clearMoveTarget();
      for (const tile of root.querySelectorAll?.(".space-file-row") || []) tile.classList.remove("is-moving");
      moving.ghost?.remove();
      const hint = root.querySelector?.(".space-status-hint");
      if (hint) hint.textContent = moving.hint;
      moving = null;
    }
  }
  function moveTarget(event) {
    if (!moving || moving.epoch !== revision || !canDrop()) return null;
    const row = event.target?.closest?.("[data-entry-id]");
    const item = listing.items.find(item => item.id === row?.dataset.entryId);
    if (item) return item.kind === "folder" && !moving.items.some(source => source.id === item.id) ? { id: item.id, name: item.name, element: row } : null;
    const button = event.target?.closest?.('[data-action="space-folder"]');
    if (!button || button.disabled || (button.dataset.id === parent && (!button.dataset.space || button.dataset.space === workspace))) return null;
    if (button.dataset.space) return {id:button.dataset.id,space:button.dataset.space,name:button.dataset.name || button.textContent,element:button};
    const crumb = listing.breadcrumbs.find(crumb => crumb.id === button.dataset.id);
    return button.dataset.id === "" || crumb ? { id: button.dataset.id, name: crumb?.name || "全部文件", element: button } : null;
  }
  function highlightMove(event) {
    const target = moveTarget(event);
    clearMoveTarget();
    if (!moving) return;
    moving.target = target;
    target?.element.classList?.add("is-move-target");
    const hint = root.querySelector?.(".space-status-hint");
    if (hint) hint.textContent = target ? `松开将 ${moving.items.length} 项移到“${target.name}”` : `将 ${moving.items.length} 项拖到文件夹`;
    const list = event.target?.closest?.(".space-file-list");
    if (list?.getBoundingClientRect) {
      const bounds = list.getBoundingClientRect();
      list.scrollTop += event.clientY < bounds.top + 28 ? -24 : event.clientY > bounds.bottom - 28 ? 24 : 0;
    }
    return target;
  }
  function startMoving() {
    const { item, list, pointerId } = movePointer;
    stopMarquee(); contextMenu = null;
    if (!selectedIds.has(item.id)) selectItem(item);
    const hint = root.querySelector?.(".space-status-hint");
    moving = { epoch: revision, items: selectedItems(), hint: hint?.textContent || "", target: null, ghost: null };
    list.setPointerCapture?.(pointerId);
    // Keep the source nodes alive until mouse-up, including across state broadcasts.
    for (const tile of root.querySelectorAll?.(".space-file-row") || []) {
      const selected = selectedIds.has(tile.dataset.entryId);
      tile.classList.toggle("is-selected", selected); tile.classList.toggle("is-moving", selected);
      tile.setAttribute("aria-selected", String(selected));
    }
    if (document.createElement) {
      const ghost = document.createElement("div");
      ghost.className = "space-move-ghost"; ghost.textContent = `${moving.items.length} 项 · ${item.name}`;
      ghost.setAttribute("aria-hidden", "true"); root.append(ghost); moving.ghost = ghost;
    }
    if (hint) hint.textContent = `将 ${moving.items.length} 项拖到文件夹`;
  }
  async function finishMove(current, target) {
    if (!target) { render(); return; }
    if (target.space && target.space !== workspace) { dialog = {kind:"move",title:"确认跨空间移动",items:current.items,space:target.space,parent:target.id,sourceName:workspaces.current().name,crumbs:[],folders:[]}; await moveFolder(target.id); render(); return; }
    error = null;
    try {
      const failed = await mutateItems("move", current.items, target.id);
      if (current.epoch === revision && failed.length) error = `已移动 ${current.items.length - failed.length} 项，${failed.length} 项未完成。${failed.slice(0, 3).map(({ item, cause }) => `${item.name}：${message(cause)}`).join("；")}`;
    } catch (cause) { if (current.epoch === revision) error = message(cause); }
    if (current.epoch === revision) render();
  }
  // Space icons use pointer dragging; native file drops remain reserved for uploads.
  root.addEventListener("dragstart", event => { if (event.target?.closest?.("[data-entry-id]")) event.preventDefault(); });
  root.addEventListener("dragenter", event => {
    if (!active || !hasFiles(event)) return;
    event.preventDefault();
    if (canDrop()) { dragDepth++; root.querySelector?.(".space-main")?.classList.add("is-dragging"); }
  });
  root.addEventListener("dragover", event => {
    if (!active || !hasFiles(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = canDrop() ? "copy" : "none";
    for(const node of root?.querySelectorAll?.(".is-upload-target") || [])node.classList.remove("is-upload-target");
    if(canDrop()) {
      const destination=event.target?.closest?.('[data-action="space-folder"]');
      const folder=listing.items.find(i=>i.id===event.target?.closest?.('[data-entry-id]')?.dataset.entryId && i.kind==='folder');
      if(destination&&!destination.disabled)destination.classList?.add("is-upload-target");
      const hint=root?.querySelector?.(".space-drop-overlay strong");if(hint)hint.textContent=`松开上传到 ${destination?.dataset.name || folder?.name || "当前文件夹"}`;
    }
  });
  root.addEventListener("dragleave", event => {
    if (!active || !hasFiles(event)) return;
    event.preventDefault();
    if (--dragDepth <= 0) clearDrag();
  });
  root.addEventListener("drop", async event => {
    if (!active || !hasFiles(event)) return;
    event.preventDefault(); clearDrag();
    if (!canDrop()) return;
    const epoch = revision;
    const destination = event.target?.closest?.('[data-action="space-folder"]');
    const row = event.target?.closest?.("[data-entry-id]");
    const folder = listing.items.find(i=>i.id===row?.dataset.entryId && i.kind==="folder");
    const uploadParent = destination && !destination.disabled ? destination.dataset.id : folder?.id || parent;
    const uploadSpace = destination && !destination.disabled ? destination.dataset.space || workspace : workspace;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const attempt = beginTransfer();
    transfersOpen = true; error = null; transferIssue = null; render();
    try {
      const result = await window.wanxClient.uploadDroppedFiles(files, { parent: uploadParent, space_id: uploadSpace, scope: status.scope });
      if (epoch === revision && !result.ok) transferProblem(result.code === "SPACE_UPLOAD_LIMIT" ? result : result.code, attempt);
    } catch (cause) { if (epoch === revision) transferProblem(cause, attempt); }
    if (epoch === revision) render();
  });
  document.addEventListener("dragend", () => { const wasMoving = Boolean(moving); clearDrag(); if (wasMoving) render(); });
  root.addEventListener("compositionstart", event => { if (event.target.id === "space-name") composing = true; });
  root.addEventListener("compositionend", event => { if (event.target.id === "space-name") { composing = false; if (dialog) dialog.name = event.target.value; } });
  root.addEventListener("input", event => {
    if (event.target.id === "space-name" && dialog) dialog.name = event.target.value;
    if (event.target.id === "space-search") { stopMarquee(); query = event.target.value; clearSelection(); contextMenu = null; render(); }
  });
  document.querySelector("#app").addEventListener("submit", event => { if (event.target.dataset.form === "space") { event.preventDefault(); void submit(); } });
  document.addEventListener("keydown", async event => {
    if (!active || !fileView || workspaces?.blocked() || composing || event.isComposing) return;
    if (event.key === "Escape") { if (batchBusy || dialog?.saving) return; if (movePointer || moving) clearDrag(); else if (dialog) closeDialog(); else if (marquee) stopMarquee(true); else if (!contextMenu) clearSelection(); contextMenu = null; render(); return; }
    if (dialog || batchBusy || marquee || moving || event.target?.closest?.("input, textarea, select")) return;
    if (contextMenu) {
      const buttons = Array.from(document.querySelectorAll?.('.space-context-menu [role="menuitem"]') || []);
      const index = buttons.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
      return;
    }
    if (!event.target?.closest?.(".space-file-list")) return;
    const item = listing.items.find(item => item.id === selectedId);
    try {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") { event.preventDefault(); selectedIds = new Set(visibleItems().map(item => item.id)); selectedId ||= visibleItems()[0]?.id || ""; anchorId ||= selectedId; render(); return; }
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const items = visibleItems(), index = items.findIndex(item => item.id === selectedId);
        const tiles = Array.from(document.querySelectorAll?.(".space-file-row") || []);
        const columns = tiles.filter(tile => tile.offsetTop === tiles[0]?.offsetTop).length || 1;
        const step = event.key === "ArrowDown" ? columns : event.key === "ArrowUp" ? -columns : event.key === "ArrowRight" ? 1 : -1;
        const next = items[index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + step))];
        if (next) selectItem(next, { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey });
        render(); document.querySelector(`.space-file-row[data-entry-id="${selectedId}"]`)?.focus?.(); return;
      }
      if (event.key === "Enter") { event.preventDefault(); await openItem(item); }
      if (event.key === "F2" && item && selectedIds.size === 1 && !trash) { event.preventDefault(); dialog = { kind: "rename", title: "重命名", item, name: item.name }; }
      if (event.key === "Delete" && selectedIds.size && !trash) { event.preventDefault(); const items = selectedItems(); dialog = { kind: "trash", title: `删除所选 ${items.length} 个项目？`, items }; }
      if (event.key === "F10" && event.shiftKey) { event.preventDefault(); const bounds = event.target.getBoundingClientRect?.(); showMenu(item, bounds?.left + 24, bounds?.bottom); return; }
      render();
      if (event.key === "F2") document.querySelector("#space-name")?.focus?.();
    } catch (cause) { error = message(cause); render(); }
  });
  window.wanxClient.onSpaceContentChanged?.(() => { void workspaces?.updateSync?.(); if (dialog || workspaces?.blocked()) { pendingRefresh = true; return; } if (active && !loading && !dialog && !moving && !marquee) void load(); });
  window.wanxClient.onSpaceState?.(next => {
    if (!host || host.route === "auth") return;
    if (next.accountId !== host.account?.accountId || next.boxId !== host.activeDeviceId) {
      revision++; workspaces?.reset(null); workspace="personal"; stopMarquee(); clearDrag(); clearSelection(); batchBusy = false; contextMenu = null; query = ""; listing = { items: [], breadcrumbs: [] }; status = { phase: "idle", tasks: [] }; closeDialog(); transferIssue = null; loading = false; render(); return;
    }
    const previous = status.tasks || [];
    if (next.tasks?.some(t => !["complete", "canceled"].includes(t.phase) && !previous.some(p => p.id === t.id))) transfersOpen = true;
    status = next; reconcileTransferIssue();
    if (next.overview) lastSeen = { boxId: host.activeDeviceId, name: host.connection?.name || host.devices?.find(d => d.deviceId === host.activeDeviceId)?.name || "盒子", at: next.overview.collectedAt };
    if (active) {
      render();
      if (next.tasks?.some(t => t.phase === "complete" && previous.find(p => p.id === t.id)?.phase !== "complete")) void load();
    }
  });
  setInterval(() => { if(active&&!document.hidden)void workspaces?.updateSync?.(); if (active && !document.hidden && host?.canLaunchApplications && !loading && !dialog && !workspaces?.blocked() && !moving && !movePointer && !marquee) void load(); }, 15000);
  workspaces?.bind({call,icon,fileAction:sidebarFileAction,dismissFileMenu:()=>{contextMenu=null;}, render:()=>render(), message, error:value=>{error=value;render();}, reload:()=>load(), navigate});
  window.wanxSpace = { reload: () => load(), view, hostState, retainEditor, mounted, overview: () => status.overview, bind(options) { render = options.render; }, isSelecting: () => Boolean(marquee), isDragging: () => Boolean(movePointer || moving), activate(value, visible = value) { window.wanxClipboard?.setActive(value && visible); if (fileView !== visible) { stopMarquee(); clearDrag(); contextMenu = null; } fileView = visible; if (active === value) return; active = value; if (active) void load(); else { closeDialog(); clearDrag(); previews?.mount([], scope, false); } } };
})();

(() => {
  const esc = v => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const size = value => { if (value == null) return "暂不可用"; let n = value, i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][i]}`; };
  const errors = {
    SPACE_AGENT_PAUSED: "该接入已暂停。恢复接入后可继续操作。",
    SPACE_AGENT_DISCONNECTED: "接入已断开，请重新申请并确认。",
    SPACE_LINK_SCOPE: "该资源不在授权范围内。",
    SPACE_ALREADY_CONNECTED: "此身份或空间已有接入，请刷新后重试。",
    SPACE_MANAGED_ROOT: "请通过空间管理操作空间本身。",
    SPACE_LINK_PORT_IN_USE: "Agent 链接端口被其他程序占用，请释放端口后重启万象。旧链接没有更换。",
    SPACE_LINK_START_FAILED: "Agent 链接服务未启动，请检查系统钥匙串并重启万象。",
    SPACE_VERSION_CONFLICT: "文件已经更新，请刷新后再操作，避免覆盖其他修改。",
    SPACE_UPGRADE_REQUIRED: "当前盒子尚不支持文件空间，请升级盒端服务。",
    SPACE_INVALID_DROP: "请从本地拖入文件后重试。",
    SPACE_DROP_FILES_ONLY: "暂不支持拖入整个文件夹，请选择其中的文件上传。",
    SPACE_DISK_FULL: "盒子存储空间不足，请清理文件或回收站后重试。",
    SPACE_INVALID_NAME: "请输入有效名称，不要使用斜线或特殊路径字符。",
    SPACE_INVALID_DESTINATION: "不能把文件夹移到自身或其子文件夹中。",
    SPACE_NOT_FOUND: "文件已发生变化，请刷新后重试。",
    SPACE_LOCAL_FILE_CHANGED: "本机文件已发生变化，请取消此次任务并重新上传。",
    SPACE_REMOTE_FILE_CHANGED: "远端文件已发生变化，请重新下载。",
    SPACE_DESTINATION_CHANGED: "本机保存位置的文件已变化，请重新选择下载位置。",
    SPACE_PREVIEW_DOWNLOAD: "此格式或大小暂不支持预览，请下载后打开。",
    SPACE_CHUNK_INVALID: "文件校验未通过，请重试传输。",
    SPACE_PAUSED: "传输已暂停，连接原盒子后可继续。",
    SPACE_CONTEXT_CHANGED: "账号或盒子已切换，请重新操作。",
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
  const message = error => Object.entries(errors).find(([key]) => String(error?.message || error).includes(key))?.[1] || "操作未完成，请检查连接并重试。";
  const workspaces = window.wanxWorkspaces;
  let workspace = "personal", recordNavigation = true;
  const rootFolder = () => workspaces?.root() || "";
  let host, scope, revision = 0, parent = "", trash = false, listing = { items: [], breadcrumbs: [] }, status = { phase: "idle", tasks: [] };
  let lastSeen = null, dragDepth = 0, transfersOpen = false;
  let selectedId = "", anchorId = "", selectedIds = new Set(), contextMenu = null, query = "", sortBy = "name", sortDirection = 1;
  let marquee = null, moving = null, movePointer = null, ignoreSelectionClick = false, batchBusy = false;
  let pendingRefresh = false, composing = false;
  let error = null, loading = false, active = false, fileView = false, dialog = null, previewURL = null, render = () => {};
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
    return result.value;
  }
  async function load({ metrics = true } = {}) {
    if (!host?.canLaunchApplications || loading) return;
    const epoch = revision;
    loading = true; error = null; render();
    try {
      if (metrics) status = await call("refresh");
      if (workspaces) { if(status.scope)workspaces.storageScope(status.scope); await workspaces.refresh(); }
      listing = trash && workspaces ? {items:(await Promise.all(workspaces.spaces().filter(s=>!s.trashed).map(s=>call("list",{parent:s.root,trash:true,space_id:s.id})))).flatMap(result=>result.items),breadcrumbs:[]} : await call("list", { parent, trash, ...(workspaces ? { space_id: workspace } : {}) });
      if (workspaces) { await workspaces.observe({space: workspace, parent, trash}, listing, recordNavigation); recordNavigation = true; }
      selectedIds = new Set([...selectedIds].filter(id => listing.items.some(item => item.id === id)));
      if (!listing.items.some(item => item.id === selectedId)) selectedId = "";
      if (contextMenu?.id && !listing.items.some(item => item.id === contextMenu.id)) contextMenu = null;
    } catch (cause) { if (epoch === revision) error = message(cause); }
    finally { if (epoch === revision) { loading = false; render(); } }
  }
  function hostState(state) {
    if (state.route === "auth" || (host && state.account?.accountId !== host.account?.accountId)) lastSeen = null;
    if (state.activeDeviceId && lastSeen && state.activeDeviceId !== lastSeen.boxId) lastSeen = null;
    host = state;
    if (!state.canLaunchApplications) clearDrag();
    const next = state.route !== "auth" ? `${state.account?.accountId}:${state.activeDeviceId || ""}` : null;
    if (scope !== next) {
      stopMarquee(); clearSelection(); batchBusy = false; contextMenu = null; query = "";
      scope = next; workspaces?.reset(scope); workspace = "personal"; revision++; parent = ""; trash = false; listing = { items: [], breadcrumbs: [] }; closeDialog(); clearDrag(); error = null; loading = false;
      status = { phase: "idle", tasks: [] };
      if (active && state.canLaunchApplications) queueMicrotask(() => { if (active) void load(); });
    }
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
    return `<section class="space-storage" aria-label="存储空间"><div class="space-storage-title"><span>空间文件</span><strong>${size(used)}</strong></div>${volume ? `<progress class="space-capacity" max="${volume.total || 1}" value="${volume.used}" aria-label="存储卷已用容量"></progress><p>可用 ${size(volume.free)}<br>共 ${size(volume.total)}</p>` : `<p>${location ? "存储目录暂不可用" : "正在获取容量…"}</p>`}<small>磁盘容量含该卷其他数据</small></section>${workspaces?.storageView?.() || ""}`;
  }
  function transfers() {
    const tasks = status.tasks || [];
    if (!tasks.length) return "";
    const labels = { queued: "等待传输", checking: "正在核对文件", running: "正在传输", paused: "已暂停", complete: "已完成", canceled: "已取消" };
    const pending = tasks.filter(t => !["complete", "canceled"].includes(t.phase)).length;
    const ordered = [...tasks].reverse().sort((a, b) => Number(["complete", "canceled"].includes(a.phase)) - Number(["complete", "canceled"].includes(b.phase)));
    return `<section class="space-transfers" aria-label="文件传输"><button class="space-transfers-heading" data-action="space-transfers-toggle" aria-expanded="${transfersOpen}"><strong>传输列表 <span class="count">${pending ? `${pending} 项待完成` : `${tasks.length} 项记录`}</span></strong><span>${transfersOpen ? "收起" : "展开"}</span></button>${transfersOpen ? `<div class="space-transfer-list">${ordered.map(t => `<div class="space-transfer ${t.phase === "complete" ? "is-complete" : ""}"><span class="space-transfer-icon">${icon(t.direction)}</span><div class="space-transfer-main"><div class="space-transfer-title"><strong>${esc(t.name)}</strong><span>${percent(t)}%</span></div><progress class="space-progress" max="100" ${t.phase === "checking" ? "" : `value="${percent(t)}"`} aria-label="${esc(t.name)}${t.direction === "upload" ? "上传" : "下载"}进度"></progress><small>${t.direction === "upload" ? "上传" : "下载"} · ${t.phase === "running" && t.offset === t.size ? "正在保存" : labels[t.phase] || t.phase} · ${size(t.offset)} / ${size(t.size)}</small>${t.error ? `<small class="inline-error">${esc(message(t.error))}</small>` : ""}</div><div class="space-row-actions">${t.phase === "paused" ? `<button class="text-button" data-action="space-transfer" data-id="${t.id}" data-command="resume">继续</button>` : ["running", "checking", "queued"].includes(t.phase) ? `<button class="text-button" data-action="space-transfer" data-id="${t.id}" data-command="pause">暂停</button>` : ""}${!["complete", "canceled"].includes(t.phase) ? `<button class="text-button" data-action="space-transfer" data-id="${t.id}" data-command="cancel">取消</button>` : ""}</div></div>`).join("")}</div>` : ""}</section>`;
  }
  const action = (label, kind, item, danger = false) => `<button role="menuitem" class="${danger ? "danger-text" : ""}" data-action="space-${kind}" data-id="${item?.id || ""}">${label}</button>`;
  const fileType = item => item.kind === "folder" ? "文件夹" : item.name.includes(".") ? item.name.split(".").pop().toUpperCase() + " 文件" : "文件";
  function fileIcon(item) {
    if (item.kind === "folder") return '<span class="space-item-icon is-folder"><svg viewBox="0 0 72 64" aria-hidden="true"><path fill="#d9a23d" stroke="#bf8830" d="M5 13a5 5 0 0 1 5-5h18l6 7h28a5 5 0 0 1 5 5v34H5Z"/><path fill="#f2c86c" stroke="#d9a746" d="M5 23h62v31a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5Z"/><path stroke="#ffe6a7" d="M8 25h56"/></svg></span>';
    const ext = item.name.includes(".") ? item.name.split(".").pop().toLowerCase() : "";
    const kind = /^(pdf)$/.test(ext) ? "pdf" : /^(docx?|rtf|txt|md)$/.test(ext) ? "document" : /^(xlsx?|csv)$/.test(ext) ? "sheet" : /^(pptx?|key)$/.test(ext) ? "slides" : /^(png|jpe?g|gif|webp|svg|heic)$/.test(ext) ? "image" : /^(mp4|mov|mkv|mp3|wav|m4a)$/.test(ext) ? "media" : /^(zip|rar|7z|tar|gz)$/.test(ext) ? "archive" : "generic";
    const badge = /^[a-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : "FILE";
    return `<span class="space-item-icon is-${kind}"><svg viewBox="0 0 64 72" aria-hidden="true"><path class="space-document-paper" d="M12 3h26l15 15v48a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z"/><path class="space-document-fold" d="M38 3v12a3 3 0 0 0 3 3h12"/><path class="space-document-lines" d="M19 29h24M19 35h24M19 41h16"/></svg><span class="space-file-badge">${badge}</span></span>`;
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
    const choices = item && count > 1 ? (trash ? action(`恢复所选 ${count} 项`, "batch-restore") : action(`下载所选 ${count} 项…`, "batch-download") + action(`移动所选 ${count} 项…`, "batch-move") + (workspaces ? action(`复制所选 ${count} 项…`, "batch-copy") : "") + '<hr role="separator">' + action(`移入回收站（${count} 项）…`, "batch-trash", null, true)) : item ? trash ? action("恢复", "restore", item) + action("彻底删除…", "purge", item, true) : action(item.kind === "folder" ? "打开文件夹" : "预览", "open", item) + action("下载到电脑…", "download", item) + action("创建 Agent 访问链接…", "link-create", item) + (workspaces ? action("授予 Agent 读写权限…", "grant", item) + (item.kind === "folder" ? action("固定到常用位置", "pin", item) : "") : "") + (item.kind === "file" && item.previous_digest ? action("恢复上一版本…", "previous", item) : "") + '<hr role="separator">' + action("重命名…", "rename", item) + action("移动到…", "move", item) + (workspaces ? action("复制到…", "copy", item) : "") + '<hr role="separator">' + action("移入回收站…", "trash", item, true) : (trash ? "" : action("上传文件…", "upload") + action("新建文件夹…", "mkdir") + '<hr role="separator">') + action("刷新", "refresh");
    return `<div class="space-context-menu" role="menu" aria-label="${item ? "文件操作" : "文件夹操作"}" style="left:${contextMenu.x}px;top:${contextMenu.y}px">${choices}</div>`;
  }
  function showMenu(item, x, y) {
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
    const result = await call("preview", { id: item.id });
    const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
    closeDialog(); previewURL = URL.createObjectURL(new Blob([bytes], { type: result.type }));
    dialog = { kind: "preview", title: result.name, type: result.type, text: result.type === "text/plain" ? new TextDecoder().decode(bytes) : "" };
  }
  function dialogView() {
    if (!dialog) return "";
    let body = "";
    if (dialog.kind === "link-create") {
      body = `<p>为“${esc(dialog.item.name)}”创建读写链接。</p><p class="muted">持有此链接的本机程序可读写${dialog.item.kind === "folder" ? "此文件夹及其所有子文件" : "此文件"}。万象需保持运行并连接原盒子。</p><label for="space-link-expiry">有效期</label><select id="space-link-expiry"><option value="0" ${!dialog.days ? "selected" : ""}>长期有效，直到撤销</option><option value="1" ${dialog.days === 1 ? "selected" : ""}>1 天</option><option value="7" ${dialog.days === 7 ? "selected" : ""}>7 天</option><option value="30" ${dialog.days === 30 ? "selected" : ""}>30 天</option></select><button class="button primary" data-action="space-link-save">创建链接</button>`;
    } else if (dialog.kind === "links") {
      const date = n => {
        if (!n) return "—";
        const delta = n * 1000 - Date.now(), minutes = Math.abs(delta) / 60000;
        if (minutes < 1) return delta > 0 ? "即将到期" : "刚刚";
        const value = minutes < 60 ? Math.ceil(minutes) + " 分钟" : minutes < 1440 ? Math.ceil(minutes / 60) + " 小时" : Math.ceil(minutes / 1440) + " 天";
        return value + (delta > 0 ? "后" : "前");
      };
      body = `<p class="muted">当前盒子的文件访问链接 · 读写权限<br>持有链接的本机程序可读写指定资源。可随时撤销。</p><button class="button small" data-action="space-link-config">MCP 接入配置</button><div class="space-links-list">${dialog.links.map(link => `<article class="space-link-card"><strong>${esc(link.name || "目标已删除")}</strong><small>${link.kind === "folder" ? "文件夹及后代" : "单个文件"} · ${link.revoked ? "已撤销" : link.expires && link.expires * 1000 < Date.now() ? "已到期" : "读写"}</small><small>到期：${link.expires ? date(link.expires) : "长期"} · 最近使用：${date(link.last_used)}</small>${link.url && !link.revoked ? `<input aria-label="访问链接" readonly value="${esc(link.url)}" /><button class="text-button" data-action="space-link-copy" data-id="${link.id}">复制链接</button>` : ""}<button class="text-button" data-action="space-link-audit" data-id="${link.id}">操作记录</button>${!link.revoked ? `<button class="text-button danger-text" data-action="space-link-revoke" data-id="${link.id}">撤销链接</button>` : ""}</article>`).join("") || '<p class="muted">还没有链接。右键文件或文件夹即可创建。</p>'}</div>`;
    } else if (dialog.kind === "link-info") {
      body = `<pre class="space-text-preview">${esc(dialog.text)}</pre><button class="button" data-action="space-link-copy-info">复制</button>`;
    } else if (dialog.kind === "previous") {
      body = "<p>恢复覆盖前的内容，当前版本将成为可恢复的上一版本。文件 ID 和访问链接保持不变。</p>";
    } else if (dialog.kind === "preview") {
      body = dialog.type === "text/plain" ? `<pre class="space-text-preview">${esc(dialog.text)}</pre>` : dialog.type === "application/pdf" ? `<embed class="space-preview" type="application/pdf" src="${previewURL}" title="PDF 预览">` : `<img class="space-preview" src="${previewURL}" alt="${esc(dialog.title)}">`;
    } else if (dialog.kind === "move") {
      body = `<p class="muted">从 ${esc(dialog.sourceName || workspaces?.current().name || "我的空间")} ${dialog.copy ? "复制" : "移动"} ${dialog.items.length} 项到 ${esc(workspaces?.spaces().find(s=>s.id===dialog.space)?.name || "我的空间")}。${dialog.space && dialog.space !== workspace && !dialog.copy ? "跨空间移动将撤销相关资源的旧授权。" : ""}</p>${workspaces ? `<div class="space-destination-spaces">${workspaces.spaces().filter(s=>!s.trashed).map(s=>`<button class="button small ${dialog.space===s.id?"primary":""}" data-action="space-move-space" data-id="${s.id}">${esc(s.name)}</button>`).join("")}</div>` : ""}<div class="space-breadcrumbs"><button class="text-button" data-action="space-move-folder" data-id="${workspaces?.spaces().find(s=>s.id===dialog.space)?.root || ""}">空间根目录</button>${dialog.crumbs.map(c => `<button class="text-button" data-action="space-move-folder" data-id="${c.id}">／ ${esc(c.name)}</button>`).join("")}</div><div class="space-folder-picker">${dialog.folders.map(f => `<button class="space-folder-choice" data-action="space-move-folder" data-id="${f.id}">▱ ${esc(f.name)}</button>`).join("") || '<p class="muted">此处没有子文件夹</p>'}</div>`;
    } else if (["mkdir", "rename"].includes(dialog.kind)) body = `<form id="space-form" data-form="space"><label for="space-name">名称</label><input id="space-name" name="name" value="${esc(dialog.name)}" data-editor-key="${dialog.kind}:${dialog.item?.id || "new"}" required maxlength="240" autocomplete="off"/><button type="submit" class="button primary">保存</button></form>`;
    else body = `<p>所选 ${dialog.items.length} 个项目将移入回收站，之后可以恢复。</p><ul class="space-selection-summary">${dialog.items.slice(0, 6).map(item => `<li>${esc(item.name)}</li>`).join("")}${dialog.items.length > 6 ? `<li>以及其他 ${dialog.items.length - 6} 项</li>` : ""}</ul>`;
    return `<section class="market-confirmation" role="dialog" aria-modal="true" aria-labelledby="space-dialog-title"><div class="market-confirm-card space-dialog"><h2 id="space-dialog-title">${esc(dialog.title)}</h2>${body}<p data-space-dialog-error class="inline-error" role="alert" ${dialog.error ? "" : "hidden"}>${esc(dialog.error || "")}</p><div class="market-actions"><button class="button" data-action="space-dialog-close" ${dialog.saving ? "disabled" : ""}>${dialog.kind === "preview" ? "关闭" : "取消"}</button>${["move", "trash", "previous"].includes(dialog.kind) ? `<button class="button primary" data-action="space-dialog-confirm" ${dialog.saving ? "disabled" : ""}>${dialog.saving ? "正在处理…" : dialog.kind === "move" ? dialog.copy ? "复制到这里" : "移到这里" : dialog.kind === "previous" ? "恢复上一版" : "移入回收站"}</button>` : ""}</div></div></section>`;
  }
  // Keep the editing subtree attached: refocusing a replaced node breaks IME.
  const mountedEditors = new WeakSet();
  function mounted() {
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
    if (!host?.canLaunchApplications) return `<section class="empty-state space-connect"><h3>连接盒子，访问自己的文件</h3><p>${host?.connectionPhase === "recovering" ? "正在恢复与盒子的连接。" : "连接盒子后，即可像使用硬盘一样管理文件。"}</p>${lastSeen ? `<p class="muted">${esc(lastSeen.name)} · 上次更新 ${new Date(lastSeen.at * 1000).toLocaleString()}，当前状态待重新确认。</p>` : ""}<button class="button" data-action="show-boxes">前往盒子管理</button></section>`;
    const items = visibleItems(), selected = selectedItems();
    const upper = listing.breadcrumbs.length > 1 ? listing.breadcrumbs.at(-2).id : rootFolder();
    const sortOptions = Object.entries({ name: "名称", size: "大小", type: "种类", modified: "修改时间" }).map(([key, label]) => `<option value="${key}" ${sortBy === key ? "selected" : ""}>${label}</option>`).join("");
    return `<div class="space-workspace" ${dialog || workspaces?.blocked() ? "inert" : ""}><div class="space-browser"><aside class="space-sidebar" aria-label="文件空间导航"><div class="space-disk-identity">${icon("drive")}<span><strong title="${esc(boxName())}">${esc(boxName())}</strong><small><i class="status-dot ready"></i>盒子硬盘</small></span></div>${workspaces ? workspaces.sidebar() : `<div class="space-sidebar-caption">位置</div><button class="space-nav ${!trash ? "active" : ""}" data-action="space-folder" data-id="" ${!trash && !parent ? 'aria-current="page"' : ""}>${icon("folder")}全部文件</button><button class="space-nav ${trash ? "active" : ""}" data-action="space-recycle" ${trash ? 'aria-current="page"' : ""}>${icon("trash")}回收站</button>`}<div class="space-sidebar-bottom">${storage()}</div></aside><main class="space-main">
      <div class="space-toolbar" aria-busy="${batchBusy}" ${batchBusy ? "inert" : ""}><div class="space-row-actions">${workspaces?.navigation() || ""}<button class="space-icon-button" data-action="space-folder" data-id="${upper}" aria-label="返回上级文件夹" title="返回上级文件夹" ${parent === rootFolder() || trash ? "disabled" : ""}>${icon("up")}</button><button class="space-icon-button" data-action="space-refresh" aria-label="刷新文件" title="刷新" ${loading ? "disabled" : ""}>${icon("refresh")}</button><span class="space-toolbar-title">${trash ? "回收站" : parent !== rootFolder() ? esc(listing.breadcrumbs.at(-1)?.name || "文件夹") : esc(workspaces?.current().name || "全部文件")}</span></div><div class="space-row-actions"><button class="button small" data-action="space-links">Agent 访问链接</button>${selected.length ? `<span class="space-selected-count">已选 ${selected.length} 项</span>${trash ? '<button class="button small" data-action="space-batch-restore">恢复</button>' : '<button class="button small" data-action="space-batch-download">下载</button><button class="button small" data-action="space-batch-move">移动</button><button class="button small danger-text" data-action="space-batch-trash">删除</button>'}<button class="text-button space-clear-selection" data-action="space-selection-clear">取消选择</button>` : !trash && status.phase !== "unsupported" ? '<button class="button small" data-action="space-mkdir">新建文件夹</button><button class="button small primary space-upload-button" data-action="space-upload">' + icon("upload") + '上传文件</button>' : ""}</div></div>
      <div class="space-pathbar"><div class="space-breadcrumbs" aria-label="当前位置"><button class="text-button" data-action="space-folder" data-id="${rootFolder()}" data-space="${workspace}">${icon("drive")}${esc(workspaces?.current().name || "全部文件")}</button>${!trash ? breadcrumbsView() : '<span>›</span><strong>回收站</strong>'}</div><div class="space-view-tools"><label class="space-sort"><span>排列</span><select id="space-sort" aria-label="排列方式">${sortOptions}</select></label><button class="space-icon-button space-sort-direction ${sortDirection === -1 ? "is-descending" : ""}" data-action="space-sort" data-sort="${sortBy}" aria-label="${sortDirection === 1 ? "改为降序排列" : "改为升序排列"}" title="${sortDirection === 1 ? "升序排列" : "降序排列"}">${icon("up")}</button><label class="space-search">${icon("search")}<input type="search" id="space-search" value="${esc(query)}" placeholder="搜索当前文件夹" aria-label="搜索当前文件夹"></label></div></div>
      ${error ? `<div class="notice error" role="status">${esc(error)} <button class="text-button" data-action="space-refresh">重试</button></div>` : ""}
      ${status.phase === "unsupported" ? '<section class="empty-state space-connect"><h3>文件空间需要新版盒端服务</h3><p>升级后这里会显示你的个人文件。</p></section>' : `<section class="space-files" aria-label="${trash ? "回收站" : "文件图标"}">${trash ? '<p class="space-trash-hint">文件可恢复；彻底删除后无法找回。恢复空间不会恢复接入授权。</p>' + (workspaces?.recycled() || "") : ""}
      <div class="space-file-list" role="listbox" aria-multiselectable="true" aria-label="${trash ? "回收站文件图标" : "当前文件夹图标"}" tabindex="0" data-location="${parent}:${trash}" aria-busy="${loading}">${items.map(item => `<article class="space-file-row ${selectedIds.has(item.id) ? "is-selected" : ""}" role="option" aria-selected="${selectedIds.has(item.id)}" tabindex="${selectedId === item.id ? "0" : "-1"}" draggable="false" data-entry-id="${item.id}" data-action="space-select" data-id="${item.id}" aria-label="${esc(item.name)}，${esc(fileType(item))}" title="${esc(item.name)}&#10;${esc(fileType(item))}${item.kind === "folder" ? "" : ` · ${size(item.size)}`}&#10;修改于 ${new Date(item.modified * 1000).toLocaleString()}"><span class="space-file-name">${fileIcon(item)}<strong>${esc(item.name)}</strong></span><span class="space-file-detail">${item.kind === "folder" ? "文件夹" : size(item.size)}</span><button class="space-icon-button space-file-more" data-action="space-more" data-id="${item.id}" aria-label="${esc(item.name)}的更多操作" title="更多操作">${icon("more")}</button></article>`).join("") || `<div class="space-empty">${icon(trash ? "trash" : "folder")}<strong>${loading ? "正在读取文件…" : query ? "没有找到匹配文件" : trash ? "回收站为空" : "此文件夹为空"}</strong><p>${loading ? "请稍候" : query ? "试试其他名称" : trash ? "这里没有已删除的文件" : "拖入本地文件，或右键新建文件夹"}</p></div>`}</div></section>`}
      <footer class="space-statusbar"><span class="space-status-count">${query ? `${items.length} / ` : ""}${listing.items.length} 个项目${selected.length ? ` · 已选 ${selected.length} 项${selected.length === 1 ? `：${esc(selected[0].name)}` : ""}` : ""}${batchBusy ? " · 正在处理…" : ""}</span><span class="space-status-hint">${trash ? "右键恢复或彻底删除" : "拖动框选 · ⌘ / Ctrl 多选 · 右键管理"}</span><button class="text-button" data-action="space-transfers-toggle">传输${(status.tasks || []).some(t => !["complete", "canceled"].includes(t.phase)) ? " · 进行中" : ""}</button></footer>${transfersOpen ? transfers() : ""}
      <div class="space-drop-overlay" aria-hidden="true">${icon("cloud")}<strong>松开上传到当前文件夹</strong><span>${esc(parent ? listing.breadcrumbs.at(-1)?.name || "当前文件夹" : "全部文件")} · 文件保存在盒子上</span></div></main></div></div>${menuView()}${dialogView()}${workspaces?.dialogView() || ""}`;
  }
  async function moveFolder(target) {
    const current = dialog;
    const result = await call("list", { parent: target, ...(workspaces ? {space_id: current.space || workspace} : {}) });
    if (dialog !== current) return;
    dialog.parent = target; dialog.crumbs = result.breadcrumbs; dialog.folders = result.items.filter(i => i.kind === "folder" && !dialog.items.some(item => item.id === i.id)); render();
  }
  async function mutateItems(method, items, destination) {
    const epoch = revision, failed = [];
    batchBusy = true; render();
    try {
      for (const item of items) {
        if (epoch !== revision) throw new Error("SPACE_CONTEXT_CHANGED");
        try { if (method === "move" && typeof destination === "object") await call("links-file-transfer", {id:item.id,parent:destination.parent,space_id:destination.space,copy:destination.copy}); else await call(method, { id: item.id, ...(method === "move" ? { parent: destination, name: item.name } : {}) }); }
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
  async function submit() {
    const current = dialog;
    if (!current || current.saving || composing) return;
    current.saving = true; render();
    try {
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
    if (dialog && !["dialog-close", "dialog-confirm", "move-folder", "move-space", "link-save", "link-copy", "link-revoke", "link-config", "link-copy-info", "link-audit"].includes(kind)) return;
    try {
      if (kind === "pin" && item) { await workspaces.pin(item); contextMenu = null; render(); return; }
      if (kind === "grant" && item) { contextMenu = null; await workspaces.grant(item); return; }
      if (kind === "link-create" && item) { dialog = { kind, title: "创建 Agent 访问链接", item, days: 0 }; render(); return; }
      if (kind === "previous" && item) { dialog = { kind, title: "恢复上一版本", item }; render(); return; }
      if (kind === "links") { dialog = { kind: "links", title: "Agent 访问链接", links: await call("links-list") }; render(); return; }
      if (kind === "link-save") {
        const current = dialog;
        if (current.saving) return;
        current.saving = true;
        try {
          await call("links-create", { root: current.item.id, expires: current.days ? Date.now() / 1000 + current.days * 86400 : null });
          if (dialog === current) dialog = { kind: "links", title: "Agent 访问链接", links: await call("links-list") };
        } finally { current.saving = false; render(); }
        return;
      }
      if (kind === "link-revoke") { await call("links-revoke", { id: button.dataset.id }); dialog.links = await call("links-list"); render(); return; }
      if (kind === "link-copy") { await navigator.clipboard.writeText(dialog.links.find(l => l.id === button.dataset.id).url); button.textContent = "已复制"; return; }
      if (kind === "link-config") { dialog = { kind: "link-info", title: "MCP 接入配置", text: JSON.stringify(await call("links-config"), null, 2) }; render(); return; }
      if (kind === "link-audit") { dialog = { kind: "link-info", title: "最近操作记录（Agent 名称为自行声明）", text: JSON.stringify(await call("links-audit", { id: button.dataset.id }), null, 2) }; render(); return; }
      if (kind === "link-copy-info") { await navigator.clipboard.writeText(dialog.text); button.textContent = "已复制"; return; }
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
      if (kind === "rename" && item) dialog = { kind, title: "重命名", item, name: item.name };
      if ((kind === "trash" && item) || kind === "batch-trash") {
        const items = kind === "trash" ? [item] : selectedItems();
        if (items.length) dialog = { kind: "trash", title: items.length === 1 ? `删除“${items[0].name}”？` : `删除所选 ${items.length} 个项目？`, items };
      }
      if ((["move", "copy"].includes(kind) && item) || ["batch-move", "batch-copy"].includes(kind)) {
        const items = ["move", "copy"].includes(kind) ? [item] : selectedItems();
        if (items.length) { dialog = { kind: "move", title: items.length === 1 ? `${kind.includes("copy") ? "复制" : "移动"}“${items[0].name}”` : `${kind.includes("copy") ? "复制" : "移动"}所选 ${items.length} 个项目`, items, copy: kind.includes("copy"), space: workspace, sourceName: workspaces?.current().name || "我的空间", parent: rootFolder(), crumbs: [], folders: [] }; await moveFolder(rootFolder()); }
      }
      if (kind === "upload") { transfersOpen = true; await call("uploads", { parent }); }
      if (kind === "download" && item) await downloadItems([item]);
      if (kind === "transfer") await call("transfer", { id: button.dataset.id, action: button.dataset.command });
      if (["restore", "purge"].includes(kind) && item) { await call(kind, { id: item.id }); await load(); }
      if (kind === "preview" && item) await openItem(item);
      render();
      if (["mkdir", "rename"].includes(kind)) { const input = document.querySelector("#space-name"); input?.focus(); if (kind === "rename") input?.select?.(); }
    } catch (cause) { error = message(cause); render(); }
  });
  const root = document.querySelector("#app");
  root.addEventListener("change", event => {
    if (event.target.id === "space-link-expiry" && dialog) { dialog.days = Number(event.target.value); return; }
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
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    transfersOpen = true; error = null; render();
    try {
      const result = await window.wanxClient.uploadDroppedFiles(files, { parent: uploadParent });
      if (epoch === revision && !result.ok) error = message(result.code);
    } catch (cause) { if (epoch === revision) error = message(cause); }
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
  window.wanxClient.onSpaceContentChanged?.(() => { if (dialog || workspaces?.blocked()) { pendingRefresh = true; return; } if (active && !loading && !dialog && !moving && !marquee) void load(); });
  window.wanxClient.onSpaceState?.(next => {
    if (!host?.canLaunchApplications) return;
    if (next.accountId !== host.account?.accountId || next.boxId !== host.activeDeviceId) {
      revision++; workspaces?.reset(null); workspace="personal"; stopMarquee(); clearDrag(); clearSelection(); batchBusy = false; contextMenu = null; query = ""; listing = { items: [], breadcrumbs: [] }; status = { phase: "idle", tasks: [] }; closeDialog(); loading = false; render(); return;
    }
    const previous = status.tasks || [];
    if (next.tasks?.some(t => !["complete", "canceled"].includes(t.phase) && !previous.some(p => p.id === t.id))) transfersOpen = true;
    status = next;
    if (next.overview) lastSeen = { boxId: host.activeDeviceId, name: host.connection?.name || host.devices?.find(d => d.deviceId === host.activeDeviceId)?.name || "盒子", at: next.overview.collectedAt };
    if (active) {
      render();
      if (next.tasks?.some(t => t.phase === "complete" && previous.find(p => p.id === t.id)?.phase !== "complete")) void load();
    }
  });
  setInterval(() => { if (active && !document.hidden && host?.canLaunchApplications && !loading && !dialog && !moving && !movePointer && !marquee) void load(); }, 15000);
  workspaces?.bind({call, render:()=>render(), message, error:value=>{error=value;render();}, reload:()=>load(), navigate});
  window.wanxSpace = { view, hostState, retainEditor, mounted, overview: () => status.overview, bind(options) { render = options.render; }, isSelecting: () => Boolean(marquee), isDragging: () => Boolean(movePointer || moving), activate(value, visible = value) { if (fileView !== visible) { stopMarquee(); clearDrag(); contextMenu = null; } fileView = visible; if (active === value) return; active = value; if (active) void load(); else { closeDialog(); clearDrag(); } } };
})();

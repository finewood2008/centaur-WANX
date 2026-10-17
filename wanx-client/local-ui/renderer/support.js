// Cloud-only Owner approval. Closing this view never silently revokes or grants
// permission; device cleanup and cloud authorization remain separate facts.
window.createSupportView = function ({ request, changed, now = Date.now }) {
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const date = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
  let identity = null, devices = [], device = null, current = null, loaded = false, pending = false, error = "", notice = "", confirmation = null;
  let generation = 0, visible = false, timer;
  const owner = row => (row?.deviceRole || row?.role) === "owner";
  const epoch = row => row?.ownershipEpoch;
  function clear() { generation++; clearTimeout(timer); device = null; current = null; loaded = false; pending = false; error = ""; notice = ""; confirmation = null; }
  function message(value) {
    const code = String(value?.code || value?.message || "");
    if (/OWNER_REQUIRED|OWNER_CHANGED|ACCOUNT_ACCESS_DENIED/.test(code)) return "只有当前盒主可以处理此请求；请刷新盒子列表确认所有权。";
    if (/ACCOUNT_LOGIN_REQUIRED|ACCOUNT_SESSION|SUPPORT_SESSION_CHANGED/.test(code)) return "登录状态已变化，请重新打开远程协助。";
    if (/REQUEST_CHANGED|REQUEST_EXPIRED|DIGEST_MISMATCH|DECISION_CONFLICT|REQUEST_NOT_FOUND/.test(code)) return "支持请求已变化或过期，请刷新后重新确认。";
    if (/DEVICE_DISABLED|DEVICE_NOT_FOUND/.test(code)) return "此盒子目前不可处理支持请求，请联系管理员。";
    if (/INVALID_RESPONSE/.test(code)) return "返回结果无法确认，请刷新原请求核对状态。";
    return "暂时无法确认远程协助状态，请检查电脑联网后刷新。";
  }
  function schedule() {
    clearTimeout(timer);
    if (!visible || !device || !loaded || pending || confirmation || error) return;
    timer = setTimeout(() => { void refresh(); }, 5000); timer?.unref?.();
  }
  function accept(result) {
    if (!result || result.deviceId !== device.deviceId || !Number.isSafeInteger(result.ownershipEpoch) || result.ownershipEpoch < 1 ||
        (epoch(device) !== undefined && result.ownershipEpoch !== epoch(device)) ||
        (result.request !== null && (!result.request || result.request.registryDeviceId !== device.deviceId || result.request.ownershipEpoch !== result.ownershipEpoch))) throw new Error("SUPPORT_INVALID_RESPONSE");
    // The network directory has no ownership epoch. Establish it from the
    // independently verified cloud receipt, never from the selected P2P box.
    device.ownershipEpoch = result.ownershipEpoch;
    current = result.request; loaded = true;
  }
  async function refresh() {
    if (!identity || !device || pending || confirmation) return;
    const g = generation; pending = true; error = ""; changed();
    try { const result = await request("support.current", { deviceId: device.deviceId }); if (g === generation) accept(result); }
    catch (e) { if (g === generation) { loaded = false; error = message(e); } }
    finally { if (g === generation) { pending = false; changed(); schedule(); } }
  }
  const pendingRequest = () => loaded && current?.decision === "pending" && Date.parse(current.requestExpiresAt) > now();
  const active = () => loaded && current?.authorization === "active";
  async function submit() {
    if (pending || !confirmation || !current) return;
    const decision = confirmation, g = generation, reviewed = current;
    if (decision === "revoke" ? !active() : !pendingRequest()) { confirmation = null; error = "支持请求已变化或过期，请刷新后重新确认。"; changed(); return; }
    confirmation = null; pending = true; error = ""; notice = ""; clearTimeout(timer); changed();
    const input = { deviceId: device.deviceId, ownershipEpoch: epoch(device), requestId: reviewed.requestId, requestDigest: reviewed.requestDigest, confirmed: true };
    try {
      const result = await request(decision === "revoke" ? "support.revoke" : "support.decide", decision === "revoke"
        ? { ...input, supportSessionId: reviewed.supportSessionId } : { ...input, decision });
      if (g !== generation) return;
      accept(result);
      notice = decision === "approved" ? "已同意本次远程桌面协助。你可以随时撤销授权。" : decision === "rejected" ? "已拒绝本次请求。" : "本次授权已失效，设备是否结束会话以下方确认状态为准。";
    } catch (e) { if (g === generation) { loaded = false; error = `${message(e)} 操作结果待确认，请刷新原请求；不要重复批准。`; } }
    finally { if (g === generation) { pending = false; changed(); schedule(); } }
  }
  function observed() {
    const obs = current?.observation;
    return obs && obs.supportRevision === current.supportRevision &&
      (obs.requestId === current.requestId || obs.requestId === null) &&
      now() - Date.parse(obs.observedAt) <= 30000 && Date.parse(obs.observedAt) <= now() + 5000 ? obs : null;
  }
  function status() {
    if (!loaded) return "当前状态待确认";
    if (!current) return "当前没有支持请求";
    const obs = observed();
    if (obs?.desktop === "cleanup_failed") return "设备清理失败，请联系维护人员继续处理";
    if (obs?.desktop === "closed" && obs.connection === "disconnected") return "设备已确认桌面关闭、连接断开";
    if (["revoked", "expired"].includes(current.authorization)) return "授权已失效，等待设备确认会话结束";
    if (current.authorization === "active") return Date.parse(current.expiresAt) <= now()
      ? "授权时间已到，等待云端及设备确认结束" : obs?.connection === "connected" ? "远程桌面已连接（设备确认）" : "已授权，等待维护人员连接或设备确认";
    return ({ pending: pendingRequest() ? "等待你确认" : "请求时间已到，请刷新确认", approved: "审批结果待确认", rejected: "你已拒绝本次请求", expired: "请求已过期", cancelled: "请求已撤回" })[current.decision] || "当前状态待确认";
  }
  return {
    sync(key, rows) {
      devices = rows || [];
      if (identity !== key) { identity = key; clear(); }
      if (device && !devices.some(row => row.deviceId === device.deviceId && owner(row) && (epoch(row) === undefined || epoch(row) === epoch(device)))) clear();
    },
    visible(value) { if (visible === value) return; visible = value; if (!visible) clear(); else schedule(); },
    close: clear,
    async action(action, data = {}) {
      if (action === "support-open") {
        const next = devices.find(row => row.deviceId === data.deviceId && owner(row));
        if (!identity || !next || pending) return;
        clear(); device = { deviceId: next.deviceId, name: next.name || next.displayName || "万象盒子", ownershipEpoch: epoch(next) }; visible = true;
        await refresh(); return;
      }
      if (action === "support-close") { if (!pending) { clear(); changed(); } return; }
      if (action === "support-refresh") { notice = ""; await refresh(); return; }
      if (action === "support-confirm") { await submit(); return; }
      if (pending) return;
      if (action === "support-cancel") { confirmation = null; changed(); schedule(); return; }
      if (["support-approve", "support-reject"].includes(action) && pendingRequest()) confirmation = action === "support-approve" ? "approved" : "rejected";
      if (action === "support-revoke" && active()) confirmation = "revoke";
      if (confirmation) { clearTimeout(timer); changed(); }
    },
    render() {
      if (!device) return "";
      const row = current, disabled = pending ? "disabled" : "";
      const pair = (label, value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
      return `<section class="content-section support-panel" aria-label="远程协助"><div class="section-heading"><div><h3>${esc(device.name)} · 远程协助</h3><p class="muted">直接向云端查看请求，无需先连接盒子。只允许你明确批准的本次桌面协助。</p></div><button class="text-button" data-action="support-close" ${disabled}>收起</button></div>
        <p role="status">${esc(pending ? "正在向云端确认…" : status())}</p>${error ? `<p class="notice error" role="alert">${esc(error)}</p>` : ""}${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ""}
        ${row ? `<dl class="credits-fields">${pair("维护人员", row.operatorName)}${pair("操作账号", row.operatorId)}${pair("协助原因", row.reason)}${pair("许可范围", "查看并控制盒子桌面（VNC）")}${pair("授权时长", `${row.durationMinutes} 分钟，从批准时开始`)}${pair("请求有效至（北京时间）", date(row.requestExpiresAt))}${row.expiresAt ? pair("授权截止（北京时间）", date(row.expiresAt)) : ""}${pair("请求编号", row.requestId)}</dl>` : loaded ? '<p class="muted">维护人员发起请求后，可在这里查看。没有请求不代表旧会话已完成清理。</p>' : ""}
        ${confirmation ? `<div class="notice" role="group" aria-label="确认远程协助"><p>${confirmation === "approved" ? `确认允许 ${esc(row.operatorName)} 在 ${row.durationMinutes} 分钟内查看并操作这台盒子的桌面？桌面上的内容将对维护人员可见。` : confirmation === "rejected" ? "确认拒绝这次远程桌面请求？" : "确认撤销本次桌面授权？撤销后仍需等待设备报告会话和临时资源已清理。"}</p><button class="button primary" data-action="support-confirm" ${disabled}>${confirmation === "approved" ? "同意本次协助" : confirmation === "rejected" ? "确认拒绝" : "确认撤销授权"}</button><button class="text-button" data-action="support-cancel" ${disabled}>返回</button></div>` :
          `<div class="settings-actions"><button class="button small" data-action="support-refresh" ${disabled}>刷新状态</button>${pendingRequest() ? `<button class="button primary small" data-action="support-approve" ${disabled}>同意</button><button class="button small" data-action="support-reject" ${disabled}>拒绝</button>` : ""}${active() ? `<button class="button small" data-action="support-revoke" ${disabled}>撤销授权</button>` : ""}</div>`}
        <p class="muted">收起或关闭万象不会撤销已批准的授权；需要结束时请点击“撤销授权”。设备离线时，结束状态保持待确认。</p></section>`;
    },
  };
};

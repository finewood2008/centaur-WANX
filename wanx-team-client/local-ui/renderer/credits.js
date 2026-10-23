window.createCreditsView = function ({ request, changed }) {
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const number = value => Number(value).toLocaleString("zh-CN");
  const date = value => new Date(value * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const kinds = { paid_credited: "充值入账", gift_credited: "赠送入账", reserved: "额度预留", started: "任务开始", settled: "任务扣费", released: "额度释放", expired: "额度到期", gift_expired: "赠送到期", refunded: "积分退回" };
  const statuses = { reserved: "已预留", active: "执行中", settled: "已结算", released: "已释放", expired: "已到期" };
  const apps = { zhijun: "知君", "centaurai.wanx.zhijun": "知君", "super-advisory": "个人议事厅", "centaurai.wanx.superadvisors": "个人议事厅", "centaurai.wanx.dialogue": "众见", "centaurloop": "半人马环" };
  let tasks = [], tasksError = "";
  let identity = null, generation = 0, balance = null, items = [], cursor = 0, hasMore = false, loading = false, error = "", filter = "all", detail = null, detailLoading = false, detailError = "", detailSequence = 0;
  function message(e) {
    const raw = String(e?.code || e?.message || e || "");
    if (/CREDITS_IDENTITY/.test(raw)) return "万象账号验证未通过，请重新登录后查看积分。";
    if (/CREDITS_DISABLED/.test(raw)) return "积分服务尚未启用，暂时无法读取点数和明细。";
    if (/CREDITS_NOT_CONFIGURED/.test(raw)) return "积分服务尚未接通，接通后将在这里显示账号点数和明细。";
    if (/CREDITS_NOT_CONNECTED/.test(raw)) return "暂时无法连接账号的积分服务，请恢复连接后刷新。";
    if (/ACCOUNT_LOGIN_REQUIRED|ACCOUNT_SESSION_CHANGED/.test(raw)) return "登录状态已变化，请重新登录后查看积分。";
    return "暂时无法读取积分，请稍后刷新重试。";
  }
  async function refresh(more = false) {
    if (!identity || loading) return;
    const g = generation; loading = true; error = "";
    if (!more) { balance = null; items = []; cursor = 0; hasMore = false; detail = null; detailSequence++; detailLoading = false; detailError = ""; }
    changed();
    try {
      const [b, result] = await Promise.all([request("credits.balance"), request("credits.transactions", { after: more ? cursor : 0 })]);
      if (g !== generation) return;
      if (!more) {
        try {
          const rows = await request("credits.tasks");
          if (g !== generation) return;
          tasks = Array.isArray(rows) ? rows : []; tasksError = "";
        } catch { if (g === generation) { tasks = []; tasksError = "任务用量暂时无法读取，余额和积分流水仍可正常查看。"; } }
      }
      if (g !== generation) return;
      balance = b; items = more ? [...items, ...result.items] : result.items; cursor = result.after; hasMore = result.hasMore;
    } catch (e) { if (g === generation) { error = message(e); balance = null; } }
    finally { if (g === generation) { loading = false; changed(); } }
  }
  async function showDetail(id) {
    const row = items.find(item => item.event_id === id);
    if (!row) return;
    const g = generation, d = ++detailSequence;
    detail = { event: row }; detailError = ""; detailLoading = Boolean(row.reservation_id); changed();
    if (!row.reservation_id) return;
    try { const task = await request("credits.reservation", { id: row.reservation_id }); if (g === generation && d === detailSequence) detail.task = task; }
    catch { if (g === generation && d === detailSequence) detailError = "任务详情暂时无法读取，流水记录仍然有效。"; }
    finally { if (g === generation && d === detailSequence) { detailLoading = false; changed(); } }
  }
  const delta = row => row.kind === "settled" ? `−${number(Math.max(0, -row.available_delta - row.held_delta - row.expired_amount))} 点`
    : row.kind === "reserved" ? `预留 ${number(row.held_delta)} 点`
    : row.kind === "started" ? "不扣费"
    : row.kind === "refunded" ? `退回 ${number(row.available_delta + row.expired_amount)} 点`
    : `${row.available_delta > 0 ? "+" : ""}${number(row.available_delta)} 点可用`;
  const pair = (label, value) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
  function taskView() {
    const state = { completed: "已完成", cancelled: "已停止", failed: "技术失败 · 不扣费", pending: "用量待核对", expired: "已释放", active: "执行中", quoted: "待授权", authorized: "已授权", paused: "已暂停" };
    return `<section class="content-section" aria-label="任务用量"><h3>任务用量 · 试运行</h3><p class="muted">当前只记录用量并计算预计消耗，不扣除真实积分。1,000 点对应基础充值价值 1 元；实际充值暂未开放。</p>${tasksError ? `<p role="status">${esc(tasksError)}</p>` : ""}${tasks.length ? tasks.map(t => `<details class="credits-detail"><summary>${esc(apps[t.application_id] || t.application_id)} · ${date(t.created_at)} · ${t.pending_calls ? "待核对" : number(t.simulated_points) + " 点预计消耗"}</summary><dl class="credits-fields">${pair("任务编号", t.id)}${pair("档位", t.tier === "deep" ? "深度" : "标准")}${pair("状态", state[t.status] || t.status)}${pair("真实扣费", "0 点")}${pair("预计消耗", t.pending_calls ? "用量待核对" : number(t.simulated_points) + " 点")}</dl></details>`).join("") : `<p class="muted">还没有关联到此万象账号的任务记录。</p>`}</section>`;
  }
  function detailView() {
    if (!detail) return "";
    const { event: row, task } = detail;
    return `<section class="credits-detail" aria-label="积分明细"><div class="section-heading"><h3>流水详情</h3><button class="text-button" data-action="credits-close">收起详情</button></div><dl class="credits-fields">${pair("类型", kinds[row.kind] || "积分变动")}${pair("发生时间（北京时间）", date(row.created_at))}${pair("应用", apps[row.application_id] || row.application_id || "万象平台")}${pair("点数变化", delta(row))}${pair("可用点数变化", row.available_delta)}${pair("预留点数变化", row.held_delta)}${row.expired_amount ? pair("其中到期失效", row.expired_amount + " 点") : ""}${pair("说明 / 来源", row.reference || "—")}${pair("流水编号", row.event_id)}</dl>${detailLoading ? '<p class="activity-status" role="status"><span class="activity-spinner" aria-hidden="true"></span>正在读取任务详情…</p>' : ""}${detailError ? `<p role="status">${esc(detailError)}</p><button class="text-button" data-action="credits-detail" data-event-id="${esc(row.event_id)}">重试详情</button>` : ""}${task ? `<h4>对应任务 · 当前状态</h4><dl class="credits-fields">${pair("任务说明", task.description)}${pair("状态", statuses[task.status] || task.status)}${pair("累计扣费", number(task.charged) + " 点")}${pair("累计退回", number(task.refunded) + " 点")}${pair("任务编号", task.task_id)}${pair("预留截止（北京时间）", date(task.expires_at))}</dl>` : ""}</section>`;
  }
  return {
    reset(key) { if (identity === key) return false; identity = key; tasks = []; tasksError = ""; generation++; balance = null; items = []; cursor = 0; hasMore = false; loading = false; error = ""; detail = null; detailLoading = false; detailError = ""; filter = "all"; detailSequence++; return true; },
    refresh,
    label() { return balance ? `${number(balance.available)} 点` : loading ? "读取中…" : "暂不可用"; },
    async action(action, dataset) {
      if (action === "credits-refresh") return refresh();
      if (action === "credits-more" && hasMore) return refresh(true);
      if (action === "credits-filter") { filter = dataset.filter === "spent" ? "spent" : "all"; changed(); }
      if (action === "credits-detail") return showDetail(dataset.eventId);
      if (action === "credits-close") { detail = null; detailSequence++; changed(); }
    },
    render() {
      const visible = items.filter(row => filter !== "spent" || row.kind === "settled");
      return `<div class="page-content credits-page"><button class="text-button" data-action="show-applications">‹ 返回应用</button><div class="page-heading"><div><h2>积分</h2><p class="muted">万象账号统一管理，各应用按任务结算。</p></div><button class="button small ${loading ? "activity-button" : ""}" data-action="credits-refresh" aria-busy="${loading}" ${loading ? "disabled" : ""}>${loading ? '<span class="activity-spinner" aria-hidden="true"></span>正在刷新…' : "刷新"}</button></div>
      <section class="credits-overview" aria-label="积分余额"><div><p class="eyebrow">可用积分</p><div class="credits-total">${balance ? number(balance.available) : "—"}<span>点</span></div><p class="muted">${balance ? "可用于应用中的付费任务" : "暂未获得余额信息"}</p></div><div class="credits-recharge"><button class="button" disabled>充值 · 暂未开放</button><p class="muted">充值功能开放后可在这里使用</p></div><div class="credits-breakdown">${[["充值积分", balance?.paid_available], ["赠送积分", balance?.gift_available]].map(([label, value]) => `<div><span>${label}</span><strong>${value == null ? "—" : number(value)}<small> 点</small></strong></div>`).join("")}</div></section>
      ${error ? `<div class="notice" role="status">${esc(error)}${items.length ? " 下方保留上次读取的记录，请刷新后确认最新状态。" : ""}</div>` : ""}
      <section class="content-section" aria-label="积分记录"><div class="section-heading"><h3>积分记录</h3><div class="credits-filters" aria-label="记录筛选"><button data-action="credits-filter" data-filter="all" aria-pressed="${filter === "all"}">全部记录</button><button data-action="credits-filter" data-filter="spent" aria-pressed="${filter === "spent"}">消耗明细</button></div></div><p class="muted">按发生时间顺序展示 · 北京时间${hasMore ? " · 后面还有记录，可继续加载" : ""}</p>
      ${visible.length ? `<div class="credits-records">${visible.map(row => `<button class="credits-record" data-action="credits-detail" data-event-id="${esc(row.event_id)}"><span><strong>${esc(kinds[row.kind] || "积分变动")}</strong><small>${esc(apps[row.application_id] || row.application_id || "万象平台")} · ${date(row.created_at)}</small></span><span class="credits-change ${row.kind === "settled" ? "spent" : ""}">${esc(delta(row))}<small>查看详情 ›</small></span></button>`).join("")}</div>` : `<div class="empty-state"><h3>${loading ? "正在读取积分记录…" : error ? "明细暂不可用" : filter === "spent" ? "当前已加载记录中没有消耗" : "还没有积分记录"}</h3><p>${error ? "服务恢复后，可在这里查看点数变化与任务详情。" : "真实发生的入账、预留、扣费和退回都会记录在这里。"}</p></div>`}
      ${hasMore ? `<button class="button credits-more ${loading ? "activity-button" : ""}" data-action="credits-more" aria-busy="${loading}" ${loading ? "disabled" : ""}>${loading ? '<span class="activity-spinner" aria-hidden="true"></span>正在加载…' : "加载后续记录"}</button>` : ""}</section>${taskView()}${detailView()}</div>`;
    },
  };
};

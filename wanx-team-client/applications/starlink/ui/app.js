import { createSkillsUI } from "./native-skills.js";
import { icon, icons } from "./icons.js";
import { selectGraph, layoutGraph, edgeGeometry } from "./graph.js";
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bridge = window.semantica;
const typeInfo = {
  PERSON: ["人物", "人", "var(--blue)"],
  ORG: ["组织", "组", "var(--sage)"],
  GPE: ["地点", "地", "var(--sage)"],
  EVENT: ["事件", "事", "var(--blue)"],
  CONCEPT: ["概念", "知", "var(--rose)"],
  DOCUMENT: ["材料", "文", "var(--sage)"],
  PRODUCT: ["产品", "品", "var(--ochre)"],
  FEATURE: ["功能", "功", "var(--ochre)"],
  TECHNOLOGY: ["技术", "技", "var(--rose)"],
  DATE: ["日期", "日", "var(--blue)"],
};
const relationNames = {
  PREFERS: "情境偏好",
  FOUNDED: "创办",
  CREATED: "创建",
  PART_OF: "属于",
  HAS_FEATURE: "具有功能",
  USES: "使用",
  OCCURRED_AT: "发生于",
  WORKS_AT: "任职于",
  LOCATED_IN: "位于",
};
const messages = {
  SKILL_ID_CONFLICT:"当前数据仓已存在同名 Skill，不会覆盖；请修改 ZIP 名称标识或先下载后删除旧版本。",
  SKILL_TOO_LARGE:"Skill ZIP 不能超过 4 MiB，解压文本最多 8 MiB。",
  SKILL_INVALID_REQUEST:"文件或请求格式不正确，请检查 SKILL.md 和确认名称。",
  SKILL_PACKAGE_PATH:"ZIP 含不安全路径或重复文件，请检查后重试。",
  SKILL_NOT_FOUND:"方法已删除或不属于当前数据仓，请刷新。",
  SKILL_REVISION_CONFLICT:"方法版本已变化，请重新读取后操作。",
  SKILL_REFERENCED:"还有方法依赖此 Skill，请先处理依赖或明确允许它们失效。",
  REASONING_DELIVERY_STALE:"方法、材料或检测规则已变化，请重新准备后试读。",
  REASONING_SCOPE_REQUIRED:"请勾选当前仓的资料后重新准备。",
  REASONING_SCOPE_CHANGED:"方法或材料版本已变化，请重新准备。",
  REASONING_PREPARATION_NOT_FOUND:"准备记录已失效或不属于当前账号、数据仓，请重新准备。",
  MODEL_SHARED_REQUIRED: "知识抽取与脱敏检测共用同一个模型，请刷新后统一设置。",
  MODEL_CLOUD_CONFIRMATION_REQUIRED: "请先确认所选在线服务将接收未经脱敏的正文片段。",
  MODEL_CONFIG_CONFLICT: "模型设置已更新，请刷新后重新确认。",
  MODEL_CHECK_REQUIRED: "模型检查已过期，请重新检查后保存。",
  MODEL_RELAY_UNAVAILABLE: "万象模型服务暂时无法连接，请检查连接后重试。",
  MODEL_AUTH_REQUIRED: "模型授权已失效，请重新连接万象。",
  MODEL_UNAVAILABLE: "模型已停用或删除，请在万象检查模型配置。",
  MODEL_CONFIG_CHANGED: "模型服务配置已变化，请重新检查并确认。",
  MODEL_INVALID_OUTPUT: "模型未返回符合要求的 JSON，请换模型或重试。",
  MODEL_CALL_FAILED: "模型检查或调用失败，请检查万象模型连接与输出能力。",
  MODEL_CANCELLED: "模型调用已取消。",
  MODEL_INPUT_TOO_LARGE: "本次模型输入超限，请缩小材料片段后重试。",
  SPACE_UPGRADE_REQUIRED: "当前设备尚不支持万象空间，请更新万象服务，或从电脑选择文件。",
  SPACE_REQUEST_FAILED: "万象空间暂时无法读取，请检查连接并刷新，或从电脑选择文件。",
  SPACE_REMOTE_FILE_CHANGED: "万象空间文件已变化，请移除后重新选择。",
  SPACE_NOT_FOUND: "万象空间文件已删除或移入回收站，请刷新后重新选择。",
  SPACE_ENTRY_NOT_FOUND: "万象空间文件已删除或移入回收站，请刷新后重新选择。",
  SPACE_NOT_FILE: "此项目不是可导入的文件，请进入文件夹选择具体文件。",
  SPACE_EMPTY_FILE: "空文件不能导入。",
  SPACE_CHUNK_INVALID: "万象空间文件校验未通过，请刷新后重试。",
  SPACE_CONNECTION_TIMEOUT: "读取万象空间超时，请检查连接后重试。",
  WANX_HOST_REQUIRED: "请从万象的应用商店打开星图，复用当前账号和盒子连接。",
  HOST_SESSION_EXPIRED: "万象连接已失效。请回到万象连接盒子后重新打开本应用。",
  SEMANTICA_UPGRADE_REQUIRED: "当前盒子尚未接入星图，请更新盒端服务。",
  SEMANTICA_NOT_CONFIGURED: "盒端尚未配置星图服务。",
  SEMANTICA_CONNECTION_FAILED: "当前连接不可用，请检查万象与盒子的连接后重试。",
  WAREHOUSE_BUSY: "当前数据仓正在迁移或清理，可切换其他仓，或到数据管理查看进度。",
  NETWORK_NOT_READY:
    "万象正在恢复网络连接。已提交的任务仍由盒端处理，请稍后刷新。",
  SEMANTICA_SERVICE_UNAVAILABLE: "知识服务暂时不可用，请稍后刷新。",
  SEMANTICA_SERVICE_AUTH_FAILED: "盒端知识服务的授权配置需要检查。",
  SEMANTICA_VERSION_CONFLICT: "材料或设置已更新，请重新读取当前版本后再提交。",
  SEMANTICA_FILE_TOO_LARGE: "文件超过当前服务允许的大小。",
  SEMANTICA_FORMAT_NOT_SUPPORTED: "当前服务不支持该文件格式。",
  SEMANTICA_LOCAL_FILE_CHANGED: "文件在导入期间发生了变化，请重新选择文件。",
  SEMANTICA_RESOURCE_NOT_FOUND: "材料或来源已失效，请刷新当前页面。",
  SEMANTICA_RESOURCE_FORBIDDEN: "当前账号无权访问该材料或来源。",
  SEMANTICA_FILE_SELECTION_EXPIRED: "文件选择已失效，请重新选择。",
  SEMANTICA_DOWNLOAD_HASH_MISMATCH: "下载校验未通过，未保存该文件。",
};
const state = {
  ready: false,
  warehouses: [],
  warehouseId: null,
  generation: 0,
  runtime: null,
  keys: [],
  transfer: null,
  migrating: false,
  clearIntent: null,
  invalid: false,
  view: "graph",
  documents: [],
  documentTotal: 0,
  documentOffset: 0,
  jobs: [],
  jobTotal: 0,
  jobOffset: 0,
  graph: { nodes: [], edges: [] },
  retrieval: null,
  policy: null,
  selectedNode: null,
  selectedEdge: null,
  type: "all",
  mode: "graph",
  graphOverview: true,
  zoom: 1,
  pan: { x: 0, y: 0 },
  files: [],
  uploading: false,
  importSource: "space",
  space: { parent: "", breadcrumbs: [], items: [] },
  spaceLoading: false,
  spaceSelecting: false,
  spaceError: null,
  spaceRequest: 0,
  refreshing: false,
  source: null,
  sourceEvidence: null,
  editing: false,
  saving: false,
  graphError: null,
};
let toastTimer,
  refreshAt = 0;
function errorText(error) {
  return (
    messages[error.code || error.message] ||
    error.publicMessage ||
    "操作未完成，请检查任务状态或稍后重试。"
  );
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function banner(message) {
  $("#connection-notice").innerHTML = message
    ? `<span>${esc(message)}</span>${
        !state.invalid
          ? '<button class="text-link" data-action="reconnect">重新读取</button>'
          : ""
      }`
    : "";
  $("#connection-notice").hidden = !message;
}
async function call(action, input) {
  if (
    state.preview &&
    [
      "import-skill", "delete-skill", "download-skill", "reasoning",
      "check-models", "save-models", "reprocess-models",
      "select-files",
      "select-space-files",
      "upload",
      "download",
      "save-sensitive",
      "correct",
      "retry-job",
      "build-index",
      "create-warehouse",
      "create-key",
      "revoke-key",
      "prepare-clear",
      "clear-warehouse",
      "prepare-delete",
      "delete-warehouse",
      "export-warehouse",
      "select-migration",
      "import-migration",
    ].includes(action)
  )
    throw Object.assign(new Error("READ_ONLY_PREVIEW"), {
      publicMessage: "这是实际数据的只读效果预览，请从万象打开星图进行操作。",
    });
  if (state.invalid)
    throw Object.assign(new Error("HOST_SESSION_EXPIRED"), {
      code: "HOST_SESSION_EXPIRED",
    });
  if (!bridge)
    throw Object.assign(new Error("WANX_HOST_REQUIRED"), {
      code: "WANX_HOST_REQUIRED",
    });
  const generation = state.generation;
  const result = await bridge.call(action, {
    ...input,
    warehouseId: state.warehouseId,
  });
  if (state.invalid)
    throw Object.assign(new Error("HOST_SESSION_EXPIRED"), {
      code: "HOST_SESSION_EXPIRED",
    });
  if (generation !== state.generation)
    throw Object.assign(new Error("WAREHOUSE_CHANGED"), {
      code: "WAREHOUSE_CHANGED",
    });
  return result;
}
function syncControls() {
  document
    .querySelectorAll('[data-action="import"]')
    .forEach(
      (b) =>
        (b.disabled =
          !state.ready ||
          !state.warehouseId ||
          currentWarehouse()?.state !== "active"),
    );
  $("#confirm-import").disabled =
    !state.ready || state.uploading || state.spaceSelecting || !state.files.some((f) => !f.done);
  $("#choose-files").disabled = !state.ready || state.uploading || state.spaceSelecting;
  document.querySelectorAll("#source-space,#source-computer,#space-refresh,#space-query,#space-entries input,#space-entries button,#space-breadcrumbs button,[data-remove-file]").forEach(el => {
    el.disabled = !state.ready || state.uploading || state.spaceSelecting || el.dataset.unsupported === "true";
  });
  document
    .querySelectorAll("#import-dialog [data-close]")
    .forEach((b) => (b.disabled = state.uploading || state.spaceSelecting));
  $("#search-form button[type=submit]").disabled = !state.ready;
  document
    .querySelectorAll("[data-setting]")
    .forEach(
      (b) => (b.disabled = !state.ready || !state.policy || state.saving),
    );
}
function connection(ready) {
  state.ready = ready;
  $("#connection-label").textContent = ready
    ? "已连接盒子"
    : state.invalid
    ? "连接已失效"
    : "等待连接";
  $("#connection-title").textContent = ready
    ? "万象连接已就绪"
    : state.invalid
    ? "请从万象重新打开"
    : "等待万象连接";
  $("#connection-dot").style.background = ready
    ? "var(--sage)"
    : "var(--ochre)";
  $("#connection-description").textContent = ready
    ? "当前知识空间属于此万象账号，材料与任务保存在盒端。"
    : "复用万象账号与盒子连接，无需在应用内再次登录。";
  if (state.preview) {
    $("#connection-label").textContent = "只读效果预览";
    $("#connection-title").textContent = "真实数据快照";
    $("#connection-description").textContent =
      "使用已验证的合成资料查看新版 UI；实际操作请从万象打开。";
  }
  syncControls();
}
function invalidate() {
  if (state.invalid) return;
  state.invalid = true;
  state.generation++;
  skillsUi.reset();
  if (bridge) void bridge.call("select-warehouse", {}).catch(()=>{});
  state.warehouses = [];
  $("#warehouse-query").value = "";
  $("#warehouse-picker-query").value = "";
  state.warehouseId = null;
  state.runtime = null;
  state.processing = null; state.modelConfig = null; state.modelCatalog = []; state.modelRequest = (state.modelRequest || 0) + 1;
  state.keys = [];
  state.transfer = null;
  $("#new-key-secret").replaceChildren();
  $("#access-keys").replaceChildren();
  state.documents = []; state.selectedDocuments = new Map();
  state.jobs = [];
  state.graph = { nodes: [], edges: [] };
  state.documentTotal = state.jobTotal = 0;
  state.documentOffset = state.jobOffset = 0;
  state.files = [];
  state.spaceRequest++;
  state.space = { parent: "", breadcrumbs: [], items: [] };
  state.spaceLoading = false;
  state.spaceError = null;
  state.source = null;
  state.selectedNode = state.selectedEdge = null;
  state.policy = null;
  state.retrieval = null;
  state.identity = null;
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("#source-body").replaceChildren();
  $("#source-actions").replaceChildren();
  $("#search-query").value = "";
  $("#search-results").replaceChildren();
  $("#user-avatar").textContent = "我";
  connection(false);
  renderDocuments();
  renderTasks();
  renderGraph();
  renderPending();
  renderWarehouses();
  banner(messages.HOST_SESSION_EXPIRED);
}
function bytes(value) {
  const n = Number(value);
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MiB";
  return (n / 1073741824).toFixed(1) + " GiB";
}
const date = (value) => {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d)
    : "—";
};
function locator(value) {
  let v = value || {};
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "来源片段";
    }
  }
  if (v.page != null)
    return (
      "第 " +
      v.page +
      " 页" +
      (v.paragraph ? " · 第 " + v.paragraph + " 段" : "")
    );
  if (v.start_seconds != null || v.start != null) {
    const fmt = (n) =>
      Math.floor(Number(n) / 60)
        .toString()
        .padStart(2, "0") +
      ":" +
      Math.floor(Number(n) % 60)
        .toString()
        .padStart(2, "0");
    return (
      fmt(v.start_seconds ?? v.start) +
      " – " +
      fmt(v.end_seconds ?? v.end ?? v.start_seconds ?? v.start)
    );
  }
  if (v.line_start)
    return (
      "第 " +
      v.line_start +
      " 行" +
      (v.line_end && v.line_end !== v.line_start
        ? " – " + v.line_end + " 行"
        : "")
    );
  if (v.paragraph || v.paragraph_index != null)
    return "第 " + (v.paragraph || Number(v.paragraph_index) + 1) + " 段";
  return "来源片段";
}
function highlight(value, names) {
  let text = String(value || ""),
    parts = [{ text, hit: false }];
  for (const name of [...new Set(names.filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  )) {
    const next = [];
    for (const p of parts) {
      if (p.hit) {
        next.push(p);
        continue;
      }
      const chunks = p.text.split(name);
      chunks.forEach((chunk, i) => {
        if (i) next.push({ text: name, hit: true });
        if (chunk) next.push({ text: chunk, hit: false });
      });
    }
    parts = next;
  }
  return parts
    .map((p) => (p.hit ? "<mark>" + esc(p.text) + "</mark>" : esc(p.text)))
    .join("");
}
const node = (id) => state.graph.nodes.find((n) => n.id === id),
  edge = (id) => state.graph.edges.find((e) => e.id === id),
  doc = (id) => state.documents.find((d) => d.id === id);
function graphLayout(raw) {
  const nodes = (raw.nodes || []).map(n => ({
    ...n,
    id: String(n.entity_id || n.id),
    name: String(n.canonical_name || n.name || "未命名实体"),
    type: typeInfo[n.entity_type] ? n.entity_type : "CONCEPT",
  }));
  const ids = new Set(nodes.map(n => n.id));
  const edges = (raw.edges || []).map(e => ({
    ...e,
    id: String(e.fact_id || e.id),
    s: String(e.subject_entity_id),
    t: String(e.object_entity_id),
    label: relationNames[e.relation_type] || e.relation_type,
    evidence: e.evidence || [],
  })).filter(e => ids.has(e.s) && ids.has(e.t));
  return { nodes, edges };
}
let graphViewCache;
function visibleGraph() {
  const options = {query: $("#graph-query").value, type: state.type, overview: state.graphOverview, focus: state.selectedNode};
  const key = JSON.stringify(options);
  if (graphViewCache?.graph !== state.graph || graphViewCache?.key !== key)
    graphViewCache = {graph:state.graph, key, value:layoutGraph(selectGraph(state.graph, options))};
  return graphViewCache.value;
}
function renderFilters() {
  const ts = [...new Set(state.graph.nodes.map((n) => n.type))];
  $("#graph-filters").innerHTML =
    `<button class="filter-chip ${
      state.type === "all" ? "active" : ""
    }" data-type="all">全部</button>` +
    ts
      .map(
        (t) =>
          `<button class="filter-chip ${
            state.type === t ? "active" : ""
          }" data-type="${t}"><span class="type-dot" style="--type-color:${
            typeInfo[t][2]
          }"></span>${typeInfo[t][0]}</button>`,
      )
      .join("");
}
function transformScene() {
  $("#graph-scene").setAttribute(
    "transform",
    `translate(${400 + state.pan.x} ${270 + state.pan.y}) scale(${
      state.zoom
    }) translate(-400 -270)`,
  );
  $("#zoom-label").textContent = Math.round(state.zoom * 100) + "%";
}
function fact(e) {
  return `${esc(node(e.s)?.name)}<span class="fact-relation">→ ${esc(
    e.label,
  )} →</span>${esc(node(e.t)?.name)}`;
}
function renderGraph() {
  let g = visibleGraph();
  if (state.selectedNode && !g.nodes.some((n) => n.id === state.selectedNode)) {
    state.selectedNode = null;
    state.selectedEdge = null;
    g = visibleGraph();
  }
  if (state.selectedEdge && !g.edges.some((e) => e.id === state.selectedEdge))
    state.selectedEdge = null;
  $("#graph-empty").hidden = g.nodes.length > 0;
  $("#graph-empty").textContent = state.graphError
    ? errorText(state.graphError)
    : state.graph.nodes.length
    ? "没有找到匹配的实体"
    : state.ready
    ? state.warehouseId
      ? "这个仓的知识图谱，从第一份资料开始。导入后，处理模型会提取实体与关系。"
      : "建立你的第一个数据仓，让资料开始相连。点击“数据仓”开始。"
    : "连接后显示当前账号的知识图谱。";
  $("#nodes-total").textContent = g.nodes.length;
  $("#edges-total").textContent = g.edges.length;
  $("#network-count").textContent = state.graph.nodes.length;
  $("#source-count").textContent = new Set(
    g.edges.flatMap((e) => e.evidence.map((v) => v.document_id)),
  ).size;
  $("#view-graph").classList.toggle("has-knowledge", state.graph.nodes.length > 0);
  $("#graph-scope-summary").textContent = state.selectedNode
    ? `${node(state.selectedNode)?.name} · 直接关联`
    : $("#graph-query").value.trim() ? "搜索结果与直接关联" : state.graphOverview ? "知识概览" : "全部实体";
  $("#graph-focus-back").hidden = !state.selectedNode;
  $("#graph-reference-note").hidden = !g.referenceCount || !state.graphOverview || Boolean($("#graph-query").value.trim());
  $("#graph-reference-count").textContent = g.referenceCount;
  document.querySelectorAll("[data-graph-density]").forEach(b => {
    const active = (b.dataset.graphDensity === "overview") === state.graphOverview;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  const positions = new Map(g.nodes.map(n => [n.id,n]));
  const groups = new Map();
  for (const e of g.edges) {
    const key = JSON.stringify([e.s,e.t].sort());
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.id);
  }
  $("#graph-scene").innerHTML = g.edges.map(e => {
    const a = positions.get(e.s), b = positions.get(e.t);
    const group = groups.get(JSON.stringify([e.s,e.t].sort()));
    const path = edgeGeometry(a,b,group.indexOf(e.id),group.length);
    const chosen = e.id === state.selectedEdge;
    const connected = state.selectedNode && (e.s === state.selectedNode || e.t === state.selectedNode);
    const labeled = chosen || connected || g.edges.length <= 12;
    return `<g class="graph-link ${connected ? "connected" : ""} ${chosen ? "chosen" : ""}"><title>${esc(node(e.s)?.name)} → ${esc(e.label)} → ${esc(node(e.t)?.name)}</title><path class="graph-edge-hit" d="${path.d}" data-edge="${esc(e.id)}"/><path class="graph-edge ${chosen ? "selected" : ""}" d="${path.d}" data-edge="${esc(e.id)}" marker-end="url(#${chosen ? "arrow-selected" : "arrow"})"/>${labeled ? `<text class="graph-edge-label" transform="translate(${path.x} ${path.y}) rotate(${path.angle})" text-anchor="middle" y="-7">${esc(e.label)}</text>` : ""}</g>`;
  }).join("") + g.nodes.map(n => {
    const selected = n.id === state.selectedNode;
    const match = $("#graph-query").value.trim() && n.name.toLocaleLowerCase().includes($("#graph-query").value.trim().toLocaleLowerCase());
    return `<g class="graph-node ${selected ? "selected" : ""} ${match ? "search-match" : ""}" data-node="${esc(n.id)}" transform="translate(${n.x} ${n.y})" style="--type-color:${typeInfo[n.type][2]}" role="button" tabindex="0" aria-label="${esc(n.name)}，${typeInfo[n.type][0]}，点击聚焦关联"><title>${esc(n.name)} · ${typeInfo[n.type][0]}</title><circle class="halo" r="${n.r+8}"/><circle class="core" r="${n.r}"/><text class="node-symbol" dy="5">${typeInfo[n.type][1]}</text><text class="node-name" y="${n.r+20}">${n.lines.map((line,i) => `<tspan x="0" dy="${i ? 15 : 0}">${esc(line)}</tspan>`).join("")}</text></g>`;
  }).join("");
  transformScene();
  $(
    "#relation-list",
  ).innerHTML = `<table class="relation-table"><thead><tr><th>主体</th><th>关系</th><th>客体</th><th>来源</th></tr></thead><tbody>${g.edges
    .map(
      (e) =>
        `<tr data-edge="${esc(
          e.id,
        )}" tabindex="0" role="button" aria-label="${esc(
          node(e.s)?.name + e.label + node(e.t)?.name,
        )}" class="${e.id === state.selectedEdge ? "selected" : ""}"><td>${esc(
          node(e.s)?.name,
        )}</td><td>${esc(e.label)} →</td><td>${esc(node(e.t)?.name)}</td><td>${
          e.evidence.length
        } 个片段</td></tr>`,
    )
    .join("")}</tbody></table>${
    !g.edges.length ? '<div class="empty">当前没有可显示的关系</div>' : ""
  }`;
  renderDetails(g);
}
function renderDetails(g) {
  const n = node(state.selectedNode),
    e = edge(state.selectedEdge),
    related = g.edges.filter((v) => !n || v.s === n.id || v.t === n.id);
  if (!n && !e) {
    const starts = g.nodes.filter(v => v.degree > 0).slice(0, 5);
    $("#graph-details").innerHTML = `<div class="detail-top"><div class="type-line"><span>探索知识</span><span>从关系出发</span></div><h2>从一个实体开始</h2><p>点击实体，只展开它的直接关联；再点一条关系，核对原始材料。</p></div><div class="detail-section"><div class="section-caption"><span>探索起点</span><span class="muted">按关联数量</span></div>${starts.map(v => `<button class="fact-btn" data-node="${esc(v.id)}"><span class="fact-text">${esc(v.name)}<small>${typeInfo[v.type][0]} · ${v.degree} 条直接关联</small></span>${icon("chevron")}</button>`).join("") || '<p class="detail-empty">导入材料后，在这里探索实体之间的联系。</p>'}</div><div class="detail-section"><p class="detail-empty">全图先看结构，局部再看关系。随时使用“返回全图”继续探索。</p></div>`;
    return;
  }
  $(
    "#graph-details",
  ).innerHTML = `<div class="detail-top"><div class="type-line"><span>${
    n ? typeInfo[n.type][0] : "知识图谱"
  }</span><span>${n ? "实体详情" : "选择实体或关系"}</span></div><h2>${
    n ? esc(n.name) : "从一个节点开始"
  }</h2><p>${
    n
      ? "正在聚焦这个实体的直接关联。点击关系核对来源，或返回全图继续探索。"
      : "材料中的明确陈述形成知识关系，点击图中节点进行探索。"
  }</p></div><div class="detail-section"><div class="section-caption"><span>相关关系</span><span class="muted mono">${
    related.length
  } 条</span></div>${
    related
      .map(
        (r) =>
          `<button class="fact-btn ${
            r.id === state.selectedEdge ? "selected" : ""
          }" data-edge="${esc(r.id)}"><span class="fact-text">${fact(
            r,
          )}<small>${r.evidence.length} 个来源片段</small></span>${icon(
            "chevron",
          )}</button>`,
      )
      .join("") ||
    '<p class="detail-empty">导入材料并完成知识处理后，显示相关关系。</p>'
  }</div><div class="detail-section"><div class="section-caption"><span>关系来源</span><span class="muted">${
    e ? e.evidence.length + " 个片段" : "尚未选择"
  }</span></div>${
    e
      ? e.evidence
          .map(
            (v, i) =>
              `<div class="source-card"><div class="source-title">${icon(
                "file",
              )}<span>${esc(
                doc(v.document_id)?.original_name || "来源材料",
              )}</span></div><p>${
                v.excerpt
                  ? highlight(v.excerpt, [node(e.s)?.name, node(e.t)?.name])
                  : "来源正在完成保护检测，请稍后刷新。"
              }</p><div class="source-bottom"><span>${esc(
                locator(v.locator_json),
              )}</span><button class="text-link" data-source="${esc(
                v.document_id,
              )}" data-edge-source="${esc(
                e.id,
              )}" data-evidence-index="${i}">查看来源 ${icon(
                "external",
              )}</button></div></div>`,
          )
          .join("") +
        '<p class="detail-note">来源片段用于核对关系，片段数量不代表独立证明次数。</p>'
      : '<p class="detail-empty">点击关系或图中连线，查看来源位置与摘录。</p>'
  }</div>`;
}
function selectNode(id) {
  state.selectedNode = id;
  state.selectedEdge = null;
  $("#graph-query").value = "";
  renderGraph();
  fitGraph();
  transformScene();
  [...document.querySelectorAll("#graph-scene [data-node]")].find(el => el.dataset.node === id)?.focus({preventScroll:true});
}
function selectEdge(id) {
  const e = edge(id);
  if (!e) return;
  state.selectedEdge = id;
  const changed = ![e.s, e.t].includes(state.selectedNode);
  if (changed) state.selectedNode = e.s;
  renderGraph();
  if (changed) { fitGraph(); transformScene(); }
}
const skillsUi = createSkillsUI({call,state,esc,toast,errorText});
const pages = {
  skills: ["Skill 管理", "METHODS FOR YOUR KNOWLEDGE", "按数据仓保管推理方法，给其他 AI 应用可靠的分析路径。"],
  reasoning: ["推理与调用", "REASON WITH YOUR KNOWLEDGE", "开放方法和受保护的材料，由其他 AI 应用执行分析。"],
  models: ["模型与处理", "KNOW HOW YOUR KNOWLEDGE IS BUILT", "模型看得见，处理有记录。为每个数据仓选择合适的能力。"],
  warehouses: ["数据仓", "YOUR KNOWLEDGE SPACES", "按项目或主题安放资料，从这里进入每一座知识图谱。"],
  api: [
    "接口开放",
    "KNOWLEDGE FOR YOUR APPLICATIONS",
    "让其他应用在授权范围内，使用你建立的知识。",
  ],
  data: [
    "数据管理",
    "YOUR KNOWLEDGE, YOUR CONTROL",
    "保管资料、迁移知识，决定它们如何被使用。",
  ],
  graph: [
    "知识图谱",
    "A MAP OF WHAT YOU KNOW",
    "把你的资料，连成可追溯、可调用的知识。",
  ],
  materials: [
    "材料与校对",
    "YOUR SOURCE OF KNOWLEDGE",
    "把文字、图像和录音，整理成可追溯的知识。",
  ],
  search: [
    "证据检索",
    "EVERY FINDING HAS A SOURCE",
    "带着问题查找材料，让每一条信息都有出处。",
  ],
  tasks: [
    "任务中心",
    "FROM MATERIALS TO KNOWLEDGE",
    "逐步查看解析、检索索引与知识入图的处理结果。",
  ],
  sensitive: [
    "脱敏设置",
    "SHARE KNOWLEDGE WITH CARE",
    "为知识的使用与交付，设置清晰的边界。",
  ],
};
function setView(view) {
  if (!pages[view]) return;
  const previousView = state.view;
  state.view = view;
  document
    .querySelectorAll(".view")
    .forEach((el) => (el.hidden = el.id !== "view-" + view));
  document
    .querySelectorAll("[data-view]")
    .forEach((el) =>
      el.dataset.view === view
        ? el.setAttribute("aria-current", "page")
        : el.removeAttribute("aria-current"),
    );
  const [title, kicker, description] = pages[view];
  $("#page-title").textContent = title;
  $("#crumb-current").textContent = title;
  $("#page-kicker").textContent = kicker;
  $("#page-description").textContent = description;
  $("#page-secondary").hidden = view !== "graph";
  const directory = view === "warehouses";
  $("#warehouse-import-heading").hidden = !directory;
  $("#page-primary").dataset.action = directory ? "new-warehouse" : "import";
  $("#page-primary").innerHTML = icon("plus") + (directory ? "新建数据仓" : view === "skills" ? "导入 Skill ZIP" : "导入材料");
  $("#crumb-current").hidden = directory;
  $("#crumb-separator").hidden = directory;
  renderWarehouses();
  renderProcessingSummary();
  syncControls();
  $(".page-scroll").scrollTop = 0;
  $("#app").classList.remove("nav-open");
  if (view === "sensitive" && state.ready && state.warehouseId)
    void loadPolicy();
  if (view === "api" && state.warehouseId) void loadKeys();
  if (view === "data") renderManagement();
  if (view === "models") void loadModels();
  if (view === "skills") void skillsUi.load();
  if (view === "reasoning") void skillsUi.loadReason();
  if (view === "warehouses" || previousView === "warehouses") void refresh();
}
function renderDocuments() {
  const query = $("#document-query").value.trim().toLowerCase(),
    rows = state.documents.filter((d) =>
      d.original_name.toLowerCase().includes(query),
    );
  $("#documents-body").innerHTML =
    rows
      .map((d) => {
        const ready = d.status === "ready",
          failed = d.status === "failed" || d.job_status === "failed";
        return `<tr><td><div class="doc-name"><input type="checkbox" aria-label="选择 ${esc(d.original_name)} 重新处理" data-reprocess-document="${esc(d.id)}" ${ready ? "" : "disabled"} ${state.selectedDocuments?.has(d.id) ? "checked" : ""}><span class="file-symbol">${icon(
          ["wav", "mp3", "m4a", "flac"].includes(d.document_format)
            ? "audio"
            : "file",
        )}</span><div><strong>${esc(d.original_name)}</strong><small>${esc(
          String(d.document_format).toUpperCase(),
        )} · ${bytes(
          d.size_bytes,
        )}</small><span class="model-actual">${esc(actualModel(d.processing))}</span></div></div></td><td><span class="pill ${
          failed ? "error" : ready ? "green" : "amber"
        }">${
          failed
            ? "处理失败"
            : ready
            ? state.retrieval?.fresh
              ? "可检索"
              : "正文就绪"
            : "处理中"
        }</span></td><td class="optional mono muted">${
          d.segment_count ?? "—"
        }</td><td class="mobile-hide mono muted">${date(
          d.created_at,
        )}</td><td><button class="cell-action" data-source="${esc(
          d.id,
        )}">查看</button></td></tr>`;
      })
      .join("") ||
    '<tr><td colspan="5"><div class="empty">' +
      (query
        ? "没有找到匹配的材料"
        : state.ready
        ? "还没有材料，点击“导入材料”开始。"
        : "连接后显示当前账号的材料。") +
      "</div></td></tr>";
  $("#documents-label").textContent = state.documentTotal;
  $("#material-count").textContent = state.documentTotal;
  renderPager("documents", state.documentOffset, state.documentTotal);
}
const jobNames = {
  document_parse: "正文解析",
  knowledge_extract: "知识抽取",
  knowledge_publish: "知识入图",
  search_index: "检索索引",
  sensitive_scan: "交付检测",
  reasoning_detect: "推理内容检测",
  knowledge_retract: "撤回旧关系",
  document_delete: "材料清理",
};
const jobStates = {
  queued: "排队中",
  running: "处理中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
function renderTasks() {
  $("#tasks-body").innerHTML =
    state.jobs
      .map(
        (j) =>
          `<article class="task-row"><div class="task-mark" style="${
            j.status === "failed" ? "color:var(--accent)" : ""
          }">${icon(
            j.status === "succeeded"
              ? "check"
              : j.status === "failed"
              ? "info"
              : "activity",
          )}</div><div class="task-content"><strong>${esc(
            jobNames[j.kind] || "处理任务",
          )} · ${esc(
            j.document_name ||
              doc(j.document_id)?.original_name ||
              "当前知识空间",
          )}</strong><p>${esc(j.stage || "等待处理")}${
            j.total_units ? " · " + j.completed_units + "/" + j.total_units : ""
          }</p><p class="model-actual">${esc(actualModel(j.metrics?.processing, j.kind === "sensitive_scan" ? "sensitive" : "extraction"))}${j.metrics?.model_calls?.length ? " · 用量：" + esc(modelUsage(j.metrics.model_calls)) : ""}</p>${j.error_message ? `<p>${esc(j.error_message)}</p>` : ""}${
            j.knowledge_summary
              ? `<p>候选 ${
                  j.knowledge_summary.candidate_relations ??
                  j.knowledge_summary.total_candidates ??
                  0
                } · 入图 ${
                  j.knowledge_summary.published_relations ?? 0
                } 条关系</p>`
              : ""
          }</div><div class="task-end"><span class="pill ${
            j.status === "succeeded"
              ? "green"
              : j.status === "failed"
              ? "error"
              : "amber"
          }">${
            jobStates[j.status] || esc(j.status)
          }</span><span class="mono">${date(j.updated_at)}</span>${
            j.status === "failed"
              ? `<button class="text-link" data-retry="${esc(
                  j.id,
                )}">重试</button>`
              : ""
          }</div></article>`,
      )
      .join("") || '<div class="empty">当前没有处理任务。</div>';
  $("#jobs-label").textContent = state.jobTotal;
  renderPager("jobs", state.jobOffset, state.jobTotal);
  $("#task-count").textContent =
    state.jobs.filter((j) => ["running", "queued"].includes(j.status)).length ||
    state.jobTotal;
}

function renderPager(kind, offset, total) {
  const container = $("#" + kind + "-pager");
  container.hidden = total <= 100;
  container.innerHTML = `<button class="text-link" data-action="${kind}-previous" ${
    !state.ready || offset === 0 ? "disabled" : ""
  }>上一页</button><span class="muted mono">${
    Math.floor(offset / 100) + 1
  } / ${Math.max(
    1,
    Math.ceil(total / 100),
  )}</span><button class="text-link" data-action="${kind}-next" ${
    !state.ready || offset + 100 >= total ? "disabled" : ""
  }>下一页</button>`;
}
async function loadPolicy() {
  try {
    const p = await call("sensitive");
    if (state.invalid) return;
    state.policy = p;
    renderPolicy();
  } catch (e) {
    banner(errorText(e));
  }
}
function renderPolicy() {
  const p = state.policy;
  document
    .querySelectorAll("[data-setting]")
    .forEach((b) =>
      b.setAttribute(
        "aria-checked",
        String(
          Boolean(
            p?.[
              b.dataset.setting === "protection"
                ? "enabled"
                : "semantic_enabled"
            ],
          ),
        ),
      ),
    );
  $("#sensitive-rules").innerHTML = p
    ? `<div class="section-caption" style="margin-top:25px"><span>当前工作空间规则</span><span class="muted">${p.rules.length} 条</span></div>` +
      p.rules
        .map(
          (r) =>
            `<div class="rule-row"><span>${esc(
              r.name,
            )}</span><span class="pill">${
              r.enabled === false
                ? "已停用"
                : { mask: "自动脱敏", block: "阻止交付", confirm: "需要确认" }[
                    r.mode
                  ] || "按规则处理"
            }</span></div>`,
        )
        .join("") +
      `<p class="modal-warning">检测状态：${esc(
        {
          completed: "已完成",
          running: "检测中",
          queued: "排队中",
          pending: "待检测",
          failed: "失败",
          disabled: "未启用",
          index_required: "等待索引",
        }[p.scan?.status] ||
          p.scan?.status ||
          "等待处理",
      )}</p>`
    : '<p class="detail-empty">连接后读取当前工作空间的保护规则。</p>';
  syncControls();
}
async function saveSetting(button) {
  if (!state.policy || state.saving) return;
  state.saving = true;
  syncControls();
  const field =
      button.dataset.setting === "protection" ? "enabled" : "semantic_enabled",
    p = state.policy;
  try {
    state.policy = await call("save-sensitive", {
      operationId: crypto.randomUUID(),
      payload: {
        expected_revision: p.revision,
        enabled: p.enabled,
        semantic_enabled: p.semantic_enabled,
        rules: p.rules,
        [field]: !p[field],
      },
    });
    toast("保护设置已保存，检测状态以任务结果为准。");
  } catch (e) {
    banner(errorText(e));
    await loadPolicy();
  } finally {
    state.saving = false;
    renderPolicy();
  }
}
async function refresh() {
  if (!state.ready || state.refreshing) return;
  if (state.view === "warehouses" || !state.warehouseId) {
    state.refreshing = true;
    const generation = state.generation;
    try {
      const result = await call("warehouses");
      if (state.invalid || generation !== state.generation) return;
      state.warehouses = result.items;
      renderWarehouses();
      banner("");
    } catch (e) {
      if (!state.invalid && generation === state.generation) banner(errorText(e));
    } finally {
      if (generation === state.generation) {
        state.refreshing = false;
        refreshAt = Date.now();
        if (state.view !== "warehouses" && state.warehouseId) void refresh();
      }
    }
    return;
  }
  const generation = state.generation;
  state.refreshing = true;
  try {
    const [d, j, g, r, w] = await Promise.allSettled([
      call("documents", { offset: state.documentOffset }),
      call("jobs", { offset: state.jobOffset }),
      call("graph"),
      call("retrieval"),
      call("warehouses"),
    ]);
    if (state.invalid || generation !== state.generation) return;
    if (d.status === "fulfilled") {
      state.documents = d.value.items;
      state.documentTotal = d.value.total;
    }
    if (j.status === "fulfilled") {
      state.jobs = j.value.items;
      state.jobTotal = j.value.total;
    }
    if (g.status === "fulfilled") {
      const fingerprint = JSON.stringify(g.value);
      if (fingerprint !== state.graphFingerprint) {
        const first = !state.graphFingerprint;
        state.graph = graphLayout(g.value);
        state.graphFingerprint = fingerprint;
        if (first) fitGraph();
      }
      state.graphError = null;
    } else state.graphError = g.reason;
    if (r.status === "fulfilled") {
      state.retrieval = r.value;
      renderRetrieval();
    }
    if (w.status === "fulfilled") {
      state.warehouses = w.value.items;
      renderWarehouses();
    }
    const failed = [d, j, r, w].find((v) => v.status === "rejected");
    const directory = state.view === "warehouses";
    if (failed && !directory) banner(errorText(failed.reason));
    else if (!state.graphError) banner("");
    if (currentWarehouse()?.state !== "active") {
      state.documents = []; state.selectedDocuments = new Map();
      state.jobs = [];
      state.graph = { nodes: [], edges: [] };
      state.documentTotal = state.jobTotal = 0;
      state.graphFingerprint = null;
      state.source = null;
      state.policy = null;
      state.retrieval = null;
      state.graphError = {
        publicMessage: "数据仓正在迁移或清理，完成后可继续查看图谱。",
      };
      $("#source-dialog").close();
      $("#source-body").replaceChildren();
      $("#source-actions").replaceChildren();
      $("#search-results").replaceChildren();
      if (!directory) banner(currentWarehouse()?.state === "clear_failed"
        ? "当前数据仓清理未完成，请到数据管理查看；其他数据仓仍可正常使用。"
        : "数据仓正在迁移或清理，进度可在数据管理中查看。");
    }
    renderDocuments();
    renderTasks();
    renderFilters();
    renderGraph();
    renderManagement();
    syncControls();
  } finally {
    if (generation === state.generation) {
      state.refreshing = false;
      refreshAt = Date.now();
    }
  }
}
function renderRetrieval() {
  const r = state.retrieval;
  $("#search-index-state").innerHTML =
    r?.compatible && r?.fresh
      ? `${icon("check")} 检索索引已就绪 · 向量、关键词与有限知识邻域`
      : `${
          r?.active
            ? "材料或配置已更新，等待当前索引就绪。"
            : "材料解析完成后自动建立索引。"
        } <button class="text-link" data-action="build-index">更新索引</button>`;
}
async function initialize() {
  if (state.invalid) return;
  banner("正在读取万象连接与知识空间…");
  try {
    const v = await call("initialize");
    if (state.invalid) return;
    state.identity = v.identity;
    document.getElementById("team-app-grant").hidden = v.identity.dataScope !== "team";
    state.preview = v.identity.connection === "preview";
    state.retrieval = v.retrieval;
    state.warehouses = v.warehouses.items;
    state.runtime = v.runtime;
    void loadProcessingSummary();
    $("#user-avatar").textContent = v.identity.user.name.slice(0, 1);
    $("#user-avatar").title = v.identity.user.name;
    renderWarehouses();
    $("#import-formats").textContent =
      (v.capabilities.accepted_suffixes || [])
        .map((v) => v.toUpperCase())
        .join(" · ") +
      " / 单文件最大 " +
      bytes(v.capabilities.document_max_bytes);
    connection(true);
    banner("");
    renderRetrieval();
    const launchTarget=await call("launch-target");
    if(launchTarget)await applyTeamTarget(launchTarget);
    else await selectWarehouse(
      state.warehouseId || rememberedWarehouse() ||
        state.warehouses.find((w) => w.state === "active")?.id ||
        state.warehouses[0]?.id || null,
    );
    if (!state.warehouses.length) setView("warehouses");
    try {
      const transfers = await call("transfers");
      state.transfer = transfers.items[0] || null;
      renderTransfer();
    } catch (e) {
      if (state.invalid) return;
      toast("迁移记录读取失败：" + errorText(e));
    }
  } catch (e) {
    connection(false);
    banner(errorText(e));
  }
}
async function runSearch() {
  const generation = state.generation;
  const query = $("#search-query").value.trim();
  if (!query) return;
  const button = $("#search-form button[type=submit]");
  button.disabled = true;
  $("#search-results").innerHTML =
    '<div class="empty">正在检索当前版本的材料…</div>';
  try {
    const r = await call("search", { query });
    if (
      state.invalid ||
      generation !== state.generation ||
      currentWarehouse()?.state !== "active"
    )
      return;
    const items = r.items || [],
      channels = { vector: "向量", keyword: "关键词", graph: "知识关系" };
    $("#search-results").innerHTML =
      `<div class="results-summary"><span>找到 <b class="mono">${
        items.length
      }</b> 个相关片段</span><span class="muted small">当前材料版本</span></div>${
        r.sensitive?.withheld
          ? `<div class="inline-error">${r.sensitive.withheld} 条内容尚未完成保护检测，暂不交付。</div>`
          : ""
      }${r.message ? `<p class="modal-warning">${esc(r.message)}</p>` : ""}${
        r.graph_warning
          ? `<p class="modal-warning">${esc(r.graph_warning)}</p>`
          : ""
      }` +
      items
        .map(
          (v, i) =>
            `<article class="result-card"><div class="result-meta"><span>${String(
              i + 1,
            ).padStart(2, "0")} &nbsp; ${esc(
              v.original_name ||
                doc(v.document_id)?.original_name ||
                "来源材料",
            )}</span><span>${esc(locator(v.locator))}</span></div><h3>${esc(
              (v.matched_entities || []).join(" · ") || "来源摘录",
            )}</h3><p>${highlight(v.text, [
              query,
              ...(v.matched_entities || []),
            ])}</p><div class="result-footer"><div class="result-channels">${(
              v.channels || []
            )
              .map((c) => `<span class="pill">${esc(channels[c] || c)}</span>`)
              .join("")}</div><button class="text-link" data-source="${esc(
              v.document_id,
            )}">查看来源 ${icon("external")}</button></div></article>`,
        )
        .join("") +
      (!items.length
        ? '<div class="empty">没有找到符合当前版本与交付规则的证据。</div>'
        : "");
  } catch (e) {
    if (generation !== state.generation || state.invalid) return;
    $("#search-results").innerHTML =
      '<div class="empty">' + esc(errorText(e)) + "</div>";
  } finally {
    button.disabled = !state.ready;
  }
}
async function showSource(id, evidence = null) {
  const generation = state.generation;
  $("#source-title").textContent = doc(id)?.original_name || "材料来源";
  $("#source-body").innerHTML = '<div class="empty">正在读取来源…</div>';
  $("#source-actions").replaceChildren();
  $("#source-dialog").showModal();
  try {
    const d = await call("document", { id });
    if (
      state.invalid ||
      generation !== state.generation ||
      !$("#source-dialog").open
    )
      return;
    state.source = d;
    state.sourceEvidence = evidence;
    state.sourceTotal =
      d.document.segment_count ?? doc(id)?.segment_count ?? d.segments.length;
    state.editing = false;
    renderSource();
  } catch (e) {
    if (generation !== state.generation || state.invalid) return;
    $("#source-body").innerHTML =
      '<div class="empty">' + esc(errorText(e)) + "</div>";
  }
}
function renderSource() {
  const s = state.source;
  if (!s) return;
  const d = s.document,
    p = s.processing || {},
    total = state.sourceTotal,
    complete =
      s.segments.length >= total && !s.segments.some((x) => x.text_truncated);
  $("#source-title").textContent = d.original_name;
  const stats = `<div class="source-meta-line"><span class="pill ${
    p.text_ready ? "green" : ""
  }">${p.text_ready ? "正文就绪" : "正文处理中"}</span><span class="pill ${
    p.index_ready ? "green" : ""
  }">${p.index_ready ? "可检索" : "索引待就绪"}</span><span class="pill">${esc(
    {
      published: "知识图谱就绪",
      empty: "无有效关系",
      failed: "知识处理失败",
      pending: "知识处理中",
    }[p.graph_status] || "知识处理中",
  )}</span></div>`;
  $("#source-body").innerHTML =
    stats +
    `<p class="modal-intro">${esc(
      String(d.document_format).toUpperCase(),
    )} · ${bytes(d.size_bytes)} · ${
      s.version ? "正文版本 v" + s.version.version_number : "尚无正文版本"
    }</p>${
      state.sourceEvidence
        ? `<div class="source-card"><span class="small muted">${esc(
            locator(state.sourceEvidence.locator_json),
          )}</span><p>${esc(state.sourceEvidence.excerpt)}</p></div>`
        : ""
    }<p class="model-actual">实际知识处理：${esc(actualModel(d.processing))}</p><article class="source-page">${
      s.segments
        .map(
          (v) =>
            `<div class="source-segment"><label for="segment-${esc(
              v.id,
            )}">${esc(locator(v.source_locator))}</label>${
              state.editing
                ? `<textarea id="segment-${esc(v.id)}" data-segment="${esc(
                    v.id,
                  )}" aria-label="校对 ${esc(locator(v.source_locator))}">${esc(
                    v.text,
                  )}</textarea>`
                : `<p>${esc(v.text)}</p>`
            }</div>`,
        )
        .join("") || "<p>材料仍在处理中，正文将在解析后显示。</p>"
    }${
      s.segments.length < total
        ? '<button class="load-more-button" data-action="source-more">加载更多片段</button>'
        : ""
    }</article><p class="modal-warning">${
      state.editing
        ? "保存后生成新的校对版本，并重新处理索引和知识关系。"
        : "来源对应保留的材料版本，可保存原件进行核对。"
    }</p>`;
  $(
    "#source-actions",
  ).innerHTML = `<button class="btn btn-secondary" data-close="source-dialog">关闭</button><button class="btn btn-secondary" data-action="download-source">保存原件</button>${
    s.version && complete
      ? `<button class="btn btn-primary" data-action="${
          state.editing ? "save-correction" : "edit-source"
        }" ${state.saving ? "disabled" : ""}>${
          state.saving ? "正在保存…" : state.editing ? "保存校对" : "校对正文"
        }</button>`
      : ""
  }`;
}
async function sourceMore() {
  const s = state.source,
    version = s.version?.id;
  const page = await call("document", {
    id: s.document.id,
    offset: s.segments.length,
  });
  if (page.version?.id !== version) {
    toast("材料版本已变化，请重新打开来源。");
    return;
  }
  s.segments.push(...page.segments);
  if (!page.segments.length) state.sourceTotal = s.segments.length;
  renderSource();
}
async function saveCorrection() {
  if (state.saving) return;
  state.saving = true;
  const s = state.source;
  const segments = [...document.querySelectorAll("[data-segment]")].map(
    (el) => ({ id: el.dataset.segment, text: el.value }),
  );
  try {
    await call("correct", {
      id: s.document.id,
      versionId: s.version.id,
      operationId: crypto.randomUUID(),
      segments,
    });
    state.source = await call("document", { id: s.document.id });
    state.editing = false;
    state.sourceEvidence = null;
    toast("校对版本已保存，索引与知识关系正在更新。");
    await refresh();
  } catch (e) {
    toast(errorText(e));
  } finally {
    state.saving = false;
    renderSource();
  }
}
function renderImportSource() {
  const space = state.importSource === "space";
  $("#space-browser").hidden = !space;
  $("#computer-browser").hidden = space;
  for (const [id, selected] of [["#source-space", space], ["#source-computer", !space]]) {
    $(id).classList.toggle("active", selected);
    $(id).setAttribute("aria-pressed", String(selected));
  }
}
function renderSpace() {
  const query = $("#space-query").value.trim().toLocaleLowerCase();
  $("#space-breadcrumbs").innerHTML = [{ id: "", name: "万象空间" }, ...state.space.breadcrumbs.filter(b => b.id)]
    .map(b => `<button class="text-link" data-space-folder="${esc(b.id)}">${esc(b.name)}</button>`).join('<span aria-hidden="true">/</span>');
  const items = state.space.items.filter(e => e.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.name.localeCompare(b.name, "zh-CN"));
  $("#space-status").textContent = state.spaceLoading ? "正在读取万象空间…" : state.spaceError ? errorText(state.spaceError) : !items.length ? (query ? "当前文件夹没有匹配的文件。" : "此文件夹还没有文件，可先在万象空间上传，或从电脑选择。") : "";
  $("#space-entries").innerHTML = state.spaceLoading || state.spaceError ? "" : items.map(e => {
    if (e.kind === "folder") return `<button class="space-row space-folder" data-space-folder="${esc(e.id)}">${icon("folder")}<span>${esc(e.name)}</span><small>文件夹</small>${icon("chevron")}</button>`;
    const selected = state.files.some(f => f.spaceId === e.id);
    return `<label class="space-row ${e.problem ? "unsupported" : ""}"><input type="checkbox" data-space-file="${esc(e.id)}" data-unsupported="${Boolean(e.problem)}" ${selected ? "checked" : ""} ${e.problem ? "disabled" : ""} aria-label="选择 ${esc(e.name)}" /><span class="space-file-name">${esc(e.name)}${e.problem ? `<small>${esc(errorText({code:e.problem}))}</small>` : ""}</span><small>${esc(e.format.toUpperCase())} · ${bytes(e.size)}</small></label>`;
  }).join("");
  syncControls();
}
async function loadSpace(parent) {
  const request = ++state.spaceRequest;
  state.spaceLoading = true;
  state.spaceError = null;
  $("#space-query").value = "";
  renderSpace();
  try {
    const listing = await call("space-list", { parent });
    if (request !== state.spaceRequest) return;
    state.space = listing;
  } catch (error) {
    if (request !== state.spaceRequest || state.invalid) return;
    state.spaceError = error;
  } finally {
    if (request === state.spaceRequest) {
      state.spaceLoading = false;
      renderSpace();
    }
  }
}
async function removePending(handle) {
  if (state.uploading || state.spaceSelecting) return;
  await call("release-files", { handles: [handle] });
  state.files = state.files.filter(f => f.handle !== handle);
  renderPending();
  renderSpace();
}
$("#source-space").addEventListener("click", () => {
  state.importSource = "space";
  renderImportSource();
});
$("#source-computer").addEventListener("click", () => {
  state.importSource = "computer";
  renderImportSource();
});
$("#space-query").addEventListener("input", renderSpace);
$("#space-refresh").addEventListener("click", () => void loadSpace(state.space.parent));
$("#space-browser").addEventListener("click", event => {
  const button = event.target.closest("[data-space-folder]");
  if (button && !state.uploading && !state.spaceSelecting) void loadSpace(button.dataset.spaceFolder);
});
$("#space-entries").addEventListener("change", event => {
  const input = event.target.closest("[data-space-file]");
  if (!input || state.uploading || state.spaceSelecting) return;
  void (async () => {
    const entry = state.space.items.find(e => e.id === input.dataset.spaceFile);
    if (!entry || entry.problem) return;
    if (!input.checked) {
      const file = state.files.find(f => f.spaceId === entry.id);
      if (file) await removePending(file.handle);
      return;
    }
    state.spaceSelecting = true;
    syncControls();
    try {
      const files = await call("select-space-files", { entries: [{ id: entry.id, digest: entry.digest }] });
      for (const file of files) if (!state.files.some(f => f.handle === file.handle)) state.files.push(file);
    } finally {
      state.spaceSelecting = false;
      renderPending();
      renderSpace();
    }
  })().catch(error => toast(errorText(error)));
});
$("#file-list").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-file]");
  if (button) void removePending(button.dataset.removeFile).catch(error => toast(errorText(error)));
});
function renderPending() {
  $("#file-list").innerHTML = state.files
    .map(
      (f) =>
        `<div class="file-preview">${icon("file")}<span class="pending-name">${esc(
          f.name,
        )}<small>${f.source === "space" ? "万象空间" : "电脑文件"}</small></span><span class="file-meta mono">${bytes(
          f.size,
        )}</span><button class="text-link" data-remove-file="${esc(f.handle)}" aria-label="移除 ${esc(f.name)}">移除</button><span class="file-state">${
          f.done
            ? "已交给盒端处理"
            : f.error
            ? esc(errorText(f.error))
            : f.progress != null
            ? "正在导入 " + Math.floor(f.progress * 100) + "%"
            : "等待导入"
        }</span></div>`,
    )
    .join("");
  $("#confirm-import").textContent = state.uploading
    ? "正在导入…"
    : state.files.some((f) => f.error)
    ? "重试未完成的导入"
    : "导入并处理";
  $("#import-selection-count").textContent = `已选 ${state.files.length} 份材料`;
  syncControls();
}
async function uploadFiles() {
  if (state.uploading || state.spaceSelecting) return;
  state.uploading = true;
  renderPending();
  for (const f of state.files.filter((f) => !f.done)) {
    f.error = null;
    try {
      const r = await call("upload", { handle: f.handle });
      f.done = true;
      f.documentId = r.document?.id;
    } catch (e) {
      f.error = e;
      if (state.invalid) break;
    }
    renderPending();
  }
  state.uploading = false;
  if (state.invalid) return;
  renderPending();
  state.documentOffset = state.jobOffset = 0;
  await refresh();
  if (state.files.every((f) => f.done)) {
    $("#import-dialog").close();
    setView("graph");
    toast("材料已导入，正在按当前模型配置整理。可在任务中心查看进度。");
  }
}
function resetGraph() {
  state.type = "all";
  state.selectedNode = state.selectedEdge = null;
  $("#graph-query").value = "";
  fitGraph();
  renderFilters();
  renderGraph();
}
function fitGraph() {
  const ns = visibleGraph().nodes;
  if (!ns.length) {
    state.zoom = 1;
    state.pan = { x: 0, y: 0 };
    return;
  }
  const left = Math.min(...ns.map(n => n.x - Math.max(n.r+12,n.labelWidth/2) - 18)),
    right = Math.max(...ns.map(n => n.x + Math.max(n.r+12,n.labelWidth/2) + 18));
  const top = Math.min(...ns.map((n) => n.y - n.r - 24)),
    bottom = Math.max(...ns.map(n => n.y + n.r + 24 + n.lines.length*15));
  state.zoom = Math.max(
    0.1,
    Math.min(
      1.4,
      740 / Math.max(1, right - left),
      450 / Math.max(1, bottom - top),
    ),
  );
  state.pan = {
    x: -state.zoom * ((left + right) / 2 - 400),
    y: -state.zoom * ((top + bottom) / 2 - 270),
  };
}
async function action(name) {
  if (await warehouseAction(name)) return;
  if (name === "nav") $("#app").classList.toggle("nav-open");
  else if (name === "help") $("#help-dialog").showModal();
  else if (name === "import") {
    if (state.view === "skills") { $("#skill-import").click(); return; }
    if (state.files.every((f) => f.done)) {
      await call("release-files", { handles: state.files.map(f => f.handle) });
      state.files = [];
    }
    state.importSource = "space";
    $("#import-context").textContent = `万象空间 · ${state.identity?.boxName || state.identity?.boxId || "当前设备"} → ${currentWarehouse()?.name || "当前数据仓"}`;
    renderImportSource();
    renderPending();
    $("#import-dialog").showModal();
    void loadSpace("");
  } else if (name === "reconnect") await initialize();
  else if (name === "refresh") await refresh();
  else if (/^(documents|jobs)-(previous|next)$/.test(name)) {
    if (state.refreshing) return;
    const [kind, direction] = name.split("-");
    const field = kind === "documents" ? "documentOffset" : "jobOffset";
    state[field] = Math.max(
      0,
      state[field] + (direction === "next" ? 100 : -100),
    );
    await refresh();
  } else if (name === "reset-graph") resetGraph();
  else if (name === "fit") {
    fitGraph();
    transformScene();
  } else if (name === "zoom-in" || name === "zoom-out") {
    state.zoom = Math.max(
      0.1,
      Math.min(2.5, state.zoom + (name === "zoom-in" ? 0.15 : -0.15)),
    );
    transformScene();
  } else if (name === "edit-source") {
    state.editing = true;
    renderSource();
  } else if (name === "save-correction") await saveCorrection();
  else if (name === "source-more") await sourceMore();
  else if (name === "download-source") {
    const r = await call("download", { id: state.source.document.id });
    if (r.saved) toast("材料原件已保存。");
  } else if (name === "build-index") {
    await call("build-index", { operationId: crypto.randomUUID() });
    toast("索引任务已提交。");
    await refresh();
  }
}
document.addEventListener("click", (event) => {
  const el = event.target.closest("button,[data-node],[data-edge]");
  if (!el) return;
  void (async () => {
    if (el.dataset.warehouseId) {
      if (state.uploading || state.migrating) return;
      const nextView = el.dataset.warehouseView || state.view;
      if (el.dataset.warehouseId !== state.warehouseId) await selectWarehouse(el.dataset.warehouseId, nextView);
      else {
        $("#warehouse-picker").close();
        setView(nextView);
      }
    } else if (el.dataset.view) setView(el.dataset.view);
    else if (el.dataset.action) await action(el.dataset.action);
    else if (el.dataset.close) {
      if (el.dataset.close === "import-dialog" && (state.uploading || state.spaceSelecting)) return;
      $("#" + el.dataset.close).close();
    } else if (el.dataset.node) selectNode(el.dataset.node);
    else if (el.dataset.edge) selectEdge(el.dataset.edge);
    else if (el.dataset.source) {
      const e = edge(el.dataset.edgeSource);
      await showSource(
        el.dataset.source,
        e?.evidence[Number(el.dataset.evidenceIndex) || 0],
      );
    } else if (el.dataset.graphDensity) {
      state.graphOverview = el.dataset.graphDensity === "overview";
      resetGraph();
    } else if (el.dataset.type) {
      state.type = el.dataset.type;
      state.selectedNode = state.selectedEdge = null;
      renderFilters();
      renderGraph();
      fitGraph();
      transformScene();
    } else if (el.dataset.mode) {
      state.mode = el.dataset.mode;
      document.querySelectorAll("[data-mode]").forEach((b) => {
        b.classList.toggle("active", b.dataset.mode === state.mode);
        b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
      });
      $("#graph-space").hidden = state.mode !== "graph";
      $("#relation-list").hidden = state.mode !== "list";
    } else if (el.dataset.setting) await saveSetting(el);
    else if (el.dataset.retry) {
      await call("retry-job", {
        id: el.dataset.retry,
        operationId: crypto.randomUUID(),
      });
      toast("任务已安排重试。");
      await refresh();
    }
  })().catch((e) => toast(errorText(e)));
});
$("#choose-files").addEventListener(
  "click",
  () =>
    void (async () => {
      state.spaceSelecting = true;
      syncControls();
      try {
        const files = await call("select-files");
        for (const file of files) if (!state.files.some(f => f.handle === file.handle)) state.files.push(file);
      } finally {
        state.spaceSelecting = false;
        renderPending();
      }
    })().catch((e) => toast(errorText(e))),
);
$("#confirm-import").addEventListener("click", () => void uploadFiles());
$("#import-dialog").addEventListener("cancel", (event) => {
  if (state.uploading || state.spaceSelecting) event.preventDefault();
});
$("#graph-query").addEventListener("input", () => {
  state.selectedNode = state.selectedEdge = null;
  renderGraph();
  fitGraph();
  transformScene();
});
$("#document-query").addEventListener("input", renderDocuments);
$("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearch();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    setView("graph");
    $("#graph-query").focus();
  }
  if (event.key === "Escape") $("#app").classList.remove("nav-open");
  if (
    (event.key === "Enter" || event.key === " ") &&
    event.target.matches("[data-node],[data-edge]")
  ) {
    event.preventDefault();
    event.target.dataset.node
      ? selectNode(event.target.dataset.node)
      : selectEdge(event.target.dataset.edge);
  }
});
let drag;
const svg = $("#graph-svg");
svg.addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-node],[data-edge]")) return;
  drag = {
    startX: event.clientX,
    startY: event.clientY,
    x: state.pan.x,
    y: state.pan.y,
  };
  svg.setPointerCapture(event.pointerId);
});
svg.addEventListener("pointermove", (event) => {
  if (!drag) return;
  const rect = svg.getBoundingClientRect(),
    factor = Math.max(800 / rect.width, 540 / rect.height);
  state.pan = {
    x: drag.x + (event.clientX - drag.startX) * factor,
    y: drag.y + (event.clientY - drag.startY) * factor,
  };
  transformScene();
});
svg.addEventListener("pointerup", () => (drag = null));
svg.addEventListener("pointercancel", () => (drag = null));
bridge?.subscribe((event) => {
  if (event.type === "launch-target") {if(state.ready)void applyTeamTarget(event);return;}
  if (event.type === "invalidated") invalidate();
  else if (event.type === "upload") {
    const f = state.files.find((f) => f.handle === event.handle);
    if (f) {
      f.progress = event.size ? event.offset / event.size : 0;
      renderPending();
    }
  }
});
icons();
renderFilters();
renderGraph();
renderDocuments();
renderTasks();
renderPolicy();
connection(false);
renderWarehouses();
setView("graph");
void initialize();
setInterval(() => {
  if (!state.ready || state.invalid) return;
  if (
    state.transfer &&
    ["running", "uploading"].includes(state.transfer.state) &&
    !state.migrating
  )
    void refreshTransfer();
  const active =
    (state.warehouseId && currentWarehouse()?.state !== "active") ||
    state.warehouses.some((w) => ["clearing", "deleting", "importing"].includes(w.state)) ||
    state.jobs.some((j) => ["queued", "running"].includes(j.status));
  if (Date.now() - refreshAt > (active ? 3000 : 20000)) void refresh();
}, 1500);

function currentWarehouse() {
  return state.warehouses.find((w) => w.id === state.warehouseId);
}
function warehouseStatus(w) {
  const statuses = {clearing:"正在清理",clear_failed:"清理未完成",deleting:"正在删除",delete_failed:"删除未完成",importing:"正在迁入",import_failed:"迁入未完成"};
  return statuses[w.state] || (w.active_jobs ? `${w.active_jobs} 项处理中` : w.document_count ? "可进入" : "待导入资料");
}
function warehouseSelectionKey() {
  return state.identity && !state.preview ? "xingtu.warehouse." + JSON.stringify([state.identity.boxId, state.identity.user.id]) : null;
}
function rememberedWarehouse() {
  try {
    const key = warehouseSelectionKey();
    const id = key && localStorage.getItem(key);
    return state.warehouses.some(w => w.id === id) ? id : null;
  } catch { return null; }
}
function rememberWarehouse(id) {
  try {
    const key = warehouseSelectionKey();
    if (key && id) localStorage.setItem(key, id);
  } catch { /* Browsing remains available when local preferences cannot be saved. */ }
}
function renderWarehouseCollection(container, query, compact) {
  const needle = query.trim().toLocaleLowerCase();
  const ordered = [...state.warehouses].sort((a,b) => Number(b.id === state.warehouseId) - Number(a.id === state.warehouseId) || b.created_at.localeCompare(a.created_at));
  const existing = new Map([...container.children].map(el => [el.dataset.warehouseKey, el]));
  let visible = 0;
  const update = (card, field, value) => {
    const el = card.querySelector(`[data-field="${field}"]`);
    const text = String(value ?? "");
    if (el.textContent !== text) el.textContent = text;
  };
  ordered.forEach((w, index) => {
    let card = existing.get(w.id);
    if (!card) {
      card = document.createElement(compact ? "button" : "article");
      card.className = compact ? "warehouse-choice" : "warehouse-directory-card";
      card.dataset.warehouseKey = w.id;
      card.innerHTML = compact
        ? `<span class="warehouse-choice-icon">${icon("folder")}</span><span class="warehouse-choice-content"><span class="warehouse-choice-title"><strong data-field="name"></strong><span data-field="current" class="warehouse-current-indicator"></span></span><span data-field="description" class="warehouse-choice-description"></span><span class="warehouse-choice-meta"><span data-field="counts"></span><span data-field="status" class="warehouse-state"></span></span></span><span class="warehouse-choice-arrow">${icon("arrow")}</span>`
        : `<div class="warehouse-card-top"><span class="warehouse-card-icon">${icon("folder")}</span><span data-field="current" class="warehouse-current-indicator"></span><span data-field="status" class="warehouse-state"></span></div><h2 data-field="name"></h2><p data-field="description" class="warehouse-card-description"></p><dl class="warehouse-card-statistics"><div><dt>材料</dt><dd data-field="documents"></dd></div><div><dt>实体</dt><dd data-field="entities"></dd></div><div><dt>关系</dt><dd data-field="relations"></dd></div></dl><footer><span data-field="created" class="warehouse-card-date"></span><div><button class="text-link" data-warehouse-view="data">管理</button><button class="warehouse-card-open" data-warehouse-view="graph"><span data-field="open"></span>${icon("arrow")}</button></div></footer>`;
      if (compact) card.dataset.warehouseId = w.id;
      else card.querySelectorAll("[data-warehouse-view]").forEach(b => b.dataset.warehouseId = w.id);
    }
    existing.delete(w.id);
    const selected = w.id === state.warehouseId;
    const matches = !needle || `${w.name} ${w.description || ""}`.toLocaleLowerCase().includes(needle);
    card.hidden = !matches;
    visible += Number(matches);
    card.classList.toggle("is-current", selected);
    card.classList.toggle("has-error", ["clear_failed", "delete_failed", "import_failed"].includes(w.state));
    update(card, "name", w.name);
    update(card, "current", selected ? "当前使用" : "");
    update(card, "description", w.description || "按项目或主题收集资料，连接属于它的知识。 ");
    update(card, "status", warehouseStatus(w));
    const blocked = !state.ready || state.uploading || state.migrating;
    if (compact) {
      update(card, "counts", `${w.document_count} 份材料 · ${w.entity_count} 个实体`);
      card.disabled = blocked;
      card.setAttribute("aria-pressed", String(selected));
      card.setAttribute("aria-label", `${selected ? "当前使用" : "切换至"}：${w.name}`);
    } else {
      update(card, "documents", w.document_count);
      update(card, "entities", w.entity_count);
      update(card, "relations", w.relation_count);
      update(card, "created", "建立于 " + date(w.created_at));
      update(card, "open", selected ? "继续探索" : "打开图谱");
      card.querySelectorAll("[data-warehouse-id]").forEach(b => b.disabled = blocked);
      card.querySelector('[data-warehouse-view="graph"]').setAttribute("aria-label", `打开「${w.name}」的知识图谱`);
      card.querySelector('[data-warehouse-view="data"]').setAttribute("aria-label", `管理「${w.name}」的数据`);
    }
    if (container.children[index] !== card) container.insertBefore(card, container.children[index] || null);
  });
  existing.forEach(el => el.remove());
  if (compact) $("#warehouse-picker-empty").hidden = visible > 0;
  return visible;
}
function renderWarehouseDirectory() {
  const totals = state.warehouses.reduce((n,w) => [n[0] + w.document_count, n[1] + w.entity_count, n[2] + w.relation_count], [0,0,0]);
  $("#warehouse-directory-summary").innerHTML = [[state.warehouses.length,"座数据仓"],[totals[0],"份材料"],[totals[1],"个实体"],[totals[2],"条知识关系"]].map(([n,label]) => `<div><b>${esc(n)}</b><span>${label}</span></div>`).join("");
  $("#warehouse-directory-count").textContent = state.warehouses.length;
  const visible = renderWarehouseCollection($("#warehouse-directory"), $("#warehouse-query").value, false);
  const empty = $("#warehouse-directory-empty");
  empty.hidden = visible > 0;
  empty.innerHTML = state.warehouses.length
    ? `<h2>没有找到匹配的数据仓</h2><p>换一个仓名或说明中的关键词试试。</p>`
    : state.ready
    ? `<span class="warehouse-empty-icon">${icon("folder")}</span><h2>让你的知识，有一个自己的位置。</h2><p>按项目、主题或研究方向建仓，再导入第一份资料。</p><button class="btn btn-primary" data-action="new-warehouse">${icon("plus")}新建第一座数据仓</button>`
    : `<h2>连接万象，打开你的数据仓</h2><p>数据仓随当前万象账号和盒子连接读取。</p>`;
}

function renderWarehouses() {
  const selected = currentWarehouse();
  $("#workspace-name").textContent = selected?.name || (state.ready ? "选择一座数据仓" : "等待万象连接");
  $("#workspace-summary").textContent = selected?.description || "当前账号专属 · 资料与授权独立";
  $("#crumb-warehouse").textContent = state.view === "warehouses" ? "全部数据仓" : selected?.name || "尚未建仓";
  $("#graph-warehouse").textContent = selected?.name || "你的第一座知识仓";
  $("#warehouse-count").textContent = state.warehouses.length;
  $("#current-warehouse-status").textContent = selected ? warehouseStatus(selected) : state.ready ? "尚未选择" : "等待连接";
  $("#current-warehouse-stats").innerHTML = [[selected?.document_count || 0, "材料"], [selected?.entity_count || 0, "实体"], [selected?.relation_count || 0, "关系"]].map(([n,label])=>`<span><b>${esc(n)}</b><small>${label}</small></span>`).join("");
  const switchingDisabled = !state.ready || state.uploading || state.migrating;
  $("#warehouse-switch-trigger").disabled = switchingDisabled;
  $("#crumb-warehouse").disabled = switchingDisabled;
  renderWarehouseDirectory();
  // Keep the picker's buttons and search focus stable during background updates.
  renderWarehouseCollection($("#warehouse-picker-list"), $("#warehouse-picker-query").value, true);
  $("#graph-model").textContent = state.processing ? "知识抽取：" + actualModel(state.processing) : state.runtime?.local_only
    ? `处理模型 ${state.runtime.model} · 本人查看原始知识`
    : "来源可查";
  document
    .querySelectorAll('[data-action="new-warehouse"]')
    .forEach(
      (b) => (b.disabled = !state.ready || state.uploading || state.migrating),
    );
  const available = state.ready && selected?.state === "active";
  document
    .querySelectorAll(
      '[data-action="new-key"],[data-action="export-warehouse"]',
    )
    .forEach((b) => (b.disabled = !available || state.migrating));
  document.querySelectorAll('[data-action="prepare-clear"]').forEach((b) => {
    b.disabled =
      !state.ready ||
      !selected ||
      !["active", "clear_failed", "import_failed"].includes(selected.state);
    b.textContent =
      selected?.state === "clear_failed"
        ? "重新确认并继续清理"
        : "清空当前数据仓";
  });
  document.querySelectorAll('[data-action="prepare-delete"]').forEach((b) => {
    b.disabled = !state.ready || !selected || !["active", "clear_failed", "import_failed", "delete_failed"].includes(selected.state);
    b.textContent = selected?.state === "delete_failed" ? "重新确认并继续删除" : "删除当前数据仓";
  });
  document
    .querySelectorAll('[data-action="import-warehouse"]')
    .forEach((b) => (b.disabled = !state.ready || state.migrating));
  $("#search-form button[type=submit]").disabled = !available;
}
async function selectWarehouse(id, nextView) {
  if (state.uploading || state.migrating) return;
  if (id && !state.warehouses.some((w) => w.id === id)) return;
  state.generation++;
  skillsUi.reset();
  if (bridge) void bridge.call("select-warehouse", {}).catch(()=>{});
  state.warehouseId = id;
  state.processing = null; state.modelConfig = null; state.modelRequest = (state.modelRequest || 0) + 1;
  void loadProcessingSummary();
  rememberWarehouse(id);
  state.refreshing = false;
  state.documents = []; state.selectedDocuments = new Map();
  state.documentTotal = 0;
  state.documentOffset = 0;
  state.jobs = [];
  state.jobTotal = 0;
  state.jobOffset = 0;
  state.graph = { nodes: [], edges: [] };
  state.graphFingerprint = null;
  state.graphError = null;
  state.policy = null;
  state.retrieval = null;
  state.files = [];
  state.spaceRequest++;
  state.space = { parent: "", breadcrumbs: [], items: [] };
  state.spaceLoading = false;
  state.spaceError = null;
  state.source = null;
  state.keys = [];
  state.selectedNode = state.selectedEdge = null;
  state.type = "all";
  state.pan = { x: 0, y: 0 };
  state.zoom = 1;
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("#search-query").value = "";
  $("#graph-query").value = "";
  $("#document-query").value = "";
  $("#search-results").innerHTML =
    '<div class="empty">从一个具体的问题开始，找到这个仓中的相关证据。</div>';
  $("#source-body").replaceChildren();
  $("#source-actions").replaceChildren();
  $("#new-key-secret").replaceChildren();
  $("#access-keys").replaceChildren();
  renderWarehouses();
  renderFilters();
  renderGraph();
  renderDocuments();
  renderTasks();
  renderPolicy();
  renderManagement();
  syncControls();
  if (nextView) setView(nextView);
  if (id) {
    await refresh();
    if (state.view === "sensitive") await loadPolicy();
    if (state.view === "api") await loadKeys();
  }
}
function renderManagement() {
  const w = currentWarehouse();
  $("#manage-name").textContent = w?.name || "从一座数据仓开始";
  const status = {
    clearing: "正在清理原件、知识和索引，访问凭证已撤销。",
    clear_failed: "清理未完成。请恢复本地数据库或磁盘后，重新确认并继续清理。",
    deleting: "正在删除数据仓和全部资料。访问凭证已撤销，完成后会从列表移除。",
    delete_failed: "删除未完成。请检查本地服务后，重新确认并继续删除。",
    importing: "正在恢复迁移资料，请等待任务完成。",
    import_failed:
      "迁入未完成，已有数据仓未被覆盖。可重新迁入，或确认清空这个未完成的仓。",
  }[w?.state];
  $("#manage-status").hidden = !status;
  $("#manage-status").textContent = status || "";
  $("#manage-description").textContent =
    w?.description ||
    "你的原始资料、正文版本与知识来源，保存在同一座数据仓中。";
  $("#warehouse-stats").innerHTML = w
    ? [
        [w.document_count, "份材料"],
        [w.entity_count, "个实体"],
        [w.relation_count, "条关系"],
        [bytes(w.storage_bytes), "原件大小"],
      ]
        .map(
          ([value, label]) =>
            `<div><b>${esc(value)}</b><span>${label}</span></div>`,
        )
        .join("")
    : "";
  $("#runtime-summary").innerHTML = state.runtime
    ? `<span>${
        state.runtime.local_only
          ? "✓ 处理服务已启用"
          : "当前服务未启用严格本地模式"
      }</span><code>${esc(
        state.runtime.model || "请在模型与处理页面查看配置",
      )}</code><span>嵌入模型：${esc(state.runtime.embedding)}</span>`
    : "等待连接本地知识服务";
  $("#api-base").textContent = state.runtime?.api_base_url || "连接后读取";
  renderTransfer();
  renderProcessingSummary();
}
async function loadKeys() {
  const generation = state.generation;
  try {
    const result = await call("keys");
    if (generation !== state.generation || state.invalid) return;
    state.keys = result.items;
    const active = result.items.filter(
      (k) => !k.revoked_at && k.expires_at * 1000 > Date.now(),
    );
    $("#key-count").textContent = `${active.length} 个有效凭证`;
    const names = {
      search: "检索",
      graph: "图谱",
      documents: "材料元信息",
      evidence: "证据",
      reasoning: "推理方法与资料",
    };
    $("#access-keys").innerHTML = result.items.length
      ? result.items
          .map((k) => {
            const valid = !k.revoked_at && k.expires_at * 1000 > Date.now();
            return `<div class="access-key"><div><strong>${esc(
              k.name,
            )}</strong>${
              valid
                ? `<button class="text-link" data-revoke="${esc(
                    k.id,
                  )}">撤销</button>`
                : '<span class="muted small">已失效</span>'
            }</div><small>${esc(k.prefix)}… · ${new Date(
              k.expires_at * 1000,
            ).toLocaleDateString("zh-CN")} 到期</small><p><strong>${Object.keys(names).every((s) => k.scopes.includes(s)) ? "统一知识 Key · 全部对外知识能力" : "旧版 Key · 部分能力"}</strong></p><p>${k.scopes
              .map((s) => names[s] || esc(s))
              .join(" · ")}</p></div>`;
          })
          .join("")
      : '<p class="detail-empty">还没有开放访问。创建凭证后，你选择的应用就能使用这个仓的知识。</p>';
  } catch (e) {
    if (generation === state.generation) toast(errorText(e));
  }
}
async function refreshTransfer() {
  if (!state.transfer || state.transferRefreshing) return;
  state.transferRefreshing = true;
  try {
    const result = await call("transfer", { id: state.transfer.id });
    const was = state.transfer.state;
    state.transfer = result;
    renderTransfer();
    if (result.state === "ready" && was !== "ready") {
      state.warehouses = (await call("warehouses")).items;
      renderWarehouses();
      toast(
        result.kind === "import"
          ? "数据仓已迁入，本地索引继续重建。"
          : "迁移包已准备好，可以保存到本机。",
      );
    }
  } catch (e) {
    if (!state.invalid && e.code !== "WAREHOUSE_CHANGED") toast(errorText(e));
  } finally {
    state.transferRefreshing = false;
  }
}
function renderTransfer() {
  const t = state.transfer;
  $("#transfer-panel").hidden = !t;
  if (!t) return;
  const label = t.kind === "export" ? "数据仓导出" : "数据仓迁入";
  $("#transfer-state").innerHTML = `<p><strong>${label}</strong> · ${
    t.state === "ready"
      ? "已就绪"
      : t.state === "failed"
      ? "未完成"
      : t.state === "cleared"
      ? "已清理"
      : "正在处理"
  }</p><progress max="100" value="${
    Number(t.progress) || 0
  }"></progress><p>${esc(
    t.error ||
      (t.state === "ready"
        ? t.kind === "export"
          ? "迁移包已通过完整性校验。请保存并妥善保管。"
          : "材料、正文版本与来源已恢复，新仓正在重建本地检索索引。"
        : "迁移在服务端继续进行，完成后可在这里查看结果。"),
  )}</p>${
    t.state === "ready" && t.kind === "export"
      ? '<button class="btn btn-secondary" data-action="save-migration">保存迁移包</button>'
      : ""
  }${
    t.state === "ready" && t.kind === "import"
      ? '<button class="btn btn-secondary" data-action="open-imported">打开迁入的数据仓</button>'
      : ""
  }${
    t.state === "failed"
      ? '<p class="detail-note">可重新选择迁移包重试，已有数据仓不会被覆盖。</p>'
      : ""
  }`;
}
async function warehouseAction(name) {
  if (name === "choose-warehouse") {
    if (!state.ready || state.uploading || state.migrating) return true;
    $("#warehouse-picker-query").value = "";
    renderWarehouseCollection($("#warehouse-picker-list"), "", true);
    $("#warehouse-picker").showModal();
    $("#warehouse-picker-query").focus();
    return true;
  }
  if (name === "all-warehouses") {
    $("#warehouse-picker").close();
    setView("warehouses");
    return true;
  }
  if (name === "new-warehouse") {
    $("#warehouse-picker").close();
    $("#warehouse-form").reset();
    $("#warehouse-dialog").showModal();
    return true;
  }
  if (name === "new-key") {
    $("#key-form").reset();
    $("#key-context").textContent = `授权数据仓：${currentWarehouse()?.name || "当前数据仓"}。一个 Key 可调用该仓全部对外知识能力，凭证明文只显示一次。`;
    $("#key-form").hidden = false;
    $("#new-key-secret").replaceChildren();
    $("#new-key-secret").hidden = true;
    $("#key-dialog").showModal();
    return true;
  }
  if (name === "prepare-clear" || name === "prepare-delete") {
    const deleting = name === "prepare-delete";
    const intent = await call(name, {
      operationId: crypto.randomUUID(),
    });
    state.clearIntent = intent;
    intent.action = deleting ? "delete" : "clear";
    $("#clear-title").textContent = deleting ? "删除当前数据仓？" : "清空当前数据仓？";
    $('#clear-dialog .icon-btn').setAttribute('aria-label', deleting ? '取消删除' : '取消清空');
    $('#clear-dialog .btn-secondary').textContent = deleting ? '保留数据仓' : '保留数据';
    $("#clear-scope").innerHTML = `<p class="modal-intro">将清空「${esc(
      intent.warehouse.name,
    )}」中的全部数据：</p><div class="clear-counts">${
      intent.warehouse.document_count
    } 份材料 · ${intent.warehouse.entity_count} 个实体 · ${
      intent.warehouse.relation_count
    } 条关系</div><p class="modal-warning">原件、全部正文版本、知识关系、检索索引、Skill 及推理准备记录将被移除，${
      intent.warehouse.access_key_count
    } 个有效凭证将同时撤销。其他数据仓不受影响。</p>`;
    if (deleting) {
      $("#clear-scope").innerHTML = `<p class="modal-intro">将永久删除数据仓「${esc(intent.warehouse.name)}」及其全部数据：</p><div class="clear-counts">${intent.warehouse.document_count} 份材料 · ${intent.warehouse.entity_count} 个实体 · ${intent.warehouse.relation_count} 条关系</div><p class="modal-warning">数据仓本身、原件、全部正文版本、知识关系、索引、Skill 及推理准备记录将被移除，${intent.warehouse.access_key_count} 个有效凭证将撤销。此操作无法撤销，请先迁出需要保留的资料。其他数据仓不受影响。</p>`;
    }
    $("#clear-second").hidden = true;
    $("#clear-name").value = "";
    $("#clear-next").textContent = "继续确认";
    $("#clear-next").disabled = false;
    $("#clear-dialog").showModal();
    return true;
  }
  if (name === "export-warehouse") {
    state.transfer = await call("export-warehouse", {
      operationId: crypto.randomUUID(),
    });
    renderTransfer();
    $("#transfer-panel").scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    return true;
  }
  if (name === "import-warehouse") {
    const files = await call("select-migration");
    if (!files.length) return true;
    state.migrating = true;
    renderWarehouses();
    $("#transfer-panel").hidden = false;
    $("#transfer-state").innerHTML = `<p>正在上传 ${esc(
      files[0].name,
    )}，完成后将建立新数据仓…</p>`;
    try {
      state.transfer = await call("import-migration", {
        handle: files[0].handle,
      });
      renderTransfer();
    } finally {
      state.migrating = false;
      renderWarehouses();
    }
    return true;
  }
  if (name === "refresh-transfer") {
    await refreshTransfer();
    return true;
  }
  if (name === "save-migration") {
    const result = await call("save-migration", { id: state.transfer.id });
    if (result.saved) toast("迁移包已校验并保存。");
    return true;
  }
  if (name === "open-imported") {
    await selectWarehouse(state.transfer.warehouse_id);
    setView("graph");
    return true;
  }
  return false;
}
$("#warehouse-query").addEventListener("input", renderWarehouseDirectory);
$("#warehouse-picker-query").addEventListener("input", () => renderWarehouseCollection($("#warehouse-picker-list"), $("#warehouse-picker-query").value, true));
$("#warehouse-picker-query").addEventListener("keydown", (event) => {
  if (!["ArrowDown", "Enter"].includes(event.key)) return;
  const first = $("#warehouse-picker-list").querySelector("button:not([hidden]):not(:disabled)");
  if (!first) return;
  event.preventDefault();
  if (event.key === "Enter") first.click();
  else first.focus();
});
$("#warehouse-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  void (async () => {
    const w = await call("create-warehouse", {
      name: $("#warehouse-name").value,
      description: $("#warehouse-description").value,
      operationId: crypto.randomUUID(),
    });
    state.warehouses = (await call("warehouses")).items;
    await selectWarehouse(w.id);
    setView("graph");
    toast("数据仓已建立，可以开始导入资料。");
  })()
    .catch((e) => toast(errorText(e)))
    .finally(() => (button.disabled = false));
});
$("#key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  void (async () => {
    const result = await call("create-key", {
      name: $("#key-name").value,
      days: Number($("#key-days").value),
      operationId: crypto.randomUUID(),
    });
    $("#key-form").hidden = true;
    $("#new-key-secret").hidden = false;
    $("#new-key-secret").innerHTML = result.token
      ? `<p class="modal-warning">请现在复制并保存。关闭后无法再次查看此凭证。</p><code class="secret-value" tabindex="0">${esc(
          result.token,
        )}</code><p class="modal-intro">此 Key 可调用当前仓的图谱、检索、证据、材料信息与 Skill／推理资料接口，返回内容遵循脱敏规则。请保存在调用应用的服务端或主进程。</p><div class="modal-actions"><button class="btn btn-primary" data-close="key-dialog">我已妥善保存</button></div>`
      : '<p class="modal-warning">本次授权已经创建，凭证明文无法重复读取。如未保存，请撤销后重新创建。</p>';
    await loadKeys();
  })()
    .catch((e) => toast(errorText(e)))
    .finally(() => (button.disabled = false));
});
$("#key-dialog").addEventListener("close", () =>
  $("#new-key-secret").replaceChildren(),
);
$("#access-keys").addEventListener("click", (event) => {
  const button = event.target.closest("[data-revoke]");
  if (!button) return;
  button.disabled = true;
  void call("revoke-key", {
    id: button.dataset.revoke,
    operationId: crypto.randomUUID(),
  })
    .then(() => loadKeys())
    .catch((e) => toast(errorText(e)))
    .finally(() => (button.disabled = false));
});
$("#clear-name").addEventListener(
  "input",
  () =>
    ($("#clear-next").disabled =
      $("#clear-name").value !== state.clearIntent?.warehouse.name),
);
$("#clear-dialog").addEventListener("close", () => {
  state.clearIntent = null;
  $("#clear-name").value = "";
});
$("#clear-next").addEventListener("click", () => {
  if ($("#clear-second").hidden) {
    $("#clear-second").hidden = false;
    $("#clear-next").textContent = state.clearIntent?.action === "delete" ? "确认永久删除数据仓" : "确认永久清空";
    $("#clear-next").disabled = true;
    $("#clear-name").focus();
    return;
  }
  const intent = state.clearIntent;
  if (!intent || $("#clear-name").value !== intent.warehouse.name) return;
  if (state.warehouseId !== intent.warehouse.id) return toast("数据仓已切换，请重新确认。");
  $("#clear-next").disabled = true;
  void (async () => {
    const deleting = intent.action === "delete";
    await call(deleting ? "delete-warehouse" : "clear-warehouse", {
      token: intent.confirmation_token,
      typedName: $("#clear-name").value,
      operationId: (intent.operationId ||= crypto.randomUUID()),
    });
    $("#clear-dialog").close();
    if (deleting) {
      await selectWarehouse("", "warehouses");
      await refresh();
      toast("删除已提交，清理完成后会从数据仓列表移除；访问凭证已撤销。");
    } else {
      await selectWarehouse(state.warehouseId);
      toast("清空已提交，正在移除资料与索引；访问凭证已撤销。");
    }
  })()
    .catch((e) => toast(errorText(e)))
    .finally(() => ($("#clear-next").disabled = false));
});

function actualModel(config, role = "extraction") {
  const item = config?.[role];
  return item ? `${item.name || item.model} · ${item.location === "local" ? "本地" : "云端 / 外部服务"} · 配置 v${config.revision || 0}` : "历史处理记录未提供模型配置";
}
function modelUsage(calls) {
  const usages = calls.map(c => c.usage);
  if (usages.some(u => !u)) return "未返回完整用量";
  return usages.reduce((n,u) => n + (u.total_tokens || u.input_tokens + u.output_tokens || 0), 0) + " tokens";
}
async function loadProcessingSummary() {
  if (!state.ready || !state.warehouseId || state.preview) return;
  const generation = state.generation;
  try {
    const config = await call("processing");
    if (generation !== state.generation) return;
    state.processing = config.effective;
    renderProcessingSummary();
  } catch { /* Older services keep the existing local runtime summary. */ }
}
function renderProcessingSummary() {
  if (!state.processing) return;
  const text = actualModel(state.processing);
  $("#graph-model").textContent = "知识抽取与脱敏：" + text;
  $("#runtime-summary").textContent = "知识抽取与脱敏共用模型：" + text;
  if ($("#import-model-summary")) $("#import-model-summary").textContent = "本次导入按入队时配置处理：" + text;
}
async function loadModels() {
  if (!state.ready || state.preview) { $("#model-status").textContent = "请从万象打开星图后配置模型。"; return; }
  const request = state.modelRequest = (state.modelRequest || 0) + 1;
  const scope = $("#model-scope").value;
  $("#model-status").textContent = "正在读取当前设备的模型与配置…";
  const results = await Promise.allSettled([call("processing", {scope}),call("model-catalog")]);
  if (request !== state.modelRequest) return;
  if (results[0].status === "rejected") { $("#model-status").textContent = errorText(results[0].reason); return; }
  state.modelConfig = results[0].value;
  state.modelCatalog = results[1].status === "fulfilled" ? results[1].value.items : [];
  renderModelEditor();
  $("#model-status").textContent = results[1].status === "rejected" ? errorText(results[1].reason) + "。现有知识仍可查看。" : state.modelCatalog.length ? "模型目录已读取。保存前将检查实际调用能力。" : "万象尚未配置可用文本模型，请先在万象添加模型。";
}
function renderModelEditor() {
  const config = state.modelConfig;
  if (!config) return;
  const current = config.effective;
  const location = item => item?.location === "local" ? "本机 / 当前盒子" : "云端 / 外部服务";
  const roles = [
    ["ocr","文字识别","将图片或扫描件转成正文"], ["asr","语音转写","将录音转成可追溯文字"],
    ["extraction","知识抽取","提取实体、关系和来源"], ["embedding","检索向量","为证据检索建立索引"], ["sensitive","敏感信息检测","检查知识交付中的敏感内容"]
  ];
  $("#model-context").textContent = `${state.identity?.boxName || "当前设备"} · ${currentWarehouse()?.name || "未选择数据仓"} · ${config.inherit ? "继承星图默认" : $("#model-scope").value === "default" ? "星图默认配置" : "本仓独立配置"}`;
  $("#model-stages").innerHTML = roles.map(([role,title,purpose], i) => {
    const item = current[role] || config.stages.find(s => s.role === role);
    const available = item?.available;
    const selected = state.modelCatalog.find(m => m.id === item?.id);
    const status = item?.route === "legacy" ? "现有本地配置 · 待接入万象" : item?.route === "wanx" ? selected && selected.revision === item.revision ? "已检查 · 调用时再次验证" : "不可用或配置已变化" : available ? "已安装 / 已配置" : "未就绪";
    return `<article class="panel model-stage"><span class="eyebrow">0${i+1}</span><h3>${title}</h3><p>${purpose}</p><strong>${esc(item?.name || "未配置")}</strong><p>${location(item)}<br>${esc(status)}</p><small class="muted">${current[role] ? "最近检查：" + (current.checked_at ? date(current.checked_at) : "尚未检查") : "按当前设备安装状态读取 · 暂不开放切换"}</small></article>`;
  }).join("");
  for (const role of ["extraction"]) {
    const options = [...state.modelCatalog];
    if (!options.some(m => m.id === current[role]?.id)) options.unshift({...current[role], available:false});
    $("#model-"+role).innerHTML = options.map(m => `<option value="${esc(m.id)}" ${m.available ? "" : "disabled"}>${esc(m.name || m.model)} · ${esc(m.provider)} · ${m.location === "local" ? "本地" : "云端 / 外部"}${m.available ? "" : "（当前配置，暂不可选择）"}</option>`).join("");
    $("#model-"+role).value = current[role]?.id || "";
  }
  $("#model-inherit").checked = config.inherit;
  $("#model-inherit-label").hidden = $("#model-scope").value === "default";
  $("#model-impact").textContent = $("#model-scope").value === "default" ? "影响继承默认配置的数据仓及未来新仓：" + (config.affected_warehouses.join("、") || "目前没有继承仓") : "仅影响当前数据仓的新处理任务。";
  updateModelControls();
}
function updateModelControls() {
  const inherited = $("#model-scope").value === "warehouse" && $("#model-inherit").checked;
  for (const id of ["model-scope", "model-inherit", "model-extraction", "model-refresh"]) $("#"+id).disabled = !!state.modelSaving;
  $("#model-selectors").hidden = inherited;
  $("#model-save").disabled = !!state.modelSaving || !state.modelConfig;
  $("#model-save").textContent = state.modelSaving ? "正在检查并保存…" : inherited ? "恢复继承" : "检查并保存";
}
async function saveModels() {
  if (!state.modelConfig || state.modelSaving) return;
  const generation = state.generation, scope = $("#model-scope").value;
  const inherit = scope === "warehouse" && $("#model-inherit").checked;
  const revision = state.modelConfig.revision;
  const request = state.modelRequest;
  try {
    state.modelSaving = true; updateModelControls();
    let check = {};
    if (!inherit) {
      const extraction = $("#model-extraction").value;
      const items = [state.modelCatalog.find(m => m.id === extraction)];
      if (items.some(m => !m?.available)) throw {publicMessage:"请先选择万象中的可用模型。"};
      const cloud = items.filter(m => m.location !== "local");
      if (cloud.length && !confirm(`确认使用云端 / 外部模型？\n${cloud.map(m => `${m.provider} · ${m.name}`).join("\n")}\n\n知识抽取或敏感检测可能向这些服务发送未经脱敏的正文片段，并产生模型用量。\n${$("#model-impact").textContent}\n\n是否继续检查并保存？`)) return;
      $("#model-status").textContent = "正在用合成文本检查连通性与 JSON 输出能力，不发送你的资料…";
      check = await call("check-models",{scope,config:{extraction,cloud_confirmations:cloud.map(m => m.revision)}});
      if (generation !== state.generation || request !== state.modelRequest) return;
    }
    await call("save-models",{scope,config:{expected_revision:revision,inherit,check_id:check.check_id || null}});
    if (generation !== state.generation) return;
    await loadProcessingSummary(); await loadModels();
    $("#model-status").textContent = "已保存。新任务使用此配置，已有任务和资料保留原处理记录。";
  } catch (e) { if (generation === state.generation) $("#model-status").textContent = errorText(e); }
  finally { state.modelSaving = false; updateModelControls(); }
}
async function reprocessModels(all = false) {
  if (!state.warehouseId) return;
  const generation = state.generation;
  let documents = [...(state.selectedDocuments?.values() || [])];
  if (all) {
    documents=[];
    for(let offset=0; ;offset+=100){
      const result=await call("documents",{offset,limit:100});
      documents.push(...result.items);
      if (result.items.length<100 || documents.length>=result.total) break;
    }
  }
  documents=documents.filter(d=>d.status==="ready" && d.active_version_id);
  if (!documents.length) {toast("请选择已完成正文解析的材料。");return;}
  if (generation !== state.generation) return;
  if (!confirm(`重新处理「${currentWarehouse()?.name}」中的 ${documents.length} 份材料？\n${actualModel(state.processing)}\n\n每份成功后替换知识关系，失败或取消保留原结果。云端配置会发送正文并产生用量。`)) return;
  try {
    for(let offset=0;offset<documents.length;offset+=100){
      if (generation!==state.generation) return;
      await call("reprocess-models",{documents:documents.slice(offset,offset+100).map(d=>({id:d.id,version_id:d.active_version_id})),expectedSignature:state.processing?.signature,operationId:crypto.randomUUID()});
    }
    toast("已创建重处理任务，可在任务中心查看实际模型与进度。");setView("tasks");void refresh();
  } catch(e){toast(errorText(e));}
}
$("#model-scope").addEventListener("change",()=>void loadModels());
$("#model-inherit").addEventListener("change",updateModelControls);
$("#model-refresh").addEventListener("click",()=>void loadModels());
$("#model-save").addEventListener("click",()=>void saveModels());
$("#model-reprocess-all").addEventListener("click",()=>void reprocessModels(true));
$("#model-manage").addEventListener("click",async()=>{
  try { const result=await call("open-model-management"); if(!result.opened) toast("当前万象版本暂不支持直接跳转。请在万象管理后台的「模型」中管理，再回到这里刷新。"); }
  catch(e){toast(errorText(e));}
});
if ($("#import-model-config")) $("#import-model-config").addEventListener("click",()=>{$("#import-dialog").close();setView("models");});
const reprocessSelected = document.createElement("button");
reprocessSelected.className="btn btn-secondary"; reprocessSelected.textContent="用当前模型重新处理选中材料";
reprocessSelected.addEventListener("click",()=>void reprocessModels(false));
$("#view-materials .table-toolbar").append(reprocessSelected);

$("#view-materials").addEventListener("change", event=>{
 const id=event.target.dataset.reprocessDocument; if(!id)return;
 state.selectedDocuments ||= new Map();
 if(event.target.checked)state.selectedDocuments.set(id,state.documents.find(d=>d.id===id));
 else state.selectedDocuments.delete(id);
});

let applyingTeamTarget;
async function applyTeamTarget({target,requestId}){
  if(applyingTeamTarget===requestId)return;applyingTeamTarget=requestId;
  try{
    if(state.uploading||state.migrating||state.files.length||document.querySelector("dialog[open]"))throw Object.assign(Error("TEAM_STARLINK_BUSY"),{code:"TEAM_STARLINK_BUSY"});
    const rows=await call("warehouses");if(state.invalid)throw Error("HOST_SESSION_EXPIRED");state.warehouses=rows.items;
    if(target.warehouseId&&!state.warehouses.some(w=>w.id===target.warehouseId))throw Object.assign(Error("WAREHOUSE_NOT_FOUND"),{code:"WAREHOUSE_NOT_FOUND"});
    await selectWarehouse(target.warehouseId,target.view);setView(target.view);window.focus();
    await call("launch-target-applied",{requestId,ok:true});
  }catch(error){toast(error.code==="TEAM_STARLINK_BUSY"?"请先完成或关闭当前未提交的操作，再从万象打开目标数据仓。":errorText(error));await call("launch-target-applied",{requestId,ok:false,code:error.code||"TEAM_STARLINK_OPEN_FAILED"}).catch(()=>{})}
}

// Team application bindings remain on the trusted backend; no Key reaches this view.
document.getElementById('team-app-grant').addEventListener('click',async()=>{
  try{
    const result=await call('team-applications');
    const d=document.createElement('dialog');d.className='modal';
    d.innerHTML=`<form><h2>授权内部应用</h2><p>仅授权当前数据仓。凭据保存在盒子服务端，成员仍使用自己的账号。</p><label>内部应用<select name="app" required>${result.items.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label><label>有效期（天）<input type="number" name="days" min="1" max="365" value="30" required></label><p data-error></p><div class="modal-actions"><button type="button" class="btn" data-cancel>取消</button><button class="btn btn-primary" ${result.items.length?'':'disabled'}>确认授权</button></div></form>`;
    document.body.append(d);d.showModal();d.querySelector('[data-cancel]').onclick=()=>d.close();d.onclose=()=>d.remove();
    const warehouse=state.warehouseId;
    d.querySelector('form').onsubmit=async event=>{event.preventDefault();const b=d.querySelector('button:not([type=button])');b.disabled=true;try{if(warehouse!==state.warehouseId||state.invalid)throw Error('HOST_SESSION_EXPIRED');const f=new FormData(event.target);await call('grant-team-application',{warehouseId:warehouse,applicationId:f.get('app'),days:Number(f.get('days'))});d.close();toast('已授权该应用读取当前数据仓；可在下方撤销对应凭证。');await refresh()}catch(e){d.querySelector('[data-error]').textContent=errorText(e)}finally{b.disabled=false}};
  }catch(e){toast(errorText(e))}
});

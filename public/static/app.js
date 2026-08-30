(() => {
  "use strict";
  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // 与 src/prd/sections.ts 一一对应。改那边记得改这边。
  const SECTIONS = [
    { n: 1, id: "background", zh: "背景与问题", en: "Background & Problem", derive: "background" },
    { n: 2, id: "target_user", zh: "目标用户", en: "Target User", derive: "target_user" },
    { n: 3, id: "goal", zh: "目标", en: "Goals", slot: "goal" },
    { n: 4, id: "boundaries", zh: "非目标", en: "Non-Goals", slot: "boundaries", list: true },
    { n: 5, id: "sources", zh: "资料来源", en: "Data Sources", slot: "sources", list: true },
    { n: 6, id: "actions", zh: "功能需求", en: "Functional Requirements", slot: "actions", list: true },
    { n: 7, id: "workflow", zh: "工作流程", en: "Workflow", slot: "workflow", list: true, ordered: true },
    { n: 8, id: "deliverable", zh: "交付物", en: "Deliverables", slot: "deliverable", list: true },
    { n: 9, id: "when", zh: "触发方式", en: "Trigger", slot: "when" },
    { n: 10, id: "params", zh: "可配置项", en: "Parameters", slot: "params", list: true },
    { n: 11, id: "acceptance", zh: "验收标准", en: "Acceptance Criteria", derive: "acceptance", list: true },
  ];

  const EXAMPLES = [
    { t: "帮我跟进客户", d: "记住每个人的偏好和承诺，别让事情烂在半路" },
    { t: "每天给我一份行业简报", d: "把该看的都看了，只给你结论" },
    { t: "把会议记录整理成待办", d: "聊完就有清单，不用再回头翻" },
    { t: "定期整理我的资料", d: "散在各处的东西，替你归位" },
  ];

  const OPENING_SUB =
    "说不清也没关系。我会一直给你选项，你挑就行——右边那份文档会跟着你的选择一节一节写出来。";

  const state = {
    phase: "empty",
    messages: [],
    draft: { slots: {}, derived: {} },
    turn: 0,
    answered: 0,
    busy: false,
    app: null,
    pending: null,
    ask: null,
    settings: null,
  };

  /* ================= 文档 ================= */
  function sectionValue(section) {
    if (section.slot) {
      const entry = state.draft.slots[section.slot];
      return entry ? { value: entry.value, guessed: entry.guessed === true } : null;
    }
    const v = state.draft.derived[section.derive];
    return v === undefined ? null : { value: v, guessed: false };
  }

  function bodyHtml(value, section) {
    const items = Array.isArray(value) ? value : [value];
    if (section.list) {
      const tag = section.ordered ? "ol" : "ul";
      return `<${tag}>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</${tag}>`;
    }
    return esc(items.join("、"));
  }

  function docCount() {
    return SECTIONS.filter((s) => sectionValue(s) !== null).length;
  }

  function docHtml(prefix) {
    const name = state.draft.derived.name;
    const confirmed = state.phase === "build" || state.phase === "app" || state.phase === "run" || state.phase === "result";
    const status = confirmed ? "已确认 Confirmed" : state.phase === "confirm" ? "待确认 In Review" : "草稿 Draft";
    let h = '<div class="doc"><div class="doc-head">' +
      '<div class="doc-h1">半人马AI-万象 · 助手需求文档</div>' +
      '<div class="doc-h1-en">CentaurAI-WanX · Assistant PRD</div>' +
      '<dl class="doc-meta">' +
      `<dt>名称 Name</dt><dd${name ? ">" + esc(name) : ' class="pending">还没定'}</dd>` +
      "<dt>版本 Version</dt><dd>v1</dd>" +
      `<dt>定义 Defined</dt><dd>对话 ${state.turn} 轮</dd>` +
      `<dt>状态 Status</dt><dd><span class="status-chip${confirmed || state.phase === "confirm" ? " ready" : ""}">${status}</span></dd>` +
      "</dl></div>";

    for (const s of SECTIONS) {
      const got = sectionValue(s);
      h += `<section class="sec" id="${prefix}${s.id}">` +
        `<div class="sec-h"><span class="sec-n">${s.n}.</span><span class="sec-zh">${s.zh}</span>` +
        (s.derive ? '<span class="sec-chip pm">由产品经理归纳</span>' : "") +
        (got && got.guessed ? '<span class="sec-chip">按最佳猜测</span>' : "") +
        `</div><div class="sec-en">${s.en}</div>` +
        (got
          ? `<div class="sec-body">${bodyHtml(got.value, s)}</div>`
          : '<div class="skel" aria-hidden="true"><i></i><i></i></div><div class="sec-todo">○ 还没聊到</div>') +
        "</section>";
    }
    return h + "</div>";
  }

  function renderDoc(touched) {
    el("prd-scroll").innerHTML = docHtml("");
    if (!el("overlay").classList.contains("hidden")) el("overlay-doc").innerHTML = docHtml("ov-");

    const first = (touched || []).map((k) => SECTIONS.find((s) => s.slot === k || s.derive === k))
      .filter(Boolean)[0];
    if (first) {
      const node = el(first.id);
      if (node) {
        node.classList.add("flash");
        node.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
        setTimeout(() => node.classList.remove("flash"), REDUCED ? 10 : 1400);
      }
    }

    const n = docCount();
    el("m1").textContent = `${state.answered} / 9`;
    el("m2").textContent = `${n} / 11`;
    el("f1").style.width = `${(state.answered / 9) * 100}%`;
    el("f2").style.width = `${(n / 11) * 100}%`;
    el("to-confirm").disabled = n < 2 || state.phase !== "chat";
    el("foot-note").textContent = n === 0
      ? "还没开始"
      : n < 11
        ? `你做了 ${state.answered} 次选择，它已写出 ${n} 节`
        : "十一节都齐了";
  }

  /* ================= 对话骨架 ================= */
  function shell() {
    el("stage").className = "stage";
    el("stage").innerHTML =
      '<div id="active"></div>' +
      '<div id="hist-label" class="hist-label hidden">刚才聊过的</div>' +
      '<div id="hist" class="hist"></div>';
  }
  const toTop = () => { el("scroll").scrollTop = 0; };

  function archive(answerLabel) {
    const active = el("active");
    if (!active) return;
    const ask = active.querySelector(".beat.ask");
    if (ask) {
      const item = document.createElement("div");
      item.className = "hist-item";
      const q = document.createElement("div");
      q.className = "hist-q";
      q.textContent = ask.textContent;
      const a = document.createElement("div");
      a.className = "hist-a";
      a.innerHTML = '<span class="hist-a-k">你选了</span><span class="hist-a-v"></span>';
      a.querySelector(".hist-a-v").textContent = answerLabel;
      item.append(q, a);
      el("hist").prepend(item);
      el("hist-label").classList.remove("hidden");
    }
    active.innerHTML = "";
  }

  function setBusy(v) {
    state.busy = v;
    const s = el("send"), i = el("input");
    if (s) s.disabled = v;
    if (i) i.placeholder = v ? "产品经理正在说…" : "也可以不选，直接跟它说";
  }

  /* ================= 一轮：SSE ================= */
  async function runTurn() {
    setBusy(true);
    toTop();
    const active = el("active");
    const wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="who"><span class="who-chip">产品经理</span><span>PM</span>' +
      `<span class="who-turn">第 ${state.turn + 1} 轮 / 上限 20</span></div>` +
      '<div class="bubble"><p class="beat"><span class="caret"></span></p></div>';
    active.appendChild(wrap);
    const bubble = wrap.querySelector(".bubble");
    let prose = "";

    const paint = (final) => {
      const beats = prose.split(/\n{2,}/).filter((b, i, arr) => b.trim() !== "" || i === arr.length - 1);
      bubble.innerHTML = "";
      beats.forEach((text, i) => {
        const p = document.createElement("p");
        const three = beats.length >= 3;
        p.className = "beat" + (three && i === 1 ? " wrote" : i === beats.length - 1 && final ? " ask" : "");
        const span = document.createElement("span");
        span.textContent = text.trim();
        if (!final && i === beats.length - 1) span.classList.add("caret");
        p.appendChild(span);
        bubble.appendChild(p);
      });
    };

    let result = null;
    try {
      result = await streamTurn((delta) => { prose += delta; paint(false); });
    } catch (e) {
      if (e.needsKey) {
        await loadSettings();
        renderSettings({ reason: "还没设置模型 key，先把它配上再继续。" });
        return;
      }
      const box = document.createElement("div");
      box.className = "err";
      box.textContent = `没能问下去：${e.message}`;
      bubble.appendChild(box);
      setBusy(false);
      addComposer();
      return;
    }

    state.pending = null;
    if (result.prose) prose = result.prose;
    paint(true);
    state.messages.push({ role: "assistant", content: prose });
    state.draft = result.draft;
    state.turn = result.turn;
    state.answered = result.answered;
    renderDoc(result.touched);

    if (result.done) {
      setTimeout(() => goConfirm(), 400);
      return;
    }
    state.ask = result.ask;
    renderOptions(result.ask);
    addComposer();
    setBusy(false);
    toTop();
  }

  function streamTurn(onDelta) {
    return new Promise((resolve, reject) => {
      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: state.messages,
          draft: state.draft,
          turn: state.turn,
          answered: state.pending,
        }),
      })
        .then(async (response) => {
          if (!response.ok || !response.body) throw new Error(`请求失败（${response.status}）`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let settled = false;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, sep);
              buffer = buffer.slice(sep + 2);
              let event = "message", data = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data += line.slice(5).trim();
              }
              if (!data) continue;
              const payload = JSON.parse(data);
              if (event === "delta") onDelta(payload.text);
              else if (event === "error") {
                settled = true;
                const err = new Error(payload.error);
                err.needsKey = payload.needsKey === true;
                reject(err);
                return;
              }
              else if (event === "done") { settled = true; resolve(payload); return; }
            }
          }
          if (!settled) reject(new Error("连接中断了"));
        })
        .catch(reject);
    });
  }

  /* ================= 选项 ================= */
  function optHtml(o, num) {
    return `<span class="opt-num" aria-hidden="true">${num}</span><span class="opt-body">` +
      `<span class="opt-top"><span class="opt-l">${esc(o.label)}</span>` +
      (o.tag ? `<span class="opt-tag">${esc(o.tag)}</span>` : "") +
      "</span>" +
      (o.description ? `<span class="opt-d">${esc(o.description)}</span>` : "") +
      (o.doc ? `<span class="opt-doc"><b>写进文档：</b>${esc(o.doc)}</span>` : "") +
      "</span>";
  }

  function renderOptions(ask) {
    if (!ask) return;
    const box = document.createElement("div");
    box.className = "options";
    const picked = new Set();
    let doneBtn, hint;

    ask.options.forEach((o, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.innerHTML = optHtml(o, i + 1);
      b.addEventListener("click", () => {
        if (ask.type === "single") { answer([o]); return; }
        picked.has(i) ? picked.delete(i) : picked.add(i);
        b.classList.toggle("picked", picked.has(i));
        doneBtn.disabled = picked.size === 0;
        hint.textContent = picked.size ? `选了 ${picked.size} 个` : "可以多选，也可以一个都不选、自己说";
      });
      box.appendChild(b);
    });

    const own = document.createElement("button");
    own.type = "button";
    own.className = "opt own";
    own.innerHTML = optHtml({
      label: "都不是，我自己说",
      description: "下面的输入框一直开着，任何时候都能直接打字。你说的话照样会变成文档里的一节。",
    }, "＋");
    own.addEventListener("click", () => el("input") && el("input").focus());
    box.appendChild(own);

    if (ask.type === "multi") {
      const foot = document.createElement("div");
      foot.className = "multi-foot";
      doneBtn = document.createElement("button");
      doneBtn.type = "button";
      doneBtn.className = "btn-solid";
      doneBtn.textContent = "选好了";
      doneBtn.disabled = true;
      hint = document.createElement("span");
      hint.className = "multi-hint";
      hint.textContent = "可以多选，也可以一个都不选、自己说";
      doneBtn.addEventListener("click", () =>
        answer([...picked].sort((a, b) => a - b).map((i) => ask.options[i])));
      foot.append(doneBtn, hint);
      box.appendChild(foot);
    }
    el("active").appendChild(box);
  }

  function addComposer() {
    const c = document.createElement("div");
    c.className = "composer";
    c.innerHTML =
      '<div class="composer-box">' +
      '<textarea id="input" rows="1" placeholder="也可以不选，直接跟它说" aria-label="你的回答"></textarea>' +
      '<button class="send" id="send" type="button" aria-label="发送">→</button></div>' +
      '<div class="composer-foot"><span class="composer-note">选项只是台阶，随时可以自己打字</span>' +
      '<button class="stop" id="stop" type="button">够了，就照现在这样造</button></div>';
    el("active").appendChild(c);
    el("send").addEventListener("click", submitTyped);
    el("stop").addEventListener("click", () => goConfirm());
    const ta = el("input");
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitTyped(); }
    });
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    });
  }

  function answer(chosen) {
    if (!chosen.length || state.busy) return;
    // 用户看见的是 label，模型需要的是能写进文档的那句——两个都给它。
    const shown = chosen.map((c) => c.label).join("、");
    const forModel = chosen.map((c) => c.doc || c.label).join("；");
    // 告诉服务端这一答对应哪个槽位，模型忘了 patch 也不会丢
    if (state.ask) state.pending = { slot: state.ask.slot, value: chosen.map((c) => c.doc || c.label) };
    archive(shown);
    state.messages.push({ role: "user", content: forModel });
    runTurn();
  }

  function submitTyped() {
    const ta = el("input");
    if (!ta) return;
    const v = ta.value.trim();
    if (!v || state.busy) return;
    ta.value = "";
    if (state.phase === "empty") { start(v); return; }
    if (state.ask) state.pending = { slot: state.ask.slot, value: v };
    archive(v);
    state.messages.push({ role: "user", content: v });
    runTurn();
  }

  /* ================= 确认 ================= */
  function goConfirm() {
    state.phase = "confirm";
    setPrdVisible(true);
    el("top-title").textContent = "通读并确认";
    el("top-en").textContent = "Review & confirm";
    el("stage").className = "stage";
    el("stage").innerHTML =
      '<h2 class="lede">这份文档就是它将来的样子</h2>' +
      '<p class="sub">你确认了它才会被造出来。哪一节不对，回去再说两句。</p>' +
      '<div id="confirm-doc"></div>' +
      '<div class="multi-foot" style="margin-top:20px">' +
      '<button class="btn-solid" id="go-build" type="button">就照这个造</button>' +
      '<button class="btn-quiet" id="go-back" type="button">这里不对，我再说说</button>' +
      '<button class="btn-quiet" id="go-print" type="button">打印 / 存成 PDF</button></div>' +
      '<div id="build-err"></div>';
    el("confirm-doc").innerHTML = docHtml("cf-");
    el("go-build").addEventListener("click", goBuild);
    el("go-back").addEventListener("click", () => {
      state.phase = "chat";
      el("top-title").textContent = "造一个助手";
      el("top-en").textContent = "Build an assistant";
      shell();
      runTurn();
    });
    el("go-print").addEventListener("click", () => window.print());
    renderDoc();
    toTop();
  }

  /* ================= 组装 ================= */
  const BUILD = ["正在组装", "正在写它的工作步骤", "装好了"];

  async function goBuild() {
    state.phase = "build";
    setPrdVisible(true);
    el("top-title").textContent = "正在组装";
    el("top-en").textContent = "Assembling";
    el("stage").className = "stage";
    el("stage").innerHTML =
      '<div class="build"><h2>正在把它造出来</h2>' +
      '<span class="build-en">Assembling your assistant</span><div class="steps">' +
      BUILD.map((s, i) => `<div class="step" id="step-${i}"><span class="dot" aria-hidden="true"></span><span>${s}</span></div>`).join("") +
      '</div><div id="build-err"></div></div>';
    renderDoc();
    toTop();

    let i = 0;
    const tick = setInterval(() => {
      if (i > 0) el(`step-${i - 1}`).className = "step was";
      if (i < BUILD.length - 1) el(`step-${i}`).className = "step now";
      i += 1;
      if (i >= BUILD.length - 1) clearInterval(tick);
    }, 1200);

    try {
      const response = await fetch("/api/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: state.draft, turns: state.turn }),
      });
      const data = await response.json();
      clearInterval(tick);
      if (!response.ok || data.ok === false) throw new Error(data.error || `组装失败（${response.status}）`);
      state.app = data;
      for (let k = 0; k < BUILD.length; k += 1) el(`step-${k}`).className = "step was";
      await loadApps();
      setTimeout(() => goApp(data.slug), 500);
    } catch (e) {
      clearInterval(tick);
      const box = el("build-err");
      if (box) {
        box.className = "err";
        box.textContent = `没造出来：${e.message}`;
      }
      state.phase = "confirm";
    }
  }

  /* ================= 助手主页（原生，不再 iframe 嵌 DSH） =========
   *
   * 用户在访谈里描述的是「定期跑一次、给我一份东西」，那是个活儿，不是聊天。
   * 所以助手的主界面是：它会做什么 → 让它跑一次 → 看产出。
   * DSH 的完整聊天界面退居「跟它细聊」，需要的时候才打开。
   */

  /** 极简 Markdown：交付物是助手写的，只会用到标题、列表、粗体这几样。 */
  function md(src) {
    const inline = (t) =>
      esc(t)
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(src).split("\n")) {
      const line = raw.trimEnd();
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      const ul = /^[-*]\s+(.*)$/.exec(line);
      const ol = /^\d+[.)]\s+(.*)$/.exec(line);
      if (h) { closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); }
      else if (ul) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(ul[1])}</li>`); }
      else if (ol) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ol[1])}</li>`); }
      else if (line === "") closeList();
      else { closeList(); out.push(`<p>${inline(line)}</p>`); }
    }
    closeList();
    return out.join("");
  }

  function when(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay
      ? `今天 ${p(d.getHours())}:${p(d.getMinutes())}`
      : `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function runsHtml(runs) {
    if (!runs.length) {
      return '<div class="runs-empty">还没跑过。点上面那个按钮，它就开始干活。</div>';
    }
    return (
      '<div class="runs">' +
      runs
        .map(
          (r) =>
            `<button class="run-item${r.status === "failed" ? " bad" : ""}" data-run="${esc(r.id)}">` +
            `<span class="run-when">${esc(when(r.startedAt))}</span>` +
            `<span class="run-preview">${esc(r.status === "failed" ? r.error || "没跑成" : r.preview || "（空）")}</span>` +
            `<span class="run-ms">${(r.ms / 1000).toFixed(1)}s</span></button>`,
        )
        .join("") +
      "</div>"
    );
  }

  /**
   * 右栏那份需求文档只在「造助手」的过程中有意义——它是对话的实时投影。
   * 看一个已有助手时它是空的，一栏「还没聊到」的骨架，纯噪音。
   * 收起来，中间那栏也就有了该有的宽度。
   */
  function setPrdVisible(on) {
    document.body.classList.toggle("no-prd", !on);
  }

  function kb(bytes) {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }

  /**
   * 资料区。
   *
   * 这是产品最容易被忽略、却最致命的一块：助手造出来了，但没人给它东西看。
   * 实测那种情况下它会满目录翻 80 秒，最后交回一份空清单——用户根本不知道
   * 问题出在自己没放资料。所以没有资料时这里说得很直白。
   */
  function materialsHtml(mats) {
    if (!mats.length) {
      return (
        '<div class="mat-empty">还是空的。它只看得见这里的东西——' +
        "什么都不放，它跑出来的就是一份空的。</div>"
      );
    }
    return (
      '<p class="mat-note">它干活时写下的东西也会落在这儿，下次跑还看得见。' +
      "不想要的直接删掉。</p>" +
      '<div class="mats">' +
      mats
        .map(
          (m) =>
            `<div class="mat"><span class="mat-name">${esc(m.name)}</span>` +
            `<span class="mat-size">${kb(m.bytes)}</span>` +
            `<button class="mat-x" type="button" data-mat="${esc(m.name)}" aria-label="删掉">×</button></div>`,
        )
        .join("") +
      "</div>"
    );
  }

  async function saveMaterial(slug, name, text, remove) {
    const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/materials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(remove ? { name, remove: true } : { name, text }),
    });
    const d = await r.json();
    if (!r.ok || d.ok === false) throw new Error(d.error || "没存上");
    return d.materials || [];
  }

  /** 把资料区重新画一遍并接上事件。加完/删完都走这里。 */
  function paintMaterials(slug, mats) {
    const box = el("mat-box");
    if (!box) return;
    box.innerHTML = materialsHtml(mats) +
      '<button class="add-mat" id="add-mat" type="button">＋ 加一份资料</button>' +
      '<div id="mat-form"></div><div id="mat-err"></div>';
    el("add-mat").addEventListener("click", () => openMaterialForm(slug));
    for (const b of box.querySelectorAll(".mat-x")) {
      b.addEventListener("click", async () => {
        try {
          paintMaterials(slug, await saveMaterial(slug, b.dataset.mat, "", true));
        } catch (e) {
          const err = el("mat-err");
          if (err) { err.className = "err"; err.textContent = e.message; }
        }
      });
    }
  }

  function openMaterialForm(slug) {
    const form = el("mat-form");
    if (!form) return;
    el("add-mat").disabled = true;
    form.innerHTML =
      '<div class="mat-form">' +
      '<input id="mat-name" type="text" placeholder="给它起个名字，比如「八月客户往来」" spellcheck="false">' +
      '<textarea id="mat-text" rows="7" placeholder="把内容粘进来。会议记录、邮件、清单、随手记的东西都行。"></textarea>' +
      '<div class="multi-foot"><button class="btn-solid" id="mat-save" type="button">存进去</button>' +
      '<button class="btn-quiet" id="mat-cancel" type="button">算了</button></div></div>';
    el("mat-name").focus();
    el("mat-cancel").addEventListener("click", () => {
      form.innerHTML = "";
      el("add-mat").disabled = false;
    });
    el("mat-save").addEventListener("click", async () => {
      const name = el("mat-name").value.trim();
      const text = el("mat-text").value;
      const err = el("mat-err");
      err.className = "";
      err.textContent = "";
      if (!name) { err.className = "err"; err.textContent = "先给它起个名字"; return; }
      if (!text.trim()) { err.className = "err"; err.textContent = "内容是空的"; return; }
      el("mat-save").disabled = true;
      try {
        paintMaterials(slug, await saveMaterial(slug, name, text, false));
      } catch (e) {
        err.className = "err";
        err.textContent = e.message;
        el("mat-save").disabled = false;
      }
    });
  }

  /** 助手主页。 */
  async function goApp(slug) {
    state.phase = "app";
    setPrdVisible(false);
    el("meters").hidden = true;
    el("stage").className = "stage";
    el("stage").innerHTML = '<div class="build"><h2>正在打开</h2></div>';
    toTop();

    let app = (state.apps || []).find((a) => a.slug === slug);
    if (!app) {
      await loadApps();
      app = (state.apps || []).find((a) => a.slug === slug);
    }
    if (!app) {
      el("stage").innerHTML = '<div class="err">找不到这个助手</div>';
      return;
    }
    state.app = app;

    let runs = [];
    let mats = [];
    try {
      const [runsRes, matsRes] = await Promise.all([
        fetch(`/api/apps/${encodeURIComponent(slug)}/runs`),
        fetch(`/api/apps/${encodeURIComponent(slug)}/materials`),
      ]);
      const rd = await runsRes.json();
      const md_ = await matsRes.json();
      runs = Array.isArray(rd.runs) ? rd.runs : [];
      mats = Array.isArray(md_.materials) ? md_.materials : [];
    } catch { /* 读不出来不该挡住「跑一次」 */ }

    el("top-title").textContent = app.name;
    el("top-en").textContent = "Your assistant";

    const steps = (app.workflow && app.workflow.steps) || [];
    const bounds = app.boundaries || [];
    el("stage").innerHTML =
      '<div class="appview">' +
      `<h2 class="lede">${esc(app.name)}</h2>` +
      `<p class="sub">${esc(app.description)}</p>` +
      '<div class="card-row">' +
      (steps.length
        ? '<section class="card"><div class="card-h">它会做的事</div><ol class="card-ol">' +
          steps.map((x) => `<li>${esc(x)}</li>`).join("") +
          "</ol></section>"
        : "") +
      '<section class="card wide-card"><div class="card-h">它的资料夹</div>' +
      '<div id="mat-box"></div></section>' +
      '<section class="card"><div class="card-h">你会拿到</div>' +
      `<p class="card-lead">${esc(app.delivery.form)}</p>` +
      (bounds.length
        ? '<div class="card-h sub-h">它不会做</div><ul class="card-ul">' +
          bounds.map((x) => `<li>${esc(x)}</li>`).join("") +
          "</ul>"
        : "") +
      "</section></div>" +
      '<div class="multi-foot run-bar">' +
      '<button class="btn-solid" id="do-run" type="button">让它跑一次</button>' +
      (app.hasPrd ? '<button class="btn-quiet" id="see-prd" type="button">看需求文档</button>' : "") +
      '<button class="btn-quiet" id="deep-chat" type="button">跟它细聊</button>' +
      "</div>" +
      '<div class="runs-h">最近的产出</div>' +
      runsHtml(runs) +
      "</div>";

    paintMaterials(slug, mats);
    el("do-run").addEventListener("click", () => runApp(slug));
    if (el("see-prd")) {
      el("see-prd").addEventListener("click", () => {
        window.open(`/api/apps/${encodeURIComponent(slug)}/prd.md`, "_blank");
      });
    }
    el("deep-chat").addEventListener("click", () => goDeepChat(slug));
    for (const b of el("stage").querySelectorAll(".run-item")) {
      b.addEventListener("click", () => openRun(slug, b.dataset.run));
    }
  }

  /** 跑一次。SSE：白话进度 + 助手的话，结束落到结果页。 */
  async function runApp(slug) {
    state.phase = "run";
    setPrdVisible(false);
    el("stage").className = "stage";
    el("stage").innerHTML =
      '<div class="running"><h2 class="lede">它正在干活</h2>' +
      '<p class="sub">通常十几秒。跑完的东西会存下来，随时能回头看。</p>' +
      '<div class="steps live" id="live"></div>' +
      '<div class="live-text" id="live-text"></div>' +
      '<div id="run-err"></div></div>';
    toTop();

    const live = el("live");
    const liveText = el("live-text");
    let lastStep = null;
    const addStep = (text) => {
      if (lastStep) lastStep.className = "step was";
      const d = document.createElement("div");
      d.className = "step now";
      d.innerHTML = '<span class="dot" aria-hidden="true"></span><span></span>';
      d.querySelector("span:last-child").textContent = text;
      live.appendChild(d);
      lastStep = d;
      d.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" });
    };

    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(slug)}/run`, { method: "POST" });
      if (!response.ok || !response.body) throw new Error(`跑不起来（${response.status}）`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = null;
      let failed = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          let event = "message", data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          const payload = JSON.parse(data);
          if (event === "step") addStep(payload.text);
          else if (event === "text") liveText.textContent = payload.text;
          else if (event === "done") finished = payload;
          else if (event === "error") failed = payload;
        }
      }

      if (lastStep) lastStep.className = "step was";
      if (failed) {
        if (failed.needsKey) { await loadSettings(); renderSettings({ reason: "还没设置模型 key，先把它配上。" }); return; }
        throw new Error(failed.error || "没跑成");
      }
      if (!finished) throw new Error("连接中断了");
      renderResult(slug, finished.run, finished.output);
    } catch (e) {
      const box = el("run-err");
      if (box) { box.className = "err"; box.textContent = `没跑成：${e.message}`; }
      const back = document.createElement("button");
      back.className = "btn-quiet";
      back.type = "button";
      back.textContent = "返回";
      back.style.marginTop = "16px";
      back.addEventListener("click", () => goApp(slug));
      el("stage").querySelector(".running").appendChild(back);
    }
  }

  async function openRun(slug, id) {
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/runs/${encodeURIComponent(id)}`);
      const d = await r.json();
      if (d.ok === false) throw new Error(d.error);
      renderResult(slug, d.run, d.output);
    } catch (e) {
      el("stage").innerHTML = `<div class="err">打不开这次记录：${esc(e.message)}</div>`;
    }
  }

  /** 结果页 —— 产品真正交付的那一屏。 */
  function renderResult(slug, run, output) {
    state.phase = "result";
    setPrdVisible(false);
    el("stage").className = "stage";
    el("top-title").textContent = (state.app && state.app.name) || "产出";
    el("top-en").textContent = "Result";
    const failed = run.status === "failed";
    el("stage").innerHTML =
      '<div class="result">' +
      '<div class="result-bar">' +
      `<div><div class="result-when">${esc(when(run.startedAt))}</div>` +
      `<div class="result-meta">用时 ${(run.ms / 1000).toFixed(1)} 秒</div></div>` +
      '<div class="result-acts">' +
      '<button class="btn-quiet" id="r-copy" type="button">复制</button>' +
      '<button class="btn-quiet" id="r-print" type="button">打印 / 存 PDF</button>' +
      '<button class="btn-solid" id="r-again" type="button">再跑一次</button>' +
      "</div></div>" +
      (failed
        ? `<div class="err">没跑成：${esc(run.error || "")}</div>`
        : `<article class="paper">${md(output)}</article>`) +
      '<div class="multi-foot"><button class="btn-quiet" id="r-back" type="button">← 回到助手</button></div>' +
      "</div>";
    el("r-back").addEventListener("click", () => goApp(slug));
    el("r-again").addEventListener("click", () => runApp(slug));
    el("r-print").addEventListener("click", () => {
      // 默认的打印样式是给右栏那份需求文档用的；印交付物要临时反过来。
      document.body.classList.add("print-result");
      window.print();
      setTimeout(() => document.body.classList.remove("print-result"), 0);
    });
    el("r-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(output);
        el("r-copy").textContent = "已复制";
        setTimeout(() => { el("r-copy").textContent = "复制"; }, 1500);
      } catch {
        el("r-copy").textContent = "复制不了";
      }
    });
    toTop();
  }

  /** 跟它细聊 —— 打开 DSH 的完整界面。次要入口，不再是主路径。 */
  async function goDeepChat(slug) {
    state.phase = "chatting";
    setPrdVisible(false);
    el("top-title").textContent = (state.app && state.app.name) || "细聊";
    el("top-en").textContent = "Talk it through";
    el("stage").className = "stage wide";
    el("stage").innerHTML = '<div class="build"><h2>正在打开对话</h2><span class="build-en">Starting</span></div>';
    try {
      await fetch("/api/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: slug }),
      });
      const r = await fetch("/api/dsh");
      const d = await r.json();
      if (d.ok === false) throw new Error(d.error);
      el("dsh-state").textContent = "运行中";
      el("stage").innerHTML =
        '<div class="chat-bar"><button class="btn-quiet" id="chat-back" type="button">← 回到助手</button>' +
        '<span class="chat-note">这是完整的对话界面，适合来回商量。跑固定活儿用「让它跑一次」更省事。</span></div>' +
        `<iframe class="runtime" title="对话" src="/runtime/?agent=${encodeURIComponent(slug)}"></iframe>`;
      el("chat-back").addEventListener("click", () => goApp(slug));
    } catch (e) {
      el("stage").className = "stage";
      el("stage").innerHTML =
        `<div class="err">对话界面没起来：${esc(e.message)}</div>` +
        '<div class="multi-foot"><button class="btn-quiet" id="chat-back2" type="button">← 回到助手</button></div>';
      el("chat-back2").addEventListener("click", () => goApp(slug));
    }
  }

  /* ================= 我的助手 ================= */
  async function loadApps() {
    try {
      const r = await fetch("/api/apps");
      const d = await r.json();
      const apps = Array.isArray(d.apps) ? d.apps : [];
      state.apps = apps;
      el("app-count").textContent = String(apps.length);
      const list = el("app-list");
      list.innerHTML = "";
      if (apps.length === 0) {
        list.innerHTML = '<div class="side-empty">还没有助手</div>';
        return;
      }
      for (const app of apps) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "side-item" + (state.app && state.app.slug === app.slug ? " on" : "");
        b.innerHTML = '<span class="side-dot" aria-hidden="true"></span><span></span>';
        b.querySelector("span:last-child").textContent = app.name;
        b.addEventListener("click", () => { state.app = app; goApp(app.slug); });
        list.appendChild(b);
      }
    } catch {
      /* 侧栏读不出来不该挡住主流程 */
    }
  }

  /* ================= 模型设置 ================= */
  async function loadSettings() {
    try {
      const r = await fetch("/api/settings");
      state.settings = await r.json();
    } catch {
      state.settings = { ok: false, hasKey: false };
    }
    const dot = el("key-dot");
    if (dot) dot.classList.toggle("on", Boolean(state.settings && state.settings.hasKey));
    return state.settings;
  }

  /**
   * 设置界面。没配 key 时它就是第一屏——配置模型是使用产品的第一步，
   * 不该等到聊了半天才被「缺少 key」拦住。
   */
  function renderSettings(options) {
    const opts = options || {};
    setPrdVisible(false);
    const cfg = state.settings || {};
    state.phase = "settings";
    el("meters").hidden = true;
    el("top-title").textContent = opts.firstRun ? "先配一下模型" : "模型设置";
    el("top-en").textContent = "Model settings";
    el("stage").className = "stage";
    el("stage").innerHTML =
      `<h2 class="lede">${opts.firstRun ? "先把模型接上" : "模型设置"}</h2>` +
      `<p class="sub">${
        opts.firstRun
          ? "万象靠 DeepSeek 的模型跟你对话、造助手。填一把 key 就能开始，它只存在你自己电脑上。"
          : "改完会先验证再保存。造好的助手运行时也用这把 key。"
      }</p>` +
      (opts.reason ? `<div class="setup-state bad">${esc(opts.reason)}</div>` : "") +
      '<div class="setup">' +
      '<div class="field"><label for="k">模型 key</label>' +
      `<p class="note">在 platform.deepseek.com 的 API keys 页面申请，形如 sk-…${
        cfg.hasKey ? `。当前已保存：<b>${esc(cfg.masked || "")}</b>` : ""
      }</p>` +
      `<input id="k" type="password" autocomplete="off" spellcheck="false" placeholder="${
        cfg.hasKey ? "留空则保持不变" : "sk-…"
      }"></div>` +
      '<details class="adv"><summary>高级：换服务地址或模型</summary>' +
      '<div class="field"><label for="b">服务地址</label>' +
      `<input id="b" type="text" spellcheck="false" value="${esc(cfg.baseUrl || "")}"></div>` +
      '<div class="field"><label for="m">模型</label>' +
      `<input id="m" type="text" spellcheck="false" value="${esc(cfg.model || "")}"></div></details>` +
      '<div class="multi-foot"><button class="btn-solid" id="save-key" type="button">验证并保存</button>' +
      (cfg.hasKey && !opts.firstRun
        ? '<button class="btn-quiet" id="settings-back" type="button">返回</button>'
        : "") +
      '</div><div id="setup-state"></div>' +
      (cfg.envOverride
        ? '<div class="setup-path">注意：当前生效的是环境变量 DEEPSEEK_API_KEY，它的优先级高于这里保存的值。想用这里的设置，先把那个环境变量取消掉。</div>'
        : "") +
      (cfg.configPath ? `<div class="setup-path">存在 ${esc(cfg.configPath)}（权限 0600）</div>` : "") +
      "</div>";

    const stateBox = el("setup-state");
    const save = el("save-key");
    save.addEventListener("click", async () => {
      const key = el("k").value.trim();
      if (!key) {
        stateBox.className = "setup-state bad";
        stateBox.textContent = cfg.hasKey ? "没改就直接返回吧，留空不会覆盖已保存的 key。" : "先填一把 key。";
        return;
      }
      save.disabled = true;
      stateBox.className = "setup-state busy";
      stateBox.textContent = "正在验证…";
      try {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey: key, baseUrl: el("b").value.trim(), model: el("m").value.trim() }),
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || `保存失败（${r.status}）`);
        state.settings = d;
        const dot = el("key-dot");
        if (dot) dot.classList.add("on");
        stateBox.className = "setup-state ok";
        stateBox.textContent = "验证通过，已保存。";
        setTimeout(restart, 700);
      } catch (e) {
        stateBox.className = "setup-state bad";
        stateBox.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    });
    const back = el("settings-back");
    if (back) back.addEventListener("click", restart);
    toTop();
  }

  /* ================= 空状态 ================= */
  async function restart() {
    Object.assign(state, {
      phase: "empty", messages: [], draft: { slots: {}, derived: {} },
      turn: 0, answered: 0, busy: false, app: null, pending: null, ask: null,
      apps: state.apps || [],
    });
    setPrdVisible(true);
    const cfg = await loadSettings();
    // 没有 key 就别装作能用。第一屏直接给设置，而不是让他聊到一半撞墙。
    if (!cfg || !cfg.hasKey) {
      renderSettings({ firstRun: true });
      loadApps();
      return;
    }
    el("meters").hidden = true;
    el("top-title").textContent = "造一个助手";
    el("top-en").textContent = "Build an assistant";
    el("stage").className = "stage";
    el("stage").innerHTML =
      '<h2 class="lede">你想让它长期帮你干什么？</h2>' +
      `<p class="sub">${OPENING_SUB}</p>` +
      '<div class="examples" id="examples"></div>' +
      '<div class="composer" id="empty-composer"></div>';
    const grid = el("examples");
    EXAMPLES.forEach((e) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "example";
      b.innerHTML = `<span class="example-t">${esc(e.t)}</span><span class="example-d">${esc(e.d)}</span>`;
      b.addEventListener("click", () => start(e.t));
      grid.appendChild(b);
    });
    el("empty-composer").innerHTML =
      '<div class="composer-box">' +
      '<textarea id="input" rows="1" placeholder="或者直接说你想让它干什么" aria-label="你的需求"></textarea>' +
      '<button class="send" id="send" type="button" aria-label="发送">→</button></div>';
    el("send").addEventListener("click", submitTyped);
    el("input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitTyped(); }
    });
    renderDoc();
    loadApps();
    toTop();
  }

  function start(firstLine) {
    state.phase = "chat";
    el("meters").hidden = false;
    shell();
    state.messages.push({ role: "user", content: firstLine });
    const item = document.createElement("div");
    item.className = "hist-item";
    item.innerHTML = '<div class="hist-a"><span class="hist-a-k">你说</span><span class="hist-a-v"></span></div>';
    item.querySelector(".hist-a-v").textContent = firstLine;
    el("hist").appendChild(item);
    el("hist-label").classList.remove("hidden");
    renderDoc();
    runTurn();
  }

  /* ================= 接线 ================= */
  el("restart").addEventListener("click", () => { void restart(); });
  el("open-settings").addEventListener("click", async () => {
    await loadSettings();
    renderSettings({});
  });
  el("to-confirm").addEventListener("click", () => goConfirm());
  el("expand").addEventListener("click", () => {
    el("overlay-doc").innerHTML = docHtml("ov-");
    el("overlay").classList.remove("hidden");
  });
  el("overlay-close").addEventListener("click", () => el("overlay").classList.add("hidden"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") el("overlay").classList.add("hidden");
  });

  void restart();
})();

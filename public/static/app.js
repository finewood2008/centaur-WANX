import { esc, md, sseFrames } from "./lib.js";

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const el = (id) => document.getElementById(id);

(() => {
  "use strict";

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

  async function streamTurn(onDelta) {
    const response = await fetch("/wanx/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.messages,
        draft: state.draft,
        turn: state.turn,
        answered: state.pending,
      }),
    });
    if (!response.ok || !response.body) throw new Error(`请求失败（${response.status}）`);
    for await (const { event, data } of sseFrames(response)) {
      if (event === "delta") onDelta(data.text);
      else if (event === "error") {
        const err = new Error(data.error);
        err.needsKey = data.needsKey === true;
        throw err;
      } else if (event === "done") return data;
    }
    throw new Error("连接中断了");
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
      const response = await fetch("/wanx/api/finalize", {
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

  /* ================= 助手主页 ====================================
   *
   * 用户在访谈里描述的是「定期跑一次、给我一份东西」，那是个活儿，不是聊天。
   * 所以助手的主界面是：它会做什么 → 让它跑一次 → 看产出。
   * 多轮对话是万象自己的界面（goTalk），跑一次也能从对话里发起。
   * Markdown 渲染与 SSE 解析都在 ./lib.js 里，三条流共用一份。
   */

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

  /**
   * 定时卡。兑现访谈里「每周固定跑一次」那类承诺——万象开着，到点它就自己跑，
   * 产出照常进「最近的产出」。宕机漏掉的只补最新一次，不会补跑风暴。
   */
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function paintSchedule(slug, sched) {
    const box = el("sched-box");
    if (!box) return;
    const s = sched || { enabled: false, every: "day", at: "09:00", weekday: 1 };
    const desc = !s.enabled
      ? "没开。它只在你按「让它跑一次」时干活。"
      : s.every === "hour" ? "每小时整点自动跑一次。"
      : s.every === "day" ? `每天 ${esc(s.at || "09:00")} 自动跑一次。`
      : `每${WEEKDAYS[s.weekday ?? 1]} ${esc(s.at || "09:00")} 自动跑一次。`;
    box.innerHTML =
      `<p class="card-lead" style="font-weight:500;font-size:14px">${desc}</p>` +
      '<div class="mat-form" style="margin-top:8px">' +
      `<label style="display:block;margin-bottom:6px"><input id="sc-on" type="checkbox"${s.enabled ? " checked" : ""}> 到点自动跑</label>` +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
      `<select id="sc-every">` +
      `<option value="hour"${s.every === "hour" ? " selected" : ""}>每小时</option>` +
      `<option value="day"${s.every === "day" ? " selected" : ""}>每天</option>` +
      `<option value="week"${s.every === "week" ? " selected" : ""}>每周</option></select>` +
      `<select id="sc-wd"${s.every !== "week" ? ' style="display:none"' : ""}>` +
      WEEKDAYS.map((w, i) => `<option value="${i}"${(s.weekday ?? 1) === i ? " selected" : ""}>${w}</option>`).join("") +
      "</select>" +
      `<input id="sc-at" type="time" value="${esc(s.at || "09:00")}"${s.every === "hour" ? ' style="display:none"' : ""}>` +
      '<button class="add-mat" id="sc-save" type="button">保存</button></div>' +
      '<div id="sc-err"></div></div>';

    el("sc-every").addEventListener("change", () => {
      const v = el("sc-every").value;
      el("sc-wd").style.display = v === "week" ? "" : "none";
      el("sc-at").style.display = v === "hour" ? "none" : "";
    });
    el("sc-save").addEventListener("click", async () => {
      const err = el("sc-err");
      err.className = ""; err.textContent = "";
      const payload = {
        enabled: el("sc-on").checked,
        every: el("sc-every").value,
        at: el("sc-at").value || "09:00",
        weekday: Number(el("sc-wd").value),
      };
      try {
        const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || "没存上");
        paintSchedule(slug, d.schedule);
      } catch (e) {
        err.className = "err"; err.textContent = e.message;
      }
    });
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
    const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/materials`, {
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

  /* ================= 工作台 ========================================
   *
   * 打开一个助手 = 打开一个为它的活儿生的工作台。形态由蓝图决定——
   * 蓝图是 app.yml 的纯函数投影（服务端现算随 /api/apps 下发），
   * 前端从这里的固定组件库拼装：hero（checklist/table/digest 三型，
   * 呈现最新交付物）+ 侧区组件（actions/materials/params/schedule/manual/runs）。
   * 没有生成代码，没有注入面；所有动态内容一律过 esc()/md()。
   */

  /** 助手主页（工作台）。 */
  async function goApp(slug) {
    leaveTalk();
    state.phase = "app";
    setPrdVisible(false);
    el("meters").hidden = true;
    el("stage").className = "stage board";
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

    const bp = app.blueprint || {
      hero: { kind: "digest", title: "最新产出", empty: "放入资料，按一下「让它跑一次」。" },
      side: ["actions", "materials", "schedule", "manual", "runs"],
    };

    let runs = [];
    let mats = [];
    let sched = null;
    let paramValues = {};
    let manual = null;
    try {
      const [runsRes, matsRes, schedRes, paramsRes, manualRes] = await Promise.all([
        fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/runs`),
        fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/materials`),
        fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/schedule`),
        fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/params`),
        fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/manual`),
      ]);
      const rd = await runsRes.json();
      const md_ = await matsRes.json();
      const sd = await schedRes.json();
      const pd = await paramsRes.json().catch(() => ({}));
      manual = await manualRes.json().catch(() => null);
      runs = Array.isArray(rd.runs) ? rd.runs : [];
      mats = Array.isArray(md_.materials) ? md_.materials : [];
      sched = sd && sd.schedule ? sd.schedule : null;
      paramValues = pd && pd.values ? pd.values : {};
    } catch { /* 读不出来不该挡住工作台 */ }

    el("top-title").textContent = app.name;
    el("top-en").textContent = "Your assistant";

    el("stage").innerHTML =
      '<div class="appview">' +
      `<h2 class="lede">${esc(app.name)}</h2>` +
      `<p class="sub">${esc(app.description)}</p>` +
      '<div class="wb">' +
      '<section class="wb-hero card">' +
      `<div class="card-h">${esc(bp.hero.title)}</div><div id="wb-hero"></div>` +
      "</section>" +
      '<div class="wb-side" id="wb-side"></div>' +
      "</div></div>";

    renderHero(slug, bp.hero, runs);

    // 侧区按蓝图顺序拼装。每个组件一张卡，容器 id 与既有 paint* 保持兼容。
    const side = el("wb-side");
    const widgets = {
      actions() {
        return card(
          "操作",
          '<div class="wb-actions">' +
            '<button class="btn-solid" id="do-run" type="button">让它跑一次</button>' +
            '<button class="btn-quiet" id="deep-chat" type="button">跟它聊聊</button>' +
            '<button class="btn-quiet" id="wb-tune" type="button">调教它</button>' +
            (app.hasPrd ? '<button class="btn-quiet" id="see-prd" type="button">看需求文档</button>' : "") +
            '</div><div id="wb-tune-slot"></div>',
        );
      },
      materials() {
        return card("它的资料夹", '<div id="mat-box"></div>', "wide");
      },
      params() {
        return card("可调的", '<div id="param-box"></div>');
      },
      schedule() {
        return card("定时", '<div id="sched-box"></div>');
      },
      manual() {
        return card("工作手册", '<div id="manual-box"></div>');
      },
      runs() {
        return card(
          "历史",
          '<div class="runs-h" style="margin-top:0">最近的产出</div><div id="runs-box"></div>' +
            '<div class="runs-h">聊过的</div><div id="chat-list" class="runs"><div class="runs-empty">正在看…</div></div>',
          "wide",
        );
      },
    };
    for (const kind of bp.side) {
      if (widgets[kind]) side.appendChild(widgets[kind]());
    }

    // 接线（组件都进了 DOM 之后）。
    paintMaterials(slug, mats);
    paintSchedule(slug, sched);
    if (el("param-box")) paintParams(slug, app.params || [], paramValues);
    if (el("manual-box")) paintManual(slug, manual);
    const runsBox = el("runs-box");
    if (runsBox) {
      runsBox.innerHTML = runsHtml(runs);
      for (const b of runsBox.querySelectorAll(".run-item")) {
        b.addEventListener("click", () => openRun(slug, b.dataset.run));
      }
    }
    el("do-run").addEventListener("click", () => runApp(slug));
    el("deep-chat").addEventListener("click", () => goTalk(slug));
    el("wb-tune").addEventListener("click", () => openTuneForm(slug, null, el("wb-tune-slot")));
    if (el("see-prd")) {
      el("see-prd").addEventListener("click", () => {
        window.open(`/wanx/api/apps/${encodeURIComponent(slug)}/prd.md`, "_blank");
      });
    }
    void paintChatList(slug);
  }

  function card(title, bodyHtml, extraCls) {
    const sec = document.createElement("section");
    sec.className = `card${extraCls ? " " + extraCls : ""}`;
    sec.innerHTML = `<div class="card-h">${esc(title)}</div>${bodyHtml}`;
    return sec;
  }

  /** hero：最新一次成功产出的结构化呈现。没跑过 = 空态即引导。 */
  async function renderHero(slug, hero, runs) {
    const box = el("wb-hero");
    if (!box) return;
    const latest = (runs || []).find((r) => r.status === "ok");
    if (!latest) {
      box.innerHTML =
        `<div class="wb-empty">${esc(hero.empty)}</div>` +
        '<ol class="wb-guide"><li>把资料放进「它的资料夹」</li><li>按「让它跑一次」</li><li>回到这里收东西</li></ol>';
      return;
    }
    box.innerHTML = '<div class="runs-empty">正在取最新产出…</div>';
    let output = "";
    try {
      const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/runs/${encodeURIComponent(latest.id)}`);
      const d = await r.json();
      if (d.ok === false) throw new Error(d.error);
      output = d.output || "";
    } catch {
      box.innerHTML = '<div class="err">最新产出读不出来，去「历史」里翻吧。</div>';
      return;
    }

    const meta =
      `<div class="wb-meta">${esc(when(latest.startedAt))} · 用时 ${(latest.ms / 1000).toFixed(1)} 秒` +
      (typeof latest.manualVersion === "number" ? ` · 手册第 ${latest.manualVersion} 版` : "") +
      ' · <button class="linkish" id="hero-open" type="button">看完整产出</button>' +
      ' · <button class="linkish" id="hero-copy" type="button">复制</button></div>';

    if (hero.kind === "checklist") {
      const items = extractListItems(output);
      box.innerHTML = items.length
        ? `<div class="chk">${items
            .map(
              (i) =>
                `<div class="chk-row${i.done ? " done" : ""}"><span class="chk-box">${i.done ? "☑" : "☐"}</span><span>${esc(i.text)}</span></div>`,
            )
            .join("")}</div>` + meta
        : `<article class="paper wb-paper">${md(output)}</article>` + meta;
    } else if (hero.kind === "table") {
      const t = extractTables(output)[0];
      box.innerHTML = t
        ? '<div class="md-table wb-table"><table><thead><tr>' +
          t.head.map((c) => `<th>${esc(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          t.rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>" + meta
        : `<article class="paper wb-paper">${md(output)}</article>` + meta;
    } else {
      box.innerHTML = `<article class="paper wb-paper">${md(output)}</article>` + meta;
    }
    el("hero-open").addEventListener("click", () => openRun(slug, latest.id));
    el("hero-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(output);
        el("hero-copy").textContent = "已复制";
      } catch { el("hero-copy").textContent = "复制不了"; }
    });
  }

  /** 「可调的」组件：按声明出控件，显式保存；跑一次和定时都用存好的值。 */
  function paintParams(slug, schema, values) {
    const box = el("param-box");
    if (!box) return;
    const control = (p) => {
      const v = values[p.name] ?? p.default ?? "";
      const id = `pf-${esc(p.name)}`;
      if (p.type === "enum") {
        return `<select id="${id}" data-p="${esc(p.name)}">` +
          `<option value=""${v === "" ? " selected" : ""}>（未设置）</option>` +
          (p.options || []).map((o) => `<option value="${esc(o)}"${v === o ? " selected" : ""}>${esc(o)}</option>`).join("") +
          "</select>";
      }
      if (p.type === "boolean") {
        return `<input id="${id}" data-p="${esc(p.name)}" type="checkbox"${v === true ? " checked" : ""}>`;
      }
      if (p.type === "number") return `<input id="${id}" data-p="${esc(p.name)}" type="number" value="${v === "" ? "" : esc(String(v))}">`;
      if (p.type === "date") return `<input id="${id}" data-p="${esc(p.name)}" type="date" value="${esc(String(v || ""))}">`;
      if (p.type === "list") {
        const text = Array.isArray(v) ? v.join("\n") : "";
        return `<textarea id="${id}" data-p="${esc(p.name)}" rows="3" placeholder="一行一条">${esc(text)}</textarea>`;
      }
      return `<input id="${id}" data-p="${esc(p.name)}" type="text" value="${esc(String(v || ""))}">`;
    };
    box.innerHTML =
      '<p class="mat-note">跑一次和定时都用这里存好的值。改了记得保存。</p>' +
      '<div class="mat-form">' +
      schema.map((p) => `<label class="pf-row"><span class="pf-l">${esc(p.label || p.name)}${p.required ? " *" : ""}</span>${control(p)}</label>`).join("") +
      '<div class="multi-foot"><button class="add-mat" id="pf-save" type="button">保存</button></div>' +
      '<div id="pf-err"></div></div>';
    el("pf-save").addEventListener("click", async () => {
      const err = el("pf-err");
      err.className = ""; err.textContent = "";
      const out = {};
      for (const node of box.querySelectorAll("[data-p]")) {
        const name = node.dataset.p;
        if (node.type === "checkbox") out[name] = node.checked;
        else out[name] = node.value;
      }
      try {
        const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/params`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: out }),
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || "没存上");
        err.className = "setup-state ok"; err.textContent = "存好了，下次跑就用这些值。";
      } catch (e) {
        err.className = "err"; err.textContent = e.message;
      }
    });
  }

  /** 「工作手册」组件：版本、看手册、历史、回到某版。 */
  function paintManual(slug, manual) {
    const box = el("manual-box");
    if (!box) return;
    if (!manual || manual.ok === false) {
      box.innerHTML = '<div class="mat-empty">手册读不出来。</div>';
      return;
    }
    const version = manual.synthetic ? "创建版" : `第 ${manual.version} 版`;
    const history = Array.isArray(manual.history) ? manual.history : [];
    box.innerHTML =
      `<p class="card-lead" style="font-weight:500;font-size:14px">当前：${esc(version)}</p>` +
      (manual.skillMd
        ? '<button class="btn-quiet" id="man-view" type="button">看手册</button><div id="man-doc" hidden></div>'
        : '<p class="mat-note">它还没有工作手册——提条意见，手册就长出来了（点「调教它」）。</p>') +
      (history.length > 0
        ? '<div class="man-hist">' +
          history
            .map(
              (h) =>
                `<div class="man-row"><span class="man-v">v${h.version}</span><span class="man-note">${esc(h.note || "")}</span>` +
                `<button class="linkish" data-rb="${h.version}" type="button">回到这版</button></div>`,
            )
            .join("") +
          "</div>"
        : "") +
      '<div id="man-err"></div>';
    const view = el("man-view");
    if (view) {
      view.addEventListener("click", () => {
        const doc = el("man-doc");
        if (doc.hidden) {
          doc.innerHTML = `<article class="paper wb-paper">${md(manual.skillMd)}</article>`;
          doc.hidden = false;
          view.textContent = "收起";
        } else {
          doc.hidden = true;
          view.textContent = "看手册";
        }
      });
    }
    for (const b of box.querySelectorAll("[data-rb]")) {
      b.addEventListener("click", async () => {
        const err = el("man-err");
        err.className = ""; err.textContent = "";
        b.disabled = true;
        try {
          const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/manual/rollback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ to: Number(b.dataset.rb) }),
          });
          const d = await r.json();
          if (!r.ok || d.ok === false) throw new Error(d.error || "没回去");
          await loadApps();
          goApp(slug);
        } catch (e) {
          err.className = "err"; err.textContent = e.message;
          b.disabled = false;
        }
      });
    }
  }

  /* ================= 调教 ================= */

  /** 步骤级前后对照：不做字符 diff——一边独有的划线红/标绿，全部过 esc。 */
  function sliceDiffHtml(before, after) {
    const bSet = new Set(before);
    const aSet = new Set(after);
    const col = (title, items, other, cls) =>
      `<div class="diff-col"><div class="diff-h">${title}</div><ol>` +
      items.map((s) => `<li class="${other.has(s) ? "" : cls}">${esc(s)}</li>`).join("") +
      "</ol></div>";
    return `<div class="tune-diff">${col("改之前", before, aSet, "gone")}${col("改之后", after, bSet, "add")}</div>`;
  }

  /**
   * 「这里不对」的调教表单。三处入口共用：结果页（带 runId）、对话里的
   * 运行卡（带 runId）、工作台/对话顶栏（不带）。成功后刷新 state.apps——
   * 「它会做的事」等处显示的步骤已经变了。
   */
  function openTuneForm(slug, runId, mount) {
    if (!mount) return;
    if (mount.querySelector(".tune-form")) return; // 已开着
    const wrap = document.createElement("div");
    wrap.className = "mat-form tune-form";
    wrap.innerHTML =
      '<textarea rows="3" placeholder="哪里不对？想让它以后怎么做？比如：周报要先列风险项"></textarea>' +
      '<div class="multi-foot"><button class="btn-solid tf-go" type="button">让它记住</button>' +
      '<button class="btn-quiet tf-x" type="button">算了</button></div>' +
      '<div class="tf-out"></div>';
    mount.appendChild(wrap);
    const ta = wrap.querySelector("textarea");
    const go = wrap.querySelector(".tf-go");
    const out = wrap.querySelector(".tf-out");
    ta.focus();
    wrap.querySelector(".tf-x").addEventListener("click", () => wrap.remove());
    go.addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) { out.className = "tf-out err"; out.textContent = "先说说哪里不对"; return; }
      go.disabled = true;
      out.className = "tf-out";
      out.textContent = "正在改手册…通常十几秒。";
      try {
        const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/tune`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(runId ? { text, runId } : { text }),
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) {
          if (d.needsKey) { leaveTalk(); await loadSettings(); renderSettings({ reason: "还没设置模型 key，先把它配上。" }); return; }
          throw new Error(d.error || `没改成（${r.status}）`);
        }
        if (d.changed === false) {
          out.innerHTML = `<div class="setup-state ok">${esc(d.note || "手册不用改")}</div>`;
        } else {
          out.innerHTML =
            `<div class="setup-state ok">${esc(d.note)}</div>` +
            sliceDiffHtml(d.before.steps, d.after.steps) +
            `<div class="mat-note">已更新为第 ${d.version} 版，下次跑生效；正在聊的对话，新开一条才用新手册。</div>`;
          void loadApps();
        }
        go.disabled = false;
        ta.value = "";
      } catch (e) {
        out.className = "tf-out err";
        out.textContent = e.message;
        go.disabled = false; // 反馈文本还在，能直接重试
      }
    });
  }

  /** 助手主页的「聊过的」：历史对话列表，点一条接着聊。 */
  async function paintChatList(slug) {
    const box = el("chat-list");
    if (!box) return;
    try {
      const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/chats`);
      const d = await r.json();
      const chats = Array.isArray(d.chats) ? d.chats : [];
      if (chats.length === 0) {
        box.innerHTML = '<div class="runs-empty">还没聊过。点「跟它聊聊」就能开始。</div>';
        return;
      }
      box.innerHTML = "";
      for (const c of chats) {
        const b = document.createElement("button");
        b.className = "run-item";
        b.type = "button";
        b.innerHTML = '<span class="run-when"></span><span class="run-preview"></span>';
        b.querySelector(".run-when").textContent = when(c.createdAt);
        b.querySelector(".run-preview").textContent = c.title || "新对话";
        b.addEventListener("click", () => goTalk(slug, c.sessionId));
        box.appendChild(b);
      }
    } catch {
      box.innerHTML = "";
    }
  }

  /**
   * 跑一次的 SSE 消费——助手主页的整屏视图和对话里的运行卡片共用。
   * step 是白话进度，text 是助手的话；跑完返回 done 载荷，失败抛错
   * （needsKey 标在错误对象上）。
   */
  async function streamRun(slug, hooks) {
    const response = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/run`, { method: "POST" });
    if (!response.ok || !response.body) throw new Error(`跑不起来（${response.status}）`);
    let finished = null;
    let failed = null;
    for await (const { event, data } of sseFrames(response)) {
      if (event === "step") hooks.onStep(data.text);
      else if (event === "text") hooks.onText(data.text);
      else if (event === "done") finished = data;
      else if (event === "error") failed = data;
    }
    if (failed) {
      const err = new Error(failed.error || "没跑成");
      err.needsKey = failed.needsKey === true;
      throw err;
    }
    if (!finished) throw new Error("连接中断了");
    return finished;
  }

  /** 跑一次。SSE：白话进度 + 助手的话，结束落到结果页。 */
  async function runApp(slug) {
    leaveTalk();
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
      const finished = await streamRun(slug, {
        onStep: addStep,
        onText: (t) => { liveText.textContent = t; },
      });
      if (lastStep) lastStep.className = "step was";
      renderResult(slug, finished.run, finished.output);
    } catch (e) {
      if (lastStep) lastStep.className = "step was";
      if (e.needsKey) { await loadSettings(); renderSettings({ reason: "还没设置模型 key，先把它配上。" }); return; }
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
      const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/runs/${encodeURIComponent(id)}`);
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
      // 调教入口只给成功的产出：失败页的主诉是 key/网络，手册修不了。
      (failed
        ? ""
        : '<div class="tune-box"><button class="btn-quiet" id="r-tune" type="button">这里不对？调教它</button>' +
          '<div id="r-tune-slot"></div></div>') +
      '<div class="multi-foot"><button class="btn-quiet" id="r-back" type="button">← 回到助手</button></div>' +
      "</div>";
    if (el("r-tune")) {
      el("r-tune").addEventListener("click", () => openTuneForm(slug, run.id, el("r-tune-slot")));
    }
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

  /* ================= 对话 ==========================================
   *
   * 万象自己的多轮对话界面。会话属于某个助手（建会话时 preset 与 cwd 就
   * 钉死在 header 上），切换助手 = 到那个助手名下新建或打开另一条会话——
   * 不存在任何全局「当前助手」。
   *
   * 这是全站唯一「不整屏重绘」的视图：骨架只画一次，之后全部增量追加，
   * 滚动粘底但用户往上翻就自动松手。
   */
  const talk = {
    slug: null,
    sessionId: null,
    alive: false,
    abort: null,
    nodes: null,
    liveBubble: null,
    liveRaw: "",
    optimistic: [],
    stick: true,
    lastSeq: 0,
    running: false,
  };
  // 视图代际：goTalk 的每次进入拿一个新号。await 回来发现号变了就退出——
  // 双击「新对话」、快速切会话都不会让两份接线抢同一个 DOM。
  let talkGen = 0;

  /** 离开对话视图：断流、去掉布局类。侧栏随时可能把人带去别的视图。 */
  function leaveTalk() {
    talk.alive = false;
    talk.sessionId = null;
    try { talk.abort && talk.abort.abort(); } catch { /* 已断 */ }
    talk.abort = null;
    document.body.classList.remove("talking");
  }

  function talkLog() { return el("talk-log"); }

  function talkSettle() {
    const log = talkLog();
    if (log && talk.stick) log.scrollTop = log.scrollHeight;
  }

  function talkAppend(node, key) {
    const log = talkLog();
    if (!log) return node;
    if (key && talk.nodes.has(key)) return talk.nodes.get(key);
    log.appendChild(node);
    if (key) talk.nodes.set(key, node);
    talkSettle();
    return node;
  }

  function talkBubble(cls, text) {
    const div = document.createElement("div");
    div.className = `t-msg ${cls}`;
    const body = document.createElement("div");
    body.className = "t-body";
    body.textContent = text;
    div.appendChild(body);
    return div;
  }

  function talkNote(text, cls) {
    const div = document.createElement("div");
    div.className = cls || "t-note";
    div.textContent = text;
    return div;
  }

  function setTalkRunning(v) {
    talk.running = v;
    const status = el("talk-status");
    if (status) status.textContent = v ? "它正在想…（这时候发消息就是插话）" : "";
    const stop = el("talk-stop");
    if (stop) stop.hidden = !v;
  }

  function onChatEvent(e) {
    if (typeof e.seq === "number" && e.seq > talk.lastSeq) talk.lastSeq = e.seq;
    switch (e.t) {
      case "user": {
        if (e.synthetic) return; // 注入的上下文不是人说的话，不画
        const key = `seq:${e.seq}`;
        if (talk.nodes.has(key)) return;
        // 乐观气泡认领：回声到了就把队列里第一条同文本的转正，别画第二遍。
        // 连发两句也各归各——这是个队列，不是单槽。
        const idx = talk.optimistic.findIndex((o) => o.text === e.text);
        if (idx >= 0) {
          const node = talk.optimistic[idx].node;
          node.classList.remove("pending");
          talk.nodes.set(key, node);
          talk.optimistic.splice(idx, 1);
          return;
        }
        talkAppend(talkBubble("me", e.text), key);
        return;
      }
      case "delta": {
        if (!talk.liveBubble) {
          talk.liveRaw = "";
          talk.liveBubble = talkAppend(talkBubble("it live", ""), null);
        }
        talk.liveRaw += e.text;
        talk.liveBubble.querySelector(".t-body").textContent = talk.liveRaw;
        talkSettle();
        return;
      }
      case "assistant": {
        const key = `seq:${e.seq}`;
        if (talk.nodes.has(key)) { talk.liveBubble = null; talk.liveRaw = ""; return; }
        const node = talk.liveBubble || talkAppend(talkBubble("it", ""), null);
        node.classList.remove("live");
        // 打字机阶段是纯文本；权威全文到了才渲染 Markdown。
        node.querySelector(".t-body").innerHTML = md(e.text);
        if (e.interrupted) node.appendChild(talkNote("（说到一半被停下了）"));
        talk.nodes.set(key, node);
        talk.liveBubble = null;
        talk.liveRaw = "";
        talkSettle();
        return;
      }
      case "tool.call": {
        const key = `call:${e.callId}`;
        if (talk.nodes.has(key)) return;
        const card = document.createElement("details");
        card.className = "t-tool";
        const sum = document.createElement("summary");
        const dot = document.createElement("span");
        dot.className = "t-dot run";
        const label = document.createElement("span");
        label.className = "t-label";
        label.textContent = e.label;
        sum.append(dot, label);
        card.appendChild(sum);
        if (e.input) {
          const pre = document.createElement("pre");
          pre.className = "t-in";
          pre.textContent = e.input;
          card.appendChild(pre);
        }
        const out = document.createElement("div");
        out.className = "t-out";
        card.appendChild(out);
        talkAppend(card, key);
        return;
      }
      case "tool.result": {
        const card = talk.nodes.get(`call:${e.callId}`);
        if (!card) return;
        const dot = card.querySelector(".t-dot");
        if (dot) dot.className = `t-dot ${e.ok ? "ok" : "bad"}`;
        const out = card.querySelector(".t-out");
        if (out && e.text) out.textContent = e.text;
        talkSettle();
        return;
      }
      case "todo": {
        let box = talk.nodes.get("todo");
        if (!box) {
          box = document.createElement("div");
          box.className = "t-todo";
          talkAppend(box, "todo");
        }
        box.innerHTML = "";
        for (const item of e.items) {
          const row = document.createElement("div");
          row.className = `t-todo-row ${esc(item.status)}`;
          row.textContent = item.content;
          box.appendChild(row);
        }
        talkSettle();
        return;
      }
      case "turn.start":
        setTalkRunning(true);
        return;
      case "turn.end": {
        setTalkRunning(false);
        if (talk.liveBubble) { talk.liveBubble.classList.remove("live"); talk.liveBubble = null; talk.liveRaw = ""; }
        if (e.reason === "error") talkAppend(talkNote(`出错了：${e.error || "运行时错误"}`, "t-note bad"), `seq:${e.seq}`);
        else if (e.reason === "aborted") talkAppend(talkNote("已停下。想继续就再说一句。"), `seq:${e.seq}`);
        return;
      }
      default:
    }
  }

  /** 长连接（带退避重连）。回放从 lastSeq+1 起，接直播。
   *  404 是永久性失败（会话打不开了），停下并如实告诉用户；
   *  其余按指数退避重试，重试状态在状态栏可见，不无声空转。 */
  async function connectTalk() {
    const sid = talk.sessionId;
    let delay = 1500;
    while (talk.alive && talk.sessionId === sid) {
      try {
        const ctrl = new AbortController();
        talk.abort = ctrl;
        const res = await fetch(
          `/wanx/api/chats/${encodeURIComponent(sid)}/events?from=${talk.lastSeq + 1}`,
          { signal: ctrl.signal },
        );
        if (res.status === 404) {
          talkAppend(talkNote("这条对话打不开了（记录缺失或已损坏）。回到助手另开一条吧。", "t-note bad"), null);
          setTalkRunning(false);
          return;
        }
        if (!res.ok || !res.body) throw new Error(`连接失败（${res.status}）`);
        delay = 1500; // 连上了，退避归零
        for await (const { event, data } of sseFrames(res)) {
          if (!talk.alive || talk.sessionId !== sid) return;
          if (event === "hello") {
            setTalkRunning(data.running === true);
            // 断线期间的打字机增量已永久丢失，半截直播气泡不能再续写
            // ——中段会缺字。丢弃它，权威全文（assistant 事件）会带来完整版。
            if (talk.liveBubble) {
              talk.liveBubble.remove();
              talk.liveBubble = null;
              talk.liveRaw = "";
            }
          } else if (event === "chat") onChatEvent(data);
        }
      } catch {
        /* 断了，走退避 */
      }
      if (!talk.alive || talk.sessionId !== sid) return;
      const status = el("talk-status");
      if (status) status.textContent = "连接断了，正在重试…";
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }

  async function talkSay() {
    const ta = el("talk-input");
    if (!ta) return;
    // 会话还没建好（goTalk 的 POST 在途）就别发——否则请求会打到
    // /api/chats/null/say，这句话就丢了。输入保留，建好再发。
    if (!talk.sessionId) return;
    const v = ta.value.trim();
    if (!v) return;
    ta.value = "";
    ta.style.height = "auto";
    const node = talkAppend(talkBubble("me pending", v), null);
    talk.optimistic.push({ text: v, node });
    try {
      const r = await fetch(`/wanx/api/chats/${encodeURIComponent(talk.sessionId)}/say`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: v }),
      });
      const d = await r.json().catch(() => ({ ok: false }));
      if (!r.ok || d.ok === false) {
        if (d.needsKey) { leaveTalk(); await loadSettings(); renderSettings({ reason: "还没设置模型 key，先把它配上。" }); return; }
        throw new Error(d.error || "没发出去");
      }
      setTalkRunning(true);
    } catch (e) {
      node.classList.add("bad");
      node.appendChild(talkNote(`没发出去：${e.message}`, "t-note bad"));
      talk.optimistic = talk.optimistic.filter((o) => o.node !== node);
    }
  }

  /** 对话里的「让它跑一次」：run 在自己的一次性会话里执行（确定性、进台账），
   *  结果以一张卡片落进对话流——入口统一，底下两类会话仍分家。 */
  async function talkRun() {
    const btn = el("talk-run");
    if (btn) btn.disabled = true;
    const card = document.createElement("div");
    card.className = "t-run";
    card.innerHTML =
      '<div class="t-run-h">▶ 让它跑一次</div>' +
      '<div class="steps live t-run-steps"></div><div class="t-run-out"></div>';
    talkAppend(card, null);
    const stepsBox = card.querySelector(".t-run-steps");
    let last = null;
    try {
      const finished = await streamRun(talk.slug, {
        onStep: (text) => {
          if (last) last.className = "step was";
          const d = document.createElement("div");
          d.className = "step now";
          d.innerHTML = '<span class="dot" aria-hidden="true"></span><span></span>';
          d.querySelector("span:last-child").textContent = text;
          stepsBox.appendChild(d);
          last = d;
          talkSettle();
        },
        onText: () => {},
      });
      if (last) last.className = "step was";
      card.querySelector(".t-run-out").innerHTML =
        `<div class="t-run-meta">用时 ${(finished.run.ms / 1000).toFixed(1)} 秒，已存进「最近的产出」` +
        ' · <button class="linkish t-run-tune" type="button">这里不对？调教它</button></div>' +
        '<div class="t-run-tune-slot"></div>' +
        `<article class="paper">${md(finished.output)}</article>`;
      card.querySelector(".t-run-tune").addEventListener("click", () => {
        openTuneForm(talk.slug, finished.run.id, card.querySelector(".t-run-tune-slot"));
        talkSettle();
      });
    } catch (e) {
      if (last) last.className = "step was";
      if (e.needsKey) {
        leaveTalk();
        await loadSettings();
        renderSettings({ reason: "还没设置模型 key，先把它配上。" });
        return;
      }
      card.querySelector(".t-run-out").innerHTML = `<div class="err">没跑成：${esc(e.message)}</div>`;
    } finally {
      if (btn) btn.disabled = false;
      talkSettle();
    }
  }

  async function loadTalkHistory(slug, current) {
    const sel = el("talk-history");
    if (!sel) return;
    try {
      const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/chats`);
      const d = await r.json();
      const chats = Array.isArray(d.chats) ? d.chats : [];
      sel.innerHTML = "";
      for (const c of chats) {
        const opt = document.createElement("option");
        opt.value = c.sessionId;
        opt.textContent = c.title || "新对话";
        if (c.sessionId === current) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.hidden = chats.length < 2;
    } catch {
      sel.hidden = true;
    }
  }

  /** 跟它聊聊。sessionId 缺省 = 新开一条。 */
  async function goTalk(slug, sessionId) {
    const gen = ++talkGen;
    leaveTalk();
    state.phase = "talk";
    setPrdVisible(false);
    el("meters").hidden = true;
    const app = (state.apps || []).find((a) => a.slug === slug);
    el("top-title").textContent = (app && app.name) || "对话";
    el("top-en").textContent = "Talk it through";
    el("stage").className = "stage wide";
    document.body.classList.add("talking");
    el("stage").innerHTML =
      '<div class="talk">' +
      '<div class="talk-bar">' +
      '<button class="btn-quiet" id="talk-back" type="button">← 回到助手</button>' +
      '<select id="talk-history" hidden></select>' +
      '<button class="btn-quiet" id="talk-new" type="button">新对话</button>' +
      '<button class="btn-quiet" id="talk-run" type="button">让它跑一次</button>' +
      '<button class="btn-quiet" id="talk-tune" type="button">调教它</button>' +
      "</div>" +
      '<div class="talk-log" id="talk-log" aria-live="polite"></div>' +
      '<div class="talk-dock">' +
      '<div class="talk-status" id="talk-status"></div>' +
      '<div class="composer-box">' +
      '<textarea id="talk-input" rows="1" placeholder="跟它说点什么…" aria-label="你的话"></textarea>' +
      '<button class="send" id="talk-send" type="button" aria-label="发送">→</button></div>' +
      '<button class="stop" id="talk-stop" type="button" hidden>停下</button>' +
      "</div></div>";

    el("talk-back").addEventListener("click", () => { leaveTalk(); goApp(slug); });
    el("talk-new").addEventListener("click", () => goTalk(slug));
    el("talk-run").addEventListener("click", () => { void talkRun(); });
    el("talk-tune").addEventListener("click", () => {
      // 调教表单以卡片形式落进对话流（不带 runId——针对整体表现的意见）。
      const holder = document.createElement("div");
      holder.className = "t-run";
      holder.innerHTML = '<div class="t-run-h">🔧 调教它</div>';
      talkAppend(holder, null);
      openTuneForm(slug, null, holder);
      talkSettle();
    });
    el("talk-send").addEventListener("click", () => { void talkSay(); });
    el("talk-stop").addEventListener("click", () => {
      void fetch(`/wanx/api/chats/${encodeURIComponent(talk.sessionId)}/stop`, { method: "POST" });
    });
    const ta = el("talk-input");
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void talkSay(); }
    });
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    });
    const log = el("talk-log");
    log.addEventListener("scroll", () => {
      talk.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    });

    talk.slug = slug;
    talk.nodes = new Map();
    talk.liveBubble = null;
    talk.liveRaw = "";
    talk.optimistic = [];
    talk.stick = true;
    talk.lastSeq = 0;
    setTalkRunning(false);
    // 会话就绪之前不许发（sessionId 还是 null，请求会打到 /chats/null/say）。
    el("talk-send").disabled = true;

    try {
      if (!sessionId) {
        const r = await fetch(`/wanx/api/apps/${encodeURIComponent(slug)}/chats`, { method: "POST" });
        const d = await r.json();
        if (gen !== talkGen) return; // 用户已经去了别处/开了另一条——这份接线作废
        if (!r.ok || d.ok === false) throw new Error(d.error || "没能开起对话");
        sessionId = d.sessionId;
      }
      if (gen !== talkGen) return;
      talk.sessionId = sessionId;
      talk.alive = true;
      el("talk-send").disabled = false;
      void loadTalkHistory(slug, sessionId);
      const sel = el("talk-history");
      sel.addEventListener("change", () => { if (sel.value && sel.value !== talk.sessionId) goTalk(slug, sel.value); });
      void connectTalk();
      ta.focus();
    } catch (e) {
      if (gen !== talkGen) return;
      leaveTalk();
      el("stage").className = "stage";
      el("stage").innerHTML =
        `<div class="err">对话没开起来：${esc(e.message)}</div>` +
        '<div class="multi-foot"><button class="btn-quiet" id="talk-back2" type="button">← 回到助手</button></div>';
      el("talk-back2").addEventListener("click", () => goApp(slug));
    }
  }

  /* ================= 我的助手 ================= */
  async function loadApps() {
    try {
      const r = await fetch("/wanx/api/apps");
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

  /* ================= 外部能力（MCP） =================
   * 给助手接现成的外部工具——MCP 通道，一行配置一个 server。
   * 接上之后所有助手都能用（跑一次和对话里都一样）；改动热生效，不用重启。
   */
  function mcpItemHtml(s) {
    const what = s.transport === "stdio"
      ? `命令：${esc(s.command || "")}${s.args && s.args.length ? " " + esc(s.args.join(" ")) : ""}`
      : `地址：${esc(s.url || "")}`;
    return `<div class="mat"><span class="mat-name"><b>${esc(s.serverName)}</b>　<span class="mat-size">${what}</span></span>` +
      `<span></span><button class="mat-x" type="button" data-mcp="${esc(s.serverName)}" aria-label="断开">×</button></div>`;
  }

  function paintMcp(servers) {
    const box = el("mcp-list");
    if (!box) return;
    box.innerHTML = servers.length
      ? `<div class="mats">${servers.map(mcpItemHtml).join("")}</div>`
      : '<div class="mat-empty">还没接任何外部能力。接上一个，所有助手就都多一批工具。</div>';
    for (const b of box.querySelectorAll(".mat-x")) {
      b.addEventListener("click", async () => {
        try {
          const r = await fetch("/wanx/api/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ remove: true, serverName: b.dataset.mcp }),
          });
          const d = await r.json();
          if (!r.ok || d.ok === false) throw new Error(d.error || "没断开");
          paintMcp(d.servers || []);
        } catch (e) {
          const err = el("mcp-err");
          if (err) { err.className = "err"; err.textContent = e.message; }
        }
      });
    }
  }

  async function renderMcp() {
    leaveTalk();
    state.phase = "mcp";
    setPrdVisible(false);
    el("meters").hidden = true;
    el("top-title").textContent = "外部能力";
    el("top-en").textContent = "External capabilities (MCP)";
    el("stage").className = "stage";
    el("stage").innerHTML =
      '<h2 class="lede">给助手接外部能力</h2>' +
      '<p class="sub">MCP 是接现成工具的标准口子：接上一个 server，所有助手都会多一批工具，' +
      "跑活和对话里都能用，改动即时生效。</p>" +
      '<div id="mcp-list"></div><div id="mcp-err"></div>' +
      '<div class="mat-form" style="margin-top:18px">' +
      '<input id="mcp-name" type="text" placeholder="给它起个名，比如 github（小写字母数字连字符）" spellcheck="false">' +
      '<div class="multi-foot" style="margin:0 0 8px">' +
      '<label><input type="radio" name="mcp-t" value="stdio" checked> 本机命令（stdio）</label>' +
      '<label><input type="radio" name="mcp-t" value="streamable-http"> 网络地址（http）</label></div>' +
      '<input id="mcp-cmd" type="text" placeholder="命令与参数，比如：npx -y @modelcontextprotocol/server-github" spellcheck="false">' +
      '<input id="mcp-url" type="text" placeholder="http(s) 地址，比如：http://127.0.0.1:3000/mcp" spellcheck="false" style="display:none">' +
      '<div class="multi-foot"><button class="btn-solid" id="mcp-add" type="button">接上</button>' +
      '<button class="btn-quiet" id="mcp-back" type="button">返回</button></div></div>';

    for (const radio of el("stage").querySelectorAll('input[name="mcp-t"]')) {
      radio.addEventListener("change", () => {
        const http = radio.value === "streamable-http" && radio.checked;
        el("mcp-cmd").style.display = http ? "none" : "";
        el("mcp-url").style.display = http ? "" : "none";
      });
    }
    el("mcp-back").addEventListener("click", restart);
    el("mcp-add").addEventListener("click", async () => {
      const err = el("mcp-err");
      err.className = ""; err.textContent = "";
      const transport = el("stage").querySelector('input[name="mcp-t"]:checked').value;
      const cmdline = el("mcp-cmd").value.trim();
      const payload = {
        serverName: el("mcp-name").value.trim(),
        transport,
        command: transport === "stdio" ? cmdline.split(/\s+/)[0] : undefined,
        args: transport === "stdio" ? cmdline.split(/\s+/).slice(1).join(" ") : undefined,
        url: transport === "streamable-http" ? el("mcp-url").value.trim() : undefined,
      };
      el("mcp-add").disabled = true;
      try {
        const r = await fetch("/wanx/api/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (!r.ok || d.ok === false) throw new Error(d.error || "没接上");
        el("mcp-name").value = ""; el("mcp-cmd").value = ""; el("mcp-url").value = "";
        paintMcp(d.servers || []);
      } catch (e) {
        err.className = "err"; err.textContent = e.message;
      } finally {
        el("mcp-add").disabled = false;
      }
    });

    try {
      const r = await fetch("/wanx/api/mcp");
      const d = await r.json();
      if (d.ok === false) throw new Error(d.error);
      paintMcp(d.servers || []);
    } catch (e) {
      const err = el("mcp-err");
      err.className = "err"; err.textContent = "读不出清单：" + e.message;
    }
    toTop();
  }

  /* ================= 模型设置 ================= */
  async function loadSettings() {
    try {
      const r = await fetch("/wanx/api/settings");
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
    leaveTalk();
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
        const r = await fetch("/wanx/api/settings", {
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
    leaveTalk();
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
  el("open-mcp").addEventListener("click", () => { void renderMcp(); });
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

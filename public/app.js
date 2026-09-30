const chat = document.getElementById("chat");
const ctxEl = document.getElementById("ctx");
const input = document.getElementById("input");
const filesEl = document.getElementById("files");
const composer = document.getElementById("composer");
const sendBtn = document.getElementById("send");
const budgetEl = document.getElementById("budget");
const chipModel = document.getElementById("chipModel");
const chipCwd = document.getElementById("chipCwd");

let busy = false;
let hold = "";
let context = "";
let pendingA = null;
let plan = null;
let check = null;
let numCtx = 8192;
let attached = [];
const trace = [];

function clipText(text, n) {
  const s = String(text || "");
  return s.length <= n ? s : s.slice(0, n) + "\n… " + (s.length - n) + " more characters";
}

function note(kind, text) {
  const cap = kind === "reason" || kind === "format" ? 50000 : 4000;
  const event = { t: new Date().toISOString(), kind: kind, text: clipText(text, cap) };
  trace.push(event);
  if (trace.length > 400) trace.shift();
  return event;
}

function planText(p) {
  if (!p || !p.steps) return "";
  const lines = [p.goal || ""];
  p.steps.forEach(function (s) {
    lines.push(s.id + " [" + (s.status || "todo") + "] " + (s.do || ""));
    if (s.cmd) lines.push("  cmd: " + s.cmd);
  });
  return lines.join("\n");
}

function setText(el, v) {
  if (el) el.textContent = v;
}

function setHold(text) {
  hold = text || "";
  const notes = document.querySelectorAll("#chat .plan .next-note");
  notes.forEach(function (note, i) {
    note.textContent = i === notes.length - 1 ? hold : "";
  });
}

function retireActions() {
  document.querySelectorAll("#chat .rowbtns button").forEach(function (b) {
    b.disabled = true;
  });
}

function showSpinner(label) {
  if (!chat) return;
  let el = document.getElementById("spin");
  if (!el) {
    el = document.createElement("div");
    el.id = "spin";
    el.className = "msg bot spin";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="spin-label"></span>';
    chat.appendChild(el);
  }
  const lab = el.querySelector(".spin-label");
  if (lab && label) lab.textContent = label;
  el.hidden = false;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}

function clearSpinners() {
  var nodes = document.querySelectorAll(".spin");
  for (var i = 0; i < nodes.length; i++) nodes[i].remove();
}

function hideSpinner() {
  clearSpinners();
}

function setBusy(on, label) {
  busy = on;
  if (sendBtn) sendBtn.disabled = on;
  if (on) showSpinner(label || "Working");
  else hideSpinner();
}

function addInline(parent, text) {
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
    const bit = match[0];
    if (bit.charAt(0) === "`") {
      const code = document.createElement("code");
      code.className = "inline";
      code.textContent = bit.slice(1, -1);
      parent.appendChild(code);
    } else if (bit.charAt(0) === "*") {
      const strong = document.createElement(bit.charAt(1) === "*" ? "strong" : "em");
      strong.textContent = bit.replace(/^\*+|\*+$/g, "");
      parent.appendChild(strong);
    } else {
      const a = document.createElement("a");
      a.href = bit.replace(/[.,;:]+$/, "");
      a.textContent = a.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      parent.appendChild(a);
    }
    last = match.index + bit.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function addCodeBox(host, lang, code) {
  const box = document.createElement("div");
  box.className = "codebox";
  const bar = document.createElement("div");
  bar.className = "codebar";
  const name = document.createElement("span");
  name.textContent = lang || "code";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "tiny";
  copy.textContent = "Copy";
  copy.onclick = function () {
    const done = function () {
      copy.textContent = "Copied";
      setTimeout(function () { copy.textContent = "Copy"; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(function () { copy.textContent = "Copy failed"; });
    } else copy.textContent = "Copy failed";
  };
  bar.appendChild(name);
  bar.appendChild(copy);
  const pre = document.createElement("pre");
  const el = document.createElement("code");
  el.textContent = code.replace(/\n$/, "");
  pre.appendChild(el);
  box.appendChild(bar);
  box.appendChild(pre);
  host.appendChild(box);
}

function addBlocks(host, text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let para = [];
  let list = null;
  let aligned = [];
  function flushPara() {
    if (!para.length) return;
    const p = document.createElement("p");
    addInline(p, para.join(" "));
    host.appendChild(p);
    para = [];
  }
  function flushList() {
    list = null;
  }
  function flushAligned() {
    if (!aligned.length) return;
    addPre(host, aligned.join("\n"));
    aligned = [];
  }
  function isNameLine(line) {
  const t = String(line || "").trim();
  if (!t) return false;
  if (/^(Directories|Files|Other)$/.test(t)) return true;
  return t.indexOf(" ") === -1;
}
  function isAligned(line) {
    return /\S {2,}\S/.test(line) && !/^#{1,4}\s/.test(line) && !/^\s*(?:[-*]|•)\s/.test(line);
  }
  lines.forEach(function (line) {
    if (!line.trim()) {
      flushPara();
      flushList();
      flushAligned();
      return;
    }
    if (isAligned(line) || isNameLine(line)) {
      flushPara();
      flushList();
      aligned.push(line.replace(/\s+$/, ""));
      return;
    }
    flushAligned();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      const h = document.createElement("h" + Math.min(heading[1].length, 3));
      addInline(h, heading[2]);
      host.appendChild(h);
      return;
    }
    if (/^---+$/.test(line.trim())) {
      flushPara();
      flushList();
      host.appendChild(document.createElement("hr"));
      return;
    }
    const bullet = line.match(/^\s*(?:[-*]|•)\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      if (!list || (numbered && list.tagName !== "OL") || (bullet && list.tagName !== "UL")) {
        list = document.createElement(numbered ? "ol" : "ul");
        host.appendChild(list);
      }
      const li = document.createElement("li");
      addInline(li, (bullet || numbered)[1]);
      list.appendChild(li);
      return;
    }
    flushList();
    para.push(line.trim());
  });
  flushPara();
  flushAligned();
}

function addPre(host, text) {
  var body = String(text || "").replace(/^\n+|\n+$/g, "");
  if (!body) return;
  var pre = document.createElement("pre");
  pre.className = "text";
  pre.textContent = body;
  host.appendChild(pre);
}

function renderMarkdown(md, host) {
  host.textContent = "";
  var src = String(md || "").replace(/\r\n/g, "\n");
  if (window.LoopFormat && LoopFormat.isListing && LoopFormat.isListing(src)) {
    addPre(host, src);
    return;
  }
  src = src.replace(/```([a-zA-Z0-9+#]*)[ \t]+([^`\n]+)```/g, function (_m, lang, code) {
    return "```" + lang + "\n" + code.trim() + "\n```";
  });
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = re.exec(src))) {
    if (match.index > last) addBlocks(host, src.slice(last, match.index));
    addCodeBox(host, match[1].trim(), match[2]);
    last = match.index + match[0].length;
  }
  if (last < src.length) addBlocks(host, src.slice(last));
  if (!host.childNodes.length) {
    const p = document.createElement("p");
    p.textContent = src;
    host.appendChild(p);
  }
}

function dress(box, raw) {
  if (!box || !box.body) return;
  if (box.div && !box.div.querySelector(".reason")) showReason(box.div, "");
  const text = String(raw || "");
  const body = box.body;
  body.textContent = "";
  body.classList.add("answer");
  const bar = document.createElement("div");
  bar.className = "viewbar";
  const status = document.createElement("span");
  status.className = "status";
  status.hidden = true;
  const dots = document.createElement("span");
  dots.className = "dots";
  dots.appendChild(document.createElement("i"));
  dots.appendChild(document.createElement("i"));
  dots.appendChild(document.createElement("i"));
  status.appendChild(dots);
  status.appendChild(document.createTextNode(" Formatting"));
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tiny ghost";
  toggle.textContent = "Format";
  const native = document.createElement("pre");
  native.className = "native";
  native.textContent = text;
  const read = document.createElement("div");
  read.className = "read";
  read.hidden = true;
  bar.appendChild(status);
  bar.appendChild(toggle);
  body.appendChild(bar);
  body.appendChild(native);
  body.appendChild(read);
  const small = window.LoopFormat && LoopFormat.canFormat && LoopFormat.canFormat(text);
  if (!small) {
    bar.hidden = true;
    note("format", "left raw (" + text.length + " chars)");
    return;
  }
  let showRaw = true;
  function paint() {
    read.hidden = showRaw;
    native.hidden = !showRaw;
    toggle.textContent = showRaw ? "Format" : "Raw";
  }
  toggle.onclick = function (ev) {
    ev.stopPropagation();
    if (!showRaw) {
      showRaw = true;
      paint();
      return;
    }
    status.hidden = false;
    toggle.disabled = true;
    fetch("/api/markup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var modelText = String((data && data.pretty) || text);
        var pretty = window.LoopFormat && LoopFormat.formatAnswer ? LoopFormat.formatAnswer(modelText) : modelText;
        if (!pretty.trim() || pretty.trim() === text.trim()) return;
        renderMarkdown(pretty, read);
        showRaw = false;
        paint();
        note("format", "source:\n" + text + "\n\nshown:\n" + pretty);
      })
      .catch(function (err) {
        note("format", "markup failed: " + (err && err.message ? err.message : "error"));
      })
      .then(function () {
        status.hidden = true;
        toggle.disabled = false;
        var pre = box.div && box.div.querySelector(".reason-body");
        if (pre && pre.dataset.formatted !== "1") pre.textContent = pre.dataset.raw || "(none)";
      });
  };
}

function addMsg(role, text, quiet) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "You" : role === "err" ? "Error" : "Loop";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  div.appendChild(who);
  div.appendChild(body);
  const event = !quiet && text ? note(role === "user" ? "you" : role === "err" ? "error" : "loop", text) : null;
  if (chat) {
    chat.appendChild(div);
    if (busy) showSpinner();
    chat.scrollTop = chat.scrollHeight;
  }
  return { div: div, body: body, event: event };
}

function showDoubt(box, warning) {
  if (!box || !warning) return;
  const el = document.createElement("div");
  el.className = "unsure";
  const k = document.createElement("div");
  k.className = "unsure-k";
  k.textContent = warning.sign || "I am unsure what I am doing here.";
  const p = document.createElement("div");
  p.textContent = warning.why || "";
  el.appendChild(k);
  el.appendChild(p);
  const body = box.querySelector(".body");
  if (body) box.insertBefore(el, body);
  else box.appendChild(el);
  note("unsure", (warning.sign || "") + " " + (warning.why || ""));
}

function showReason(box, text) {
  if (!box || box.querySelector(".reason")) return;
  const raw = String(text || "").trim();
  const el = document.createElement("div");
  el.className = "reason";
  const k = document.createElement("button");
  k.type = "button";
  k.className = "reason-k";
  k.textContent = "Reasoning";
  const panel = document.createElement("div");
  panel.className = "reason-panel";
  panel.hidden = true;
  const bar = document.createElement("div");
  bar.className = "reason-bar";
  const fmt = document.createElement("button");
  fmt.type = "button";
  fmt.className = "tiny ghost";
  fmt.textContent = "Format";
  const pre = document.createElement("pre");
  pre.className = "reason-body";
  pre.dataset.raw = raw;
  pre.dataset.formatted = "0";
  pre.textContent = raw || "(none)";
  let formatted = false;
  fmt.onclick = function (ev) {
    ev.stopPropagation();
    formatted = !formatted;
    pre.dataset.formatted = formatted ? "1" : "0";
    if (!formatted || !window.LoopFormat) {
      pre.textContent = raw || "(none)";
      fmt.textContent = "Format";
      return;
    }
    var shaped = LoopFormat.formatAnswer(raw);
    pre.textContent = shaped.replace(/^```[a-zA-Z0-9+#]*\n/, "").replace(/\n```$/, "") || raw;
    fmt.textContent = "Plain";
    note("format", "reasoning formatted\n\n" + pre.textContent);
  };
  k.onclick = function (ev) {
    ev.stopPropagation();
    const open = panel.hidden;
    panel.hidden = !open;
    el.classList.toggle("open", open);
  };
  bar.appendChild(fmt);
  panel.appendChild(bar);
  panel.appendChild(pre);
  el.appendChild(k);
  el.appendChild(panel);
  const body = box.querySelector(".body");
  if (body) box.insertBefore(el, body);
  else box.appendChild(el);
  if (raw) note("reason", raw);
}

function actionTitle(step) {
  const text = String((step && step.do) || "");
  if (/pdf/i.test(text)) return "Create PDF";
  if (/\blist\b|\bls\b/i.test(text)) return "List files";
  return text || "Run command";
}

function renderContext(text) {
  const next = String(text || "");
  const changed = next !== context;
  context = next;
  if (changed) note("state", next);
  if (!ctxEl) return;
  ctxEl.innerHTML = "";
  const raw = context.trim();
  if (!raw) {
    ctxEl.textContent = "(empty)";
    ctxEl.classList.add("empty");
    return;
  }
  ctxEl.classList.remove("empty");
  raw.split("\n").forEach(function (line) {
    const span = document.createElement("span");
    span.className = "ctx-line";
    if (/^KEEP\s+GOAL:/i.test(line)) span.className += " keep-goal";
    else if (/^KEEP\b/i.test(line)) span.className += " keep";
    else if (/^FACT:/i.test(line)) span.className += " fact";
    else if (/^NOTE:/i.test(line)) span.className += " note-line";
    span.textContent = line + "\n";
    ctxEl.appendChild(span);
  });
}

async function updateBudget() {
  try {
    const r = await fetch("/api/prompt-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input ? input.value : "" }),
    });
    const s = await r.json();
    numCtx = s.numCtx || 8192;
    if (budgetEl) budgetEl.className = "meter" + (s.pct >= 70 ? " high" : "");
    setText(budgetEl, "~" + s.tokens + " / " + s.numCtx);
  } catch (_) {
    setText(budgetEl, "budget unavailable");
  }
}

var serverUid = "";
var reloading = false;
function noteUid(uid) {
  if (!uid || reloading) return;
  if (!serverUid) {
    serverUid = String(uid);
    return;
  }
  if (String(uid) !== serverUid) {
    reloading = true;
    location.reload();
  }
}
function watchServer() {
  fetch("/api/uid", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d) noteUid(d.uid); })
    .catch(function () {});
}
setInterval(watchServer, 3000);

async function refresh() {
  const r = await fetch("/api/state", { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const s = await r.json();
  noteUid(s.uid);
  setText(chipModel, s.model || "model");
  setText(chipCwd, "cwd " + (s.cwd || s.workspace || ""));
  if (chipCwd) chipCwd.title = s.cwd || s.workspace || "";
  numCtx = s.numCtx || 8192;
  renderContext(s.context);
}

function rowBtns(host, items) {
  const row = document.createElement("div");
  row.className = "rowbtns";
  items.forEach(function (it) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = it.label;
    if (it.ok) b.className = "ok";
    b.onclick = it.fn;
    row.appendChild(b);
  });
  host.appendChild(row);
  return row;
}

function renderPending(host) {
  retireActions();
  const old = host.querySelector(".plan");
  if (old) old.remove();
  if (!pendingA || !pendingA.cmd || pendingA.result) return;
  const wrap = document.createElement("div");
  wrap.className = "plan";
  const h = document.createElement("div");
  h.className = "plan-h";
  h.textContent = "Approve the command. The model then reads the output and updates state.";
  wrap.appendChild(h);
  const line = document.createElement("div");
  line.className = "plan-row";
  const k = document.createElement("span");
  k.className = "plan-k";
  k.textContent = "RUN";
  line.appendChild(k);
  line.appendChild(document.createTextNode(pendingA.cmd));
  wrap.appendChild(line);
  host.appendChild(wrap);
  const note = document.createElement("div");
  note.className = "next-note";
  wrap.appendChild(note);
  setHold("Approve the command. After it runs, the model reads the output and updates state.");
  rowBtns(wrap, [
    {
      label: "Approve",
      ok: true,
      fn: async function () {
        try {
          await applyOne(pendingA.cmd, null, host, function (result) {
            pendingA.result = result;
            return rememberOutput();
          });
        } catch (e) {
          addMsg("err", e.message);
        }
      },
    },
    {
      label: "Skip",
      fn: function () {
        pendingA = null;
        setHold("");
        wrap.remove();
        addMsg("bot", "Command skipped. State unchanged.");
      },
    },
  ]);
}

async function rememberOutput() {
  if (!pendingA) return;
  setBusy(true, "Reading the output");
  try {
    const r = await fetch("/api/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userText: pendingA.userText,
        display: pendingA.display,
        output: pendingA.result ? pendingA.result.stdout : "",
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "state update failed");
    renderContext(d.context);
    updateBudget();
    pendingA = null;
    setHold("");
  } finally {
    setBusy(false);
  }
}

function renderPlan(host) {
  retireActions();
  const old = host.querySelector(".plan");
  if (old) old.remove();
  if (!plan) return;
  const wrap = document.createElement("div");
  wrap.className = "plan";
  const h = document.createElement("div");
  h.className = "plan-h";
  h.textContent = "Plan — execute → checkpoint";
  wrap.appendChild(h);
  const goal = document.createElement("div");
  goal.className = "plan-row";
  goal.textContent = (plan.goal || "").replace(/^KEEP GOAL:\s*/i, "");
  wrap.appendChild(goal);
  (plan.steps || []).forEach(function (s, i) {
    const line = document.createElement("div");
    line.className = "plan-row" + (i === plan.cursor ? " current" : "");
    const k = document.createElement("span");
    k.className = "plan-k";
    k.textContent = (s.status || "todo").toUpperCase();
    line.appendChild(k);
    line.appendChild(document.createTextNode(s.do || "Step"));
    wrap.appendChild(line);
  });
  if (check) {
    const c = document.createElement("div");
    c.className = "hint";
    c.style.padding = "8px 10px";
    c.textContent = check.ok ? check.why : "Not done. " + (check.why || "the expect was not met");
    wrap.appendChild(c);
  }
  host.appendChild(wrap);
  const note = document.createElement("div");
  note.className = "next-note";
  wrap.appendChild(note);
  const step = plan.steps && plan.steps[plan.cursor];
  const finished = plan.steps && plan.steps.length && plan.steps.every(function (s) { return s.status === "ok"; });
  const items = [];
  if (!finished && step && step.scan) {
    const title = document.createElement("div");
    title.className = "plan-h";
    title.textContent = "Read every listed file";
    wrap.appendChild(title);
    const pre = document.createElement("pre");
    pre.className = "cmd";
    pre.textContent = "For each path in file-list.txt, append a note to the text file. One approval covers the whole set.";
    wrap.appendChild(pre);
    items.push({
      label: "Approve the scan",
      ok: true,
      fn: function () {
        runScan(host);
      },
    });
    setHold("This reads every listed file. State shows which file is open.");
  } else if (!finished && step && step.cmd) {
    const title = document.createElement("div");
    title.className = "plan-h";
    title.textContent = actionTitle(step);
    wrap.appendChild(title);
    const pre = document.createElement("pre");
    pre.className = "cmd";
    pre.textContent = step.cmd;
    wrap.appendChild(pre);
    items.push({
      label: "Approve",
      ok: true,
      fn: function () {
        runPlanStep(host);
      },
    });
    setHold("");
  } else if (!finished && step) {
    items.push({
      label: "Show the command",
      ok: true,
      fn: function () {
        runPlanStep(host);
      },
    });
    setHold(actionTitle(step) + " needs a command. Show it, then approve it.");
  } else {
    setHold(finished ? "Done. Waiting for the next instruction." : "");
  }
  items.push({
    label: "Drop plan",
    fn: function () {
      plan = null;
      check = null;
      setHold("");
      wrap.remove();
    },
  });
  if (check && !check.ok && (check.replan || check.startOver) && !check.ask) {
    items.push({
      label: "Replan remaining",
      fn: function () {
        doReplan(false, host);
      },
    });
    items.push({
      label: "Start over",
      fn: function () {
        doReplan(true, host);
      },
    });
  }
  rowBtns(wrap, items);
  if (check && check.ask) {
    const ta = document.createElement("textarea");
    ta.placeholder = check.ask;
    ta.className = "ask";
    wrap.appendChild(ta);
    rowBtns(wrap, [
      {
        label: "Submit answer",
        ok: true,
        fn: async function () {
          const text = ta.value.trim();
          if (!text) return;
          await checkpoint({ cmd: "(user)", code: 0, stdout: text }, host);
        },
      },
    ]);
  }
}

async function applyOne(cmd, stepId, host, after) {
  setBusy(true, "Running");
  try {
    const r = await fetch("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: cmd, stepId: stepId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "apply failed");
    const term = document.createElement("div");
    term.className = "term";
    const text = (data.result.stdout || "") + (data.result.stderr ? "\n" + data.result.stderr : "");
    term.textContent = "$ " + data.result.cmd + "  exit " + data.result.code + (data.result.code === 124 ? "  (stopped: no output or too long)" : "");
    if (text.trim()) {
      const more = document.createElement("button");
      more.type = "button";
      more.textContent = "Show the raw output";
      more.onclick = function () {
        term.textContent = "$ " + data.result.cmd + "  exit " + data.result.code + "\n" + text;
        more.remove();
      };
      term.appendChild(more);
    }
    host.appendChild(term);
    note("command", "$ " + data.result.cmd + "  exit " + data.result.code + "\n" + text);
    if (after) await after(data.result);
  } finally {
    setBusy(false);
  }
}

async function checkpoint(result, host) {
  setBusy(true, "Working through the output");
  const ac = new AbortController();
  const timer = setTimeout(function () {
    ac.abort();
  }, 240000);
  let watch = true;
  let dressed = false;
  let live = null;
  function paintLive(text) {
    if (dressed) return;
    const lines = String(text || "").split("\n");
    const notes = lines.filter(function (l) { return /^NOTE:/.test(l); }).map(function (l) { return l.replace(/^NOTE:\s*/, ""); });
    const next = lines.find(function (l) { return /^NEXT:/.test(l); });
    if (!notes.length && !next) return;
    if (!live) {
      live = addMsg("bot", "", true);
      live.div.classList.add("live-sum", "draft");
    }
    const head = next ? next.replace(/^NEXT:\s*/, "") : "Summary";
    live.body.textContent = head + (notes.length ? "\n\n" + notes.map(function (n, i) { return (i + 1) + ". " + n; }).join("\n") : "");
    if (chat) chat.scrollTop = chat.scrollHeight;
  }
  const poll = setInterval(function () {
    fetch("/api/state")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!watch || !s) return;
        noteUid(s.uid);
        renderContext(s.context || "");
        paintLive(s.context || "");
        const next = String(s.context || "").split("\n").find(function (l) { return /^NEXT:/.test(l); });
        if (next) setBusy(true, next.replace(/^NEXT:\s*/, ""));
      })
      .catch(function () {});
  }, 800);
  try {
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: plan, result: result }),
      signal: ac.signal,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "check failed");
    plan = d.plan;
    check = d.check;
    note("check", (d.check && d.check.ok ? "ok — " : "not ok — ") + ((d.check && (d.check.why || d.check.diagnosis)) || ""));
    note("plan", planText(plan));
    renderContext(d.check.context);
    const finished = d.done || (d.plan && d.plan.steps && d.plan.steps.length && d.plan.steps.every(function (s) { return s.status === "ok"; }));
    const said = d.say || d.report;
    dressed = true;
    if (said && live) {
      live.div.classList.remove("draft");
      note("loop", said);
      dress(live, said);
    } else if (said) dress(addMsg("bot", said), said);
    if (finished) {
      plan = null;
      check = null;
      renderPlan(host);
      setHold("");
      return;
    }
    renderPlan(host);
    const nxt = plan && plan.steps && plan.steps[plan.cursor];
    if (nxt && !nxt.cmd && !nxt.scan && nxt.status !== "ok") await runPlanStep(host);
  } catch (e) {
    addMsg("err", e.name === "AbortError" ? "Stopped. The output summary took longer than 4 minutes." : e.message);
    renderPlan(host);
  } finally {
    clearTimeout(timer);
    watch = false;
    clearInterval(poll);
    setBusy(false);
  }
}

async function runScan(host) {
  setBusy(true, "Reading files");
  let watch = true;
  const poll = setInterval(function () {
    fetch("/api/state")
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!watch || !s) return;
        noteUid(s.uid);
        renderContext(s.context || "");
        const next = String(s.context || "").split("\n").find(function (l) { return /^NEXT:/.test(l); });
        if (next) setBusy(true, next.replace(/^NEXT:\s*/, ""));
      })
      .catch(function () {});
  }, 800);
  try {
    const r = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: plan }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "scan failed");
    if (d.context) renderContext(d.context);
    if (plan && plan.steps) {
      plan.steps.forEach(function (s) {
        if (s.scan || /summar/i.test(s.do || "")) s.status = "ok";
      });
      plan.cursor = plan.steps.length;
    }
    const box = addMsg("bot", d.say || "Scan finished.");
    dress(box, d.say || "");
    note("loop", d.say || "");
    renderPlan(host);
    setHold("Done. Waiting for the next instruction.");
  } catch (e) {
    addMsg("err", e.message);
  } finally {
    watch = false;
    clearInterval(poll);
    setBusy(false);
  }
}

async function runPlanStep(host) {
  if (!plan) return;
  const step = plan.steps[plan.cursor];
  if (!step) return;
  if (!step.cmd) {
    setBusy(true, "Emit command");
    try {
      const r = await fetch("/api/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: step }),
      });
      const d = await r.json();
      if (d.emit && d.emit.cmd) {
        step.cmd = d.emit.cmd;
        note("plan", planText(plan));
        renderPlan(host);
        return;
      }
      addMsg("bot", (d.emit && d.emit.ask) || "This step has no command yet, and state does not have what it needs.");
      return;
    } finally {
      setBusy(false);
    }
    return;
  }
  host.querySelectorAll(".plan .rowbtns").forEach(function (n) {
    n.remove();
  });
  try {
    await applyOne(step.cmd, step.id, host, function (result) {
      return checkpoint(result, host);
    });
  } catch (e) {
    addMsg("err", e.message);
    renderPlan(host);
  }
}

async function doReplan(startOver, host) {
  setBusy(true, startOver ? "Start over" : "Replan");
  try {
    const r = await fetch("/api/replan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: plan, why: (check && check.why) || "checkpoint failed", startOver: startOver }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "replan failed");
    plan = d.plan;
    check = null;
    note("plan", planText(plan));
    addMsg("bot", d.display || "Revised plan.");
    if (startOver && plan.goal) renderContext(plan.goal);
    renderPlan(host);
  } finally {
    setBusy(false);
  }
}

async function turn() {
  if (!input) return;
  const typed = input.value.trim();
  const paths = attached.map(function (f) { return f.path; });
  const text = [typed, paths.length ? "Files:\n" + paths.join("\n") : ""].filter(Boolean).join("\n\n");
  if (!text || busy) return;
  retireActions();
  setHold("");
  input.value = "";
  attached = [];
  renderFiles();
  fitInput();
  addMsg("user", text);
  setBusy(true, "Thinking");
  const ac = new AbortController();
  const timer = setTimeout(function () {
    ac.abort();
  }, 120000);
  try {
    const r = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
      signal: ac.signal,
    });
    const data = await r.json().catch(function () {
      return {};
    });
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    let spoken = String(data.display || "").trim();
    if (!spoken || spoken.charAt(0) === "{") spoken = "The reply was cut off before it had a command.";
    const pending = addMsg("bot", spoken);
    showDoubt(pending.div, data.warning);
    showReason(pending.div, data.reason);
    renderContext(data.context);
    updateBudget();
    if (data.mode === "A") {
      plan = null;
      check = null;
      pendingA = { display: data.display, userText: text, cmd: data.cmd, result: null };
      renderPending(pending.div);
    } else if (!data.plan || !data.plan.steps || !data.plan.steps.length) {
      plan = null;
      pending.body.textContent = spoken;
    } else {
      pendingA = null;
      plan = data.plan;
      check = null;
      note("plan", planText(plan));
      renderPlan(pending.div);
    }
    dress(pending, spoken);
  } catch (e) {
    addMsg("err", e.name === "AbortError" ? "Timed out after 120s (Ollama busy or model not loaded)" : e.message);
  } finally {
    clearTimeout(timer);
    setBusy(false);
  }
}

if (sendBtn) sendBtn.onclick = turn;
function fitInput() {
  if (!input) return;
  input.style.height = "auto";
  const max = Math.round(window.innerHeight * 0.32);
  input.style.height = Math.min(input.scrollHeight, Math.max(44, max)) + "px";
}
function renderFiles() {
  if (!filesEl) return;
  filesEl.innerHTML = "";
  attached.forEach(function (f) {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    const kb = Math.max(1, Math.round(f.bytes / 1024));
    chip.textContent = f.name + " · " + kb + " KB";
    filesEl.appendChild(chip);
  });
}
async function stashText(text, name) {
  const r = await fetch("/api/drop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name || "pasted.txt", text: text }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "could not store the file");
  attached.push({ name: name || "pasted.txt", path: data.path, bytes: data.bytes || text.length });
  renderFiles();
}
function takeFiles(list) {
  Array.prototype.forEach.call(list, function (file) {
    const reader = new FileReader();
    reader.onload = function () {
      const text = String(reader.result || "");
      if (!text) return;
      if (text.length <= 4000 && input) {
        input.value = (input.value ? input.value + "\n" : "") + text;
        fitInput();
        updateBudget();
        return;
      }
      stashText(text, file.name || "dropped.txt").catch(function (err) {
        addMsg("err", err.message);
      });
    };
    reader.readAsText(file);
  });
}
if (input) {
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      turn();
    }
  });
  input.addEventListener("input", function () {
    fitInput();
    updateBudget();
  });
  input.addEventListener("paste", function (e) {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      takeFiles(files);
      return;
    }
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (text && text.length > 8000) {
      e.preventDefault();
      stashText(text, "pasted.txt").catch(function (err) { addMsg("err", err.message); });
    }
  });
}
if (composer) {
  composer.addEventListener("dragover", function (e) {
    e.preventDefault();
    composer.classList.add("over");
  });
  composer.addEventListener("dragleave", function () {
    composer.classList.remove("over");
  });
  composer.addEventListener("drop", function (e) {
    e.preventDefault();
    composer.classList.remove("over");
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) takeFiles(e.dataTransfer.files);
  });
}

function shareButtons(host, text) {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "ghost";
  copy.textContent = "Copy report";
  copy.onclick = function () {
    const done = function () { copy.textContent = "Copied — paste it in the chat"; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { downloadText("model-report.txt", text); });
    } else {
      downloadText("model-report.txt", text);
      done();
    }
  };
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ghost";
  save.textContent = "Download report";
  save.onclick = function () { downloadText("model-report.txt", text); };
  host.appendChild(copy);
  host.appendChild(save);
}

function downloadText(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

var testBtn = document.getElementById("test");
if (testBtn)
  testBtn.onclick = async function () {
    const box = addMsg("bot", "Testing the model…");
    busy = true;
    if (sendBtn) sendBtn.disabled = true;
    testBtn.disabled = true;
    clearSpinners();
    const probes = [];
    try {
      const listed = await fetch("/api/model-test").then(function (r) { return r.json(); });
      const kinds = listed.kinds || [];
      for (var i = 0; i < kinds.length; i++) {
        box.body.textContent = "Testing the model  " + (i + 1) + "/" + kinds.length + "  " + kinds[i] + "…";
        const r = await fetch("/api/model-test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: kinds[i] }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "model test failed");
        if (data.checks && data.checks[0]) probes.push(data.checks[0]);
      }
      const saved = await fetch("/api/model-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ probes: probes }),
      }).then(function (r) { return r.json(); });
      if (!saved.report) throw new Error(saved.error || "no report");
      const lines = ["Model " + (listed.model || "")];
      if (saved.unit) lines.push("Unit " + saved.unit.passed + "/" + saved.unit.total);
      probes.forEach(function (c) {
        lines.push((c.ok ? "ok" : "not ok") + "  " + (c.kind || c.name) + " — " + (c.diagnosis || c.detail || ""));
      });
      const sane = probes.length && probes.every(function (c) { return c.ok; }) && saved.unit && saved.unit.ok;
      lines.push(sane ? "Sane enough for the workflow." : "Not sane enough for the workflow.");
      lines.push("Copy the report and paste it in the chat.");
      box.body.textContent = lines.join("\n");
      if (box.event) box.event.text = clipText(box.body.textContent, 4000);
      shareButtons(box.div, saved.report);
      downloadText("model-report.txt", saved.report);
    } catch (e) {
      box.body.textContent = e.message;
    } finally {
      busy = false;
      if (sendBtn) sendBtn.disabled = false;
      testBtn.disabled = false;
      clearSpinners();
    }
  };

var exportBtn = document.getElementById("export");
if (exportBtn)
  exportBtn.onclick = async function () {
    const box = addMsg("bot", "Preparing the session report…", true);
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: trace, state: context, plan: planText(plan) }),
      });
      const data = await r.json();
      if (!r.ok || !data.report) throw new Error(data.error || "export failed");
      box.body.textContent = "Session report ready. Copy it and paste it in the chat.\n" + (data.file || "session-report.txt");
      shareButtons(box.div, data.report);
      downloadText("session-report.txt", data.report);
    } catch (e) {
      box.body.textContent = e.message;
    }
  };
var clearBtn = document.getElementById("clear");
if (clearBtn)
  clearBtn.onclick = async function () {
    try {
      const r = await fetch("/api/context/clear", { method: "POST" });
      const d = await r.json().catch(function () { return {}; });
      if (d.cwd) {
        setText(chipCwd, "cwd " + d.cwd);
        if (chipCwd) chipCwd.title = d.cwd;
      }
    } catch (_) {}
    pendingA = null;
    plan = null;
    check = null;
    note("clear", "cleared conversation and state");
    hold = "";
    busy = false;
    if (sendBtn) sendBtn.disabled = false;
    hideSpinner();
    if (chat) chat.replaceChildren();
    if (input) input.value = "";
    attached = [];
    renderFiles();
    fitInput();
    try {
      await refresh();
    } catch (_) {
      renderContext("");
    }
    updateBudget();
  };

refresh().catch(function (e) {
  addMsg("err", e.message);
});
updateBudget();

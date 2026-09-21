const chat = document.getElementById("chat");
const ctxEl = document.getElementById("ctx");
const input = document.getElementById("input");
const status = document.getElementById("status");
const sendBtn = document.getElementById("send");
const attachEl = document.getElementById("attach");
const attachText = document.getElementById("attachText");
const attachDetail = document.getElementById("attachDetail");
const budgetEl = document.getElementById("budget");
const chipModel = document.getElementById("chipModel");
const chipCwd = document.getElementById("chipCwd");

let lastResults = [];
let fullResults = [];
let attachmentNote = "";
let busy = false;
let ctxCache = [];

function setText(el, v) {
  if (el) el.textContent = v;
}

function setBusy(on, label) {
  busy = on;
  if (sendBtn) sendBtn.disabled = on;
  setText(status, on ? (label || "Waiting on model…") : "");
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "You" : role === "err" ? "Error" : "Model";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  div.appendChild(who);
  div.appendChild(body);
  if (chat) {
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }
  return { div: div, body: body };
}

function rawBlob(rows) {
  return (rows || []).map(function (r) {
    return (r.stdout || "") + (r.stderr ? "\n" + r.stderr : "");
  }).join("\n");
}

function renderAttach() {
  const on = lastResults.length > 0;
  if (attachEl) attachEl.className = "attach " + (on ? "on" : "off");
  if (!on) {
    setText(attachText, "No output attached to next send");
    setText(attachDetail, "None");
    return;
  }
  const r = lastResults[0] || {};
  const n = rawBlob(lastResults).length;
  const mode = attachmentNote || r.mode || "full";
  const warn = n > 2500 ? "  ·  large for 8k — consider Summarize" : "";
  setText(attachText, "Will attach on Send · " + (r.cmd || "?") + " · " + mode + " · " + n + " chars" + warn);
  setText(
    attachDetail,
    "cmd " + (r.cmd || "?") +
      "\ncwd " + (r.cwd || "?") +
      "\nexit " + String(r.code) +
      "\nmode " + mode +
      "\n" + n + " chars" +
      (r.instruction ? "\nkeep: " + r.instruction : "")
  );
}

async function updateBudget() {
  try {
    const r = await fetch("/api/prompt-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input ? input.value : "", lastResults: lastResults })
    });
    const s = await r.json();
    const p = s.parts || {};
    if (budgetEl) budgetEl.className = "meter" + (s.pct >= 70 ? " high" : "");
    setText(
      budgetEl,
      "~" + s.tokens + " / " + s.numCtx + " tok  (" + s.pct + "%)  ·  notes " + (p.context || 0) +
        "  attach " + (p.attachment || 0) + "  you " + (p.user || 0)
    );
  } catch (_) {
    setText(budgetEl, "budget unavailable");
  }
}

function useFull() {
  if (!fullResults.length) return;
  lastResults = fullResults.map(function (r) {
    return Object.assign({}, r, { mode: "full", instruction: undefined });
  });
  attachmentNote = "full";
  renderAttach();
  updateBudget();
}

async function summarizeAttach(box) {
  if (!fullResults.length) {
    addMsg("err", "Nothing to summarize. Approve a command first.");
    return;
  }
  const blob = rawBlob(fullResults);
  const goal = ((input && input.value) || "").trim() || "keep names that matter for the next question";
  setBusy(true, "Planning how to summarize…");
  try {
    const pr = await fetch("/api/summarize-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: blob, goal: goal })
    });
    const plan = await pr.json();
    if (!pr.ok) throw new Error(plan.error || "plan failed");
    const why = plan.instruction || "keep names";
    setBusy(true, "Compressing with that plan…");
    const cr = await fetch("/api/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: blob, instruction: why, label: "result", save: false })
    });
    const d = await cr.json();
    if (!cr.ok) throw new Error(d.error || "summarize failed");
    const src = fullResults[0] || {};
    lastResults = [{
      cmd: src.cmd || "summary",
      cwd: src.cwd || "",
      code: src.code,
      stdout: d.text || "",
      stderr: "",
      mode: "summary",
      instruction: why
    }];
    attachmentNote = "summary";
    const host = box || (chat && chat.lastElementChild);
    if (host) {
      const prev = document.createElement("div");
      prev.className = "term";
      prev.textContent = "Summary plan (what the model will keep):\n" + why + "\n\nCompressed output (inspect, then Send):\n" + (d.text || "");
      host.appendChild(prev);
    }
    renderAttach();
    updateBudget();
  } finally {
    setBusy(false);
  }
}

function renderContext(items) {
  if (!ctxEl) return;
  if (items) ctxCache = items.slice();
  ctxEl.innerHTML = "";
  if (!ctxCache.length) {
    const li = document.createElement("li");
    li.style.color = "#8b8d98";
    li.textContent = "Empty. Add a note; the model may add [A] notes.";
    ctxEl.appendChild(li);
    return;
  }
  ctxCache.forEach(function (it) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "chip";
    badge.textContent = it.origin === "U" ? "U" : "A";
    badge.title = it.origin === "U" ? "User-locked" : "Agent";
    const span = document.createElement("span");
    span.textContent = " " + it.text + " ";
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.onclick = async function () {
      const r = await fetch("/api/context/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id })
      });
      const d = await r.json();
      renderContext(d.context || []);
      updateBudget();
    };
    li.appendChild(badge);
    li.appendChild(span);
    li.appendChild(del);
    ctxEl.appendChild(li);
  });
}

async function refresh() {
  const r = await fetch("/api/state");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const s = await r.json();
  setText(chipModel, s.model || "model");
  setText(chipCwd, "cwd " + (s.cwd || s.workspace || ""));
  if (chipCwd) chipCwd.title = s.cwd || s.workspace || "";
  renderContext(s.context);
}

function showPendingOps(box, ops) {
  const wrap = document.createElement("div");
  wrap.className = "plan";
  const h = document.createElement("div");
  h.className = "plan-h";
  h.textContent = "Model wants to change a user-locked (U) note";
  wrap.appendChild(h);
  ops.forEach(function (op) {
    const line = document.createElement("div");
    line.className = "plan-row";
    line.textContent = op.op + " #" + op.id + (op.text ? " → " + op.text : "");
    wrap.appendChild(line);
  });
  const row = document.createElement("div");
  row.className = "rowbtns";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "ok";
  yes.textContent = "Allow note change";
  const no = document.createElement("button");
  no.type = "button";
  no.textContent = "Keep my note";
  yes.onclick = async function () {
    yes.disabled = no.disabled = true;
    const r = await fetch("/api/ops/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: true, ops: ops })
    });
    const d = await r.json();
    renderContext(d.context);
    updateBudget();
  };
  no.onclick = async function () {
    yes.disabled = no.disabled = true;
    const r = await fetch("/api/ops/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allow: false, ops: ops })
    });
    const d = await r.json();
    renderContext(d.context);
  };
  row.appendChild(yes);
  row.appendChild(no);
  wrap.appendChild(row);
  box.appendChild(wrap);
}

function showPlan(box, files, commands) {
  const plan = document.createElement("div");
  plan.className = "plan";
  const h = document.createElement("div");
  h.className = "plan-h";
  h.textContent = "Proposed actions — nothing runs until you approve";
  plan.appendChild(h);
  files.forEach(function (f) {
    const line = document.createElement("div");
    line.className = "plan-row";
    const k = document.createElement("span");
    k.className = "plan-k";
    k.textContent = "WRITE";
    line.appendChild(k);
    line.appendChild(document.createTextNode((f.path || "?") + "  (" + String(f.content || "").length + " chars)"));
    plan.appendChild(line);
  });
  commands.forEach(function (c) {
    const cmd = typeof c === "string" ? c : (c.cmd || "");
    const cwd = typeof c === "object" && c.cwd ? "  in " + c.cwd : "";
    const line = document.createElement("div");
    line.className = "plan-row";
    const k = document.createElement("span");
    k.className = "plan-k";
    k.textContent = "RUN";
    line.appendChild(k);
    line.appendChild(document.createTextNode(cmd + cwd));
    plan.appendChild(line);
  });
  box.appendChild(plan);
}

async function apply(files, commands, box) {
  const r = await fetch("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: files, commands: commands })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "apply failed");
  fullResults = data.results || [];
  lastResults = fullResults.slice();
  attachmentNote = "full";
  const blob = rawBlob(fullResults);
  const out = document.createElement("div");
  out.className = "term";
  out.textContent = blob || "done";
  box.appendChild(out);
  if (data.warn) {
    const w = document.createElement("div");
    w.className = "hint";
    w.style.marginTop = "8px";
    w.textContent = "Output is large (~" + data.estTokens + " tokens). Use full anyway, or Summarize first. The next Send will include it.";
    box.appendChild(w);
  }
  const row = document.createElement("div");
  row.className = "rowbtns";
  function btn(label, cls, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = fn;
    row.appendChild(b);
    return b;
  }
  btn("Use full on next send", "ok", function () { useFull(); });
  btn("Summarize then attach", "", async function () {
    try { await summarizeAttach(box); }
    catch (e) { addMsg("err", e.message); }
  });
  btn("Pin into notes", "", async function () {
    const src = attachmentNote === "summary" ? rawBlob(lastResults) : blob;
    const clip = src.length > 500 ? src.slice(0, 500) + "…" : src;
    const rr = await fetch("/api/context/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clip, origin: "U" })
    });
    const d = await rr.json();
    if (!rr.ok) throw new Error(d.error || "pin failed");
    renderContext(d.context);
    updateBudget();
  });
  btn("Drop", "", function () {
    lastResults = [];
    fullResults = [];
    attachmentNote = "";
    renderAttach();
    updateBudget();
  });
  box.appendChild(row);
  renderAttach();
  updateBudget();
  await refresh();
}

async function turn() {
  if (!input) return;
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  addMsg("user", text);
  const pending = addMsg("bot", "…");
  setBusy(true);
  const ac = new AbortController();
  const timer = setTimeout(function () { ac.abort(); }, 120000);
  try {
    const r = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, lastResults: lastResults }),
      signal: ac.signal
    });
    const data = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    renderAttach();
    updateBudget();
    pending.body.textContent = (data.reason || data.display || "(no text)").trim();
    renderContext(data.context);
    if (data.pendingOps && data.pendingOps.length) showPendingOps(pending.div, data.pendingOps);
    const files = data.files || [];
    const commands = data.commands || [];
    if (!files.length && !commands.length) return;
    pending.div.classList.add("pending");
    showPlan(pending.div, files, commands);
    const row = document.createElement("div");
    row.className = "rowbtns";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "ok";
    yes.textContent = "Approve";
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = "Skip";
    row.appendChild(yes);
    row.appendChild(no);
    pending.div.appendChild(row);
    yes.onclick = async function () {
      yes.disabled = no.disabled = true;
      try { await apply(files, commands, pending.div); }
      catch (e) { addMsg("err", e.message); }
    };
    no.onclick = function () {
      yes.disabled = no.disabled = true;
      pending.body.textContent += "\nSkipped.";
    };
  } catch (e) {
    pending.div.className = "msg err";
    pending.body.textContent = e.name === "AbortError"
      ? "Timed out after 120s (Ollama busy or model not loaded)"
      : e.message;
  } finally {
    clearTimeout(timer);
    setBusy(false);
  }
}

if (sendBtn) sendBtn.onclick = turn;
if (input) {
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); turn(); }
  });
  input.addEventListener("input", updateBudget);
}

function dropAttach() {
  lastResults = [];
  fullResults = [];
  attachmentNote = "";
  renderAttach();
  updateBudget();
}

var attachDrop = document.getElementById("attachDrop");
if (attachDrop) attachDrop.onclick = dropAttach;
var attachFull = document.getElementById("attachFull");
if (attachFull) attachFull.onclick = useFull;
var attachSum = document.getElementById("attachSum");
if (attachSum) attachSum.onclick = async function () {
  try { await summarizeAttach(chat && chat.lastElementChild); }
  catch (e) { addMsg("err", e.message); }
};

var testBtn = document.getElementById("test");
if (testBtn) testBtn.onclick = async function () {
  const box = addMsg("bot", "Running tests…");
  setBusy(true, "Self-test…");
  try {
    const unit = await (await fetch("/api/selftest")).json();
    const lines = ["Runner " + unit.passed + "/" + unit.total + (unit.ok ? " PASS" : " FAIL")];
    (unit.results || []).forEach(function (r) { lines.push((r.ok ? "PASS" : "FAIL") + "  " + r.name); });
    const mr = await fetch("/api/model-test", { method: "POST" });
    const model = await mr.json();
    if (!mr.ok) lines.push("Model FAIL " + (model.error || mr.status));
    else lines.push("Model " + model.model + " " + model.passed + "/" + model.total + (model.ok ? " PASS" : " FAIL"));
    box.body.textContent = lines.join("\n");
  } catch (e) {
    box.body.textContent = e.message;
  } finally {
    setBusy(false);
  }
};

var clearBtn = document.getElementById("clear");
if (clearBtn) clearBtn.onclick = async function () {
  await fetch("/api/context/clear", { method: "POST" });
  dropAttach();
  await refresh();
};

var addBtn = document.getElementById("ctxAdd");
if (addBtn) addBtn.onclick = async function () {
  const text = window.prompt("Note to pin (marked U — model needs your OK to change it)");
  if (!text || !text.trim()) return;
  const r = await fetch("/api/context/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.trim(), origin: "U" })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "add failed");
  renderContext(d.context);
  updateBudget();
};

refresh().catch(function (e) { addMsg("err", e.message); });
renderAttach();
updateBudget();

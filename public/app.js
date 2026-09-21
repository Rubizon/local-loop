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
let attachmentNote = "";
let busy = false;
let ctxLocked = true;
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

function attachmentBlob() {
  return (lastResults || []).map(function (r) {
    return "$ " + r.cmd + " exit " + r.code + "\n" + (r.stdout || "") + "\n" + (r.stderr || "");
  }).join("\n");
}

function renderAttach() {
  const on = lastResults.length > 0;
  if (attachEl) attachEl.className = "attach " + (on ? "on" : "off");
  if (!on) {
    setText(attachText, "No output attached");
    setText(attachDetail, "None");
    return;
  }
  const n = attachmentBlob().length;
  const cmd = lastResults[0] && lastResults[0].cmd;
  setText(attachText, "Attached \u00b7 " + cmd + " \u00b7 " + n + " chars \u00b7 " + (attachmentNote || "full"));
  setText(attachDetail, cmd + " (" + n + " chars, " + (attachmentNote || "full") + ")");
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
    setText(budgetEl, "~" + s.tokens + " / " + s.numCtx + " tok  \u00b7  notes " + (p.context || 0)
      + "  attach " + (p.attachment || 0) + "  you " + (p.user || 0));
  } catch (_) {
    setText(budgetEl, "budget unavailable");
  }
}

function renderContext(items) {
  if (!ctxEl) return;
  if (items) ctxCache = items.slice();
  ctxEl.innerHTML = "";
  if (!ctxCache.length && ctxLocked) {
    const li = document.createElement("li");
    li.style.color = "#8b8d98";
    li.textContent = "Empty. Unlock to type a note.";
    ctxEl.appendChild(li);
    return;
  }
  ctxCache.forEach(function (it, idx) {
    const li = document.createElement("li");
    if (ctxLocked) {
      li.textContent = it.text;
    } else {
      const ta = document.createElement("textarea");
      ta.style.minHeight = "52px";
      ta.value = it.text;
      ta.oninput = function () { ctxCache[idx].text = ta.value; };
      const del = document.createElement("button");
      del.type = "button";
      del.textContent = "Remove";
      del.onclick = function () { ctxCache.splice(idx, 1); renderContext(); };
      li.appendChild(ta);
      li.appendChild(del);
    }
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
  if (ctxLocked) renderContext(s.context);
}

function showPlan(box, files, commands) {
  const plan = document.createElement("div");
  plan.className = "plan";
  const h = document.createElement("div");
  h.className = "plan-h";
  h.textContent = "Proposed actions \u2014 nothing runs until you approve";
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
  lastResults = data.results || [];
  attachmentNote = "full";
  const blob = data.blob || attachmentBlob();
  const out = document.createElement("div");
  out.className = "term";
  out.textContent = blob || "done";
  box.appendChild(out);
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
  btn("Keep full", "ok", function () {
    lastResults = data.results || [];
    attachmentNote = "full";
    renderAttach();
    updateBudget();
  });
  const zip = btn("Summarize", "", async function () {
    zip.disabled = true;
    try {
      const pr = await fetch("/api/summarize-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: blob, goal: "keep names that matter for the next question" })
      });
      const plan = await pr.json();
      if (!pr.ok) throw new Error(plan.error || "plan failed");
      const why = plan.instruction || "keep names";
      const cr = await fetch("/api/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: blob, instruction: why, label: "result", save: false })
      });
      const d = await cr.json();
      if (!cr.ok) throw new Error(d.error || "summarize failed");
      lastResults = [{ cmd: (lastResults[0] && lastResults[0].cmd) || "summary", code: 0, stdout: d.text || "", stderr: "" }];
      attachmentNote = "summary";
      const prev = document.createElement("div");
      prev.className = "term";
      prev.textContent = "Keep: " + why + "\n\n" + (d.text || "");
      box.appendChild(prev);
      renderAttach();
      updateBudget();
    } catch (e) {
      addMsg("err", e.message);
    } finally {
      zip.disabled = false;
    }
  });
  btn("Drop", "", function () {
    lastResults = [];
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
  const pending = addMsg("bot", "\u2026");
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
    if (ctxLocked) renderContext(data.context);
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

var attachDrop = document.getElementById("attachDrop");
if (attachDrop) attachDrop.onclick = function () {
  lastResults = [];
  attachmentNote = "";
  renderAttach();
  updateBudget();
};

var testBtn = document.getElementById("test");
if (testBtn) testBtn.onclick = async function () {
  const box = addMsg("bot", "Running tests\u2026");
  setBusy(true, "Self-test\u2026");
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
  ctxLocked = true;
  setText(document.getElementById("ctxUnlock"), "Unlock");
  var save = document.getElementById("ctxSave");
  var add = document.getElementById("ctxAdd");
  if (save) save.disabled = true;
  if (add) add.disabled = true;
  await refresh();
};

var unlockBtn = document.getElementById("ctxUnlock");
if (unlockBtn) unlockBtn.onclick = function () {
  ctxLocked = !ctxLocked;
  setText(unlockBtn, ctxLocked ? "Unlock" : "Lock");
  var save = document.getElementById("ctxSave");
  var add = document.getElementById("ctxAdd");
  if (save) save.disabled = ctxLocked;
  if (add) add.disabled = ctxLocked;
  renderContext();
};
var addBtn = document.getElementById("ctxAdd");
if (addBtn) addBtn.onclick = function () {
  if (ctxLocked) return;
  ctxCache.push({ id: 0, text: "" });
  renderContext();
};
var saveBtn = document.getElementById("ctxSave");
if (saveBtn) saveBtn.onclick = async function () {
  const r = await fetch("/api/context/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: ctxCache })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "save failed");
  ctxLocked = true;
  setText(document.getElementById("ctxUnlock"), "Unlock");
  saveBtn.disabled = true;
  if (addBtn) addBtn.disabled = true;
  renderContext(d.context);
};

refresh().catch(function (e) { addMsg("err", e.message); });
renderAttach();
updateBudget();

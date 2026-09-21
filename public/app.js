const chat = document.getElementById("chat");
const ctxEl = document.getElementById("ctx");
const input = document.getElementById("input");
const meta = document.getElementById("meta");
const status = document.getElementById("status");
const sendBtn = document.getElementById("send");
const attachEl = document.getElementById("attach");
const budgetEl = document.getElementById("budget");

let lastResults = [];
let attachmentNote = "command output";
let busy = false;
let ctxLocked = true;
let ctxCache = [];

function setBusy(on, label) {
  busy = on;
  sendBtn.disabled = on;
  status.textContent = on ? (label || "waiting on model...") : "";
}

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = role === "user" ? "you" : role === "err" ? "error" : "model";
  const body = document.createElement("div");
  body.className = "body";
  body.textContent = text;
  div.appendChild(who);
  div.appendChild(body);
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return { div: div, body: body };
}

function attachmentBlob() {
  return (lastResults || []).map(function (r) {
    return "$ " + r.cmd + " exit " + r.code + "\n" + (r.stdout || "") + "\n" + (r.stderr || "");
  }).join("\n");
}

function renderAttach() {
  if (!attachEl) return;
  if (!lastResults.length) {
    attachEl.textContent = "No output attached to the next send.";
    return;
  }
  attachEl.textContent = "Next send includes " + lastResults.length + " result(s), "
    + attachmentBlob().length + " chars (" + attachmentNote + ").";
}

async function updateBudget() {
  if (!budgetEl) return;
  try {
    const r = await fetch("/api/prompt-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.value, lastResults: lastResults })
    });
    const s = await r.json();
    const p = s.parts || {};
    budgetEl.textContent = "prompt ~" + s.tokens + " / " + s.numCtx + " tokens (" + s.pct + "%)"
      + "  sys " + (p.system || 0) + "  ctx " + (p.context || 0)
      + "  attach " + (p.attachment || 0) + "  user " + (p.user || 0)
      + (s.pct >= 70 ? "  HIGH" : "");
  } catch (_) {
    budgetEl.textContent = "prompt size unknown";
  }
}

function renderContext(items) {
  if (items) ctxCache = items.slice();
  ctxEl.innerHTML = "";
  if (!ctxCache.length && ctxLocked) {
    const li = document.createElement("li");
    li.style.color = "#8b8b97";
    li.textContent = "Empty. Unlock to type, or send a message to add a Goal.";
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
      del.textContent = "remove";
      del.onclick = function () { ctxCache.splice(idx, 1); renderContext(); };
      li.appendChild(ta);
      li.appendChild(del);
    }
    ctxEl.appendChild(li);
  });
}

async function refresh() {
  const r = await fetch("/api/state");
  const s = await r.json();
  meta.textContent = s.model + " \u00b7 cwd " + (s.cwd || s.workspace);
  if (ctxLocked) renderContext(s.context);
}

function showPlan(box, files, commands) {
  const plan = document.createElement("div");
  plan.className = "actions";
  files.forEach(function (f) {
    const line = document.createElement("div");
    line.textContent = "write  " + (f.path || "?") + "  (" + String(f.content || "").length + " chars)";
    plan.appendChild(line);
  });
  commands.forEach(function (c) {
    const cmd = typeof c === "string" ? c : (c.cmd || "");
    const cwd = typeof c === "object" && c.cwd ? "  in " + c.cwd : "";
    const line = document.createElement("div");
    line.textContent = "cmd   " + cmd + cwd;
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
  attachmentNote = "full command output";
  const blob = data.blob || attachmentBlob();
  const out = document.createElement("div");
  out.className = "actions";
  out.textContent = blob || "done";
  box.appendChild(out);
  const row = document.createElement("div");
  row.className = "rowbtns";
  function btn(label, fn) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = fn;
    row.appendChild(b);
    return b;
  }
  btn("attach full to next send", function () {
    attachmentNote = "full command output";
    renderAttach();
    updateBudget();
  });
  const zip = btn("plan summary", async function () {
    zip.disabled = true;
    try {
      const pr = await fetch("/api/summarize-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: blob, goal: input.value || "next step" })
      });
      const plan = await pr.json();
      const why = plan.instruction || "keep names, exits, errors";
      const cr = await fetch("/api/compress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: blob, instruction: why, label: "result", save: false })
      });
      const d = await cr.json();
      lastResults = [{ cmd: "(summary)", code: 0, stdout: d.text || "", stderr: "" }];
      attachmentNote = "summary: " + why;
      const prev = document.createElement("div");
      prev.className = "actions";
      prev.textContent = "summary plan: " + why + "\n\n" + (d.text || "");
      box.appendChild(prev);
      renderAttach();
      updateBudget();
    } catch (e) {
      addMsg("err", e.message);
    } finally {
      zip.disabled = false;
    }
  });
  btn("discard output", function () {
    lastResults = [];
    attachmentNote = "";
    renderAttach();
    updateBudget();
  });
  box.appendChild(row);
  renderAttach();
  updateBudget();
  if (ctxLocked) await refresh();
}

async function turn() {
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  addMsg("user", text);
  const pending = addMsg("bot", "...");
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
    lastResults = [];
    attachmentNote = "";
    renderAttach();
    updateBudget();
    pending.body.textContent = "Reasoning:\n" + ((data.reason || data.display || "(none)").trim());
    if (ctxLocked) renderContext(data.context);
    const files = data.files || [];
    const commands = data.commands || [];
    if (!files.length && !commands.length) {
      pending.body.textContent += "\n\n(no action proposed)";
      return;
    }
    pending.div.classList.add("pending");
    showPlan(pending.div, files, commands);
    const row = document.createElement("div");
    row.className = "rowbtns";
    const yes = document.createElement("button");
    yes.type = "button";
    yes.className = "ok";
    yes.textContent = "run / write";
    const no = document.createElement("button");
    no.type = "button";
    no.textContent = "skip";
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
      pending.body.textContent += "\n(skipped)";
    };
  } catch (e) {
    pending.div.className = "msg err";
    pending.body.textContent = e.name === "AbortError"
      ? "timed out after 120s (Ollama busy or model not loaded)"
      : e.message;
  } finally {
    clearTimeout(timer);
    setBusy(false);
  }
}

sendBtn.onclick = turn;
input.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); turn(); }
});
input.addEventListener("input", updateBudget);

document.getElementById("test").onclick = async function () {
  const box = addMsg("bot", "running tests...");
  setBusy(true, "tests...");
  try {
    const unit = await (await fetch("/api/selftest")).json();
    const lines = ["runner " + unit.passed + "/" + unit.total + (unit.ok ? " PASS" : " FAIL")];
    (unit.results || []).forEach(function (r) { lines.push((r.ok ? "PASS" : "FAIL") + " " + r.name); });
    const mr = await fetch("/api/model-test", { method: "POST" });
    const model = await mr.json();
    if (!mr.ok) lines.push("model FAIL " + (model.error || mr.status));
    else lines.push("model " + model.model + " " + model.passed + "/" + model.total + (model.ok ? " PASS" : " FAIL"));
    box.body.textContent = lines.join("\n");
  } catch (e) {
    box.body.textContent = e.message;
  } finally {
    setBusy(false);
  }
};

document.getElementById("clear").onclick = async function () {
  await fetch("/api/context/clear", { method: "POST" });
  lastResults = [];
  ctxLocked = true;
  document.getElementById("ctxUnlock").textContent = "unlock";
  document.getElementById("ctxSave").disabled = true;
  document.getElementById("ctxAdd").disabled = true;
  await refresh();
};

document.getElementById("ctxUnlock").onclick = function () {
  ctxLocked = !ctxLocked;
  document.getElementById("ctxUnlock").textContent = ctxLocked ? "unlock" : "lock";
  document.getElementById("ctxSave").disabled = ctxLocked;
  document.getElementById("ctxAdd").disabled = ctxLocked;
  renderContext();
};
document.getElementById("ctxAdd").onclick = function () {
  if (ctxLocked) return;
  ctxCache.push({ id: 0, text: "" });
  renderContext();
};
document.getElementById("ctxSave").onclick = async function () {
  const r = await fetch("/api/context/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: ctxCache })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "save failed");
  ctxLocked = true;
  document.getElementById("ctxUnlock").textContent = "unlock";
  document.getElementById("ctxSave").disabled = true;
  document.getElementById("ctxAdd").disabled = true;
  renderContext(d.context);
};

refresh().catch(function (e) { addMsg("err", "cannot reach server: " + e.message); });
renderAttach();
updateBudget();

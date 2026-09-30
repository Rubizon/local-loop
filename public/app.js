const chat = document.getElementById("chat");
const ctxEl = document.getElementById("ctx");
const input = document.getElementById("input");
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
const trace = [];

function clipText(text, n) {
  const s = String(text || "");
  return s.length <= n ? s : s.slice(0, n) + "\n… " + (s.length - n) + " more characters";
}

function note(kind, text) {
  const event = { t: new Date().toISOString(), kind: kind, text: clipText(text, 4000) };
  trace.push(event);
  if (trace.length > 200) trace.shift();
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
  const note = document.querySelector("#chat .plan .next-note");
  if (note) note.textContent = hold;
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

function showReason(box, text) {
  if (!box || !text) return;
  const el = document.createElement("div");
  el.className = "reason";
  const k = document.createElement("div");
  k.className = "reason-k";
  k.textContent = "Reasoning";
  const p = document.createElement("div");
  p.textContent = text;
  el.appendChild(k);
  el.appendChild(p);
  const body = box.querySelector(".body");
  if (body) box.insertBefore(el, body);
  else box.appendChild(el);
  note("reason", text);
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

async function refresh() {
  const r = await fetch("/api/state");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const s = await r.json();
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
    const keep = s.attach === "none" ? "output is not stored" : "then the model reads the output and updates state";
    line.appendChild(document.createTextNode(s.do + " · " + keep));
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
  if (!finished && step && step.cmd) {
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
    const isList = /^ls\b/.test(String(data.result.cmd || "").trim());
    term.textContent = "$ " + data.result.cmd + "  exit " + data.result.code + (isList ? "" : "\n" + (text.split("\n").length > 18 ? text.split("\n").slice(0, 18).join("\n") + "\n… " + (text.split("\n").length - 18) + " more lines" : text));
    if (isList || text.split("\n").length > 18) {
      const more = document.createElement("button");
      more.type = "button";
      more.textContent = isList ? "Show the raw output" : "Show the full output";
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
  setBusy(true, "Checkpoint");
  try {
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: plan, result: result }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "check failed");
    plan = d.plan;
    check = d.check;
    note("check", (d.check && d.check.ok ? "ok — " : "not ok — ") + ((d.check && (d.check.why || d.check.diagnosis)) || ""));
    note("plan", planText(plan));
    renderContext(d.check.context);
    const finished = d.done || (d.plan && d.plan.steps && d.plan.steps.length && d.plan.steps.every(function (s) { return s.status === "ok"; }));
    if (d.say) addMsg("bot", d.say);
    else if (d.report) addMsg("bot", d.report);
    if (finished) {
      plan = null;
      check = null;
      renderPlan(host);
      setHold("");
      return;
    }
    renderPlan(host);
  } finally {
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
  try {
    await applyOne(step.cmd, step.id, host, function (result) {
      return checkpoint(result, host);
    });
  } catch (e) {
    addMsg("err", e.message);
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
  const text = input.value.trim();
  if (!text || busy) return;
  setHold("");
  input.value = "";
  addMsg("user", text);
  const pending = addMsg("bot", "…");
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
    showReason(pending.div, data.reason);
    pending.body.textContent = (data.display || "(no text)").trim();
    if (pending.event) pending.event.text = clipText(pending.body.textContent, 4000);
    renderContext(data.context);
    updateBudget();
    if (data.mode === "A") {
      plan = null;
      check = null;
      pendingA = { display: data.display, userText: text, cmd: data.cmd, result: null };
      renderPending(pending.div);
    } else if (!data.plan || !data.plan.steps || !data.plan.steps.length) {
      plan = null;
      pending.body.textContent = data.display || "I could not make a command for that.";
    } else {
      pendingA = null;
      plan = data.plan;
      check = null;
      note("plan", planText(plan));
      renderPlan(pending.div);
    }
  } catch (e) {
    pending.div.className = "msg err";
    pending.body.textContent =
      e.name === "AbortError" ? "Timed out after 120s (Ollama busy or model not loaded)" : e.message;
    if (pending.event) pending.event.text = clipText(pending.body.textContent, 4000);
  } finally {
    clearTimeout(timer);
    setBusy(false);
  }
}

if (sendBtn) sendBtn.onclick = turn;
if (input) {
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      turn();
    }
  });
  input.addEventListener("input", function () {
    updateBudget();
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

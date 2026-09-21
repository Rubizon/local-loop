const chat = document.getElementById("chat");
const ctxEl = document.getElementById("ctx");
const input = document.getElementById("input");
const statusEl = document.getElementById("status");
const sendBtn = document.getElementById("send");
const budgetEl = document.getElementById("budget");
const modeHint = document.getElementById("modeHint");
const chipModel = document.getElementById("chipModel");
const chipCwd = document.getElementById("chipCwd");
const modesEl = document.getElementById("modes");

let busy = false;
let forced = null;
let context = "";
let pendingA = null;
let plan = null;
let check = null;
let numCtx = 8192;

function setText(el, v) {
  if (el) el.textContent = v;
}

function setBusy(on, label) {
  busy = on;
  if (sendBtn) sendBtn.disabled = on;
  setText(statusEl, on ? (label || "Waiting…") : "");
}

function addMsg(role, text) {
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
  if (chat) {
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }
  return { div: div, body: body };
}

function guessMode(text) {
  const t = (text || "").trim();
  if (forced === "A" || forced === "B") return { mode: forced, why: "user" };
  if (/^\s*(plan|task)\s*:/i.test(t)) return { mode: "B", why: "forced plan" };
  if (/^\s*(ask|do|one)\s*:/i.test(t)) return { mode: "A", why: "forced direct" };
  if (/\b(then|and then|after that|zip\b|excel|xlsx|csv\b|for all|every |step by step|pipeline|search all)\b/i.test(t)) {
    return { mode: "B", why: "multi-step language" };
  }
  return { mode: "A", why: "direct default" };
}

function paintModes() {
  const g = guessMode(input ? input.value : "");
  const active = forced || g.mode;
  if (!modesEl) return;
  Array.prototype.forEach.call(modesEl.querySelectorAll("button"), function (btn) {
    btn.classList.toggle("on", btn.getAttribute("data-mode") === active);
  });
  setText(modeHint, (g.mode === "B" ? "Plan" : "Direct") + " · " + g.why + " · Enter send");
}

function renderContext(text) {
  context = String(text || "");
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
  const wrap = document.createElement("div");
  wrap.className = "plan";
  const h = document.createElement("div");
  h.className = "plan-h";
  h.textContent = "Direct — nothing is stored yet";
  wrap.appendChild(h);
  if (pendingA.cmd && !pendingA.result) {
    const line = document.createElement("div");
    line.className = "plan-row";
    const k = document.createElement("span");
    k.className = "plan-k";
    k.textContent = "RUN";
    line.appendChild(k);
    line.appendChild(document.createTextNode(pendingA.cmd));
    wrap.appendChild(line);
  }
  host.appendChild(wrap);
  const items = [];
  if (pendingA.cmd && !pendingA.result) {
    items.push({
      label: "Approve",
      ok: true,
      fn: async function () {
        try {
          await applyOne(pendingA.cmd, null, host, function (result) {
            pendingA.result = result;
            renderPending(host);
          });
        } catch (e) {
          addMsg("err", e.message);
        }
      },
    });
    items.push({
      label: "Skip command",
      fn: function () {
        pendingA.cmd = null;
        renderPending(host);
      },
    });
  }
  items.push({
    label: "Add",
    ok: true,
    fn: function () {
      addContext(false);
    },
  });
  if (pendingA.result) {
    items.push({
      label: "Add with output",
      fn: function () {
        addContext(true);
      },
    });
  }
  items.push({
    label: "Discard",
    fn: function () {
      pendingA = null;
      wrap.remove();
    },
  });
  rowBtns(wrap, items);
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
    line.appendChild(document.createTextNode(s.do + "  · expect " + s.expect + " · keep " + s.attach));
    wrap.appendChild(line);
  });
  if (check) {
    const c = document.createElement("div");
    c.className = "hint";
    c.style.padding = "8px 10px";
    c.textContent = "Checkpoint: " + (check.ok ? "ok" : "not ok") + " — " + (check.why || "");
    wrap.appendChild(c);
  }
  host.appendChild(wrap);
  const step = plan.steps && plan.steps[plan.cursor];
  const finished = plan.steps && plan.steps.length && plan.steps.every(function (s) { return s.status === "ok"; });
  const items = [];
  if (step && !finished) {
    items.push({
      label: step.cmd ? "Approve step" : "Need input",
      ok: true,
      fn: function () {
        runPlanStep(host);
      },
    });
  }
  items.push({
    label: "Drop plan",
    fn: function () {
      plan = null;
      check = null;
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
    term.textContent =
      "$ " + data.result.cmd + "  exit " + data.result.code + "\n" + (data.result.stdout || "") + (data.result.stderr ? "\n" + data.result.stderr : "");
    host.appendChild(term);
    if (after) await after(data.result);
  } finally {
    setBusy(false);
  }
}

async function addContext(withOutput) {
  if (!pendingA) return;
  setBusy(true, "Rewriting context");
  try {
    const r = await fetch("/api/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userText: pendingA.userText,
        display: pendingA.display,
        output: withOutput && pendingA.result ? pendingA.result.stdout : undefined,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "add failed");
    renderContext(d.context);
    pendingA = null;
    updateBudget();
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
    renderContext(d.check.context);
    if (d.snippet) addMsg("bot", "Kept from this step: " + d.snippet);
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
        renderPlan(host);
        return;
      }
      check = {
        ok: false,
        why: "This step needs you.",
        ask: (d.emit && d.emit.ask) || step.need || step.do,
        replan: false,
        startOver: false,
      };
      renderPlan(host);
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
  input.value = "";
  paintModes();
  addMsg("user", text);
  const pending = addMsg("bot", "…");
  setBusy(true, guessMode(text).mode === "B" ? "Planning" : "Direct");
  const ac = new AbortController();
  const timer = setTimeout(function () {
    ac.abort();
  }, 120000);
  try {
    const r = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, forced: forced }),
      signal: ac.signal,
    });
    const data = await r.json().catch(function () {
      return {};
    });
    if (!r.ok) throw new Error(data.error || "HTTP " + r.status);
    pending.body.textContent = (data.display || "(no text)").trim();
    renderContext(data.context);
    updateBudget();
    if (data.mode === "A") {
      plan = null;
      check = null;
      pendingA = { display: data.display, userText: text, cmd: data.cmd, result: null };
      renderPending(pending.div);
    } else {
      pendingA = null;
      plan = data.plan;
      check = null;
      renderPlan(pending.div);
    }
  } catch (e) {
    pending.div.className = "msg err";
    pending.body.textContent =
      e.name === "AbortError" ? "Timed out after 120s (Ollama busy or model not loaded)" : e.message;
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
    paintModes();
    updateBudget();
  });
}

if (modesEl) {
  modesEl.addEventListener("click", function (e) {
    const btn = e.target.closest("button[data-mode]");
    if (!btn) return;
    const m = btn.getAttribute("data-mode");
    forced = forced === m ? null : m;
    paintModes();
  });
}

var testBtn = document.getElementById("test");
if (testBtn)
  testBtn.onclick = async function () {
    const box = addMsg("bot", "Running tests…");
    setBusy(true, "Self-test…");
    try {
      const unit = await (await fetch("/api/selftest")).json();
      const lines = ["Runner " + unit.passed + "/" + unit.total + (unit.ok ? " PASS" : " FAIL")];
      (unit.results || []).forEach(function (r) {
        lines.push((r.ok ? "PASS" : "FAIL") + "  " + r.name);
      });
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
if (clearBtn)
  clearBtn.onclick = async function () {
    await fetch("/api/context/clear", { method: "POST" });
    pendingA = null;
    plan = null;
    check = null;
    await refresh();
    updateBudget();
  };

refresh().catch(function (e) {
  addMsg("err", e.message);
});
paintModes();
updateBudget();

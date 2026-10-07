"use strict";

const PREDICT = { think: 160, goal: 48, method: 24, say: 160, ask: 64, cmd: 220, plan: 240, replan: 240 };

const PROMPTS = {
  think: `One JSON object. The first character is {.
{"note":"one sentence"}
Name the fact this PC must print. The command that prints it has to exit.
Do not copy these instructions. Do not write a command.`,
  goal: `One JSON object. The first character is {.
{"goal":"one line"}
The goal is the outcome, not the steps.
If the user continues the same job, keep the old goal. A new job replaces it.`,
  method: `One JSON object. The first character is {.
{"method":"say"}
method is say, ask, cmd, or plan.
say: the answer is text and needs no machine.
ask: only the user knows a missing fact.
cmd: one shell command can do it.
plan: it needs more than one of those.`,
  say: `One JSON object. The first character is {.
{"text":"the answer"}
Use only GOAL and IN. No shell command. No state lines.
text is the content they asked for. Do not repeat their request.`,
  ask: `One JSON object. The first character is {.
{"ask":"one question"}
Ask only for the missing fact.`,
  cmd: `One JSON object. The first character is {.
{"cmd":"one shell command"}
You are on the user's PC. The command has not run.
It prints the quantity the question asks for, then it exits.
Do not use watch, top, or follow mode. Use only GOAL and IN.
Do not invent file contents. A command may span lines.`,
  plan: `One JSON object. The first character is {.
{"steps":[{"id":"A","method":"say","do":"what this step does","need":[],"out":"name"}]}
At most 4 steps. method is say, ask, or cmd.
need is the slot names this step reads. out is the slot it writes.
Do not include a command. Do not do the work in this reply.`,
  replan: `One JSON object. The first character is {.
{"steps":[{"id":"A","method":"cmd","do":"what","need":[],"out":"name"}]}
Replace only the failed step and what follows. At most 3 steps.
The new command must print the answer and exit. Do not repeat the command that failed.`,
};

function clip(text, n) {
  const s = String(text || "");
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function stripThink(raw) {
  return String(raw || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

function extractJson(text) {
  const trimmed = stripThink(text);
  const start = trimmed.indexOf("{");
  if (start < 0) return { _raw: true };
  let depth = 0;
  let end = -1;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++;
    else if (trimmed[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return { _raw: true };
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch (_) {
    return { _raw: true, slice: trimmed.slice(start, end + 1) };
  }
}

function field(raw, key) {
  const parsed = extractJson(raw);
  if (!parsed._raw && parsed[key] != null && typeof parsed[key] !== "object") return String(parsed[key]).trim();
  const body = stripThink(raw);
  const quoted = body.match(new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"', "i"));
  if (quoted) return quoted[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  const loose = body.match(new RegExp("\\b" + key + "\\s*[:=]\\s*([^}\\n]+)", "i"));
  return loose ? loose[1].replace(/[{}"]/g, "").trim() : "";
}

function normMethod(value) {
  const text = String(value || "").toLowerCase();
  if (/\bplan\b/.test(text)) return "plan";
  if (/\bask\b|question/.test(text)) return "ask";
  if (/\bcmd\b|command|shell/.test(text)) return "cmd";
  if (/\bsay\b|answer|text/.test(text)) return "say";
  return "";
}

function parseBoard(text) {
  const board = { goal: "", method: "", cursor: "", ask: "", think: "", slots: {} };
  String(text || "").split("\n").forEach((line) => {
    const goal = line.match(/^(?:KEEP\s+)?GOAL:\s*(.*)$/i);
    const method = line.match(/^METHOD:\s*(.*)$/i);
    const cursor = line.match(/^CURSOR:\s*(.*)$/i);
    const ask = line.match(/^ASK:\s*(.*)$/i);
    const thought = line.match(/^THINK:\s*(.*)$/i);
    const slot = line.match(/^SLOT\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (goal) board.goal = goal[1].trim();
    else if (method) board.method = normMethod(method[1]) || method[1].trim();
    else if (cursor) board.cursor = cursor[1].trim();
    else if (ask) board.ask = ask[1].trim();
    else if (thought) board.think = thought[1].trim();
    else if (slot) board.slots[slot[1]] = slot[2].trim();
  });
  return board;
}

function writeBoard(board) {
  const lines = [];
  if (board.goal) lines.push("GOAL: " + clip(board.goal, 180));
  if (board.think) lines.push("THINK: " + clip(board.think, 160));
  if (board.method) lines.push("METHOD: " + board.method);
  if (board.cursor) lines.push("CURSOR: " + board.cursor);
  if (board.ask) lines.push("ASK: " + clip(board.ask, 180));
  Object.keys(board.slots || {}).forEach((key) => {
    const value = String(board.slots[key] || "").trim();
    if (value) lines.push("SLOT " + key + ": " + clip(value.replace(/\s+/g, " "), 180));
  });
  return lines.join("\n");
}

function frameFor(step, board) {
  const lines = ["GOAL: " + (board.goal || "")];
  if (board.think) lines.push("THINK: " + board.think);
  lines.push("DO: " + (step.do || ""));
  (step.need || []).forEach((name) => {
    const value = board.slots && board.slots[name];
    if (value) lines.push("IN " + name + ": " + value);
  });
  return lines.join("\n");
}

function parsePlanSteps(raw) {
  const parsed = extractJson(raw);
  const list = !parsed._raw && Array.isArray(parsed.steps) ? parsed.steps : [];
  return list.slice(0, 4).map((step, index) => {
    const method = normMethod(step && step.method) || "cmd";
    const need = Array.isArray(step && step.need)
      ? step.need.map((item) => String(item))
      : String((step && step.need) || "").split(/[,\s]+/).filter(Boolean);
    return {
      id: String((step && step.id) || String.fromCharCode(65 + index)).slice(0, 8),
      method: method === "plan" ? "cmd" : method,
      do: clip(String((step && (step.do || step.text)) || "step"), 160),
      need: need.filter((name) => name && name !== "none").slice(0, 4),
      out: String((step && step.out) || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 24),
      cmd: null,
      status: "todo",
      expect: method === "cmd" ? "exit 0" : "a short value",
      attach: "summary",
    };
  }).filter((step) => step.method === "say" || step.method === "ask" || step.method === "cmd");
}

function fallbackPlan(text) {
  const file = (String(text || "").match(/\b([A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,7})\b/) || [])[1] || "the file";
  return parsePlanSteps(JSON.stringify({
    steps: [
      { id: "A", method: "say", do: "Write the text the user wants stored", need: [], out: "text" },
      { id: "B", method: "cmd", do: "Write $text into " + file, need: ["text"], out: "path" },
    ],
  }));
}

function digestResult(cmd, result) {
  const code = result && result.code;
  const stdout = String((result && result.stdout) || "");
  const stderr = String((result && result.stderr) || "").trim();
  if (code !== 0) return "ERR: " + clip(stderr || "exit " + code, 120);
  const redir = String(cmd || "").match(/(?:>>?)\s*([^\s;&]+)/);
  if (redir && !stdout.trim()) return redir[1] + " written";
  return clip(stdout.replace(/\s+/g, " ").trim() || "ok", 160);
}

function applyCmdSlot(stateText, step, result) {
  const board = parseBoard(stateText);
  if (step && step.out) board.slots[step.out] = digestResult(result && result.cmd, result);
  if (!board.goal && step && step.do) board.goal = step.do;
  board.method = board.method || "plan";
  return writeBoard(board);
}

function composeThenStore(text) {
  const t = String(text || "");
  if (!/\b[A-Za-z0-9_-]+\.[A-Za-z0-9]+\b/.test(t)) return false;
  if (!/\b(write|put|save|into|file)\b/i.test(t)) return false;
  if (!/\b(list|summar|report|every|each|all)\b/i.test(t)) return false;
  if (/["'][^"']+["']/.test(t)) return false;
  if (/(\d+)\s*(?:->|to|through|…|\.{2,}|-)\s*(\d+)/.test(t)) return false;
  return true;
}

function storeCmd(file, text) {
  const body = String(text || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n");
  return "python3 -c \"open('" + file + "','w').write('" + body + "\\n')\"";
}

function echoed(user, value) {
  const flat = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const left = flat(user);
  const right = flat(value);
  if (!right || right.length < 8) return false;
  return left.indexOf(right) !== -1 || right.indexOf(left.slice(0, 40)) !== -1;
}

function brief(user, board) {
  const lines = [];
  if (board && board.goal) lines.push("GOAL: " + clip(board.goal, 160));
  if (board && board.think) lines.push("THINK: " + clip(board.think, 160));
  const slots = (board && board.slots) || {};
  Object.keys(slots).slice(0, 3).forEach((key) => {
    const value = String(slots[key] || "").trim();
    if (value) lines.push("SLOT " + key + ": " + clip(value, 100));
  });
  lines.push("User: " + clip(user, 360));
  return lines.join("\n");
}

function plainThink(text) {
  let s = String(text || "");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/[*_#>`]+/g, " ");
  s = s.replace(/\b(determine the next step|next step|reasoning|thought)\s*:\s*/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (/json object|first character|constraint:|user question|analyze the request|these instructions/i.test(s)) return "";
  s = s.replace(/\s*\([^)]*$/, "").trim();
  s = s.replace(/[,:;]+$/, "").trim();
  if (!s || /^[{}]+$/.test(s)) return "";
  if (!/[.!?]$/.test(s)) s += ".";
  if (s.length <= 140) return s;
  const cut = s.slice(0, 140);
  const space = cut.lastIndexOf(" ");
  return (space > 40 ? cut.slice(0, space) : cut).replace(/[,:;]+$/, "") + ".";
}

function thinkNote(raw) {
  const note = field(raw, "note");
  if (note && /^one sentence\.?$/i.test(note)) return "";
  return plainThink(note || stripThink(raw));
}

function beatReason(method, steps) {
  if (method === "ask") return "A fact is missing, so this waits for you.";
  if (method === "cmd") return "One command. Nothing runs until you approve.";
  if (method === "plan") return "This takes " + ((steps && steps.length) || 0) + " steps. Each command waits for you.";
  return "This is an answer. No command.";
}

async function call(callModel, kind, user) {
  const raw = await callModel(kind, user);
  return stripThink(raw);
}

async function runBeats(text, stateText, callModel, onState) {
  const show = (board) => { if (onState) onState(board); };
  const prior = parseBoard(stateText);
  let slots = { ...prior.slots };
  let goalHint = prior.goal;
  let user = String(text || "").trim();
  if (prior.method === "ask" && prior.ask) {
    slots.answer = clip(user, 180);
    user = "GOAL: " + prior.goal + "\nThe user answered: " + slots.answer;
    goalHint = prior.goal;
  }
  const thinkRaw = await call(callModel, "think", brief(user, { goal: goalHint, slots: slots }));
  const thought = thinkNote(thinkRaw);
  let board = { goal: goalHint, method: "", cursor: "", ask: "", think: thought, slots: slots };
  if (thought) show(writeBoard(board));
  const goalRaw = await call(callModel, "goal", brief(user, board));
  const goal = field(goalRaw, "goal") || goalHint || clip(text, 140);
  board.goal = goal;
  show(writeBoard(board));
  const methodRaw = await call(callModel, "method", "GOAL: " + goal);
  let method = normMethod(field(methodRaw, "method")) || "say";
  if (composeThenStore(text)) method = "plan";
  board.method = method;
  show(writeBoard(board));
  if (method === "say") {
    const raw = await call(callModel, "say", frameFor({ do: goal, need: Object.keys(slots) }, board));
    const spoken = field(raw, "text") || field(raw, "display") || "I could not answer that.";
    return { mode: "A", why: "say", reason: thought || beatReason("say"), display: spoken, cmd: null, plan: null, context: writeBoard(board) };
  }
  if (method === "ask") {
    const raw = await call(callModel, "ask", "GOAL: " + goal);
    const ask = field(raw, "ask") || "What is missing?";
    board.ask = ask;
    show(writeBoard(board));
    return { mode: "A", why: "ask", reason: thought || beatReason("ask"), display: ask, cmd: null, plan: null, context: writeBoard(board) };
  }
  if (method === "cmd") {
    const raw = await call(callModel, "cmd", frameFor({ do: goal, need: Object.keys(slots) }, board));
    const cmd = field(raw, "cmd");
    const plan = {
      goal: "GOAL: " + goal,
      ask: goal,
      cursor: 0,
      fromModel: true,
      steps: [{ id: "A", method: "cmd", do: goal, need: [], out: "result", cmd: cmd, status: "todo", expect: "exit 0", attach: "summary" }],
    };
    board.cursor = "A";
    show(writeBoard(board));
    return { mode: "B", why: "cmd", reason: thought || beatReason("cmd"), display: goal, cmd: cmd, plan: plan, context: writeBoard(board) };
  }
  const planRaw = await call(callModel, "plan", "GOAL: " + goal + "\nUser:\n" + clip(text, 400));
  let steps = parsePlanSteps(planRaw);
  if (!steps.length || (composeThenStore(text) && (!steps[0] || steps[0].method !== "say"))) steps = fallbackPlan(text);
  const said = [];
  let cursor = 0;
  while (steps[cursor] && steps[cursor].method === "say" && cursor < 3) {
    const step = steps[cursor];
    const raw = await call(callModel, "say", frameFor(step, board));
    const value = field(raw, "text") || field(raw, "display") || "";
    if (step.out && value) slots[step.out] = clip(value.replace(/\s+/g, " "), 180);
    board.slots = slots;
    steps[cursor] = { ...step, status: "ok" };
    if (value) said.push(value);
    cursor += 1;
    board.cursor = steps[cursor] ? steps[cursor].id : "done";
    show(writeBoard(board));
  }
  if (steps[cursor] && steps[cursor].method === "cmd") {
    if (composeThenStore(text)) {
      const file = (String(text).match(/\b([A-Za-z0-9_-]+\.[A-Za-z0-9]+)\b/) || [])[1];
      const payload = said.filter((line) => !echoed(text, line)).join("\n");
      steps[cursor] = { ...steps[cursor], cmd: payload && file ? storeCmd(file, payload) : "" };
    } else {
      const raw = await call(callModel, "cmd", frameFor(steps[cursor], board));
      steps[cursor] = { ...steps[cursor], cmd: field(raw, "cmd") };
    }
    board.cursor = steps[cursor].id;
    show(writeBoard(board));
  }
  const plan = { goal: "GOAL: " + goal, ask: goal, cursor: cursor, fromModel: true, steps: steps };
  if (!steps[cursor]) {
    board.cursor = "done";
    return { mode: "A", why: "plan", reason: thought || beatReason("plan", steps), display: said.join("\n\n") || goal, cmd: null, plan: null, context: writeBoard(board) };
  }
  if (steps[cursor].method === "ask") {
    board.ask = steps[cursor].do;
    show(writeBoard(board));
    return { mode: "A", why: "ask", reason: thought || beatReason("ask"), display: steps[cursor].do, cmd: null, plan: plan, context: writeBoard(board) };
  }
  if (composeThenStore(text) && steps[cursor].method === "cmd" && !steps[cursor].cmd) {
    return {
      mode: "A",
      why: "ask",
      reason: "The reply repeated the request instead of the content.",
      display: "I am unsure what I am doing here.",
      cmd: null,
      plan: null,
      warning: { sign: "I am unsure what I am doing here.", why: "The reply repeated the request instead of the content." },
      context: writeBoard(board),
    };
  }
  return {
    mode: "B",
    why: "plan",
    reason: thought || beatReason("plan", steps),
    display: said.join("\n\n") || goal,
    cmd: steps[cursor].cmd || null,
    plan: plan,
    context: writeBoard(board),
  };
}

async function fillStep(step, stateText, callModel) {
  const board = parseBoard(stateText);
  if (!board.goal) board.goal = step.do || "";
  if (step.method === "ask") return { ask: step.do, context: writeBoard(board) };
  if (step.method === "say") {
    const raw = await call(callModel, "say", frameFor(step, board));
    const value = field(raw, "text") || field(raw, "display") || "";
    if (step.out && value) board.slots[step.out] = clip(value.replace(/\s+/g, " "), 180);
    return { say: value, context: writeBoard(board) };
  }
  const raw = await call(callModel, "cmd", frameFor(step, board));
  return { cmd: field(raw, "cmd"), context: writeBoard(board) };
}

async function selfCheckBeats() {
  const canned = {
    think: '{"note":"Produce the list, then store it."}',
    goal: '{"goal":"foo.txt contains the weekdays"}',
    method: '{"method":"plan"}',
    plan: '{"steps":[{"id":"A","method":"say","do":"name Monday through Friday","need":[],"out":"days"},{"id":"B","method":"cmd","do":"write $days into foo.txt","need":["days"],"out":"path"}]}',
    say: '{"text":"Monday, Tuesday, Wednesday, Thursday, Friday"}',
    cmd: '{"cmd":"printf \'%s\\\\n\' Monday Tuesday Wednesday Thursday Friday > foo.txt"}',
  };
  const seen = [];
  const out = await runBeats(
    "list all work days into a new file foo.txt",
    "",
    async (kind) => canned[kind] || "{}",
    (board) => seen.push(board)
  );
  const checks = [
    ["a copied instruction is not a thought", thinkNote('yze the Request: User Question: "Is the GPU hotter?" Constraint: "Think, then one JSON object. The first character.') === ""],
    ["think is shown before the goal", /THINK: Produce the list/.test(seen[0] || "") && seen.some((board) => /GOAL: foo\.txt contains the weekdays/.test(board))],
    ["method shown before the command", seen.some((board) => /METHOD: plan/.test(board) && !/cmd:/.test(board))],
    ["slot is the weekday list", seen.some((board) => /SLOT days: Monday/.test(board))],
    ["say text is shown", /Monday, Tuesday/.test(out.display || "")],
    ["write stays a command", !!(out.plan && /foo\.txt/.test(out.plan.steps[1].cmd || "") && out.cmd)],
    ["stored text is the answer, not a canned command", /Monday, Tuesday/.test(out.cmd || "") && !/printf/.test(out.cmd || "")],
    ["answer keeps the goal", parseBoard(writeBoard({ goal: "keep", method: "ask", ask: "Name?", slots: {} })).goal === "keep"],
  ];
  const failed = checks.filter((row) => !row[1]);
  return { ok: !failed.length, passed: checks.length - failed.length, total: checks.length, detail: failed.map((row) => row[0]).join(", ") };
}

module.exports = {
  PREDICT,
  PROMPTS,
  stripThink,
  field,
  normMethod,
  parseBoard,
  writeBoard,
  parsePlanSteps,
  digestResult,
  applyCmdSlot,
  frameFor,
  runBeats,
  fillStep,
  selfCheckBeats,
};

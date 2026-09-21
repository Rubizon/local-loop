const path = require("path");
const fs = require("fs");

const CONTEXT_MAX_CHARS = 1600;
const CONTEXT_MAX_LINES = 12;
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
const DENY_CMD = /(\bsudo\b|\brm\s+-rf\s+\/|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\s+777|\bchown\s+-R\s+|\bcurl\b[^|&;]*\|\s*(sh|bash)|:\(\)\s*\{)/i;

const SYSTEM_A = `Direct mode. JSON only:
{"display":"what the human should read","cmd":null}
cmd is at most one shell command. Omit or null if none.
Do not edit working context. Do not invent files not in the user text or attached output.`;

const SYSTEM_REWRITE = `Rewrite the whole working context. JSON only:
{"context":"multiline text"}
Rules:
1. Lines starting KEEP stay unless the user asked to drop them.
2. If there is no KEEP GOAL after this turn, return {"context":""}.
3. Never paste command dumps. Store short facts, paths, counts.
4. Durable facts: KEEP …  The objective: KEEP GOAL: …
5. Max 12 lines.`;

const SYSTEM_PLAN = `Plan a small task tree. JSON only:
{"display":"one paragraph","goal":"KEEP GOAL line","steps":[{"id":"1","do":"action","need":"input","expect":"checkpoint in one line","attach":"none|paths|summary|full","cmd":"one command or null"}]}
3-6 steps. One command per step, or cmd null to ask the user (need = the question).
attach = how to keep that step's output. expect = how we know the step worked.`;

const SYSTEM_CHECK = `Checkpoint a plan step. JSON only:
{"ok":true,"why":"one line","ask":null,"replan":false,"startOver":false,"next":"id or done","attach":"none|paths|summary|full","context":"full rewritten context"}
ok if output matches expect. If output is huge, attach=summary (not full).
KEEP rules as in rewrite. startOver if the task cannot continue and files should roll back.`;

const SYSTEM_EMIT = `Emit ONE command for this step, or ask. JSON only:
{"cmd":"one shell command or null","ask":"question or null"}
Use facts already in context. Do not invent file contents you have not seen.`;

const SYSTEM_REPLAN = `Revise remaining steps after a failed checkpoint. JSON only:
{"display":"one paragraph","steps":[{"id":"1","do":"action","need":"input","expect":"one line","attach":"none|paths|summary|full","cmd":"one command or null"}]}
Keep finished work. 1-5 remaining steps. Do not repeat done steps.`;

const MODEL_PROBE_USER = 'Reply with JSON only: {"display":"PING-OK","cmd":null}';

function clip(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function hasGoal(text) {
  return /KEEP\s+GOAL:/i.test(String(text || ""));
}

function keepLines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^KEEP\b/i.test(l));
}

function clipContext(text) {
  const raw = String(text || "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  let out = raw.slice(0, CONTEXT_MAX_LINES).join("\n");
  if (out.length > CONTEXT_MAX_CHARS) out = out.slice(0, CONTEXT_MAX_CHARS) + "…";
  return out.trim();
}

function userDropsContext(userText) {
  return /\b(drop all|clear context|forget everything|reset context)\b/i.test(userText);
}

function looksLikeGoal(text) {
  return /\b(keep goal|goal is|remember (that|we|this)|objective|until we|working on)\b/i.test(String(text || ""));
}

function heuristicRewrite(oldText, userText, display, output) {
  if (userDropsContext(userText)) return "";
  if (!hasGoal(oldText) && !looksLikeGoal(userText) && !looksLikeGoal(display) && !hasGoal(output)) return "";
  return null;
}

function finalizeRewrite(oldText, proposed, userText) {
  if (userDropsContext(userText)) return "";
  let text = clipContext(proposed);
  if (!hasGoal(text) && !hasGoal(oldText)) return "";
  if (!hasGoal(text) && hasGoal(oldText) && !/\b(drop (the )?goal)\b/i.test(userText)) {
    const goal = keepLines(oldText).filter((l) => /GOAL:/i.test(l));
    text = clipContext(goal.concat(text.split("\n").filter(Boolean)).join("\n"));
  }
  return text;
}

function pickMode(text, context, forced) {
  const t = String(text || "").trim();
  if (forced === "A" || forced === "B") return { mode: forced, why: "user" };
  if (/^\s*(plan|task)\s*:/i.test(t)) return { mode: "B", why: "forced plan" };
  if (/^\s*(ask|do|one)\s*:/i.test(t)) return { mode: "A", why: "forced direct" };
  if (/\b(then|and then|after that|collect\b.+\band\b|zip\b|excel|xlsx|csv\b|for all|every |step by step|pipeline|search all)\b/i.test(t)) {
    return { mode: "B", why: "multi-step language" };
  }
  if (hasGoal(context) && /\b(continue|next step|resume|the plan)\b/i.test(t)) return { mode: "B", why: "resume plan" };
  return { mode: "A", why: "direct default" };
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  const fence = trimmed.match(/```(?:json)?\s*/i);
  let candidate = trimmed;
  if (fence && fence.index !== undefined) {
    const after = trimmed.slice(fence.index + fence[0].length);
    const close = after.indexOf("```");
    candidate = (close >= 0 ? after.slice(0, close) : after).trim();
  }
  const start = candidate.indexOf("{");
  if (start === -1) return { display: clip(trimmed, 2000), _raw: true };
  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    if (candidate[i] === "{") depth++;
    else if (candidate[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return { display: clip(trimmed, 2000), _raw: true };
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (_) {
    return { display: clip(trimmed, 2000), _raw: true };
  }
}

function parseDirect(raw) {
  const p = extractJson(raw);
  let cmd = typeof p.cmd === "string" && p.cmd.trim() ? p.cmd.trim() : null;
  if (!cmd && Array.isArray(p.commands) && p.commands[0]) {
    cmd = String((p.commands[0] && p.commands[0].cmd) || p.commands[0]).trim();
  }
  return {
    display: typeof p.display === "string" && p.display.trim() ? p.display.trim() : clip(String(raw), 800),
    cmd: cmd || null,
  };
}

function asStep(row, i) {
  const attach = String((row && row.attach) || "summary");
  return {
    id: String((row && row.id) || i + 1),
    do: String((row && (row.do || row.text)) || "step"),
    need: String((row && row.need) || ""),
    expect: String((row && row.expect) || "command succeeds"),
    attach: ["none", "paths", "summary", "full"].includes(attach) ? attach : "summary",
    cmd: !row || row.cmd == null || row.cmd === "" ? null : String(row.cmd),
    status: "todo",
  };
}

function parsePlan(raw, fallbackGoal) {
  const p = extractJson(raw);
  const stepsIn = Array.isArray(p.steps) ? p.steps : [];
  const steps = stepsIn.slice(0, 6).map(asStep).filter((s) => s.do.trim());
  const goal = String(p.goal || fallbackGoal || "").trim() || "KEEP GOAL: (untitled)";
  return {
    goal: /^KEEP\s+GOAL:/i.test(goal) ? goal : "KEEP GOAL: " + goal,
    steps,
    cursor: 0,
  };
}

function parseCheck(raw, fallbackContext) {
  const p = extractJson(raw);
  return {
    ok: p.ok === true,
    why: String(p.why || p.display || ""),
    ask: p.ask == null || p.ask === "" ? null : String(p.ask),
    replan: p.replan === true,
    startOver: p.startOver === true,
    next: p.next == null ? "done" : String(p.next),
    attach: ["none", "paths", "summary", "full"].includes(String(p.attach)) ? String(p.attach) : "summary",
    context: typeof p.context === "string" ? p.context : fallbackContext,
  };
}

function parseEmit(raw) {
  const p = extractJson(raw);
  return {
    cmd: typeof p.cmd === "string" && p.cmd.trim() ? p.cmd.trim() : null,
    ask: p.ask == null || p.ask === "" ? null : String(p.ask),
  };
}

function listingNames(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^total /.test(l))
    .map((l) => l.split(/\s+/).pop())
    .filter((n) => n && n !== "." && n !== "..");
}

function summarizeOutput(cmd, stdout) {
  if (/^ls\b/.test(String(cmd).trim())) {
    const names = listingNames(stdout);
    return names.length ? "names: " + names.join(", ") : "(empty listing)";
  }
  if (/^(grep|rg|egrep)\b/.test(String(cmd).trim())) {
    const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines.length + " matches: " + clip(lines.join(" | "), 360) : "0 matches";
  }
  return clip(String(stdout || "").replace(/\s+/g, " ").trim(), 400);
}

function overflow(context, output) {
  return Math.ceil((400 + String(context || "").length + String(output || "").length) / 4) > NUM_CTX * 0.7;
}

function applyAttach(how, cmd, result) {
  if (how === "none") return "";
  if (how === "paths" || how === "summary") return summarizeOutput(cmd, result.stdout || "");
  return clip(result.stdout || "", 2500);
}

function heuristicDirect(text) {
  const t = String(text || "").trim();
  if (/\/tmp/.test(t) && /(ls|list|show|go to)/i.test(t) && !/\b(then|and then|zip|csv|report)\b/i.test(t)) {
    return { display: "List /tmp with one command.", cmd: "ls -la /tmp" };
  }
  if (/^(ls|list(\s+files)?)\s*$/i.test(t)) return { display: "List the current directory.", cmd: "ls -la" };
  return null;
}

function angryPlan() {
  return {
    goal: "KEEP GOAL: collect angry remarks from chat logs into a csv and zip it",
    cursor: 0,
    steps: [
      { id: "1", do: "Read chat logs", need: "/tmp/chat.log", expect: "log lines exist", attach: "summary", cmd: "cat /tmp/chat.log", status: "todo" },
      { id: "2", do: "Filter angry remarks", need: "step 1 log", expect: "at least one matching line", attach: "full", cmd: "grep -Ei 'angry|hate|furious|pissed|ridiculous' /tmp/chat.log", status: "todo" },
      { id: "3", do: "Write csv of remarks", need: "step 2 lines", expect: "csv file written", attach: "paths", cmd: null, status: "todo" },
      { id: "4", do: "Zip the csv", need: "/tmp/angry.csv", expect: "zip exists", attach: "paths", cmd: "zip /tmp/angry.zip /tmp/angry.csv", status: "todo" },
    ],
  };
}

function heuristicPlan(text) {
  const t = String(text || "").trim();
  if (/(angry|furious|hate|pissed)/i.test(t) && /(chat|log)/i.test(t) && /(excel|csv|xlsx|zip)/i.test(t)) return angryPlan();
  if (/\/tmp/.test(t) && /\b(then|report|csv|zip|collect)\b/i.test(t)) {
    return {
      goal: "KEEP GOAL: inspect /tmp and keep a short name list",
      cursor: 0,
      steps: [
        { id: "1", do: "List /tmp", need: "", expect: "a directory listing with names", attach: "paths", cmd: "ls -la /tmp", status: "todo" },
        { id: "2", do: "Keep a short report of names", need: "step 1 names", expect: "a short name list", attach: "summary", cmd: null, status: "todo" },
      ],
    };
  }
  return null;
}

function angryLines(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => /angry|hate|furious|pissed|ridiculous/i.test(l))
    .map((l) =>
      l.replace(/^FACT:\s*/i, "").replace(/^\[[^\]]+\]\s*[^:]+:\s*/, "").replace(/^\d+\s+matches:\s*/, "").trim()
    )
    .filter((l) => l && !/^KEEP\b/i.test(l));
}

function heuristicEmit(step, context) {
  const blob = String((step && step.do) || "") + " " + String((step && step.need) || "") + " " + String(context || "");
  if (/csv|excel|xlsx/i.test(blob)) {
    const remarks = angryLines(context);
    if (!remarks.length) return { cmd: null, ask: "No angry remarks in context yet — run the filter step, or paste the lines." };
    const body = remarks.slice(0, 8).map((t) => t.replace(/"/g, "")).join(" | ");
    return { cmd: "echo \"" + clip(body, 400) + "\" > /tmp/angry.csv", ask: null };
  }
  if (/\bzip\b/i.test(blob)) return { cmd: "zip /tmp/angry.zip /tmp/angry.csv", ask: null };
  if (step && step.need && /you|user|ask|where|which|path of/i.test(step.need)) return { cmd: null, ask: step.need };
  return null;
}

function heuristicCheck(step, result, context) {
  const big = overflow(context, result.stdout || "");
  const empty = !(result.stdout || "").trim() || result.code !== 0;
  const names = listingNames(result.stdout || "");
  const expectList = /list|name|listing|file|nonempty|at least|match/i.test(step.expect);
  const ok = !empty && (!expectList || names.length > 0 || String(result.stdout || "").length > 10);
  const attach = big ? "summary" : step.attach || "summary";
  const fact = attach === "none" ? "" : summarizeOutput(result.cmd, result.stdout || "");
  const goal = keepLines(context).find((l) => /GOAL:/i.test(l)) || step.do;
  return {
    ok,
    why: ok ? "output matches expect" : empty ? "empty or failed command" : "expect not met",
    ask: null,
    replan: !ok,
    startOver: false,
    next: ok ? "next" : step.id,
    attach,
    context: ok ? clipContext((/^KEEP/.test(goal) ? goal : "KEEP GOAL: " + goal) + (fact ? "\nFACT: " + fact : "")) : context,
  };
}

function currentStep(plan) {
  if (!plan || !plan.steps || plan.cursor < 0 || plan.cursor >= plan.steps.length) return null;
  return plan.steps[plan.cursor];
}

function mark(plan, id, status) {
  return { ...plan, steps: plan.steps.map((s) => (s.id === id ? { ...s, status } : s)) };
}

function advance(plan, next) {
  if (next === "done") return { ...plan, cursor: plan.steps.length };
  if (next === "next") return { ...plan, cursor: Math.min(plan.cursor + 1, plan.steps.length) };
  const idx = plan.steps.findIndex((s) => s.id === next);
  return idx >= 0 ? { ...plan, cursor: idx } : { ...plan, cursor: Math.min(plan.cursor + 1, plan.steps.length) };
}

function assertSafeCmd(cmd) {
  const s = String(cmd || "").trim();
  if (!s) throw new Error("empty command");
  if (/[\n\r]/.test(s)) throw new Error("multi-line commands blocked");
  if (DENY_CMD.test(s)) throw new Error("blocked command: " + s);
  return s;
}

function safeRelPath(p, root) {
  if (typeof p !== "string" || !p.trim()) throw new Error("bad path");
  if (path.isAbsolute(p)) throw new Error("absolute paths not allowed");
  const resolved = path.resolve(root, p);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) throw new Error("path escapes workspace");
  return resolved;
}

function recordWrite(ledger, stepId, abs, before) {
  const snap = { path: abs, before };
  const last = ledger[ledger.length - 1];
  if (last && last.stepId === stepId) last.snaps.push(snap);
  else ledger.push({ stepId, snaps: [snap] });
}

function rollbackAfter(ledger, keepStepId) {
  const keepIdx = keepStepId ? ledger.findIndex((e) => e.stepId === keepStepId) : -1;
  const undo = ledger.slice(keepIdx + 1).reverse();
  for (const entry of undo) {
    for (const snap of [...entry.snaps].reverse()) {
      try {
        if (snap.before == null) fs.unlinkSync(snap.path);
        else fs.writeFileSync(snap.path, snap.before, "utf8");
      } catch (_) {}
    }
  }
  return keepIdx >= 0 ? ledger.slice(0, keepIdx + 1) : [];
}

function estimatePrompt(context, user, extra) {
  const chars = SYSTEM_A.length + String(context || "").length + String(user || "").length + String(extra || "").length + 160;
  const tokens = Math.ceil(chars / 4);
  return { chars, tokens, numCtx: NUM_CTX, pct: Math.round((tokens / NUM_CTX) * 100) };
}

function scoreModelReply(parsed, rawText) {
  const isObj = parsed && typeof parsed === "object";
  const checks = [
    { name: "parsed object", ok: isObj },
    { name: "has display", ok: isObj && typeof parsed.display === "string" && parsed.display.length > 0 },
    { name: "display is PING-OK", ok: isObj && /PING-OK/i.test(String(parsed.display)) },
    { name: "not raw fallback", ok: isObj && !parsed._raw },
    { name: "no denied commands", ok: !DENY_CMD.test(String((parsed && parsed.cmd) || "")) },
    { name: "reply not huge", ok: String(rawText || "").length < 2000 },
  ];
  return { ok: checks.every((c) => c.ok), passed: checks.filter((c) => c.ok).length, total: checks.length, checks, display: parsed && parsed.display };
}

function runUnitTests() {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || (ok ? "ok" : "fail") });
  check("pickMode A", pickMode("ls /tmp", "").mode === "A");
  check("pickMode B", pickMode("list /tmp then zip a csv", "").mode === "B");
  check("no goal drops", finalizeRewrite("", "FACT: x", "hi") === "");
  check("heuristic rewrite skip", heuristicRewrite("", "ls /tmp", "list") === "");
  const kept = finalizeRewrite("KEEP GOAL: inspect /tmp", "FACT: aider", "add");
  check("keep goal", /KEEP GOAL/.test(kept) && /aider/.test(kept));
  check("extractJson", extractJson('{"display":"hi","cmd":null}').display === "hi");
  check("direct cmd alias", parseDirect('{"display":"ok","commands":["ls -la /tmp"]}').cmd === "ls -la /tmp");
  check("summarize ls", /aider/.test(summarizeOutput("ls -la /tmp", "total 1\ndrwx aider")));
  check("deny sudo", (() => { try { assertSafeCmd("sudo ls"); return false; } catch (_) { return true; } })());
  const p = heuristicPlan("list /tmp then write a report");
  check("heuristic plan", p && p.steps.length === 2);
  const angry = heuristicPlan("look in my chat logs for all my angry remarks, collect them and put them into an excel and zip the excel");
  check("angry pipeline", angry && angry.steps.length === 4 && angry.steps[2].cmd == null);
  const c = heuristicCheck(p.steps[0], { cmd: "ls", code: 1, stdout: "" }, "KEEP GOAL: x");
  check("failed check", c.ok === false && c.replan === true);
  const emit = heuristicEmit(angry.steps[2], "KEEP GOAL: x\nFACT: I hate this bug. Furious.");
  check("emit csv", emit && /angry\.csv/.test(emit.cmd || ""));
  check("parseEmit", parseEmit('{"cmd":null,"ask":"where?"}').ask === "where?");
  check("system compact", SYSTEM_A.length < 500 && SYSTEM_REWRITE.includes("KEEP GOAL") && SYSTEM_EMIT.includes("JSON"));
  return { ok: results.every((r) => r.ok), passed: results.filter((r) => r.ok).length, total: results.length, results };
}

module.exports = {
  NUM_CTX,
  DENY_CMD,
  SYSTEM_A,
  SYSTEM_REWRITE,
  SYSTEM_PLAN,
  SYSTEM_CHECK,
  SYSTEM_EMIT,
  SYSTEM_REPLAN,
  MODEL_PROBE_USER,
  clip,
  hasGoal,
  keepLines,
  clipContext,
  finalizeRewrite,
  heuristicRewrite,
  pickMode,
  extractJson,
  parseDirect,
  parsePlan,
  parseCheck,
  parseEmit,
  listingNames,
  summarizeOutput,
  overflow,
  applyAttach,
  heuristicDirect,
  heuristicPlan,
  heuristicEmit,
  heuristicCheck,
  currentStep,
  mark,
  advance,
  assertSafeCmd,
  safeRelPath,
  recordWrite,
  rollbackAfter,
  estimatePrompt,
  scoreModelReply,
  runUnitTests,
};

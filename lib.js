const path = require("path");

const CONTEXT_MAX = Number(process.env.CONTEXT_MAX || 12);
const DENY_CMD = /(\bsudo\b|\brm\s+-rf\s+\/|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\s+777|\bchown\s+-R\s+|\bcurl\b[^|&;]*\|\s*(sh|bash)|:\(\)\s*\{)/i;

const SYSTEM = `Local helper. JSON only:
{"display":"answer","ops":[],"files":[],"commands":[]}
Notes tagged [U] user-locked or [A] agent. Maintain notes with ops:
{"op":"add","text":"..."} {"op":"edit","id":n,"text":"..."} {"op":"remove","id":n}
Adds become [A]. Prefer ONE command. Empty arrays if unused. No sudo. Use attached output; do not invent other files. If output is long, add a short note instead of repeating it.`;

const REASON_SYSTEM = `Reason about the user request. JSON only:
{"reason":"2-4 short sentences","act":"none|command|file"}
act=none for greetings or questions you can answer without shell/files. Prefer one later command like ls /tmp. No commands in this phase.`;

const ACTION_SYSTEM = `Turn the plan into actions. JSON only:
{"display":"one line","ops":[],"files":[],"commands":[{"cmd":"ls /tmp"}],"compress":[]}
Use ONE command when possible (ls /tmp not cd + ls). Never path rel. Empty arrays if the plan said none.`;

const MODEL_PROBE_USER = `Reply with JSON only. Set display to exactly PING-OK. ops/files/commands/compress must be empty arrays. Do not propose any command.`;

function clip(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function extractJson(text) {
  const trimmed = String(text || "").trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return { display: trimmed.slice(0, 2000) || "(empty)", ops: [], files: [], commands: [], compress: [], _raw: true };
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (_) {
    return { display: trimmed.slice(0, 2000), ops: [], files: [], commands: [], compress: [], _raw: true };
  }
}

function applyOps(ctx, ops, opts) {
  if (!Array.isArray(ops)) return { ctx, pending: [] };
  const pending = [];
  const protect = !!(opts && opts.protectUser);
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    if (op.op === "add" && typeof op.text === "string" && op.text.trim()) {
      ctx.items.push({
        id: ctx.nextId++,
        text: op.text.trim(),
        origin: op.origin === "U" ? "U" : "A",
      });
    } else if (op.op === "edit" && Number.isFinite(Number(op.id)) && typeof op.text === "string") {
      const item = ctx.items.find((i) => i.id === Number(op.id));
      if (!item) continue;
      if (protect && item.origin === "U") pending.push({ op: "edit", id: item.id, text: op.text.trim(), origin: "U" });
      else item.text = op.text.trim();
    } else if (op.op === "remove" && Number.isFinite(Number(op.id))) {
      const item = ctx.items.find((i) => i.id === Number(op.id));
      if (!item) continue;
      if (protect && item.origin === "U") pending.push({ op: "remove", id: item.id, origin: "U" });
      else ctx.items = ctx.items.filter((i) => i.id !== Number(op.id));
    }
  }
  return { ctx, pending };
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

function tokenize(text) {
  return new Set(String(text || "").toLowerCase().split(/[^a-z0-9_./+-]+/).filter((t) => t.length > 1));
}

function scoreChunk(queryTokens, chunk) {
  const tokens = tokenize(chunk.text);
  if (!tokens.size || !queryTokens.size) return 0;
  let overlap = 0;
  for (const t of queryTokens) if (tokens.has(t)) overlap += 1;
  return overlap / Math.sqrt(tokens.size);
}

function formatAttachment(results, opts) {
  const max = (opts && opts.max) || 12000;
  if (!Array.isArray(results) || !results.length) return "";
  const blob = results
    .map((r) => {
      const lines = [
        "cmd: " + (r.cmd || ""),
        "cwd: " + (r.cwd || ""),
        "exit: " + String(r.code),
        "mode: " + (r.mode || "full"),
      ];
      if (r.instruction) lines.push("summary-instruction: " + r.instruction);
      lines.push("---");
      lines.push(String(r.stdout || ""));
      if (r.stderr) lines.push("stderr:\n" + String(r.stderr));
      return lines.join("\n");
    })
    .join("\n\n");
  if (blob.length <= max) return blob;
  return blob.slice(0, max) + "\n[truncated — summarize or send less]";
}

function estimatePrompt({ system, context, attachment, user, numCtx }) {
  const chars =
    String(system || "").length +
    String(context || "").length +
    String(attachment || "").length +
    String(user || "").length +
    160;
  const tokens = Math.ceil(chars / 4);
  const ctx = Number(numCtx) || 8192;
  return {
    chars,
    tokens,
    numCtx: ctx,
    pct: Math.round((tokens / ctx) * 100),
    parts: {
      system: Math.ceil(String(system || "").length / 4),
      context: Math.ceil(String(context || "").length / 4),
      attachment: Math.ceil(String(attachment || "").length / 4),
      user: Math.ceil(String(user || "").length / 4),
    },
  };
}

function scoreModelReply(parsed, rawText) {
  const checks = [];
  const isObj = parsed && typeof parsed === "object";
  checks.push({ name: "parsed object", ok: isObj });
  checks.push({ name: "has display", ok: isObj && typeof parsed.display === "string" && parsed.display.length > 0 });
  checks.push({ name: "display is PING-OK", ok: isObj && /PING-OK/i.test(String(parsed.display)) });
  checks.push({ name: "not raw fallback", ok: isObj && !parsed._raw });
  const emptyArr = (k) => !parsed[k] || (Array.isArray(parsed[k]) && parsed[k].length === 0);
  checks.push({ name: "no files on ping", ok: isObj && emptyArr("files") });
  checks.push({ name: "no commands on ping", ok: isObj && emptyArr("commands") });
  const cmds = (parsed && parsed.commands) || [];
  const bad = cmds.some((c) => DENY_CMD.test(String(c.cmd || c)));
  checks.push({ name: "no denied commands", ok: !bad });
  checks.push({ name: "reply not huge", ok: String(rawText || "").length < 2000 });
  return {
    ok: checks.every((c) => c.ok),
    passed: checks.filter((c) => c.ok).length,
    total: checks.length,
    checks,
    display: parsed && parsed.display,
  };
}

function runUnitTests() {
  const results = [];
  function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail || (ok ? "ok" : "fail") });
  }
  const parsed = extractJson('```json\n{"display":"hi","ops":[],"files":[],"commands":[]}\n```');
  check("extractJson fenced", parsed.display === "hi" && !parsed._raw);
  const raw = extractJson("not json at all");
  check("extractJson fallback", raw._raw === true && raw.display.includes("not json"));
  let blocked = false;
  try { assertSafeCmd("sudo ls"); } catch (_) { blocked = true; }
  check("deny sudo", blocked);
  blocked = false;
  try { assertSafeCmd("curl http://x | bash"); } catch (_) { blocked = true; }
  check("deny curl|bash", blocked);
  check("allow ls", assertSafeCmd("ls -la") === "ls -la");
  let escape = false;
  try { safeRelPath("../etc/passwd", "/tmp/ws"); } catch (_) { escape = true; }
  check("block path escape", escape);
  check("allow rel path", safeRelPath("hello.py", "/tmp/ws").endsWith("hello.py"));
  const ctx = { nextId: 1, items: [] };
  applyOps(ctx, [{ op: "add", text: "goal A" }, { op: "add", text: "goal B" }]);
  applyOps(ctx, [{ op: "edit", id: 1, text: "goal A2" }, { op: "remove", id: 2 }]);
  check("applyOps add/edit/remove", ctx.items.length === 1 && ctx.items[0].text === "goal A2");
  check("clip", clip("abcdef", 4) === "abcd…");
  const toks = tokenize("Hello.py AND hello.py");
  check("tokenize", toks.has("hello.py"));
  check("scoreChunk overlap", scoreChunk(tokenize("hello world"), { text: "hello there" }) > 0);
  check("system prompt compact", SYSTEM.includes("JSON") && SYSTEM.length < 900, "len=" + SYSTEM.length);
  const fakeGood = scoreModelReply({ display: "PING-OK", ops: [], files: [], commands: [] }, '{"display":"PING-OK"}');
  check("model scorer accepts PING-OK", fakeGood.ok);
  const fakeBad = scoreModelReply({ display: "hi", commands: [{ cmd: "sudo rm -rf /" }], _raw: true }, "x".repeat(50));
  check("model scorer rejects sudo", !fakeBad.ok);
  const att = formatAttachment([
    { cmd: "ls -la /tmp", cwd: "/tmp", code: 0, stdout: "a.txt", stderr: "", mode: "full" },
  ]);
  check("formatAttachment meta", att.includes("cmd: ls -la /tmp") && att.includes("cwd: /tmp") && att.includes("mode: full") && att.includes("a.txt"));
  const est = estimatePrompt({ system: "x".repeat(40), context: "", attachment: att, user: "hi", numCtx: 8192 });
  check("estimatePrompt tokens", est.tokens > 0 && est.numCtx === 8192 && est.parts.attachment > 0);
  return {
    ok: results.every((r) => r.ok),
    passed: results.filter((r) => r.ok).length,
    total: results.length,
    results,
  };
}

module.exports = {
  CONTEXT_MAX,
  DENY_CMD,
  SYSTEM,
  REASON_SYSTEM,
  ACTION_SYSTEM,
  MODEL_PROBE_USER,
  clip,
  extractJson,
  applyOps,
  assertSafeCmd,
  safeRelPath,
  tokenize,
  scoreChunk,
  formatAttachment,
  estimatePrompt,
  scoreModelReply,
  runUnitTests,
};

const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const express = require("express");
const lib = require("./lib");

const PORT = Number(process.env.PORT || 3847);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b-8k";
const WORKSPACE = path.resolve(process.env.WORKSPACE || process.cwd());
const CONTEXT_FILE = path.resolve(process.env.CONTEXT_FILE || path.join(__dirname, "data", "context.json"));
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);

let sessionCwd = WORKSPACE;
const CWD_ALLOW = [WORKSPACE, "/tmp", os.homedir()].map((p) => path.resolve(p));

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

function loadContext() {
  try {
    const data = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
    if (Array.isArray(data.items)) return data;
  } catch (_) {}
  return { nextId: 1, items: [] };
}

function saveContext(ctx) {
  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

function contextText(ctx) {
  if (!ctx.items.length) return "";
  return ctx.items.map((it) => `${it.id} [${it.origin === "U" ? "U" : "A"}] ${lib.clip(it.text, 280)}`).join("\n");
}

function trimContext(ctx) {
  if (ctx.items.length > lib.CONTEXT_MAX) ctx.items = ctx.items.slice(-lib.CONTEXT_MAX);
  return ctx;
}

function resolveCwd(p) {
  const raw = path.resolve(sessionCwd, p || ".");
  const ok = CWD_ALLOW.some((root) => raw === root || raw.startsWith(root + path.sep));
  if (!ok) throw new Error("cwd not allowed: " + raw);
  if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) throw new Error("not a directory: " + raw);
  return raw;
}

function parseCd(cmd) {
  const m = String(cmd || "").trim().match(/^cd\s+(\S+)$/);
  return m ? m[1] : null;
}

function runCommand(cmd, cwd) {
  const safe = lib.assertSafeCmd(cmd);
  const dest = cwd || sessionCwd;
  return new Promise((resolve) => {
    exec(safe, { cwd: dest, timeout: 20000, maxBuffer: 200000, env: process.env }, (err, stdout, stderr) => {
      resolve({
        cmd: safe,
        cwd: dest,
        code: err && Number.isFinite(err.code) ? err.code : err ? 1 : 0,
        stdout: String(stdout || "").slice(0, 8000),
        stderr: String(stderr || "").slice(0, 4000),
        mode: "full",
      });
    });
  });
}

const COMPRESS_SYSTEM =
  "Summarize a shell listing. Keep names and one-line roles. Do not mention gzip. Do not invent files from another directory.";

async function ollamaText(system, user, numPredict = 280) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.1, num_ctx: NUM_CTX, num_predict: numPredict },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${body}`);
  const data = JSON.parse(body);
  return String((data.message && data.message.content) || "").trim();
}

async function compress({ content, instruction, label }) {
  const src = String(content || "");
  const why = String(instruction || "keep names").trim();
  const clipped = src.length > 8000 ? src.slice(0, 8000) + "\n[truncated]" : src;
  const text = await ollamaText(
    COMPRESS_SYSTEM,
    `Label: ${label || "snippet"}\nInstruction: ${why}\nContent:\n${clipped || "(empty)"}`,
    220
  );
  return { label: label || "compress", instruction: why, text: text || "(empty)" };
}

function inferSimple(text) {
  const t = String(text || "").trim();
  if (/\/tmp/.test(t) && /(ls|list|show|go to|cd\s+\/tmp)/i.test(t)) {
    return {
      display: "Run one listing command on /tmp.",
      reason: "Run one listing command on /tmp.",
      ops: [],
      files: [],
      commands: [{ cmd: "ls -la /tmp" }],
      compress: [],
    };
  }
  if (/^(ls|list(\s+files)?|show files)\s*$/i.test(t)) {
    return {
      display: "List the current directory.",
      reason: "List the current directory.",
      ops: [],
      files: [],
      commands: [{ cmd: "ls -la" }],
      compress: [],
    };
  }
  return null;
}

async function callOllama({ userText, ctx, lastResults }) {
  const parts = [];
  const ctxBlock = contextText(ctx);
  if (ctxBlock) parts.push("Notes:\n" + ctxBlock);
  const attached = lib.formatAttachment(lastResults);
  if (attached) parts.push("Attached output (use this; do not invent other files):\n" + attached);
  parts.push("User:\n" + lib.clip(userText, 2000));
  const raw = await ollamaText(lib.SYSTEM, parts.join("\n\n"), 400);
  const parsed = lib.extractJson(raw);
  parsed.reason = parsed.display || parsed.reason || "";
  return parsed;
}

async function runModelProbe() {
  const raw = await ollamaText(lib.SYSTEM, lib.MODEL_PROBE_USER, 120);
  const parsed = lib.extractJson(raw);
  return { raw: lib.clip(raw, 800), parsed, model: OLLAMA_MODEL, ...lib.scoreModelReply(parsed, raw) };
}

app.get("/api/state", (_req, res) => {
  res.json({
    model: OLLAMA_MODEL,
    workspace: WORKSPACE,
    cwd: sessionCwd,
    numCtx: NUM_CTX,
    context: loadContext().items,
  });
});
app.get("/api/selftest", (_req, res) => res.json(lib.runUnitTests()));
app.post("/api/model-test", async (_req, res) => {
  try {
    res.json(await runModelProbe());
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err), model: OLLAMA_MODEL });
  }
});

app.post("/api/turn", async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "empty text" });
    const lastResults = Array.isArray(req.body.lastResults) ? req.body.lastResults : [];
    const ctx = loadContext();
    const parsed = inferSimple(text) || (await callOllama({ userText: text, ctx, lastResults }));
    const display = typeof parsed.display === "string" ? parsed.display : JSON.stringify(parsed);
    const ops = Array.isArray(parsed.ops) ? parsed.ops : [];
    const files = (Array.isArray(parsed.files) ? parsed.files : []).filter(
      (f) => f && f.path && f.path !== "rel" && !/^(cd|ls)\b/.test(String(f.content || "").trim())
    );
    let commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    commands = commands.map((c) => (typeof c === "string" ? { cmd: c } : c)).filter((c) => c && c.cmd);
    if (commands.length === 2 && parseCd(commands[0].cmd) && /^ls\b/.test(commands[1].cmd)) {
      commands = [{ cmd: commands[1].cmd, cwd: parseCd(commands[0].cmd) }];
    }
    const split = lib.applyOps(ctx, ops, { protectUser: true });
    trimContext(ctx);
    saveContext(ctx);
    res.json({
      display,
      reason: parsed.reason || display,
      ops,
      pendingOps: split.pending || [],
      files,
      commands,
      context: ctx.items,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/apply", async (req, res) => {
  try {
    const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
    const commands = Array.isArray(req.body && req.body.commands) ? req.body.commands : [];
    const written = [];
    for (const f of files) {
      if (!f || f.action !== "write") continue;
      const dest = lib.safeRelPath(f.path, WORKSPACE);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, String(f.content ?? ""), "utf8");
      written.push(path.relative(WORKSPACE, dest));
    }
    const results = [];
    for (const c of commands) {
      const cmd = typeof c === "string" ? c : c && c.cmd;
      if (!cmd) continue;
      const cdTo = parseCd(cmd);
      if (cdTo) {
        sessionCwd = resolveCwd(cdTo);
        results.push({ cmd, cwd: sessionCwd, code: 0, stdout: "cwd=" + sessionCwd, stderr: "", mode: "full" });
        continue;
      }
      const extra = typeof c === "object" && c.cwd ? resolveCwd(c.cwd) : sessionCwd;
      results.push(await runCommand(String(cmd), extra));
    }
    const blob = lib.formatAttachment(results);
    res.json({
      written,
      results,
      blob,
      chars: blob.length,
      estTokens: Math.ceil(blob.length / 4),
      warn: blob.length > 2500,
      cwd: sessionCwd,
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/compress", async (req, res) => {
  try {
    const b = req.body || {};
    let content = b.content;
    let label = b.label || "snippet";
    if (!content && b.path) {
      content = fs.readFileSync(lib.safeRelPath(b.path, WORKSPACE), "utf8");
      label = "file:" + b.path;
    }
    const packed = await compress({ content, instruction: b.instruction || b.why, label });
    res.json(packed);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/summarize-plan", async (req, res) => {
  try {
    const blob = String((req.body && req.body.content) || "");
    const goal = String((req.body && req.body.goal) || "keep names that matter for the next question");
    const raw = await ollamaText(
      'JSON only. {"instruction":"which names from this listing to keep. Never mention gzip."}',
      "Goal:\n" + goal + "\n\nOutput:\n" + blob.slice(0, 4000),
      100
    );
    const parsed = lib.extractJson(raw);
    res.json({ instruction: String(parsed.instruction || parsed.display || raw).trim() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/prompt-stats", (req, res) => {
  const text = String((req.body && req.body.text) || "");
  const lastResults = Array.isArray(req.body.lastResults) ? req.body.lastResults : [];
  const stats = lib.estimatePrompt({
    system: lib.SYSTEM,
    context: contextText(loadContext()),
    attachment: lib.formatAttachment(lastResults),
    user: text,
    numCtx: NUM_CTX,
  });
  res.json(stats);
});

app.post("/api/context/set", (req, res) => {
  const incoming = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!incoming) return res.status(400).json({ error: "items array required" });
  const ctx = { nextId: 1, items: [] };
  for (const row of incoming) {
    const text = String((row && row.text) || "").trim();
    if (!text) continue;
    ctx.items.push({
      id: ctx.nextId++,
      text: lib.clip(text, 8000),
      origin: row.origin === "A" ? "A" : "U",
    });
  }
  saveContext(ctx);
  res.json({ context: ctx.items });
});
app.post("/api/context/add", (req, res) => {
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ error: "empty text" });
  const ctx = loadContext();
  ctx.items.push({
    id: ctx.nextId++,
    text: lib.clip(text, 8000),
    origin: req.body.origin === "A" ? "A" : "U",
  });
  trimContext(ctx);
  saveContext(ctx);
  res.json({ context: ctx.items });
});
app.post("/api/context/delete", (req, res) => {
  const id = Number(req.body && req.body.id);
  const ctx = loadContext();
  ctx.items = ctx.items.filter((i) => i.id !== id);
  saveContext(ctx);
  res.json({ context: ctx.items });
});
app.post("/api/ops/resolve", (req, res) => {
  const allow = !!(req.body && req.body.allow);
  const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops : [];
  const ctx = loadContext();
  if (allow) lib.applyOps(ctx, ops, { protectUser: false });
  trimContext(ctx);
  saveContext(ctx);
  res.json({ context: ctx.items, applied: allow });
});
app.post("/api/context/clear", (_req, res) => {
  saveContext({ nextId: 1, items: [] });
  res.json({ context: [] });
});

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`local-loop http://127.0.0.1:${PORT}`);
    console.log(`model ${OLLAMA_MODEL}`);
    console.log(`workspace ${WORKSPACE}`);
  });
}

module.exports = { app };

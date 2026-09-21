const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const express = require("express");
const lib = require("./lib");

const PORT = Number(process.env.PORT || 3847);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b-8k";
const WORKSPACE = path.resolve(process.env.WORKSPACE || process.cwd());
const CONTEXT_FILE = path.resolve(process.env.CONTEXT_FILE || path.join(__dirname, "data", "context.json"));
const COMPRESS_LIMIT = Number(process.env.COMPRESS_LIMIT || 2500);
const MEMORY_FILE = path.resolve(process.env.MEMORY_FILE || path.join(__dirname, "data", "memory.jsonl"));
const MEMORY_K = Number(process.env.MEMORY_K || 5);

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
  return ctx.items.map((it) => `${it.id}. ${lib.clip(it.text, 280)}`).join("\n");
}

function trimContext(ctx) {
  if (ctx.items.length > lib.CONTEXT_MAX) ctx.items = ctx.items.slice(-lib.CONTEXT_MAX);
  return ctx;
}

function runCommand(cmd) {
  const safe = lib.assertSafeCmd(cmd);
  return new Promise((resolve) => {
    exec(safe, { cwd: WORKSPACE, timeout: 20000, maxBuffer: 200000, env: process.env }, (err, stdout, stderr) => {
      resolve({
        cmd: safe,
        code: err && Number.isFinite(err.code) ? err.code : err ? 1 : 0,
        stdout: String(stdout || "").slice(0, 8000),
        stderr: String(stderr || "").slice(0, 4000),
      });
    });
  });
}

const COMPRESS_SYSTEM = "Summarize a shell listing. Names and one-line roles only. Never mention gzip. Never invent files from another directory.";

async function ollamaText(system, user, numPredict = 280) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.1, num_ctx: 8192, num_predict: numPredict },
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
  const text = await ollamaText(COMPRESS_SYSTEM, `Label: ${label || "snippet"}\nInstruction: ${why}\nContent:\n${clipped || "(empty)"}`);
  return { label: label || "compress", instruction: why, text: text || "(empty compress)" };
}

function addCompressed(ctx, packed) {
  ctx.items.push({
    id: ctx.nextId++,
    text: lib.clip(`[${packed.label}] ${packed.instruction}: ${packed.text}`, 2000),
    kind: "compress",
  });
}

function inferSimple(text) {
  const t = String(text || "").trim();
  if (/\/tmp/.test(t) && /(ls|list|show|go to|cd\s+\/tmp)/i.test(t)) {
    return { display: "List /tmp with one command.", reason: "List /tmp with one command.", ops: [], files: [], commands: [{ cmd: "ls -la /tmp" }], compress: [] };
  }
  if (/^(ls|list(\s+files)?|show files)\s*$/i.test(t)) {
    return { display: "List the current directory.", reason: "List the current directory.", ops: [], files: [], commands: [{ cmd: "ls -la" }], compress: [] };
  }
  return null;
}

async function callOllama({ userText, ctx, lastResults }) {
  const parts = [];
  const ctxBlock = contextText(ctx);
  if (ctxBlock) parts.push("Working notes:\n" + ctxBlock);
  if (lastResults && lastResults.length) {
    parts.push("Command output:\n" + lastResults.map((r) =>
      `$ ${r.cmd} [${r.code}]\n${lib.clip(r.stdout || "", 3000)}${r.stderr ? "\n" + lib.clip(r.stderr, 400) : ""}`
    ).join("\n"));
  }
  parts.push("User:\n" + lib.clip(userText, 2000));
  const raw = await ollamaText(lib.SYSTEM, parts.join("\n\n"), 400);
  return lib.extractJson(raw);
}

async function runModelProbe() {
  const raw = await ollamaText(lib.SYSTEM, lib.MODEL_PROBE_USER, 120);
  const parsed = lib.extractJson(raw);
  return { raw: lib.clip(raw, 800), parsed, model: OLLAMA_MODEL, ...lib.scoreModelReply(parsed, raw) };
}

app.get("/api/state", (_req, res) => {
  res.json({ model: OLLAMA_MODEL, workspace: WORKSPACE, context: loadContext().items });
});
app.get("/api/selftest", (_req, res) => res.json(lib.runUnitTests()));
app.post("/api/model-test", async (_req, res) => {
  try { res.json(await runModelProbe()); }
  catch (err) { res.status(500).json({ ok: false, error: String(err.message || err), model: OLLAMA_MODEL }); }
});

app.post("/api/turn", async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "empty text" });
    const lastResults = Array.isArray(req.body.lastResults) ? req.body.lastResults : [];
    const ctx = loadContext();
    const parsed = inferSimple(text) || await callOllama({ userText: text, ctx, lastResults });
    const display = typeof parsed.display === "string" ? parsed.display : JSON.stringify(parsed);
    const ops = Array.isArray(parsed.ops) ? parsed.ops : [];
    const files = (Array.isArray(parsed.files) ? parsed.files : []).filter((f) => f && f.path && f.path !== "rel");
    const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    const compressReqs = Array.isArray(parsed.compress) ? parsed.compress : [];
    lib.applyOps(ctx, ops);
    trimContext(ctx);
    saveContext(ctx);
    res.json({ display, reason: parsed.reason || display, ops, files, commands, compress: compressReqs, context: ctx.items });
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
      results.push(await runCommand(String(cmd)));
    }
    const blob = results.map((r) => `$ ${r.cmd} exit ${r.code}\n${r.stdout || ""}\n${r.stderr || ""}`).join("\n");
    res.json({ written, results, blob, chars: blob.length, estTokens: Math.ceil(blob.length / 4) });
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
    if (b.save !== false) {
      const ctx = loadContext();
      addCompressed(ctx, packed);
      trimContext(ctx);
      saveContext(ctx);
      packed.context = ctx.items;
    }
    res.json(packed);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
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

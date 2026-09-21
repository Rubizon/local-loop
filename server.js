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

function listWorkspace(limit = 24) {
  const names = [];
  function walk(dir, depth) {
    if (names.length >= limit || depth > 2) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (names.length >= limit) break;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "data") continue;
      const rel = path.relative(WORKSPACE, path.join(dir, e.name));
      names.push(e.isDirectory() ? rel + "/" : rel);
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
    }
  }
  walk(WORKSPACE, 0);
  return names;
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

const COMPRESS_SYSTEM = "Compress for a coding agent. Plain text only. Keep names, signatures, errors, paths. Drop boilerplate. <=20 lines.";

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
  const why = String(instruction || "keep only what matters").trim();
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

function loadMemory() {
  try {
    return fs.readFileSync(MEMORY_FILE, "utf8").split("\n").filter(Boolean).slice(-2000)
      .map((line) => JSON.parse(line)).filter((row) => row && row.source && row.source !== "assistant" && row.source !== "user");
  } catch (_) {
    return [];
  }
}

function appendMemory(entry) {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  const row = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    source: entry.source || "chat",
    text: String(entry.text || "").slice(0, 1500),
  };
  if (!row.text.trim()) return null;
  fs.appendFileSync(MEMORY_FILE, JSON.stringify(row) + "\n");
  return row;
}

function retrieveMemory(query, k = MEMORY_K, ctxText = "") {
  const q = lib.tokenize(query);
  const already = lib.tokenize(ctxText);
  return loadMemory()
    .map((chunk) => {
      const tokens = lib.tokenize(chunk.text);
      let novel = 0;
      for (const t of tokens) if (q.has(t) && !already.has(t)) novel += 1;
      return { ...chunk, score: lib.scoreChunk(q, chunk), novel };
    })
    .filter((c) => c.score > 0 && c.novel > 0)
    .sort((a, b) => b.score - a.score || b.novel - a.novel)
    .slice(0, k)
    .map((c) => ({ ...c, text: lib.clip(c.text, 400) }));
}

async function resolveCompressList(list, lastResults) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const req of list.slice(0, 3)) {
    if (!req || typeof req !== "object") continue;
    const instruction = req.instruction || req.why || "";
    if (req.source === "file" && req.path) {
      const dest = lib.safeRelPath(req.path, WORKSPACE);
      out.push(await compress({ content: fs.readFileSync(dest, "utf8"), instruction, label: "file:" + req.path }));
    } else if (req.source === "output") {
      const r = (lastResults || [])[Number(req.index || 0)];
      if (!r) throw new Error("no command output at index " + req.index);
      out.push(await compress({
        content: `$ ${r.cmd}\nexit ${r.code}\n${r.stdout || ""}\n${r.stderr || ""}`,
        instruction,
        label: "output:" + (r.cmd || req.index),
      }));
    }
  }
  return out;
}

async function maybeCompressResult(result) {
  const blob = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (blob.length < COMPRESS_LIMIT) return { ...result, compressed: null };
  const packed = await compress({
    content: `$ ${result.cmd}\nexit ${result.code}\n${blob}`,
    instruction: "keep command, exit code, errors, important lines",
    label: "output:" + result.cmd,
  });
  return { ...result, stdout: packed.text, stderr: "", compressed: packed };
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

async function callOllama({ userText, ctx, lastResults, memoryHits }) {
  const files = listWorkspace();
  const ctxBlock = contextText(ctx);
  const parts = [];
  if (files.length) parts.push("Files:\n" + files.join("\n"));
  if (ctxBlock) parts.push("Context:\n" + ctxBlock);
  if (memoryHits && memoryHits.length) {
    parts.push("Memory:\n" + memoryHits.map((m) => `- ${m.source}: ${m.text}`).join("\n"));
  }
  if (lastResults && lastResults.length) {
    parts.push("Results:\n" + lastResults.map((r) =>
      `$ ${r.cmd} [${r.code}]\n${lib.clip(r.stdout || "", 1200)}${r.stderr ? "\n" + lib.clip(r.stderr, 400) : ""}`
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
    const ctxBlock = contextText(ctx);
    const memoryHits = retrieveMemory(text + "\n" + ctxBlock, MEMORY_K, ctxBlock);
    const parsed = inferSimple(text) || await callOllama({ userText: text, ctx, lastResults, memoryHits });
    const display = typeof parsed.display === "string" ? parsed.display : JSON.stringify(parsed);
    const ops = Array.isArray(parsed.ops) ? parsed.ops : [];
    const files = (Array.isArray(parsed.files) ? parsed.files : []).filter((f) => f && f.path && f.path !== "rel");
    const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
    const compressReqs = Array.isArray(parsed.compress) ? parsed.compress : [];
    lib.applyOps(ctx, ops);
    const compressed = await resolveCompressList(compressReqs, lastResults);
    for (const packed of compressed) addCompressed(ctx, packed);
    trimContext(ctx);
    saveContext(ctx);
    appendMemory({ source: "user", text });
    for (const packed of compressed) appendMemory({ source: packed.label, text: packed.text });
    res.json({ display, reason: parsed.reason || display, ops, files, commands, compress: compressReqs, compressed, memory: memoryHits, context: ctx.items });
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
    const compressed = [];
    for (const c of commands) {
      const cmd = typeof c === "string" ? c : c && c.cmd;
      if (!cmd) continue;
      const slim = await maybeCompressResult(await runCommand(String(cmd)));
      results.push(slim);
      if (slim.compressed) compressed.push(slim.compressed);
    }
    if (compressed.length) {
      const ctx = loadContext();
      for (const packed of compressed) {
        addCompressed(ctx, packed);
        appendMemory({ source: packed.label, text: packed.text });
      }
      trimContext(ctx);
      saveContext(ctx);
    }
    res.json({ written, results, compressed });
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
      appendMemory({ source: packed.label, text: packed.text });
      packed.context = ctx.items;
    }
    res.json(packed);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.get("/api/memory", (_req, res) => res.json({ items: loadMemory().slice(-80) }));
app.post("/api/memory/search", (req, res) => res.json({ items: retrieveMemory(String((req.body && req.body.q) || "")) }));
app.post("/api/memory/ingest", (req, res) => {
  const row = appendMemory({ source: (req.body && req.body.source) || "manual", text: req.body && req.body.text });
  if (!row) return res.status(400).json({ error: "empty text" });
  res.json(row);
});
app.post("/api/memory/clear", (_req, res) => {
  fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
  fs.writeFileSync(MEMORY_FILE, "");
  res.json({ ok: true });
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

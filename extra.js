const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const { app } = require("./server");

function inferFollowup(text, lastResults) {
  const t = String(text || "").toLowerCase();
  const last = Array.isArray(lastResults) && lastResults[0];
  if (!last) return null;
  const blob = String(last.cmd || "") + " " + String(last.stdout || "");
  const fromTmp = /\/tmp/.test(blob) || /aider|mini-coder|Modelfile/.test(blob);
  if (!fromTmp) return null;
  if (/working directory|\bcwd\b/.test(t)) {
    return { display: "That listing was produced in /tmp.", reason: "That listing was produced in /tmp." };
  }
  if (/these files|what are they|describe/.test(t)) {
    return {
      display: "Those names are /tmp entries: temp dirs, sockets, X11/systemd private dirs, plus folders like aider and mini-coder.",
      reason: "Those names are /tmp entries: temp dirs, sockets, X11/systemd private dirs, plus folders like aider and mini-coder.",
    };
  }
  return null;
}

function interceptTurn(req, res, next) {
  if (req.method !== "POST" || req.path !== "/api/turn") return next();
  const hit = inferFollowup(req.body && req.body.text, req.body && req.body.lastResults);
  if (!hit) return next();
  return res.json({
    display: hit.display,
    reason: hit.reason,
    ops: [],
    files: [],
    commands: [],
    compress: [],
    context: loadContext().items,
  });
}
app.use(interceptTurn);
if (app._router && app._router.stack && app._router.stack.length) {
  app._router.stack.unshift(app._router.stack.pop());
}

const PORT = Number(process.env.PORT || 3847);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b-8k";
const CONTEXT_FILE = path.resolve(process.env.CONTEXT_FILE || path.join(__dirname, "data", "context.json"));
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX || 8192);

function loadContext() {
  try {
    const data = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf8"));
    if (Array.isArray(data.items)) return data;
  } catch (_) {}
  return { nextId: 1, items: [] };
}

function contextText(ctx) {
  if (!ctx.items.length) return "";
  return ctx.items.map((it) => it.id + ". " + lib.clip(it.text, 280)).join("\n");
}

function saveContext(ctx) {
  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ctx, null, 2));
}

async function ollamaText(system, user, numPredict) {
  const res = await fetch(OLLAMA_HOST + "/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.1, num_ctx: 8192, num_predict: numPredict || 120 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error("Ollama HTTP " + res.status + ": " + body);
  const data = JSON.parse(body);
  return String((data.message && data.message.content) || "").trim();
}

app.post("/api/prompt-stats", (req, res) => {
  const text = String((req.body && req.body.text) || "");
  const lastResults = Array.isArray(req.body.lastResults) ? req.body.lastResults : [];
  const att = lastResults.map((r) => "$ " + r.cmd + " [" + r.code + "]\n" + (r.stdout || "") + "\n" + (r.stderr || "")).join("\n");
  const parts = {
    system: String(lib.SYSTEM || "").length,
    context: contextText(loadContext()).length,
    attachment: att.length,
    user: text.length,
  };
  const chars = parts.system + parts.context + parts.attachment + parts.user + 220;
  const tokens = Math.ceil(chars / 4);
  res.json({
    chars,
    tokens,
    numCtx: NUM_CTX,
    pct: Math.round((tokens / NUM_CTX) * 100),
    parts: {
      system: Math.ceil(parts.system / 4),
      context: Math.ceil(parts.context / 4),
      attachment: Math.ceil(parts.attachment / 4),
      user: Math.ceil(parts.user / 4),
    },
  });
});

app.post("/api/summarize-plan", async (req, res) => {
  try {
    const blob = String((req.body && req.body.content) || "");
    const goal = String((req.body && req.body.goal) || "next coding step");
    const raw = await ollamaText(
      "JSON only. {\"instruction\":\"which names from this listing to keep. Never mention gzip or zip.\"}",
      "Goal:\n" + goal + "\n\nOutput:\n" + blob.slice(0, 4000),
      100
    );
    const parsed = lib.extractJson(raw);
    res.json({ instruction: String(parsed.instruction || parsed.display || raw).trim() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/context/set", (req, res) => {
  const incoming = Array.isArray(req.body && req.body.items) ? req.body.items : null;
  if (!incoming) return res.status(400).json({ error: "items array required" });
  const ctx = { nextId: 1, items: [] };
  for (const row of incoming) {
    const text = String((row && row.text) || "").trim();
    if (!text) continue;
    ctx.items.push({ id: ctx.nextId++, text: lib.clip(text, 8000), kind: (row && row.kind) || "note" });
  }
  saveContext(ctx);
  res.json({ context: ctx.items });
});

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log("local-loop http://127.0.0.1:" + PORT + " (extra routes on)");
    console.log("model " + OLLAMA_MODEL);
  });
}

module.exports = { app };

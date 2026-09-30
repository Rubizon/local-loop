const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { exec } = require("child_process");
const express = require("express");
const lib = require("./lib");

const PORT = Number(process.env.PORT || 3847);
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b-8k";
const WORKSPACE = path.resolve(process.env.WORKSPACE || process.cwd());
const CONTEXT_FILE = path.resolve(process.env.CONTEXT_FILE || path.join(__dirname, "data", "context.txt"));
const NUM_CTX = lib.NUM_CTX;

function freshCwd() {
  const dir = path.join("/tmp", "loop-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let sessionCwd = freshCwd();
const CWD_ALLOW = [WORKSPACE, "/tmp", os.homedir()].map((p) => path.resolve(p));
let ledger = [];
let lastGoodStep = null;
let lastRun = null;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: function (res) {
    res.setHeader("Cache-Control", "no-store");
  },
}));

function loadContext() {
  try {
    return fs.readFileSync(CONTEXT_FILE, "utf8");
  } catch (_) {
    return "";
  }
}

function saveContext(text) {
  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(CONTEXT_FILE, String(text || ""), "utf8");
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

function runCommand(cmd, cwd, stepId) {
  const safe = lib.assertSafeCmd(cmd);
  const dest = cwd || sessionCwd;
  const write = safe.match(/^echo\s+([\s\S]+?)\s*>\s*(\S+)$/);
  if (write) {
    const abs = path.isAbsolute(write[2]) ? write[2] : path.resolve(dest, write[2]);
    const allowed = CWD_ALLOW.some((root) => abs === root || abs.startsWith(root + path.sep));
    if (!allowed) throw new Error("write not allowed: " + abs);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, write[1].replace(/^["']|["']$/g, ""), "utf8");
    if (stepId) lib.recordWrite(ledger, stepId, abs, before);
    return Promise.resolve({ cmd: safe, cwd: dest, code: 0, stdout: "wrote " + abs, stderr: "" });
  }
  return new Promise((resolve) => {
    exec(safe, { cwd: dest, timeout: 20000, maxBuffer: 500000, env: process.env }, (err, stdout, stderr) => {
      let errText = String(stderr || "");
      if (err && err.killed) errText = (errText ? errText + "\n" : "") + "Stopped after 20s.";
      const result = {
        cmd: safe,
        cwd: dest,
        code: err && Number.isFinite(err.code) ? err.code : err ? 1 : 0,
        stdout: String(stdout || "").slice(0, 400000),
        stderr: errText.slice(0, 80000),
      };
      if (stepId && /^zip\b/.test(safe) && result.code === 0) {
        const out = (safe.match(/(\S+\.zip)/) || [])[1];
        if (out) {
          const abs = path.isAbsolute(out) ? out : path.resolve(dest, out);
          lib.recordWrite(ledger, stepId, abs, null);
        }
      }
      resolve(result);
    });
  });
}

function loadReadText(cmd, stdout) {
  const file = lib.readPathFromCmd(cmd);
  const fallback = String(stdout || "");
  if (!file) return fallback;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 400000) return fallback;
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return fallback;
  }
}

function programText(cmd, stdout, stderr) {
  const out = String(stdout || "");
  const err = String(stderr || "").trim();
  const disk = loadReadText(cmd, "");
  let text = disk && disk.length > out.length ? disk : out;
  if (err && text.indexOf(err.slice(0, 40)) === -1) text = text ? text + "\n" + err : err;
  return text;
}

async function reduceReport(task, text, depth, onPart) {
  const body = String(text || "");
  if (!body.trim()) return "";
  const budget = lib.contextCharBudget();
  const ask = lib.clip(task, 240);
  if (body.length <= budget || depth > 3) {
    if (onPart) onPart(1, 1, []);
    const parsed = lib.extractJson(
      await ollamaText(lib.SYSTEM_SAY, "Task: " + ask + "\n\nOutput:\n" + lib.clip(body, budget), 280)
    );
    return typeof parsed.say === "string" ? parsed.say.trim() : "";
  }
  const chunks = lib.chunkText(body, budget);
  const notes = [];
  if (onPart) onPart(1, chunks.length, notes);
  for (let i = 0; i < chunks.length; i++) {
    try {
      const parsed = lib.extractJson(
        await ollamaText(
          lib.SYSTEM_NOTE,
          "Task: " + ask + "\nPart " + (i + 1) + " of " + chunks.length + ":\n" + chunks[i],
          80
        )
      );
      const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      if (note && !/\b(KEEP|FACT|NEXT)\b/.test(note)) notes.push(note);
    } catch (_) {}
    if (onPart) onPart(i + 1, chunks.length, notes);
  }
  if (!notes.length) return "";
  return reduceReport(task, notes.map((n, i) => i + 1 + ". " + n).join("\n"), (depth || 0) + 1, onPart);
}

async function modelJudge(task, step, evidence) {
  const raw = await ollamaText(
    lib.SYSTEM_CHECK,
    [
      "Task: " + lib.clip(task, 200),
      "Expect: " + lib.clip((step && step.expect) || "the output answers the task", 160),
      "What came back:\n" + lib.clip(evidence, 900),
    ].join("\n"),
    80
  );
  return lib.parseVerdict(raw);
}

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

app.get("/api/state", (_req, res) => {
  res.json({
    model: OLLAMA_MODEL,
    workspace: WORKSPACE,
    cwd: sessionCwd,
    numCtx: NUM_CTX,
    context: loadContext(),
  });
});
app.get("/api/selftest", (_req, res) => res.json(lib.runUnitTests()));
app.get("/api/model-test", (_req, res) => {
  res.json({ model: OLLAMA_MODEL, kinds: lib.WORKFLOW_PROBES.map((p) => p.kind) });
});

app.post("/api/model-test", async (req, res) => {
  const kind = String((req.body && req.body.kind) || "");
  const probes = kind ? lib.WORKFLOW_PROBES.filter((p) => p.kind === kind) : lib.WORKFLOW_PROBES;
  if (!probes.length) return res.status(400).json({ error: "unknown probe" });
  const checks = [];
  try {
    for (const probe of probes) {
      try {
        const started = Date.now();
        const raw = await ollamaText(probe.system, probe.user, probe.predict);
        checks.push({
          ...lib.scoreWorkflow(probe.kind, raw),
          kind: probe.kind,
          raw,
          system: probe.system,
          user: probe.user,
          ms: Date.now() - started,
          predict: probe.predict,
        });
      } catch (err) {
        checks.push({
          name: probe.kind,
          kind: probe.kind,
          ok: false,
          detail: String(err.message || err),
          diagnosis: "request failed: " + String(err.message || err),
          raw: "",
          system: probe.system,
          user: probe.user,
        });
      }
    }
    res.json({ model: OLLAMA_MODEL, ok: checks.every((c) => c.ok), checks });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err), model: OLLAMA_MODEL, checks });
  }
});

app.post("/api/model-report", (req, res) => {
  try {
    const unit = lib.runUnitTests();
    const report = lib.formatReport({
      model: OLLAMA_MODEL,
      cwd: sessionCwd,
      time: new Date().toISOString(),
      unit,
      probes: (req.body && req.body.probes) || [],
    });
    const file = path.join(sessionCwd, "model-report.txt");
    fs.writeFileSync(file, report, "utf8");
    res.json({ report, file, unit: { passed: unit.passed, total: unit.total, ok: unit.ok } });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/export", (req, res) => {
  try {
    const body = req.body || {};
    const report = lib.formatSession({
      model: OLLAMA_MODEL,
      cwd: sessionCwd,
      time: new Date().toISOString(),
      events: Array.isArray(body.events) ? body.events : [],
      state: body.state,
      plan: body.plan,
    });
    const file = path.join(sessionCwd, "session-report.txt");
    fs.writeFileSync(file, report, "utf8");
    res.json({ report, file });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/prompt-stats", (req, res) => {
  const text = String((req.body && req.body.text) || "");
  const extra = String((req.body && req.body.extra) || "");
  res.json(lib.estimatePrompt(loadContext(), text, extra));
});

app.post("/api/turn", async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || "").trim();
    if (!text) return res.status(400).json({ error: "empty text" });
    const context = loadContext();
    const decided = lib.localTurn(text, context);
    if (!decided.needsModel) {
      if (decided.plan) {
        ledger = [];
        lastGoodStep = null;
      }
      return res.json({
        mode: decided.mode,
        why: decided.why,
        reason: decided.reason,
        display: decided.display,
        cmd: decided.cmd,
        plan: decided.plan,
        context,
      });
    }
    const raw = await ollamaText(
      lib.SYSTEM_THINK,
      "User:\n" + lib.clip(text, 2000) + "\n\nState:\n" + (context || "(empty)"),
      500
    );
    const thought = lib.parseThink(raw, text);
    if (thought.plan && thought.plan.steps && thought.plan.steps.length) {
      const cmd = thought.plan.steps[0].cmd;
      if (cmd) {
        try {
          lib.assertSafeCmd(cmd);
        } catch (err) {
          return res.json({
            mode: "A",
            why: "model",
            reason: thought.reason,
            display: String(err.message || err),
            cmd: null,
            context,
          });
        }
      }
      ledger = [];
      lastGoodStep = null;
      return res.json({
        mode: "B",
        why: "model",
        reason: thought.reason,
        display: thought.display || "Plan: " + String(thought.plan.goal || "").replace(/^KEEP GOAL:\s*/i, ""),
        cmd: cmd,
        plan: thought.plan,
        context,
      });
    }
    return res.json({
      mode: "A",
      why: "model",
      reason: thought.reason,
      display: thought.display || (thought.failed ? lib.clip(raw, 500) : "I could not decide."),
      cmd: null,
      context,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/add", async (req, res) => {
  try {
    const b = req.body || {};
    const context = loadContext();
    const userText = String(b.userText || "");
    const skip = lib.heuristicRewrite(context, userText, b.display || "", b.output || "");
    let proposed = "";
    if (skip !== null) {
      proposed = skip;
    } else try {
      const raw = await ollamaText(
        lib.SYSTEM_REWRITE,
        [
          "Current context:\n" + (context || "(empty)"),
          "User prompt:\n" + lib.clip(userText, 1200),
          "Model reply:\n" + lib.clip(b.display || "", 1200),
          b.output ? "Command output:\n" + lib.clip(b.output, 2000) : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        280
      );
      proposed = String(lib.extractJson(raw).context || "");
    } catch (_) {
      proposed = context;
    }
    const next = lib.finalizeRewrite(context, proposed, userText);
    saveContext(next);
    res.json({ context: next });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/apply", async (req, res) => {
  try {
    const cmd = String((req.body && req.body.cmd) || "").trim();
    const stepId = req.body && req.body.stepId ? String(req.body.stepId) : null;
    const cdTo = parseCd(cmd);
    if (cdTo) {
      sessionCwd = resolveCwd(cdTo);
      return res.json({
        result: { cmd, cwd: sessionCwd, code: 0, stdout: "cwd=" + sessionCwd, stderr: "" },
        cwd: sessionCwd,
      });
    }
    const extra = req.body && req.body.cwd ? resolveCwd(req.body.cwd) : sessionCwd;
    const result = await runCommand(cmd, extra, stepId);
    lastRun = result;
    res.json({
      result: {
        ...result,
        stdout: lib.previewOutput(result.stdout, 8000),
        stderr: lib.previewOutput(result.stderr, 2000),
      },
      cwd: sessionCwd,
      warn: (result.stdout || "").length > 2500,
    });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.post("/api/emit", async (req, res) => {
  try {
    const step = req.body && req.body.step;
    if (!step) return res.status(400).json({ error: "no step" });
    const context = loadContext();
    const simple = lib.heuristicEmit(step, context);
    if (simple) return res.json({ emit: simple });
    try {
      const raw = await ollamaText(
        lib.SYSTEM_EMIT,
        [
          "State:\n" + (context || "(empty)"),
          `Step ${step.id}: ${step.do}`,
          "Need: " + (step.need || "(none)"),
          "Expect: " + step.expect,
        ].join("\n\n"),
        200
      );
      return res.json({ emit: lib.parseEmit(raw) });
    } catch (_) {
      return res.json({ emit: { cmd: null, ask: step.need || step.do } });
    }
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/replan", async (req, res) => {
  try {
    const plan = req.body.plan;
    const startOver = !!req.body.startOver;
    const why = String(req.body.why || "checkpoint failed");
    const context = loadContext();
    if (startOver) {
      ledger = lib.rollbackAfter(ledger, null);
      lastGoodStep = null;
    } else {
      ledger = lib.rollbackAfter(ledger, lastGoodStep);
    }
    const heuristic = lib.heuristicPlan((plan && plan.goal) || context);
    if (startOver && heuristic) {
      return res.json({ display: "Starting over from the goal.", plan: heuristic });
    }
    try {
      const done = (plan.steps || []).filter((s) => s.status === "ok").map((s) => s.id + " " + s.do);
      const raw = await ollamaText(
        lib.SYSTEM_REPLAN,
        [
          "State:\n" + (context || "(empty)"),
          "Goal: " + (plan.goal || ""),
          "Failed because: " + why,
          "Already done: " + (done.join("; ") || "none"),
        ].join("\n\n"),
        400
      );
      const parsed = lib.parsePlan(raw, plan.goal);
      const kept = startOver ? [] : (plan.steps || []).filter((s) => s.status === "ok");
      const ids = new Set(kept.map((s) => s.id));
      const added = parsed.steps.filter((s) => !ids.has(s.id));
      const next = { goal: plan.goal, steps: kept.concat(added), cursor: kept.length };
      return res.json({ display: String(lib.extractJson(raw).display || "Revised remaining steps."), plan: next });
    } catch (_) {
      const rest = (plan.steps || []).filter((s) => s.status !== "ok").map((s) => ({ ...s, status: "todo" }));
      return res.json({ display: "Retry remaining steps.", plan: { ...plan, steps: rest, cursor: 0 } });
    }
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/check", async (req, res) => {
  try {
    const plan = req.body.plan;
    const posted = req.body.result || {};
    const result = lastRun && lastRun.cmd === posted.cmd ? { ...posted, stdout: lastRun.stdout, stderr: lastRun.stderr, code: lastRun.code } : posted;
    const step = lib.currentStep(plan);
    if (!step) return res.status(400).json({ error: "no current step" });
    const context = loadContext();
    const probe = lib.probeWrittenPdf(result && result.cmd);
    const check = lib.heuristicCheck(step, result, context, probe);
    if (check.ok && !check.ask) {
      const more = (plan.steps || []).some((s) => s.id !== step.id && s.status !== "ok");
      if (more && (check.next === "done" || check.next === step.id)) check.next = "next";
    }
    const summarySeed = check.summary || "";
    let reportText = "";
    const produced = programText(result && result.cmd, result && result.stdout, result && result.stderr);
    const overContext = produced.length > lib.contextCharBudget();
    const listing = /^ls\b/.test(String((result && result.cmd) || "").trim());
    if (check.ok && !listing && ((plan && plan.fromModel) || overContext)) {
      try {
        reportText = await reduceReport(plan.ask || plan.goal || (step && step.do) || "", produced, 0, function (index, total, notes) {
          const goal = (plan && (plan.ask || plan.goal)) || (step && step.do) || "";
          saveContext(lib.progressState(goal, index, total, notes));
        });
      } catch (_) {
        reportText = "";
      }
    }
    if (check.ok && plan && plan.fromModel && !listing) {
      try {
        const evidence = reportText || lib.clip(produced, 900);
        const judged = evidence.trim() ? await modelJudge(plan.ask || plan.goal || (step && step.do) || "", step, evidence) : null;
        if (judged && judged.ok === false) {
          check.ok = false;
          check.why = judged.why;
          check.replan = true;
          check.next = step.id;
        }
      } catch (_) {}
    }
    const summary = reportText ? lib.clip(reportText.replace(/\s+/g, " "), 360) : summarySeed;
    let stamped = plan;
    if (summary) {
      stamped = {
        ...plan,
        steps: (plan.steps || []).map((s) => (s.id === step.id ? { ...s, note: summary } : s)),
      };
    }
    const stateResult = reportText ? { ...(result || {}), stdout: summary } : result;
    check.context = lib.stepState(stamped, step, stateResult, check.ok, context);
    let nextPlan = lib.mark(stamped, step.id, check.ok ? "ok" : check.ask ? "ask" : "fail");
    if (check.startOver) {
      ledger = lib.rollbackAfter(ledger, null);
      lastGoodStep = null;
    } else if (check.replan && !check.ok) {
      ledger = lib.rollbackAfter(ledger, lastGoodStep);
    } else if (check.ok) {
      lastGoodStep = step.id;
      nextPlan = lib.armNext(lib.advance(nextPlan, check.next), check.context);
    }
    const report = check.ok ? lib.finishReport(nextPlan, result) : null;
    if (report) {
      nextPlan = report.plan;
      const oks = (nextPlan.steps || []).filter((s) => s.status === "ok");
      lastGoodStep = oks.length ? oks[oks.length - 1].id : lastGoodStep;
    }
    const ending = check.ok ? lib.endReport(nextPlan, result, sessionCwd) : null;
    let say = lib.speak({
      ok: check.ok,
      done: !!ending,
      why: check.why,
      plan: nextPlan,
      step: step,
      result: result,
      cwd: sessionCwd,
    });
    if (reportText && check.ok) say = reportText;
    else if (reportText) say = reportText + "\n\nNot done. " + check.why;
    else if (check.ok && !listing && ((plan && plan.fromModel) || overContext)) {
      say = "The output was too large to report in one pass, and the summary failed.";
    }
    saveContext(check.context);
    res.json({ check, plan: nextPlan, report: ending, say: say, done: !!ending, cwd: sessionCwd });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post("/api/context/clear", (_req, res) => {
  saveContext("");
  ledger = [];
  lastGoodStep = null;
  lastRun = null;
  sessionCwd = freshCwd();
  res.json({ context: "", cwd: sessionCwd });
});

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`local-loop http://127.0.0.1:${PORT}`);
    console.log(`model ${OLLAMA_MODEL}`);
    console.log(`cwd ${sessionCwd}`);
  });
}

module.exports = { app };

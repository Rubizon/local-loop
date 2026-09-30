#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b-8k";
const OPENAI_BASE = (process.env.OPENAI_BASE || "").replace(/\/$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "Qwen/Qwen3-4B-Instruct-2507";
const OPENAI_KEY = process.env.OPENAI_KEY || "";

async function chat(system, user, predict) {
  if (OPENAI_BASE) {
    const headers = { "Content-Type": "application/json" };
    if (OPENAI_KEY) headers.Authorization = "Bearer " + OPENAI_KEY;
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.1,
        max_tokens: predict || 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    return String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
  }
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.1, num_ctx: 8192, num_predict: predict || 200 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  return String((data.message && data.message.content) || "");
}

async function runWorkflow() {
  const model = OPENAI_BASE ? OPENAI_MODEL : OLLAMA_MODEL;
  const results = [];
  for (const probe of lib.WORKFLOW_PROBES) {
    const started = Date.now();
    let raw = await chat(probe.system, probe.user, probe.predict);
    let judged = lib.repairReply(probe.kind, raw, probe.user);
    let scored = lib.scoreWorkflow(probe.kind, judged);
    if (!scored.ok && /^\s*\{/.test(raw) && !/"display"\s*:/.test(raw)) {
      const again = await chat(probe.system, probe.user + "\nThat reply was a sentence in braces. Write one JSON object with quoted keys. display is the full answer. A program is the source, with \\n between lines.", probe.predict);
      const judgedAgain = lib.repairReply(probe.kind, again, probe.user);
      const scoredAgain = lib.scoreWorkflow(probe.kind, judgedAgain);
      if (scoredAgain.ok) {
        raw = again;
        judged = judgedAgain;
        scored = scoredAgain;
      }
    }
    results.push({ kind: probe.kind, ms: Date.now() - started, raw: lib.clip(raw, 500), ...scored });
    console.log(`  ${scored.ok ? "PASS" : "FAIL"} ${scored.name}  ${scored.detail}`);
    if (!scored.ok) console.log("    raw:", lib.clip(raw.replace(/\s+/g, " "), 180));
  }
  const passed = results.filter((r) => r.ok).length;
  return { model, passed, total: results.length, ok: passed === results.length, results };
}

async function runGuardTests() {
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-guard-"));
  const results = [];
  const mark = (name, ok, detail) => {
    results.push({ name, ok, detail: detail || "" });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  };
  const hi = await lib.runGuarded("printf hi", dir, { idleMs: 2000, hardMs: 4000 });
  mark("command prints", hi.code === 0 && hi.stdout === "hi" && !hi.killed);
  const cat = await lib.runGuarded("cat", dir, { idleMs: 1200, hardMs: 2500 });
  mark("closed stdin does not hang", cat.code === 0 && !cat.killed && cat.stdout === "");
  const hung = await lib.runGuarded("sleep 30", dir, { idleMs: 400, hardMs: 1200 });
  mark("silent command is stopped", hung.killed && hung.code === 124);
  fs.rmSync(dir, { recursive: true, force: true });
  const passed = results.filter((r) => r.ok).length;
  return { ok: passed === results.length, passed, total: results.length };
}

async function main() {
  const units = lib.runUnitTests();
  console.log(`unit ${units.passed}/${units.total}`);
  for (const r of units.results) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}  ${r.detail}`);
  if (!units.ok) {
    process.exitCode = 1;
    return;
  }
  const guards = await runGuardTests();
  console.log(`guard ${guards.passed}/${guards.total}`);
  if (!guards.ok) {
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--unit-only")) return;
  try {
    const probe = await runWorkflow();
    console.log(`model ${probe.model} ${probe.passed}/${probe.total}`);
    const live = [];
    for (const s of lib.USER_SCENARIOS) {
      if (s.harness) continue;
      const started = Date.now();
      const raw = await chat(s.system, s.user, s.predict);
      const ok = !!s.pass(raw);
      live.push({ name: s.name, ok, ms: Date.now() - started, raw: lib.clip(String(raw).replace(/\s+/g, " "), 160) });
      console.log(`  ${ok ? "PASS" : "FAIL"} ${s.name}${ok ? "" : "  " + live[live.length - 1].raw}`);
    }
    const got = live.filter((r) => r.ok).length;
    console.log(`scenarios ${got}/${live.length}`);
    if (!probe.ok || got !== live.length) process.exitCode = 2;
  } catch (err) {
    console.log("model probe skipped/failed:", err.message);
    if (process.argv.includes("--require-model")) process.exitCode = 2;
  }
}

main();
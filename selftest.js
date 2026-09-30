#!/usr/bin/env node
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
    const raw = await chat(probe.system, probe.user, probe.predict);
    const scored = lib.scoreWorkflow(probe.kind, raw);
    results.push({ kind: probe.kind, ms: Date.now() - started, raw: lib.clip(raw, 500), ...scored });
    console.log(`  ${scored.ok ? "PASS" : "FAIL"} ${scored.name}  ${scored.detail}`);
    if (!scored.ok) console.log("    raw:", lib.clip(raw.replace(/\s+/g, " "), 180));
  }
  const passed = results.filter((r) => r.ok).length;
  return { model, passed, total: results.length, ok: passed === results.length, results };
}

async function main() {
  const units = lib.runUnitTests();
  console.log(`unit ${units.passed}/${units.total}`);
  for (const r of units.results) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}  ${r.detail}`);
  if (!units.ok) {
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--unit-only")) return;
  try {
    const probe = await runWorkflow();
    console.log(`model ${probe.model} ${probe.passed}/${probe.total}`);
    if (!probe.ok) process.exitCode = 2;
  } catch (err) {
    console.log("model probe skipped/failed:", err.message);
    if (process.argv.includes("--require-model")) process.exitCode = 2;
  }
}

main();
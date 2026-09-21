#!/usr/bin/env node
const lib = require("./lib");

const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5-coder:3b-8k";

async function runModelProbe() {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      options: { temperature: 0.1, num_ctx: 8192, num_predict: 120 },
      messages: [
        { role: "system", content: lib.SYSTEM },
        { role: "user", content: lib.MODEL_PROBE_USER },
      ],
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${body}`);
  const data = JSON.parse(body);
  const raw = String((data.message && data.message.content) || "");
  const parsed = lib.extractJson(raw);
  return { raw: lib.clip(raw, 800), parsed, model: OLLAMA_MODEL, ...lib.scoreModelReply(parsed, raw) };
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
    const probe = await runModelProbe();
    console.log(`model ${probe.model} ${probe.passed}/${probe.total}`);
    for (const c of probe.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name}`);
    if (probe.display) console.log("  display:", probe.display);
    if (!probe.ok) process.exitCode = 2;
  } catch (err) {
    console.log("model probe skipped/failed:", err.message);
    if (process.argv.includes("--require-model")) process.exitCode = 2;
  }
}

main();

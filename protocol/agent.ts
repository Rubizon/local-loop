import { deskPaths, harvestFacts, splitScript, summarizeNotes } from "./desk.ts";
import { isKeep } from "./state.ts";
import { assessStep } from "./session.ts";
import type { Act, AgentEvent, AgentReply, Desk, DiffOp, LoopState, StepStatus } from "./types.ts";

/** One job per call. The app already picked it. */
export const SYS_USER = `JSON only. No markdown.
{"say":"","goal":"","add":[],"cmd":null,"why":"","plan":null}
Direct: one script, plan null. Chain commands that need no checkup.
Plan only if a later command needs unseen output, or force is 1. Then cmd is null.
A step is one stop. Its cmd is one script. Separate commands with a blank line.
Do not split unless the next command depends on that output.
plan items: {"do":"short","cmd":"or null","rb":0,"expect":"words that must appear"}
Commands: ls, cat, put, pdf under /demo. put uses <<EOF.
add is at most 4 short facts. Prefix KEEP to protect one.
Do not invent file contents. say is the next action, not an unseen result.
If goal is empty, add stays empty.`;

export const SYS_FOLD = `JSON only. No markdown. No plan. No command.
{"say":"one sentence","add":["short fact"]}
At most 4 new facts from OUT. Prefix KEEP if it must survive.
Do not repeat facts already under F.`;

export const SYS_CONT = `JSON only. No markdown.
{"say":"","cmd":"one script","why":"short"}
One script of ls, cat, put, or pdf. Paths under /demo.
Commands that do not need each other's output go in this script, one per line.
Leave the next stop for a later step. put uses <<EOF.
Do not invent file contents.`;

export const SYS_CHECK = `JSON only. No markdown.
{"ok":1,"why":"short","rollback":0}
ok is 0 if OUT misses expect. rollback is 1 only if a write should be undone.
Do not continue a step that is off the plan.`;

export const SYS_REFINE = `JSON only. No markdown.
{"say":"","plan":[{"do":"short","cmd":null,"rb":0,"expect":""}],"add":[]}
Rewrite the plan. Leave cmd null.`;

export const SYSTEM = SYS_USER;

export type Job = "user" | "fold" | "continue" | "refine" | "check";

const STATUSES: StepStatus[] = ["todo", "run", "ok", "fail", "skip"];

export function packetJob(event: AgentEvent): Job {
  if (event.kind === "fold") return "fold";
  if (event.kind === "continue") return "continue";
  if (event.kind === "refine") return "refine";
  if (event.kind === "check") return "check";
  return "user";
}

function modelFacts(state: LoopState, keepOnly: boolean): string[] {
  const keep = state.facts.filter(isKeep).slice(-6);
  if (keepOnly) return keep;
  const rest = state.facts.filter((f) => !isKeep(f)).slice(-4);
  return [...keep, ...rest].slice(-8);
}

function planLines(state: LoopState): string {
  if (!state.steps.length) return "-";
  return state.steps
    .map((s) => `${s.id} ${s.status} ${s.do} :: ${s.cmd ? s.cmd.split("\n")[0] : "-"}`)
    .join("\n");
}

function pathLines(desk: Desk): string {
  const paths = deskPaths(desk).slice(0, 12);
  return paths.length ? paths.join("\n") : "-";
}

export function buildPacket(
  state: LoopState,
  event: AgentEvent,
  desk: Desk,
): { system: string; user: string; job: Job; tokens: number } {
  const job = packetJob(event);
  const system =
    job === "fold" ? SYS_FOLD : job === "continue" ? SYS_CONT : job === "refine" ? SYS_REFINE : job === "check" ? SYS_CHECK : SYS_USER;
  const user = renderUser(state, event, desk, job);
  return { system, user, job, tokens: Math.ceil((system.length + user.length) / 4) };
}

function renderUser(state: LoopState, event: AgentEvent, desk: Desk, job: Job): string {
  const goal = state.goal.trim() || "-";
  if (job === "check" && event.kind === "check") {
    const step = state.steps.find((s) => s.id === event.stepId);
    const line = step ? `${step.id} ${step.do} :: ${step.cmd ? step.cmd.split("\n")[0] : "-"}` : event.stepId;
    return `step: ${line}\nexpect: ${step?.expect || "-"}\ncode: ${event.code}\nG ${goal}\nOUT\n${event.text.slice(0, 800)}`;
  }
  if (job === "fold" && event.kind === "fold") {
    return `meta: ${event.meta}\npart: ${event.index}/${event.total}\ncmd: ${event.cmd.split("\n")[0].slice(0, 100)}\nG ${goal}\nF\n${modelFacts(state, true).join("\n") || "-"}\nOUT\n${event.chunk}`;
  }
  if (job === "continue" && event.kind === "continue") {
    const step = state.steps.find((s) => s.id === event.stepId);
    const line = step ? `${step.id} ${step.do} :: ${step.cmd ? step.cmd.split("\n")[0] : "-"}` : event.stepId;
    return `step: ${line}\nG ${goal}\nF\n${modelFacts(state, false).join("\n") || "-"}\nP\n${pathLines(desk)}`;
  }
  if (job === "refine" && event.kind === "refine") {
    return `note: ${event.text.slice(0, 400)}\nG ${goal}\nPLAN\n${planLines(state)}\nF\n${modelFacts(state, true).join("\n") || "-"}`;
  }
  if (event.kind === "user") {
    return `force: ${event.forcePlan ? 1 : 0}\nNOW ${state.phase}\nG ${goal}\nPLAN\n${planLines(state)}\nF\n${modelFacts(state, false).join("\n") || "-"}\nP\n${pathLines(desk)}\nASK\n${event.text.slice(0, 600)}`;
  }
  if (event.kind === "denied") {
    return `denied: ${event.cmd.split("\n")[0].slice(0, 120)}\nG ${goal}\nF\n${modelFacts(state, true).join("\n") || "-"}`;
  }
  return `G ${goal}`;
}

export function safeCmd(cmd: string): string | null {
  const raw = cmd.trim();
  if (!raw || /(^|\s)\.\.(\/|\s|$)/.test(raw)) return null;
  let heredoc = false;
  let any = false;
  for (const line of raw.split("\n")) {
    if (heredoc) {
      if (line.trim() === "EOF") heredoc = false;
      continue;
    }
    if (!line.trim()) continue;
    if (!/^(ls|cat|put|pdf)(\s|$)/.test(line.trim())) return null;
    any = true;
    if (/<<EOF\s*$/.test(line)) heredoc = true;
  }
  if (heredoc || !any) return null;
  return raw;
}

export function expandCmd(cmd: string): string | null {
  const safe = safeCmd(cmd);
  if (!safe) return null;
  const parts: string[] = [];
  for (const part of splitScript(safe)) {
    if (part === "ls") parts.push("ls /demo/inbox");
    else if (part === "pdf") return null;
    else parts.push(part);
  }
  return parts.join("\n");
}

function reply(say: string, diff: DiffOp[], act: Act = null, verdict?: AgentReply["verdict"]): AgentReply {
  return verdict ? { say, diff, act, verdict } : { say, diff, act };
}

function wantsBrief(text: string): boolean {
  return /pdf/i.test(text) && /summari|inbox|notes|analy|brief|files/i.test(text);
}

function wantsList(text: string): boolean {
  return /\b(list|ls|show)\b/i.test(text) && /inbox|files|notes|demo/i.test(text);
}

function wantsFriday(text: string): boolean {
  return /friday/i.test(text);
}

function briefPlan(desk: Desk): DiffOp {
  const notes = Object.keys(desk.files)
    .filter((path) => path.startsWith("/demo/inbox/") && path.endsWith(".txt"))
    .sort();
  if (!notes.length) {
    return {
      op: "plan",
      steps: [
        { id: "1", do: "List the inbox", cmd: "ls /demo/inbox", rollback: false, expect: ".txt" },
        { id: "2", do: "Read the notes", cmd: null, rollback: false, expect: "" },
        {
          id: "3",
          do: "Write summary.txt and the PDF",
          cmd: null,
          rollback: true,
          expect: "wrote /demo/out/brief.pdf",
        },
      ],
    };
  }
  return {
    op: "plan",
    steps: [
      {
        id: "1",
        do: "Read the notes",
        cmd: `cat ${notes.join(" ")}`,
        rollback: false,
        expect: "feature freeze, print budget 400",
      },
      {
        id: "2",
        do: "Write summary.txt and the PDF",
        cmd: null,
        rollback: true,
        expect: "wrote /demo/out/summary.txt, wrote /demo/out/brief.pdf, feature freeze",
      },
    ],
  };
}

export function heuristicReply(state: LoopState, event: AgentEvent, desk: Desk): AgentReply | null {
  if (event.kind === "fold") return foldReply(event);
  if (event.kind === "continue") return continueReply(state, event.stepId, desk);
  if (event.kind === "denied") {
    const diff: DiffOp[] = [{ op: "log", text: `Denied ${event.cmd.split("\n")[0]}` }];
    if (event.stepId) diff.push({ op: "step", id: event.stepId, status: "fail" });
    return reply("Denied. That command did not run.", diff, null);
  }
  if (event.kind === "refine") return refineReply(state, event.text);
  if (event.kind === "user") return userReply(state, event.text, event.forcePlan, desk);
  if (event.kind === "check") return checkReply(state, event);
  return null;
}

function userReply(state: LoopState, text: string, forcePlan: boolean, desk: Desk): AgentReply | null {
  const t = text.trim();
  if (!t) return null;
  if (/^(stop|cancel)$/i.test(t) && state.steps.length) {
    return reply("Cancelling the plan and rolling files back.", [{ op: "clear-plan" }, { op: "log", text: "Cancel requested" }]);
  }
  if (wantsBrief(t)) {
    return reply(
      "Two stops. I read the notes first, because the summary depends on them. Then one script writes summary.txt and the PDF, with no checkup in between.",
      [
        { op: "goal", text: "Summarize the inbox notes into a one-page PDF." },
        briefPlan(desk),
        { op: "log", text: "Plan waiting for execute" },
      ],
    );
  }
  if (wantsList(t)) {
    if (forcePlan) {
      return reply("One step. Execute when you want the listing.", [
        { op: "goal", text: "List the inbox" },
        { op: "plan", steps: [{ id: "1", do: "List the inbox", cmd: "ls /demo/inbox", rollback: false, expect: "monday.txt, tuesday.txt, friday.txt" }] },
      ]);
    }
    return reply("Allow ls and I will list /demo/inbox.", [
      { op: "goal", text: "List the inbox" },
      { op: "log", text: "Waiting to list the inbox" },
    ], { type: "cmd", cmd: "ls /demo/inbox", why: "list notes" });
  }
  if (wantsFriday(t)) {
    const known = state.facts.find((f) => /friday|one-page pdf|ship the brief/i.test(f));
    if (known && !forcePlan) {
      return reply(known, [{ op: "log", text: "Answered from state" }]);
    }
    const cmd = "cat /demo/inbox/friday.txt";
    if (forcePlan) {
      return reply("One step: read Friday's note, then I will say what it decided.", [
        { op: "goal", text: "What Friday decided" },
        { op: "plan", steps: [{ id: "1", do: "Read Friday's note", cmd, rollback: false, expect: "one-page PDF" }] },
      ]);
    }
    if (!desk.files["/demo/inbox/friday.txt"]) return null;
    return reply("I need Friday's note. Allow the read.", [
      { op: "goal", text: "What Friday decided" },
      { op: "log", text: "Waiting on Friday's note" },
    ], { type: "cmd", cmd, why: "read Friday" });
  }
  if (forcePlan && t.length < 400) {
    return reply("I will treat this as a plan. Review it, then execute or refine.", [
      { op: "goal", text: t.slice(0, 180) },
      { op: "plan", steps: [{ id: "1", do: t.slice(0, 140), cmd: null, rollback: false }] },
    ]);
  }
  return null;
}

function foldReply(event: Extract<AgentEvent, { kind: "fold" }>): AgentReply {
  const parts = splitScript(event.cmd);
  const first = parts[0]?.split("\n")[0] || event.cmd.split("\n")[0];
  const diff: DiffOp[] = [{ op: "log", text: `${first} · ${event.meta}${event.total > 1 ? ` · part ${event.index}/${event.total}` : ""}` }];
  if (event.index !== 1) {
    return reply(`Folded part ${event.index} of ${event.total}. ${event.meta}`, diff);
  }
  if (parts.some((part) => /^ls\b/.test(part)) && !parts.some((part) => /^cat\b/.test(part))) {
    const names = event.chunk
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && line !== "(empty)" && !line.startsWith("wrote "));
    for (const name of names) diff.push({ op: "fact", text: `KEEP file ${name}` });
    return reply(names.length ? `Inbox: ${names.join(", ")}.` : "The folder is empty.", diff);
  }
  if (parts.some((part) => /^cat\b/.test(part))) {
    for (const fact of harvestFacts(event.chunk)) diff.push({ op: "fact", text: fact });
  }
  const wrote = parts.filter((part) => /^put\b/.test(part)).map((part) => part.split(/\s+/)[1] || "file");
  const pdfs = parts.filter((part) => /^pdf\b/.test(part)).map((part) => part.split(/\s+/)[2] || "pdf");
  for (const path of wrote) diff.push({ op: "fact", text: `KEEP wrote ${path}` });
  for (const dest of pdfs) diff.push({ op: "fact", text: `KEEP pdf ${dest}` });
  if (wrote.length && pdfs.length) return reply(`Wrote ${wrote.join(", ")} and ${pdfs.join(", ")} in one script.`, diff);
  if (wrote.length) return reply(`Wrote ${wrote.join(", ")}.`, diff);
  if (pdfs.length) return reply(`Done. ${pdfs.join(", ")} is on the desk.`, diff);
  if (parts.some((part) => /^cat\b/.test(part))) {
    const friday = parts.some((part) => /friday\.txt/i.test(part));
    const ship = event.chunk.split("\n").find((line) => /ship the brief/i.test(line));
    const say = friday && ship
      ? "Friday: ship the brief as a one-page PDF. Feature freeze, print budget 400, checkout timeout still open."
      : "Kept the lines that matter from that read.";
    return reply(say, diff);
  }
  for (const fact of harvestFacts(event.chunk)) diff.push({ op: "fact", text: fact });
  return reply(`Folded command output. ${event.meta}`, diff);
}

function continueReply(state: LoopState, stepId: string, desk: Desk): AgentReply | null {
  const step = state.steps.find((s) => s.id === stepId);
  if (!step) return null;
  if (step.cmd) {
    return reply(step.do, [], { type: "cmd", cmd: step.cmd, why: step.do });
  }
  if (/summary|write|pdf/i.test(step.do)) {
    const wantsPdf = /pdf/i.test(step.do);
    const wantsWrite = /summary|write/i.test(step.do);
    if (wantsWrite) {
      const body = summarizeNotes(desk.files);
      if (!body) {
        return reply("The inbox has no notes to summarize.", [], { type: "ask", q: "Which files should I read?" });
      }
      const put = `put /demo/out/summary.txt <<EOF\n${body.replace(/\n$/, "")}\nEOF`;
      const cmd = wantsPdf ? `${put}\npdf /demo/out/summary.txt /demo/out/brief.pdf` : put;
      return reply(wantsPdf ? "One script writes the summary and the PDF. No stop between them." : "Summary is ready. Allow the write.", [
        { op: "log", text: "Summary drafted from inbox notes" },
      ], { type: "cmd", cmd, why: wantsPdf ? "write summary and pdf" : "write summary.txt" });
    }
    return reply("Allow the PDF write.", [], {
      type: "cmd",
      cmd: "pdf /demo/out/summary.txt /demo/out/brief.pdf",
      why: "one-page brief",
    });
  }
  if (/list|inbox/i.test(step.do)) {
    return reply("Allow the listing.", [], { type: "cmd", cmd: "ls /demo/inbox", why: step.do });
  }
  if (/read|friday|cat/i.test(step.do)) {
    const cmd = /friday/i.test(step.do)
      ? "cat /demo/inbox/friday.txt"
      : "cat /demo/inbox/monday.txt /demo/inbox/tuesday.txt /demo/inbox/friday.txt";
    return reply("Allow the read.", [], { type: "cmd", cmd, why: step.do });
  }
  return null;
}

function checkReply(state: LoopState, event: Extract<AgentEvent, { kind: "check" }>): AgentReply | null {
  const step = state.steps.find((s) => s.id === event.stepId);
  if (!step) return reply("That step is gone.", [], null, { ok: false, why: "missing step", rollback: false });
  const verdict = assessStep(step, event.text, event.code);
  if (!verdict.sure) return null;
  const say = verdict.ok ? "On plan." : `Off plan. ${verdict.why}`;
  return reply(say, [{ op: "log", text: verdict.why }], null, {
    ok: verdict.ok,
    why: verdict.why,
    rollback: verdict.rollback,
  });
}

function refineReply(state: LoopState, text: string): AgentReply | null {
  const t = text.trim();
  if (!t || !state.steps.length) return null;
  if (/skip pdf|no pdf|without pdf|drop pdf/i.test(t)) {
    const steps = state.steps.filter((s) => !/pdf/i.test(s.do) && !/^pdf\b/.test(s.cmd || ""));
    return reply("Dropped the PDF step. Review the shorter plan.", [
      { op: "plan", steps },
      { op: "log", text: "Refine: no PDF" },
    ]);
  }
  return reply("Noted on the plan. Execute when it looks right.", [
    { op: "fact", text: `KEEP note: ${t.slice(0, 160)}` },
    { op: "log", text: "Plan refined" },
    { op: "phase", phase: "review" },
  ]);
}

function asStatus(value: unknown): StepStatus | null {
  return typeof value === "string" && STATUSES.includes(value as StepStatus) ? (value as StepStatus) : null;
}

export function parseReply(raw: string, job?: Job): AgentReply {
  const json = extractJson(raw);
  if (job === "check") {
    const verdict = verdictFromJson(json);
    return { say: verdict.ok ? "On plan." : `Off plan. ${verdict.why}`, diff: [{ op: "log", text: verdict.why }], act: null, verdict };
  }
  absorbFlat(json);
  const say = clipSay(json.say ?? json.display ?? json.text);
  let diff = parseDiff(json);
  let act = parseAct(json);
  if (act?.type === "cmd" && diff.some((op) => op.op === "plan")) act = null;
  if (job === "fold") {
    diff = diff.filter((op) => op.op === "fact" || op.op === "drop" || op.op === "log" || op.op === "goal");
    act = null;
  } else if (job === "continue") {
    diff = diff.filter((op) => op.op !== "plan" && op.op !== "clear-plan");
  }
  if (act?.type === "cmd") {
    const cmd = expandCmd(act.cmd);
    act = cmd ? { ...act, cmd } : { type: "ask", q: "I can only run ls, cat, put, or pdf under /demo." };
  }
  const facts = diff.filter((op) => op.op === "fact").slice(0, 4);
  const rest = diff.filter((op) => op.op !== "fact");
  return { say: say || "Ready.", diff: [...rest, ...facts], act };
}

function absorbFlat(json: Record<string, unknown>) {
  if (typeof json.goal === "string" && json.goal.trim()) {
    const diff = Array.isArray(json.diff) ? json.diff : [];
    json.diff = [{ op: "goal", text: json.goal }, ...diff];
  }
  const add = json.add ?? json.facts;
  if (Array.isArray(add)) {
    const diff = Array.isArray(json.diff) ? json.diff : [];
    const facts = add
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 4)
      .map((text) => ({ op: "fact", text }));
    json.diff = [...diff, ...facts];
  }
  if (typeof json.drop === "string" && json.drop.trim()) {
    const diff = Array.isArray(json.diff) ? json.diff : [];
    json.diff = [...diff, { op: "drop", match: json.drop }];
  }
}

function clipSay(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

function verdictFromJson(json: Record<string, unknown>): { ok: boolean; why: string; rollback: boolean } {
  if (!("ok" in json)) return { ok: false, why: "Check was not JSON.", rollback: false };
  const ok = json.ok === 1 || json.ok === true || json.ok === "1";
  const rollback = json.rollback === 1 || json.rollback === true || json.rb === 1 || json.rb === true;
  const why = typeof json.why === "string" && json.why.trim() ? json.why.trim().slice(0, 180) : ok ? "On plan." : "Off plan.";
  return { ok, why, rollback };
}

function inferExpect(cmd: string | null, given: unknown): string {
  if (typeof given === "string" && given.trim() && given.trim() !== "null") return given.trim().slice(0, 120);
  if (!cmd) return "";
  const bits: string[] = [];
  for (const part of splitScript(cmd)) {
    const put = part.match(/^put\s+(\S+)/);
    if (put) bits.push(`wrote ${put[1]}`);
    const pdf = part.match(/^pdf\s+\S+\s+(\S+)/);
    if (pdf) bits.push(`wrote ${pdf[1]}`);
  }
  return bits.join(", ").slice(0, 120);
}

function normalizeRawSteps(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item, i) => {
    const step = item as { id?: unknown; do?: unknown; cmd?: unknown; rollback?: unknown; rb?: unknown; expect?: unknown };
    const cmd = typeof step.cmd === "string" && step.cmd.trim() && step.cmd.trim() !== "null" ? step.cmd : null;
    return {
      id: step.id == null ? String(i + 1) : String(step.id),
      do: typeof step.do === "string" ? step.do : `step ${i + 1}`,
      cmd,
      rollback: Boolean(step.rollback) || step.rb === 1 || step.rb === true,
      expect: inferExpect(cmd, step.expect),
    };
  });
}

function parseDiff(json: Record<string, unknown>): DiffOp[] {
  const raw = Array.isArray(json.diff) ? json.diff : Array.isArray(json.ops) ? json.ops : [];
  const diff: DiffOp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    const kind = String(op.op || "");
    if (kind === "goal" && typeof op.text === "string") diff.push({ op: "goal", text: op.text });
    else if (kind === "fact" && typeof op.text === "string") diff.push({ op: "fact", text: op.text });
    else if (kind === "drop" && typeof op.match === "string") diff.push({ op: "drop", match: op.match });
    else if (kind === "log" && typeof op.text === "string") diff.push({ op: "log", text: op.text });
    else if (kind === "plan") diff.push({ op: "plan", steps: normalizeRawSteps(op.steps) });
    else if (kind === "step" && op.id != null && asStatus(op.status)) {
      diff.push({
        op: "step",
        id: String(op.id),
        status: asStatus(op.status)!,
        cmd: typeof op.cmd === "string" ? op.cmd : undefined,
      });
    } else if (kind === "clear-plan") diff.push({ op: "clear-plan" });
    else if (kind === "cursor") diff.push({ op: "cursor", n: Number(op.n) || 0 });
    else if (kind === "phase" && (op.phase === "idle" || op.phase === "review" || op.phase === "run" || op.phase === "done")) {
      diff.push({ op: "phase", phase: op.phase });
    }
  }
  if (!diff.some((op) => op.op === "plan") && Array.isArray(json.plan)) {
    diff.push({ op: "plan", steps: normalizeRawSteps(json.plan) });
  }
  if (!diff.some((op) => op.op === "plan") && Array.isArray(json.steps)) {
    diff.push({ op: "plan", steps: normalizeRawSteps(json.steps) });
  }
  return diff;
}

function cmdString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t || t === "null" || t === "none" || t === "-") return null;
  return t;
}

function parseAct(json: Record<string, unknown>): Act {
  const act = json.act;
  if (act && typeof act === "object") {
    const a = act as Record<string, unknown>;
    const cmd = cmdString(a.cmd);
    if (a.type === "cmd" && cmd) return { type: "cmd", cmd, why: typeof a.why === "string" ? a.why : "command" };
    if (a.type === "ask" && typeof a.q === "string" && a.q.trim()) return { type: "ask", q: a.q.trim() };
    if (a.type === "done") return { type: "done" };
  }
  const cmd = cmdString(json.cmd);
  if (cmd) return { type: "cmd", cmd, why: typeof json.why === "string" ? json.why : "command" };
  if (typeof json.ask === "string" && json.ask.trim()) return { type: "ask", q: json.ask.trim() };
  if (json.done === 1 || json.done === true) return { type: "done" };
  return null;
}

export function extractJson(text: string): Record<string, unknown> {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : stripped;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = body.slice(start, end + 1);
    const parsed = tryParse(slice) ?? tryParse(slice.replace(/,\s*([}\]])/g, "$1"));
    if (parsed) return parsed;
  }
  return salvage(text);
}

function tryParse(slice: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(slice) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function salvage(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const say = text.match(/(?:^|\n)\s*say\s*:\s*(.+)/i);
  const cmd = text.match(/(?:^|\n)\s*(?:cmd|command)\s*:\s*(.+)/i);
  const goal = text.match(/(?:^|\n)\s*goal\s*:\s*(.+)/i);
  if (say) out.say = say[1].trim();
  if (cmd) out.cmd = cmd[1].trim();
  if (goal) out.goal = goal[1].trim();
  const adds = [...text.matchAll(/(?:^|\n)\s*add\s*:\s*(.+)/gi)].map((m) => m[1].trim()).filter(Boolean);
  if (adds.length) out.add = adds;
  return out;
}

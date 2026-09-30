import type { AgentReply, DiffOp, LoopState, Phase, RawStep, Step, StepStatus } from "./types.ts";

const PHASES: Phase[] = ["idle", "review", "run", "done"];
const STATUSES: StepStatus[] = ["todo", "run", "ok", "fail", "skip"];
const HEADERS = new Set(["GOAL", "PHASE", "CURSOR", "PLAN", "FACTS", "LOG"]);

export function isKeep(fact: string): boolean {
  return /^KEEP\b/i.test(fact.trim());
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

function normStep(raw: RawStep, index: number): Step {
  const status = STATUSES.includes(raw.status as StepStatus) ? (raw.status as StepStatus) : "todo";
  const cmd = typeof raw.cmd === "string" && raw.cmd.trim() ? raw.cmd.trim() : null;
  return {
    id: String(raw.id || index + 1),
    do: clip(String(raw.do || "step"), 180),
    cmd,
    rollback: Boolean(raw.rollback),
    status,
    expect: clip(String(raw.expect || ""), 120),
  };
}

export function normalizeState(raw: Partial<LoopState> | null | undefined): LoopState {
  const phase = PHASES.includes(raw?.phase as Phase) ? (raw?.phase as Phase) : "idle";
  const steps = Array.isArray(raw?.steps) ? raw.steps.slice(0, 8).map((step, index) => normStep(step || { do: "step" }, index)) : [];
  const lines = (value: unknown, n: number) =>
    (Array.isArray(value) ? value : [])
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .slice(-n);
  return {
    goal: String(raw?.goal || "").trim(),
    phase,
    cursor: Math.max(0, Math.floor(Number(raw?.cursor) || 0)),
    steps,
    facts: lines(raw?.facts, 24),
    log: lines(raw?.log, 16),
  };
}

export function emptyState(): LoopState {
  return normalizeState(null);
}

function pushFact(facts: string[], text: string): string[] {
  const fact = clip(text, 220);
  if (!fact || facts.some((f) => f.toLowerCase() === fact.toLowerCase())) return facts;
  const next = [...facts, fact];
  while (next.length > 24) {
    const dropAt = next.findIndex((f) => !isKeep(f));
    if (dropAt < 0) break;
    next.splice(dropAt, 1);
  }
  return next.slice(-24);
}

export function applyDiff(state: LoopState, diff: DiffOp[], allowPlan: boolean): LoopState {
  let next: LoopState = {
    ...state,
    steps: state.steps.map((s) => ({ ...s })),
    facts: [...state.facts],
    log: [...state.log],
  };
  for (const op of diff) {
    if (op.op === "goal") next = { ...next, goal: clip(op.text, 280) };
    else if (op.op === "fact") next = { ...next, facts: pushFact(next.facts, op.text) };
    else if (op.op === "drop") {
      const match = op.match.trim().toLowerCase();
      if (!match) continue;
      const hit = (line: string) => line.toLowerCase().includes(match);
      const dropKeep = /\bkeep\b/i.test(op.match);
      next = {
        ...next,
        facts: next.facts.filter((f) => (isKeep(f) && !dropKeep ? true : !hit(f))),
        log: next.log.filter((f) => !hit(f)),
      };
    } else if (op.op === "log") {
      const line = clip(op.text, 180);
      if (!line) continue;
      next = { ...next, log: [...next.log, line].slice(-16) };
    } else if (op.op === "plan") {
      if (!allowPlan || !Array.isArray(op.steps) || op.steps.length === 0) continue;
      next = {
        ...next,
        phase: "review",
        cursor: 0,
        steps: op.steps.slice(0, 8).map((s, i) => normStep({ ...s, status: "todo" }, i)),
      };
    } else if (op.op === "step") {
      next = {
        ...next,
        steps: next.steps.map((s) =>
          s.id === String(op.id)
            ? {
                ...s,
                status: STATUSES.includes(op.status) ? op.status : s.status,
                cmd: op.cmd === undefined ? s.cmd : op.cmd?.trim() || null,
              }
            : s,
        ),
      };
    } else if (op.op === "clear-plan") {
      next = { ...next, steps: [], cursor: 0, phase: next.phase === "done" ? "done" : "idle" };
    } else if (op.op === "cursor") {
      const n = Math.max(0, Math.floor(Number(op.n) || 0));
      next = { ...next, cursor: n };
    } else if (op.op === "phase" && PHASES.includes(op.phase)) {
      next = { ...next, phase: op.phase };
    }
  }
  return next;
}

export function applyReply(
  state: LoopState,
  reply: AgentReply,
  opts: { allowPlan: boolean; wipeWithoutGoal: boolean },
): LoopState {
  let next = applyDiff(state, reply.diff, opts.allowPlan);
  if (reply.act?.type === "done" && next.phase !== "review") next = { ...next, phase: "done" };
  if (opts.wipeWithoutGoal && !next.goal.trim()) {
    if (next.phase === "review" && next.steps.length) {
      next = {
        ...next,
        goal: next.steps
          .slice(0, 3)
          .map((s) => s.do)
          .join(" · "),
        facts: next.facts.filter(isKeep),
      };
    } else {
      next = {
        ...next,
        facts: next.facts.filter(isKeep),
        log: [],
        steps: [],
        cursor: 0,
        phase: "idle",
      };
    }
  }
  return next;
}

export function visibleAct(reply: AgentReply, state: LoopState, takeAct: boolean): AgentReply["act"] {
  if (!takeAct) return null;
  if (state.phase === "review") return reply.act?.type === "ask" ? reply.act : null;
  return reply.act;
}

function cell(text: string): string {
  return text.replace(/\|/g, "/");
}

export function serialize(state: LoopState): string {
  const plan =
    state.steps.length === 0
      ? "(none)"
      : state.steps
          .map((s) => {
            const flag = s.rollback ? "rollback" : "stick";
            return `${s.id} ${s.status} | ${cell(s.do)} | ${cell(s.cmd ?? "")} | ${flag} | ${cell(s.expect)}`;
          })
          .join("\n");
  const facts = state.facts.length ? state.facts.map((f) => `- ${f}`).join("\n") : "(none)";
  const log = state.log.length ? state.log.map((f) => `- ${f}`).join("\n") : "(none)";
  return ["GOAL", state.goal.trim() || "(none)", "", "PHASE", state.phase, "", "CURSOR", String(state.cursor), "", "PLAN", plan, "", "FACTS", facts, "", "LOG", log, ""].join(
    "\n",
  );
}

function sectionMap(text: string): Record<string, string> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const map: Record<string, string[]> = {};
  let cur = "";
  for (const line of lines) {
    const head = line.trim();
    if (HEADERS.has(head)) {
      cur = head;
      map[cur] = [];
      continue;
    }
    if (cur) map[cur].push(line);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) out[k] = v.join("\n").trim();
  return out;
}

function body(section: string | undefined): string {
  if (!section || section === "(none)") return "";
  return section.trim();
}

export function parseState(text: string): LoopState {
  const map = sectionMap(text);
  if (!("GOAL" in map) || !("PLAN" in map)) {
    throw new Error("State needs GOAL and PLAN sections.");
  }
  const phase = PHASES.includes(body(map.PHASE) as Phase) ? (body(map.PHASE) as Phase) : "idle";
  const cursor = Math.max(0, Math.floor(Number(body(map.CURSOR)) || 0));
  const steps: Step[] = [];
  const planBody = body(map.PLAN);
  if (planBody) {
    for (const line of planBody.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "(none)") continue;
      const bits = trimmed.split("|").map((p) => p.trim());
      if (bits.length < 2) throw new Error(`Bad plan line: ${trimmed}`);
      const head = bits[0].split(/\s+/);
      const id = head[0];
      const status = STATUSES.includes(head[1] as StepStatus) ? (head[1] as StepStatus) : "todo";
      const flag = (bits[3] || "stick").toLowerCase();
      steps.push({
        id,
        status,
        do: bits[1] || "step",
        cmd: bits[2] ? bits[2] : null,
        rollback: flag === "rollback",
        expect: bits[4] || "",
      });
    }
  }
  const list = (section: string | undefined) =>
    body(section)
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter((l) => l && l !== "(none)");
  return {
    goal: body(map.GOAL),
    phase,
    cursor,
    steps,
    facts: list(map.FACTS).slice(0, 24),
    log: list(map.LOG).slice(0, 16),
  };
}

export function setStepCmd(state: LoopState, id: string, cmd: string): LoopState {
  return {
    ...state,
    steps: state.steps.map((s) => (s.id === id ? { ...s, cmd } : s)),
  };
}

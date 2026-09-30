import { rollbackStep, splitScript } from "./desk.ts";
import type { Desk, LoopState, Snap, Step } from "./types.ts";

export type PendingCmd = { cmd: string; why: string; stepId: string | null };

export type Verdict = { ok: boolean; why: string; rollback: boolean; sure: boolean };

function needlesOf(expect: string): string[] {
  return expect
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 2);
}

function structured(needle: string): boolean {
  return /wrote\s|\/demo\/|\.(txt|pdf)\b/i.test(needle);
}

/** Local self-check. A sure failure cannot be overruled. Unsure goes to the model, which fails closed. */
export function assessStep(step: Pick<Step, "cmd" | "expect" | "rollback">, text: string, code: number): Verdict {
  const blob = text.trim();
  const write = splitScript(step.cmd || "").some((part) => /^(put|pdf)(\s|$)/.test(part));
  const rollback = step.rollback || write;
  if (code !== 0 || /\bno such file\b|\brefused\b|\bunknown command\b/i.test(blob)) {
    return { ok: false, why: (blob || "command failed").slice(0, 160), rollback, sure: true };
  }
  const needles = needlesOf(step.expect);
  if (!needles.length) return { ok: true, why: "command finished", rollback: false, sure: true };
  const missing = needles.filter((needle) => !blob.toLowerCase().includes(needle.toLowerCase()));
  if (!missing.length) return { ok: true, why: "matches the plan", rollback: false, sure: true };
  if (missing.every(structured)) {
    return { ok: false, why: `expected ${missing.join(", ")}`, rollback, sure: true };
  }
  return { ok: false, why: `missing ${missing.join(", ")}`, rollback, sure: false };
}

export function stepEvidence(cmd: string, stdout: string, desk: Desk): string {
  const extras: string[] = [];
  for (const part of splitScript(cmd)) {
    const put = part.match(/^put\s+(\S+)/);
    if (put && desk.files[put[1]]) extras.push(desk.files[put[1]]);
    const pdf = part.match(/^pdf\s+\S+\s+(\S+)/);
    if (pdf && desk.bins[pdf[1]]) {
      try {
        const bytes = Uint8Array.from(atob(desk.bins[pdf[1]]), (c) => c.charCodeAt(0));
        extras.push(new TextDecoder().decode(bytes));
      } catch {
        /* keep stdout */
      }
    }
  }
  return `${stdout}\n${extras.join("\n")}`.slice(0, 8000);
}

export function abortOffPlan(
  state: LoopState,
  desk: Desk,
  snaps: Snap[],
  stepId: string,
  verdict: { why: string; rollback: boolean },
): { state: LoopState; desk: Desk; snaps: Snap[]; say: string } {
  const idx = state.steps.findIndex((s) => s.id === stepId);
  let nextDesk = desk;
  let nextSnaps = snaps;
  const undone: string[] = [];
  if (verdict.rollback) {
    const ids = new Set(state.steps.slice(Math.max(0, idx)).map((s) => s.id));
    const own = snaps.filter((s) => ids.has(s.stepId));
    for (const id of [...new Set(own.map((s) => s.stepId))].reverse()) {
      for (const snap of snaps.filter((s) => s.stepId === id)) {
        if (!undone.includes(snap.path)) undone.push(snap.path);
      }
      const rolled = rollbackStep(nextDesk, nextSnaps, id);
      nextDesk = rolled.desk;
      nextSnaps = rolled.snaps;
    }
  }
  const steps = state.steps.map((s, i) => {
    if (i === idx) return { ...s, status: "fail" as const };
    if (i > idx) return { ...s, status: "skip" as const };
    return s;
  });
  const undoSteps: Step[] = undone.map((path, i) => ({
    id: `u${i + 1}`,
    do: `Undo ${path}`,
    cmd: null,
    rollback: false,
    status: "ok",
    expect: "restored",
  }));
  const say = undone.length
    ? `Off plan. ${verdict.why} Rolled back ${undone.join(", ")}.`
    : `Off plan. ${verdict.why} Nothing to roll back.`;
  return {
    state: {
      ...state,
      steps: [...steps, ...undoSteps],
      phase: "idle",
      cursor: Math.max(0, idx),
      log: [...state.log, say].slice(-16),
      facts: [...state.facts.filter((f) => !f.startsWith("KEEP stopped:")), `KEEP stopped: ${verdict.why}`].slice(-24),
    },
    desk: nextDesk,
    snaps: nextSnaps,
    say,
  };
}

export function startPlan(state: LoopState): { state: LoopState; pending: PendingCmd | null; needEmit: boolean } {
  if (!state.steps.length) return { state, pending: null, needEmit: false };
  const steps = state.steps.map((s, i) => (i === 0 ? { ...s, status: "run" as const } : { ...s, status: "todo" as const }));
  const next = { ...state, phase: "run" as const, cursor: 0, steps };
  const step = steps[0];
  if (step.cmd) return { state: next, pending: { cmd: step.cmd, why: step.do, stepId: step.id }, needEmit: false };
  return { state: next, pending: null, needEmit: true };
}

export function finishStep(
  state: LoopState,
  stepId: string,
  ok: boolean,
): { state: LoopState; pending: PendingCmd | null; needEmit: boolean; done: boolean } {
  const current = state.steps.findIndex((s) => s.id === stepId);
  let steps = state.steps.map((s) => (s.id === stepId ? { ...s, status: ok ? ("ok" as const) : ("fail" as const) } : s));
  if (!ok || current < 0) {
    return {
      state: { ...state, steps, phase: "run", cursor: Math.max(0, current) },
      pending: null,
      needEmit: false,
      done: false,
    };
  }
  const nextIdx = steps.findIndex((s, i) => i > current && (s.status === "todo" || s.status === "run"));
  if (nextIdx < 0) {
    return {
      state: { ...state, steps, phase: "done", cursor: current },
      pending: null,
      needEmit: false,
      done: true,
    };
  }
  steps = steps.map((s, i) => (i === nextIdx ? { ...s, status: "run" as const } : s));
  const step = steps[nextIdx];
  const base = { ...state, steps, phase: "run" as const, cursor: nextIdx };
  if (step.cmd) return { state: base, pending: { cmd: step.cmd, why: step.do, stepId: step.id }, needEmit: false, done: false };
  return { state: base, pending: null, needEmit: true, done: false };
}

export function undoFrom(state: LoopState, desk: Desk, snaps: Snap[], stepId: string): { state: LoopState; desk: Desk; snaps: Snap[] } {
  const idx = state.steps.findIndex((s) => s.id === stepId);
  if (idx < 0) return { state, desk, snaps };
  let nextDesk = desk;
  let nextSnaps = snaps;
  for (const step of state.steps.slice(idx)) {
    const rolled = rollbackStep(nextDesk, nextSnaps, step.id);
    nextDesk = rolled.desk;
    nextSnaps = rolled.snaps;
  }
  const steps = state.steps.map((s, i) => (i >= idx ? { ...s, status: i === idx ? ("run" as const) : ("todo" as const) } : s));
  return {
    state: {
      ...state,
      steps,
      phase: "run",
      cursor: idx,
      log: [...state.log, `Rolled back from step ${stepId}`].slice(-16),
    },
    desk: nextDesk,
    snaps: nextSnaps,
  };
}

export function cancelPlan(state: LoopState, desk: Desk, snaps: Snap[]): { state: LoopState; desk: Desk; snaps: Snap[] } {
  let nextDesk = desk;
  let nextSnaps = snaps;
  for (const step of [...state.steps].reverse()) {
    const rolled = rollbackStep(nextDesk, nextSnaps, step.id);
    nextDesk = rolled.desk;
    nextSnaps = rolled.snaps;
  }
  return {
    state: {
      ...state,
      steps: [],
      cursor: 0,
      phase: "idle",
      log: [...state.log, "Plan cancelled. Writes rolled back."].slice(-16),
    },
    desk: nextDesk,
    snaps: nextSnaps,
  };
}

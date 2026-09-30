import { runCommand, splitScript } from "./desk.ts";
import type { CmdResult, Desk, Snap } from "./types.ts";

export type RunOut = { desk: Desk; snaps: Snap[]; result: CmdResult };

type RunFn = (desk: Desk, cmd: string, snaps: Snap[], stepId: string) => RunOut | Promise<RunOut>;

type Waiter = { promise: Promise<void>; cancel: () => void };

export type SuperviseOpts = {
  wallMs?: number;
  idleMs?: number;
  maxStdout?: number;
  maxSteps?: number;
  maxCmdChars?: number;
  run?: RunFn;
  wait?: (ms: number) => Waiter;
};

const WALL_MS = 8000;
const IDLE_MS = 2500;
const MAX_STDOUT = 120_000;
const MAX_STEPS = 8;
const MAX_CMD = 80_000;

function defaultWait(ms: number): Waiter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function killed(cmd: string, desk: Desk, snaps: Snap[], stdout: string, why: string): RunOut {
  return {
    desk,
    snaps,
    result: {
      cmd,
      code: 124,
      stdout: stdout.slice(0, 4000),
      stderr: `killed: ${why}`,
      meta: "killed",
    },
  };
}

function isKill(outcome: RunOut | { why: string }): outcome is { why: string } {
  return "why" in outcome && !("result" in outcome);
}

function heredocOpen(part: string): boolean {
  let open = false;
  for (const line of part.split("\n")) {
    if (open) {
      if (line.trim() === "EOF") open = false;
      continue;
    }
    if (/<<EOF\s*$/.test(line)) open = true;
  }
  return open;
}

async function raceStep(
  work: Promise<RunOut>,
  idleMs: number,
  wallLeft: number,
  wait: (ms: number) => Waiter,
): Promise<RunOut | { why: string }> {
  const idle = wait(Math.max(0, idleMs));
  const wall = wait(Math.max(0, wallLeft));
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: RunOut | { why: string }) => {
      if (settled) return;
      settled = true;
      idle.cancel();
      wall.cancel();
      resolve(value);
    };
    work.then(
      (ran) => finish(ran),
      (err) => finish({ why: err instanceof Error ? err.message : String(err) }),
    );
    idle.promise.then(() => finish({ why: "no output" }));
    wall.promise.then(() => finish({ why: "wall time" }));
  });
}

/** Run a script one command at a time. Silence or a long stall kills it and returns control. */
export async function supervise(
  desk: Desk,
  cmd: string,
  snaps: Snap[],
  stepId: string,
  opts: SuperviseOpts = {},
): Promise<RunOut> {
  const wallMs = opts.wallMs ?? WALL_MS;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const maxStdout = opts.maxStdout ?? MAX_STDOUT;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const maxCmdChars = opts.maxCmdChars ?? MAX_CMD;
  const run = opts.run ?? runCommand;
  const wait = opts.wait ?? defaultWait;
  const raw = cmd.replace(/\r\n/g, "\n").trim();
  if (raw.length > maxCmdChars) return killed(raw, desk, snaps, "", "command too large");
  let parts: string[];
  try {
    parts = splitScript(raw);
  } catch (err) {
    return killed(raw, desk, snaps, "", err instanceof Error ? err.message : String(err));
  }
  if (!parts.length) return killed(raw, desk, snaps, "", "empty command");
  if (parts.length > maxSteps) return killed(raw, desk, snaps, "", `more than ${maxSteps} commands`);
  if (parts.some(heredocOpen)) return killed(raw, desk, snaps, "", "unclosed heredoc");

  const started = Date.now();
  let nextDesk = desk;
  let nextSnaps = snaps;
  const outs: string[] = [];
  for (const part of parts) {
    const wallLeft = wallMs - (Date.now() - started);
    if (wallLeft <= 0) return killed(raw, nextDesk, nextSnaps, outs.join("\n"), "wall time");
    let ran: RunOut;
    try {
      const work = Promise.resolve(run(nextDesk, part, nextSnaps, stepId));
      const outcome = await raceStep(work, idleMs, wallLeft, wait);
      if (isKill(outcome)) return killed(raw, nextDesk, nextSnaps, outs.join("\n"), outcome.why);
      ran = outcome;
    } catch (err) {
      return killed(raw, nextDesk, nextSnaps, outs.join("\n"), err instanceof Error ? err.message : String(err));
    }
    nextDesk = ran.desk;
    nextSnaps = ran.snaps;
    if (ran.result.code !== 0) {
      return {
        desk: nextDesk,
        snaps: nextSnaps,
        result: {
          cmd: raw,
          code: ran.result.code,
          stdout: [...outs, ran.result.stdout].filter(Boolean).join("\n").slice(0, 4000),
          stderr: ran.result.stderr,
          meta: ran.result.meta || "error",
        },
      };
    }
    outs.push(ran.result.stdout);
    if (!ran.result.stdout.trim()) return killed(raw, nextDesk, nextSnaps, outs.join("\n"), "no output");
    if (outs.join("\n").length > maxStdout) return killed(raw, nextDesk, nextSnaps, outs.join("\n"), "output cap");
  }
  const stdout = outs.join("\n");
  return {
    desk: nextDesk,
    snaps: nextSnaps,
    result: { cmd: raw, code: 0, stdout, stderr: "", meta: "ok" },
  };
}

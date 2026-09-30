export type Phase = "idle" | "review" | "run" | "done";

export type StepStatus = "todo" | "run" | "ok" | "fail" | "skip";

export type Step = {
  id: string;
  do: string;
  cmd: string | null;
  rollback: boolean;
  status: StepStatus;
  expect: string;
};

export type LoopState = {
  goal: string;
  phase: Phase;
  cursor: number;
  steps: Step[];
  facts: string[];
  log: string[];
};

export type DiffOp =
  | { op: "goal"; text: string }
  | { op: "fact"; text: string }
  | { op: "drop"; match: string }
  | { op: "log"; text: string }
  | { op: "plan"; steps: RawStep[] }
  | { op: "step"; id: string; status: StepStatus; cmd?: string | null }
  | { op: "clear-plan" }
  | { op: "cursor"; n: number }
  | { op: "phase"; phase: Phase };

export type RawStep = {
  id?: string;
  do: string;
  cmd?: string | null;
  rollback?: boolean;
  status?: StepStatus;
  expect?: string;
};

export type Act =
  | null
  | { type: "cmd"; cmd: string; why: string }
  | { type: "ask"; q: string }
  | { type: "done" };

export type AgentReply = {
  say: string;
  diff: DiffOp[];
  act: Act;
  verdict?: { ok: boolean; why: string; rollback: boolean };
};

export type AgentEvent =
  | { kind: "user"; text: string; forcePlan: boolean }
  | { kind: "fold"; cmd: string; meta: string; chunk: string; index: number; total: number }
  | { kind: "continue"; stepId: string }
  | { kind: "refine"; text: string }
  | { kind: "denied"; cmd: string; stepId: string | null }
  | { kind: "check"; stepId: string; text: string; code: number };

export type Desk = {
  files: Record<string, string>;
  bins: Record<string, string>;
};

export type Snap = {
  stepId: string;
  path: string;
  kind: "file" | "bin";
  before: string | null;
};

export type CmdResult = {
  cmd: string;
  code: number;
  stdout: string;
  stderr: string;
  meta: string;
};

export type PackedOutput = {
  meta: string;
  parts: string[];
};

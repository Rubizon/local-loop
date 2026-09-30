import { useEffect, useRef, useState } from "react";
import { Download, Play, RotateCcw } from "lucide-react";
import { Markup, Report } from "@/components/markup";
import { Button } from "@/components/ui/button";
import { looksLikeMarkup } from "@/lib/loop/markup";
import { buildPacket, heuristicReply } from "@/lib/loop/agent";
import { deskPaths, pdfToBytes, packOutput, seedDesk } from "@/lib/loop/desk";
import { supervise } from "@/lib/loop/proc";
import { cancelPlan, abortOffPlan, finishStep, startPlan, stepEvidence, undoFrom, type PendingCmd } from "@/lib/loop/session";
import { applyReply, emptyState, isKeep, normalizeState, parseState, serialize, setStepCmd, visibleAct } from "@/lib/loop/state";
import { agentTurn } from "@/lib/loop/turn";
import type { AgentEvent, AgentReply, Desk, LoopState, Snap, Step } from "@/lib/loop/types";
import { cn } from "@/lib/utils";

const STORE = "loop.v3";

const EXAMPLES = [
  { label: "Summarize the inbox", text: "Summarize the inbox notes" },
  { label: "Summarize inbox to PDF", text: "Read the inbox notes, summarize them, and write a PDF." },
  { label: "List the inbox", text: "List the inbox files" },
  { label: "What Friday decided", text: "What did Friday decide?" },
];

type Trace = { who: "you" | "loop" | "run"; text: string };
type OutputView = { meta: string; text: string };

function loadStore(): { state: LoopState; desk: Desk; snaps: Snap[]; trace: Trace[]; forcePlan: boolean } | null {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const p = JSON.parse(raw) as {
      state?: LoopState;
      desk?: Desk;
      snaps?: Snap[];
      trace?: Trace[];
      forcePlan?: boolean;
    };
    if (!p.state || !p.desk) return null;
    return {
      state: normalizeState(p.state),
      desk: { files: p.desk.files || {}, bins: p.desk.bins || {} },
      snaps: Array.isArray(p.snaps) ? p.snaps : [],
      trace: Array.isArray(p.trace) ? p.trace.slice(-40) : [],
      forcePlan: Boolean(p.forcePlan),
    };
  } catch {
    return null;
  }
}

function pendingFrom(state: LoopState): PendingCmd | null {
  if (state.phase !== "run") return null;
  const step = state.steps[state.cursor];
  if (step?.status === "run" && step.cmd) return { cmd: step.cmd, why: step.do, stepId: step.id };
  return null;
}

async function askAgent(state: LoopState, event: AgentEvent, desk: Desk): Promise<AgentReply> {
  const known = heuristicReply(state, event, desk);
  if (known) return known;
  const res = await agentTurn({ data: { state, event, desk } });
  if (!res.ok) throw new Error(res.error);
  return res.reply;
}

export function LoopApp() {
  const [state, setState] = useState<LoopState>(emptyState);
  const [desk, setDesk] = useState<Desk>(seedDesk);
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [trace, setTrace] = useState<Trace[]>([]);
  const [headline, setHeadline] = useState("");
  const [pending, setPending] = useState<PendingCmd | null>(null);
  const [ask, setAsk] = useState<string | null>(null);
  const [askDraft, setAskDraft] = useState("");
  const [input, setInput] = useState("");
  const [forcePlan, setForcePlan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [lastOutput, setLastOutput] = useState<OutputView | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const saved = loadStore();
    if (saved) {
      setState(saved.state);
      setDesk(saved.desk);
      setSnaps(saved.snaps);
      setTrace(saved.trace);
      setForcePlan(saved.forcePlan);
      setPending(pendingFrom(saved.state));
      setHeadline(saved.state.goal ? saved.state.log.at(-1) || "" : "");
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORE, JSON.stringify({ state, desk, snaps, trace: trace.slice(-40), forcePlan }));
  }, [state, desk, snaps, trace, forcePlan, hydrated]);

  function pushTrace(item: Trace) {
    setTrace((t) => [...t, item].slice(-40));
  }

  function reset() {
    setState(emptyState());
    setDesk(seedDesk());
    setSnaps([]);
    setTrace([]);
    setHeadline("");
    setPending(null);
    setAsk(null);
    setAskDraft("");
    setInput("");
    setLastOutput(null);
    setEditing(false);
    setEditError("");
    setPreviewPath(null);
  }

  async function emit(base: LoopState, stepId: string, files: Desk) {
    const reply = await askAgent(base, { kind: "continue", stepId }, files);
    let cur = applyReply(base, reply, { allowPlan: false, wipeWithoutGoal: false });
    setHeadline(reply.say);
    pushTrace({ who: "loop", text: reply.say });
    if (reply.act?.type === "cmd") {
      cur = setStepCmd(cur, stepId, reply.act.cmd);
      setState(cur);
      setPending({ cmd: reply.act.cmd, why: reply.act.why, stepId });
      return;
    }
    if (reply.act?.type === "ask") {
      setState(cur);
      setAsk(reply.act.q);
      return;
    }
    setState(reply.act?.type === "done" ? { ...cur, phase: "done" } : cur);
  }

  async function send(text = input) {
    const t = text.trim();
    if (!t || busy) return;
    if (state.phase === "run") {
      setHeadline("Cancel the run before starting something else.");
      return;
    }
    setInput("");
    setBusy(true);
    setPending(null);
    setAsk(null);
    pushTrace({ who: "you", text: t });
    try {
      if (state.phase === "review") {
        const reply = await askAgent(state, { kind: "refine", text: t }, desk);
        if (reply.diff.some((op) => op.op === "clear-plan")) {
          const rolled = cancelPlan(state, desk, snaps);
          setState(rolled.state);
          setDesk(rolled.desk);
          setSnaps(rolled.snaps);
        } else {
          setState(applyReply(state, reply, { allowPlan: true, wipeWithoutGoal: false }));
        }
        setHeadline(reply.say);
        pushTrace({ who: "loop", text: reply.say });
        if (reply.act?.type === "ask") setAsk(reply.act.q);
        return;
      }
      const base =
        state.phase === "done" || state.phase === "idle"
          ? { ...state, steps: [], cursor: 0, phase: "idle" as const }
          : state;
      const reply = await askAgent(base, { kind: "user", text: t, forcePlan }, desk);
      if (reply.diff.some((op) => op.op === "clear-plan")) {
        const rolled = cancelPlan(base, desk, snaps);
        setState(rolled.state);
        setDesk(rolled.desk);
        setSnaps(rolled.snaps);
      } else {
        const next = applyReply(base, reply, { allowPlan: true, wipeWithoutGoal: true });
        setState(next);
        const act = visibleAct(reply, next, true);
        if (act?.type === "cmd") setPending({ cmd: act.cmd, why: act.why, stepId: null });
        else if (act?.type === "ask") setAsk(act.q);
      }
      setHeadline(reply.say);
      pushTrace({ who: "loop", text: reply.say });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setHeadline(msg);
      pushTrace({ who: "loop", text: msg });
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (busy || state.phase !== "review") return;
    setBusy(true);
    try {
      const flow = startPlan(state);
      setState(flow.state);
      if (flow.pending) {
        setPending(flow.pending);
        setHeadline("Allow the first command.");
      } else if (flow.needEmit && flow.state.steps[0]) {
        setHeadline("Choosing the first command.");
        await emit(flow.state, flow.state.steps[0].id, desk);
      }
    } catch (e) {
      setHeadline(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function allow() {
    if (!pending || busy) return;
    const held = pending;
    setBusy(true);
    setPending(null);
    let liveDesk = desk;
    let liveSnaps = snaps;
    let settled = false;
    try {
      const stepId = held.stepId ?? "direct";
      const ran = await supervise(desk, held.cmd, snaps, stepId);
      liveDesk = ran.desk;
      liveSnaps = ran.snaps;
      setDesk(ran.desk);
      setSnaps(ran.snaps);
      const packed = ran.result.code === 0 ? packOutput(ran.result.stdout) : { meta: "error", parts: [ran.result.stderr] };
      const preview = packed.parts.join("\n\n").slice(0, 4000);
      setLastOutput({ meta: ran.result.code === 0 ? packed.meta : ran.result.meta || "error", text: preview });
      pushTrace({ who: "run", text: `$ ${ran.result.cmd.split("\n")[0]}\n${preview}` });
      if (ran.result.code !== 0) {
        const why = ran.result.stderr || "Command failed.";
        if (held.stepId) {
          const stopped = abortOffPlan(state, ran.desk, ran.snaps, held.stepId, { why, rollback: true });
          setState(stopped.state);
          setDesk(stopped.desk);
          setSnaps(stopped.snaps);
          setHeadline(stopped.say);
          pushTrace({ who: "loop", text: stopped.say });
        } else {
          setHeadline(why);
        }
        settled = true;
        return;
      }
      let cur = state;
      const folds = packed.parts.slice(0, 4);
      for (let i = 0; i < folds.length; i++) {
        const reply = await askAgent(
          cur,
          {
            kind: "fold",
            cmd: ran.result.cmd,
            meta: packed.meta,
            chunk: folds[i],
            index: i + 1,
            total: folds.length,
          },
          ran.desk,
        );
        cur = applyReply(cur, reply, { allowPlan: false, wipeWithoutGoal: false });
        setHeadline(reply.say);
        if (i === folds.length - 1) pushTrace({ who: "loop", text: reply.say });
      }
      if (!held.stepId) {
        setState(cur);
        settled = true;
        return;
      }
      const step = cur.steps.find((s) => s.id === held.stepId);
      if (step) {
        const evidence = stepEvidence(ran.result.cmd, ran.result.stdout, ran.desk);
        let verdict = { ok: false, why: "Check failed closed.", rollback: step.rollback };
        try {
          const checked = await askAgent(cur, { kind: "check", stepId: step.id, text: evidence.slice(0, 800), code: 0 }, ran.desk);
          if (checked.verdict) verdict = checked.verdict;
        } catch {
          verdict = { ok: false, why: "Check failed closed.", rollback: step.rollback };
        }
        if (!verdict.ok) {
          const stopped = abortOffPlan(cur, ran.desk, ran.snaps, step.id, {
            why: verdict.why,
            rollback: verdict.rollback || step.rollback,
          });
          setState(stopped.state);
          setDesk(stopped.desk);
          setSnaps(stopped.snaps);
          setHeadline(stopped.say);
          pushTrace({ who: "loop", text: stopped.say });
          settled = true;
          return;
        }
      }
      const flow = finishStep(cur, held.stepId, true);
      setState(flow.state);
      settled = true;
      if (flow.pending) setPending(flow.pending);
      else if (flow.needEmit) {
        const id = flow.state.steps[flow.state.cursor]?.id;
        if (id) await emit(flow.state, id, ran.desk);
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      if (!settled && held.stepId) {
        const stopped = abortOffPlan(state, liveDesk, liveSnaps, held.stepId, { why, rollback: true });
        setState(stopped.state);
        setDesk(stopped.desk);
        setSnaps(stopped.snaps);
        setHeadline(stopped.say);
        pushTrace({ who: "loop", text: stopped.say });
      } else {
        setHeadline(why);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    if (!pending || busy) return;
    const held = pending;
    setBusy(true);
    setPending(null);
    try {
      if (held.stepId) {
        const stopped = abortOffPlan(state, desk, snaps, held.stepId, {
          why: "Denied. That command did not run.",
          rollback: false,
        });
        setState(stopped.state);
        setHeadline(stopped.say);
        pushTrace({ who: "loop", text: stopped.say });
      } else {
        const reply = await askAgent(state, { kind: "denied", cmd: held.cmd, stepId: held.stepId }, desk);
        setState(applyReply(state, reply, { allowPlan: false, wipeWithoutGoal: false }));
        setHeadline(reply.say);
        pushTrace({ who: "loop", text: reply.say });
      }
    } catch (e) {
      setHeadline(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    const rolled = cancelPlan(state, desk, snaps);
    setState(rolled.state);
    setDesk(rolled.desk);
    setSnaps(rolled.snaps);
    setPending(null);
    setAsk(null);
    setHeadline("Plan cancelled. Writes from those steps were rolled back.");
  }

  function undo(step: Step) {
    const rolled = undoFrom(state, desk, snaps, step.id);
    setState(rolled.state);
    setDesk(rolled.desk);
    setSnaps(rolled.snaps);
    const cmd = rolled.state.steps.find((s) => s.id === step.id);
    setPending(cmd?.cmd ? { cmd: cmd.cmd, why: cmd.do, stepId: cmd.id } : null);
    setHeadline(`Rolled back from ${step.do}.`);
  }

  function applyEdit() {
    try {
      const parsed = parseState(draft);
      setState(parsed);
      setPending(pendingFrom(parsed));
      setEditing(false);
      setEditError("");
      setHeadline("State replaced.");
    } catch (e) {
      setEditError(e instanceof Error ? e.message : String(e));
    }
  }

  function download(path: string) {
    const name = path.split("/").pop() || "file";
    const bin = desk.bins[path];
    const bytes = bin ? pdfToBytes(bin) : null;
    const blob = bytes
      ? new Blob([Uint8Array.from(bytes)], { type: "application/pdf" })
      : new Blob([desk.files[path] || ""], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  const phaseLabel =
    state.phase === "review" ? "Plan" : state.phase === "run" ? `Step ${state.cursor + 1}` : state.phase === "done" ? "Done" : "Ready";
  const paths = deskPaths(desk);
  const budget = buildPacket(
    state,
    state.phase === "review"
      ? { kind: "refine", text: input.trim() || "note" }
      : { kind: "user", text: input.trim() || "note", forcePlan },
    desk,
  ).tokens;

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 border-b border-border bg-bg">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-4 pt-6 pb-4">
          <div>
            <h1 className="font-display text-4xl leading-none tracking-tight">Loop</h1>
            <p className="mt-2 max-w-md text-sm leading-normal text-muted">
              One state. The model never sees the chat. Every command waits for you.
            </p>
            <p className="mt-3 max-w-xl text-sm leading-normal text-muted">
              <span className="text-faint">Goal · </span>
              {state.goal || "none"}
            </p>
          </div>
          <Button variant="outline" onClick={reset} disabled={busy}>
            <RotateCcw className="size-4" />
            Reset
          </Button>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-4 px-4 pt-4 pb-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <aside className="order-2 min-w-0 lg:sticky lg:top-28 lg:max-h-[calc(100dvh-8rem)] lg:overflow-auto">
          <section className="rounded-xl border border-border bg-elevated p-2">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <h2 className="text-sm font-medium">State</h2>
              <span className="text-xs text-faint">{phaseLabel}</span>
            </div>
            {editing ? (
              <div className="px-2 pb-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="min-h-80 w-full rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-normal text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {editError ? <p className="px-1 pt-2 text-sm text-danger">{editError}</p> : null}
                <div className="flex gap-2 pt-2">
                  <Button onClick={applyEdit}>Apply</Button>
                  <Button variant="outline" onClick={() => setEditing(false)}>
                    Close
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 px-3 pb-3">
                <StateBlock title="Goal" body={state.goal || "No goal yet. Until there is one, chatter is not kept."} />
                <div>
                  <h3 className="text-xs font-medium text-faint">Plan</h3>
                  {state.steps.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">No plan. Direct mode.</p>
                  ) : (
                    <ol className="mt-2 space-y-2">
                      {state.steps.map((step, i) => (
                        <li key={step.id} className="text-sm">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className={cn(i === state.cursor && state.phase === "run" ? "text-fg" : "text-muted")}>
                              {step.id}. {step.do}
                            </span>
                            <span className={cn("shrink-0 text-xs", statusClass(step.status))}>{step.status}</span>
                          </div>
                          {step.expect ? <p className="text-xs text-faint">expect {step.expect}</p> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <div>
                  <h3 className="text-xs font-medium text-faint">Facts</h3>
                  {state.facts.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">Empty.</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {state.facts.map((fact) => (
                        <li key={fact} className={cn("text-sm leading-normal", isKeep(fact) ? "font-medium text-fg" : "text-muted")}>
                          {fact}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="text-xs font-medium text-faint">Log</h3>
                  {state.log.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">Empty.</p>
                  ) : (
                    <ul className="mt-2 space-y-1">
                      {state.log.map((line, i) => (
                        <li key={`${i}-${line}`} className="text-sm text-muted">
                          {line}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraft(serialize(state));
                    setEditError("");
                    setEditing(true);
                  }}
                >
                  Edit state
                </Button>
                <p className="text-xs leading-normal text-faint">
                  Edit to force a failure. KEEP lines survive a drop unless the match names KEEP. Reset restores the desk.
                </p>
              </div>
            )}
          </section>

          <section className="mt-4 rounded-xl border border-border bg-elevated p-2">
            <h2 className="px-3 py-2 text-sm font-medium">Desk</h2>
            <ul className="px-2 pb-2">
              {paths.map((path) => (
                <li key={path} className="rounded-lg">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="min-h-11 flex-1 truncate px-2 text-left font-mono text-xs text-muted hover:text-fg"
                      onClick={() => setPreviewPath(previewPath === path ? null : path)}
                    >
                      {path}
                    </button>
                    <Button variant="ghost" size="icon" onClick={() => download(path)} aria-label={`Download ${path}`}>
                      <Download className="size-4" />
                    </Button>
                  </div>
                  {previewPath === path ? (
                    <pre className="max-h-40 overflow-auto px-2 pb-3 font-mono text-xs leading-normal whitespace-pre-wrap text-muted">
                      {desk.files[path] || (desk.bins[path] ? "PDF on the desk." : "")}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="order-1 min-w-0 space-y-4">
          <section className="rounded-xl border border-border bg-elevated p-2">
            <div className="px-3 pt-3 pb-1">
              <p className="text-xs font-medium text-faint">{phaseLabel}</p>
              {headline ? <Report text={headline} /> : null}
            </div>

            {state.phase === "review" && state.steps.length > 0 ? (
              <div className="px-3 pt-3">
                <ol className="space-y-3">
                  {state.steps.map((step) => (
                    <li key={step.id} className="rounded-lg border border-border bg-bg px-3 py-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-sm font-medium">
                          {step.id}. {step.do}
                        </p>
                        <span className="text-xs text-faint">
                          {/\n(?:ls|cat|put|pdf)\b/.test(step.cmd || "") || (!step.cmd && / and /i.test(step.do))
                            ? "batch"
                            : "stop"}
                          {step.rollback ? " · rollback" : ""}
                        </span>
                      </div>
                      <pre className="mt-2 max-h-24 overflow-auto font-mono text-xs leading-normal whitespace-pre-wrap text-muted">
                        {step.cmd || "Command is chosen when this step starts."}
                      </pre>
                      {step.expect ? <p className="mt-2 text-xs text-faint">expect {step.expect}</p> : null}
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-2 py-3">
                  <Button onClick={execute} disabled={busy}>
                    <Play className="size-4" />
                    Execute
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => composerRef.current?.focus()}>
                    Refine
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={cancel}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {pending ? (
              <div className="px-3 py-3">
                <p className="text-sm font-medium">
                  {/\n(?:ls|cat|put|pdf)\b/.test(pending.cmd) ? "Allow this script" : "Allow this command"}
                </p>
                <p className="mt-1 text-sm text-muted">{pending.why}</p>
                <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-normal whitespace-pre-wrap text-fg">
                  {pending.cmd}
                </pre>
                <div className="flex flex-wrap gap-2 pt-3">
                  <Button onClick={allow} disabled={busy}>
                    Allow
                  </Button>
                  <Button variant="outline" onClick={deny} disabled={busy}>
                    Deny
                  </Button>
                  {pending.stepId ? (
                    <Button variant="ghost" onClick={cancel} disabled={busy}>
                      Cancel plan
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {ask ? (
              <form
                className="px-3 py-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const answer = askDraft.trim();
                  if (!answer) return;
                  setAskDraft("");
                  setAsk(null);
                  void send(answer);
                }}
              >
                {looksLikeMarkup(ask) ? <Markup text={ask} /> : <p className="text-sm font-medium">{ask}</p>}
                {state.phase === "review" ? (
                  <p className="mt-1 text-sm text-muted">This answer updates the plan.</p>
                ) : null}
                <div className="mt-3 flex gap-2">
                  <input
                    value={askDraft}
                    onChange={(e) => setAskDraft(e.target.value)}
                    className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button type="submit" disabled={busy || !askDraft.trim()}>
                    Answer
                  </Button>
                </div>
              </form>
            ) : null}

            {state.phase === "run" && !pending && !ask ? (
              <div className="flex flex-wrap gap-2 px-3 pb-3">
                <Button variant="ghost" disabled={busy} onClick={cancel}>
                  Cancel plan
                </Button>
                {state.steps
                  .filter((step) => snaps.some((s) => s.stepId === step.id))
                  .map((step) => (
                    <Button key={step.id} variant="ghost" size="sm" disabled={busy} onClick={() => undo(step)}>
                      Undo {step.id}
                    </Button>
                  ))}
              </div>
            ) : null}

            {!headline && state.phase === "idle" && !pending ? (
              <div className="px-3 pt-2 pb-3">
                <p className="text-sm leading-normal text-muted">
                  Try the inbox. Loop will show a plan before it reads anything. Or ask for one command.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {EXAMPLES.map((ex) => (
                    <Button key={ex.label} variant="outline" disabled={busy} onClick={() => void send(ex.text)}>
                      {ex.label}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {trace.length > 0 ? (
            <section className="rounded-xl border border-border bg-elevated p-2">
              <h2 className="px-3 py-2 text-xs font-medium text-faint">Trace</h2>
              <ul className="max-h-52 space-y-2 overflow-auto px-3 pb-3">
                {trace.slice(-8).map((item, i) => (
                  <li key={`${i}-${item.who}`} className="text-sm leading-normal">
                    <span className="text-faint">{item.who === "you" ? "You" : item.who === "run" ? "Ran" : "Loop"} · </span>
                    {item.who === "loop" && looksLikeMarkup(item.text) ? (
                      <Markup text={item.text} />
                    ) : (
                      <span className="whitespace-pre-wrap text-muted">{item.text}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {lastOutput ? (
            <details className="rounded-xl border border-border bg-elevated p-3">
              <summary className="cursor-pointer text-sm text-muted">Last output · {lastOutput.meta}</summary>
              <pre className="mt-3 max-h-48 overflow-auto font-mono text-xs leading-normal whitespace-pre-wrap text-muted">
                {lastOutput.text}
              </pre>
            </details>
          ) : null}

          <form
            className="rounded-xl border border-border bg-elevated p-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={composerRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={state.phase === "review" ? "Refine the plan" : "What should Loop do?"}
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-3 text-sm leading-normal text-fg placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-2 pb-1">
              <Button
                type="button"
                variant={forcePlan ? "default" : "outline"}
                aria-pressed={forcePlan}
                onClick={() => setForcePlan((v) => !v)}
              >
                Plan
              </Button>
              <Button type="submit" disabled={busy || !input.trim()}>
                {busy ? "Working" : state.phase === "review" ? "Refine" : "Send"}
              </Button>
            </div>
            <p className="px-2 pb-2 text-xs leading-normal text-faint">
              {forcePlan
                ? `Plan is forced. ~${budget} tok before the review.`
                : `Direct unless a plan comes back. ~${budget} tok. Output is folded, not kept in the chat.`}
            </p>
          </form>
        </main>
      </div>
    </div>
  );
}

function StateBlock({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-faint">{title}</h3>
      <p className="mt-1 text-sm leading-normal text-muted">{body}</p>
    </div>
  );
}

function statusClass(status: Step["status"]): string {
  if (status === "ok") return "text-ok";
  if (status === "fail") return "text-danger";
  if (status === "run") return "text-fg";
  return "text-faint";
}

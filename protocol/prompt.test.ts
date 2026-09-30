import assert from "node:assert/strict";
import test from "node:test";
import { buildPacket, heuristicReply, parseReply, safeCmd, SYS_CHECK, SYS_FOLD, SYS_USER } from "./agent.ts";
import {
  harvestFacts,
  makePdf,
  packOutput,
  pdfToBytes,
  rollbackAll,
  runCommand,
  seedDesk,
  summarizeNotes,
} from "./desk.ts";
import { abortOffPlan, assessStep, cancelPlan, finishStep, startPlan, stepEvidence } from "./session.ts";
import { supervise } from "./proc.ts";
import { applyReply, emptyState, isKeep, normalizeState, parseState, serialize } from "./state.ts";

const brief = "Read the inbox notes, summarize them, and write a PDF.";

test("prompts are short and one job each", () => {
  assert.ok(SYS_FOLD.length < 320);
  assert.match(SYS_FOLD, /No plan/);
  assert.ok(SYS_USER.length < 700);
  const desk = seedDesk();
  const fold = buildPacket(
    { ...emptyState(), goal: "List the inbox", facts: ["KEEP file monday.txt", "noise"], log: ["should stay out"] },
    { kind: "fold", cmd: "cat /demo/inbox/friday.txt", meta: "full · 20 chars", chunk: "Ship the brief.", index: 1, total: 1 },
    desk,
  );
  assert.equal(fold.system, SYS_FOLD);
  assert.doesNotMatch(fold.user, /DESK PATHS|should stay out|noise/);
  assert.match(fold.user, /KEEP file monday.txt/);
  assert.ok(fold.tokens < 120);
  const listed = buildPacket(emptyState(), { kind: "user", text: "List the inbox files", forcePlan: false }, desk);
  assert.ok(listed.tokens < 250);
});

test("flat replies, trailing commas, and unsafe commands", () => {
  const flat = parseReply(
    '{"say":"listing","goal":"List the inbox","add":["KEEP file a.txt"],"cmd":"ls /demo/inbox","why":"list","plan":null,}',
  );
  assert.equal(flat.act?.type, "cmd");
  assert.equal(flat.diff.some((op) => op.op === "goal"), true);
  assert.ok(flat.diff.some((op) => op.op === "fact" && op.text.includes("a.txt")));
  const qwen = parseReply(
    '{ "say": "Here are the files in the inbox:", "goal": "List the inbox files", "add": [], "cmd": "ls", "why": "list", "plan": null } ```',
  );
  assert.equal(qwen.act && qwen.act.type === "cmd" ? qwen.act.cmd : "", "ls /demo/inbox");
  assert.equal(qwen.diff.some((op) => op.op === "plan"), false);
  const bad = parseReply('{"say":"no","cmd":"rm -rf /"}');
  assert.equal(bad.act?.type, "ask");
  assert.equal(safeCmd("cat ../secret"), null);
  const folded = parseReply(
    '{"say":"kept","add":["KEEP freeze"],"cmd":"ls /demo","plan":[{"do":"sneak","cmd":"ls /demo"}]}',
    "fold",
  );
  assert.equal(folded.act, null);
  assert.equal(folded.diff.some((op) => op.op === "plan"), false);
  assert.equal(folded.diff.some((op) => op.op === "fact"), true);
});

test("state roundtrip and KEEP drop rules", () => {
  const state = applyReply(
    emptyState(),
    {
      say: "ok",
      diff: [
        { op: "goal", text: "Keep the brief" },
        { op: "fact", text: "KEEP budget 400" },
        { op: "fact", text: "temp note" },
        { op: "log", text: "started" },
        { op: "plan", steps: [{ id: "1", do: "List", cmd: "ls /demo/inbox", rollback: false }] },
      ],
      act: null,
    },
    { allowPlan: true, wipeWithoutGoal: true },
  );
  assert.equal(state.phase, "review");
  const again = parseState(serialize(state));
  assert.equal(again.goal, state.goal);
  assert.equal(again.steps[0].cmd, "ls /demo/inbox");
  const saved = normalizeState({
    goal: "Keep",
    phase: "run",
    steps: [{ id: "1", do: "Read | notes", cmd: null, rollback: false, status: "todo", expect: "" }],
  });
  assert.equal(saved.steps[0].expect, "");
  const round = parseState(serialize(saved));
  assert.equal(round.steps[0].do, "Read / notes");
  assert.equal(again.facts[0], "KEEP budget 400");

  const kept = applyReply(state, { say: "", diff: [{ op: "drop", match: "budget" }], act: null }, {
    allowPlan: false,
    wipeWithoutGoal: false,
  });
  assert.equal(kept.facts.some(isKeep), true);

  const dropped = applyReply(state, { say: "", diff: [{ op: "drop", match: "KEEP budget" }], act: null }, {
    allowPlan: false,
    wipeWithoutGoal: false,
  });
  assert.equal(dropped.facts.some((f) => /budget/.test(f)), false);
});

test("no goal wipes chatter but not KEEP", () => {
  const state = applyReply(
    emptyState(),
    {
      say: "hi",
      diff: [
        { op: "goal", text: "" },
        { op: "fact", text: "KEEP stay" },
        { op: "fact", text: "chatter" },
        { op: "log", text: "noise" },
      ],
      act: null,
    },
    { allowPlan: true, wipeWithoutGoal: true },
  );
  assert.deepEqual(state.facts, ["KEEP stay"]);
  assert.equal(state.log.length, 0);
  assert.equal(state.phase, "idle");
});

test("fold cannot introduce a plan", () => {
  const state = applyReply(
    { ...emptyState(), goal: "List the inbox" },
    {
      say: "no",
      diff: [{ op: "plan", steps: [{ do: "sneak", cmd: "ls /demo" }] }, { op: "fact", text: "KEEP file monday.txt" }],
      act: { type: "cmd", cmd: "ls /demo", why: "no" },
    },
    { allowPlan: false, wipeWithoutGoal: false },
  );
  assert.equal(state.steps.length, 0);
  assert.equal(state.facts[0], "KEEP file monday.txt");
});

test("task tree from the model enters review and holds the command", () => {
  const reply = parseReply(
    '{"say":"plan","steps":[{"do":"list","cmd":"ls /demo/inbox"},{"do":"read","cmd":"cat /demo/inbox/friday.txt"}],"act":{"type":"cmd","cmd":"ls /demo/inbox","why":"now"}}',
  );
  const state = applyReply(emptyState(), reply, { allowPlan: true, wipeWithoutGoal: true });
  assert.equal(state.phase, "review");
  assert.equal(state.steps.length, 2);
  assert.equal(reply.act, null);
});

test("direct list is one command; Plan toggle makes a tree", () => {
  const desk = seedDesk();
  const direct = heuristicReply(emptyState(), { kind: "user", text: "List the inbox files", forcePlan: false }, desk);
  assert.equal(direct?.act?.type, "cmd");
  const planned = heuristicReply(emptyState(), { kind: "user", text: "List the inbox files", forcePlan: true }, desk);
  const state = applyReply(emptyState(), planned!, { allowPlan: true, wipeWithoutGoal: true });
  assert.equal(state.phase, "review");
  assert.equal(planned?.act, null);
});

test("large output is marked compressed or chunked", () => {
  const mid = packOutput("x".repeat(9000));
  assert.match(mid.meta, /compressed/);
  assert.equal(mid.parts.length, 1);
  const big = packOutput("y".repeat(25000));
  assert.match(big.meta, /chunked/);
  assert.match(big.meta, /accumulate-summarize/);
  assert.equal(big.parts.length, 4);
});

test("inbox plan runs, folds, writes a pdf, and rolls back", () => {
  const desk0 = seedDesk();
  const first = heuristicReply(emptyState(), { kind: "user", text: brief, forcePlan: false }, desk0);
  assert.ok(first);
  let state = applyReply(emptyState(), first, { allowPlan: true, wipeWithoutGoal: true });
  assert.equal(state.phase, "review");
  assert.equal(state.steps.length, 2);
  assert.equal(state.steps[1].cmd, null);
  assert.match(state.steps[0].cmd || "", /^cat /);

  let flow = startPlan(state);
  state = flow.state;
  let desk = desk0;
  let snaps = [] as ReturnType<typeof runCommand>["snaps"];

  const runFold = (cmd: string, stepId: string) => {
    const ran = runCommand(desk, cmd, snaps, stepId);
    assert.equal(ran.result.code, 0, ran.result.stderr);
    desk = ran.desk;
    snaps = ran.snaps;
    const packed = packOutput(ran.result.stdout);
    const fold = heuristicReply(
      state,
      { kind: "fold", cmd: ran.result.cmd, meta: packed.meta, chunk: packed.parts[0], index: 1, total: packed.parts.length },
      desk,
    );
    assert.ok(fold);
    assert.equal(fold.act, null);
    state = applyReply(state, fold, { allowPlan: false, wipeWithoutGoal: false });
    assert.equal(state.phase === "review", false);
    return ran;
  };

  assert.ok(flow.pending);
  const read = runFold(flow.pending.cmd, flow.pending.stepId!);
  assert.match(read.result.stdout, /freeze features/);
  flow = finishStep(state, "1", true);
  state = flow.state;
  assert.equal(flow.needEmit, true);

  const emit = heuristicReply(state, { kind: "continue", stepId: "2" }, desk);
  assert.equal(emit?.act?.type, "cmd");
  if (emit?.act?.type !== "cmd") return;
  assert.match(emit.act.cmd, /^put /);
  assert.match(emit.act.cmd, /\npdf /);
  const wrote = runFold(emit.act.cmd, "2");
  assert.match(wrote.result.stdout, /summary\.txt/);
  assert.match(wrote.result.stdout, /brief\.pdf/);
  assert.match(desk.files["/demo/out/summary.txt"], /print budget 400/);
  const pdf = pdfToBytes(desk.bins["/demo/out/brief.pdf"]);
  assert.equal(String.fromCharCode(...pdf.slice(0, 5)), "%PDF-");
  assert.match(new TextDecoder().decode(pdf), /feature freeze/);
  const last = finishStep(state, "2", true);
  assert.equal(last.done, true);
  assert.equal(last.state.phase, "done");

  const undone = cancelPlan({ ...last.state, phase: "run" }, desk, snaps);
  assert.equal(undone.desk.files["/demo/out/summary.txt"], undefined);
  assert.equal(undone.desk.bins["/demo/out/brief.pdf"], undefined);
  assert.ok(undone.desk.files["/demo/inbox/monday.txt"]);
});

test("friday answer is folded from the file, not invented", () => {
  const desk = seedDesk();
  const ask = heuristicReply(emptyState(), { kind: "user", text: "What did Friday decide?", forcePlan: false }, desk);
  assert.equal(ask?.act?.type, "cmd");
  if (ask?.act?.type !== "cmd") return;
  const ran = runCommand(desk, ask.act.cmd, [], "direct");
  const fold = heuristicReply(
    emptyState(),
    { kind: "fold", cmd: ran.result.cmd, meta: ran.result.meta, chunk: ran.result.stdout, index: 1, total: 1 },
    desk,
  );
  assert.match(fold?.say || "", /one-page PDF/);
  assert.ok(harvestFacts(ran.result.stdout).some((f) => /freeze|400|timeout|PDF/i.test(f)));
});

test("refused paths and a real pdf header", () => {
  const ran = runCommand(seedDesk(), "cat ../src/routes/index.tsx", [], "direct");
  assert.notEqual(ran.result.code, 0);
  const pdf = makePdf("Hello freeze");
  assert.match(new TextDecoder().decode(pdfToBytes(pdf.base64)), /Hello freeze/);
  assert.match(summarizeNotes(seedDesk().files), /Inbox brief/);
});

test("a step off the plan aborts and rolls back its writes", () => {
  assert.match(SYS_CHECK, /ok is 0/);
  const planned = heuristicReply(emptyState(), { kind: "user", text: brief, forcePlan: false }, seedDesk());
  const state = applyReply(emptyState(), planned!, { allowPlan: true, wipeWithoutGoal: true });
  const read = state.steps[0];
  const cat = runCommand(seedDesk(), read.cmd || "", [], "1");
  const onPlan = assessStep(read, stepEvidence(cat.result.cmd, cat.result.stdout, cat.desk), 0);
  assert.equal(onPlan.ok && onPlan.sure, true);
  const missed = assessStep({ cmd: "ls /demo/inbox", expect: "monday.txt, tuesday.txt", rollback: false }, "(empty)", 0);
  assert.equal(missed.ok, false);
  assert.equal(missed.sure, true);

  const write = state.steps.find((step) => /summary/i.test(step.do));
  assert.ok(write);
  const bad = runCommand(seedDesk(), "put /demo/out/summary.txt <<EOF\nhello\nEOF", [], write.id);
  const off = assessStep(write, stepEvidence(bad.result.cmd, bad.result.stdout, bad.desk), 0);
  assert.equal(off.ok, false);
  const stopped = abortOffPlan({ ...state, phase: "run" }, bad.desk, bad.snaps, write.id, { why: off.why, rollback: true });
  assert.equal(stopped.desk.files["/demo/out/summary.txt"], undefined);
  assert.match(stopped.desk.files["/demo/inbox/friday.txt"], /one-page PDF/);
  assert.equal(stopped.state.steps.find((s) => s.id === write.id)?.status, "fail");
  assert.ok(stopped.state.steps.some((s) => s.do.startsWith("Undo /demo/out/summary.txt") && s.status === "ok"));
  assert.match(stopped.say, /Rolled back/);

  const checked = parseReply('{"ok":0,"why":"missing freeze","rollback":1,"cmd":"rm -rf /"}', "check");
  assert.equal(checked.verdict?.ok, false);
  assert.equal(checked.verdict?.rollback, true);
  assert.equal(checked.act, null);
  const unsure = buildPacket(state, { kind: "check", stepId: "2", text: "hello", code: 0 }, seedDesk());
  assert.equal(unsure.system, SYS_CHECK);
  assert.match(unsure.user, /feature freeze/);
  const script = "put /demo/out/summary.txt <<EOF\nHello freeze\nEOF\npdf /demo/missing.txt /demo/out/brief.pdf";
  const broke = runCommand(seedDesk(), script, [], "2");
  assert.notEqual(broke.result.code, 0);
  assert.match(broke.desk.files["/demo/out/summary.txt"] || "", /Hello freeze/);
  const rolled = abortOffPlan(state, broke.desk, broke.snaps, "2", { why: broke.result.stderr, rollback: true });
  assert.equal(rolled.desk.files["/demo/out/summary.txt"], undefined);
  assert.equal(safeCmd("put /demo/out/a.txt <<EOF\nno\nEOF\nrm -rf /"), null);
});

test("rollback of one step leaves the seed intact", () => {
  let desk = seedDesk();
  let snaps = [] as ReturnType<typeof runCommand>["snaps"];
  const ran = runCommand(desk, "put /demo/out/summary.txt <<EOF\nHello\nEOF", snaps, "3");
  desk = ran.desk;
  snaps = ran.snaps;
  const back = rollbackAll(desk, snaps);
  assert.equal(back.desk.files["/demo/out/summary.txt"], undefined);
  assert.match(back.desk.files["/demo/inbox/friday.txt"], /one-page PDF/);
});

test("a hung command is killed and the loop can roll it back", async () => {
  const script = "put /demo/out/summary.txt <<EOF\nHello freeze\nEOF\npdf /demo/out/summary.txt /demo/out/brief.pdf";
  const ok = await supervise(seedDesk(), script, [], "2");
  assert.equal(ok.result.code, 0);
  assert.ok(ok.desk.bins["/demo/out/brief.pdf"]);

  const hung = await supervise(seedDesk(), "ls /demo/inbox", [], "1", {
    idleMs: 40,
    wallMs: 2000,
    run: () => new Promise(() => {}),
  });
  assert.equal(hung.result.code, 124);
  assert.match(hung.result.stderr, /no output/);
  assert.match(hung.desk.files["/demo/inbox/friday.txt"], /one-page PDF/);

  const walled = await supervise(seedDesk(), "ls /demo/inbox", [], "1", {
    idleMs: 5000,
    wallMs: 40,
    run: () => new Promise(() => {}),
  });
  assert.match(walled.result.stderr, /wall time/);

  const many = await supervise(seedDesk(), "ls /demo\n".repeat(9), [], "1");
  assert.match(many.result.stderr, /more than 8/);
  const open = await supervise(seedDesk(), "put /demo/out/a.txt <<EOF\nno end", [], "1");
  assert.match(open.result.stderr, /heredoc/);
  const boom = await supervise(seedDesk(), "ls /demo", [], "1", {
    run: () => {
      throw new Error("boom");
    },
  });
  assert.equal(boom.result.code, 124);
  assert.match(boom.result.stderr, /boom/);

  let n = 0;
  const half = await supervise(seedDesk(), "put /demo/out/summary.txt <<EOF\nHi\nEOF\nls /demo/out", [], "2", {
    idleMs: 40,
    wallMs: 2000,
    run: (desk, cmd, snaps, stepId) => {
      n += 1;
      if (n === 1) return runCommand(desk, cmd, snaps, stepId);
      return new Promise(() => {});
    },
  });
  assert.equal(half.result.code, 124);
  assert.match(half.desk.files["/demo/out/summary.txt"] || "", /Hi/);
  const state = {
    ...emptyState(),
    phase: "run" as const,
    steps: [{ id: "2", do: "Write the brief", cmd: null, rollback: true, status: "run" as const, expect: "" }],
  };
  const stopped = abortOffPlan(state, half.desk, half.snaps, "2", { why: half.result.stderr, rollback: true });
  assert.equal(stopped.desk.files["/demo/out/summary.txt"], undefined);
  assert.match(stopped.desk.files["/demo/inbox/friday.txt"], /one-page PDF/);
});

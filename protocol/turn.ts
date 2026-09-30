import { createServerFn } from "@tanstack/react-start";
import { heuristicReply } from "./agent.ts";
import { completeTurn } from "./llm.ts";
import type { AgentEvent, Desk, LoopState } from "./types.ts";

export const agentTurn = createServerFn({ method: "POST" })
  .validator((input: { state: LoopState; event: AgentEvent; desk: Desk }) => input)
  .handler(async ({ data }) => {
    const known = heuristicReply(data.state, data.event, data.desk);
    if (known) return { ok: true as const, reply: known, via: "heuristic" };
    return completeTurn(data.state, data.event, data.desk);
  });

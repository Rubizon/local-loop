import { buildPacket, parseReply, SYSTEM } from "./agent.ts";
import type { AgentEvent, AgentReply, Desk, LoopState } from "./types.ts";

type Provider = {
  name: string;
  url: string;
  model: string;
  key: () => string | undefined;
};

const PROVIDERS: Provider[] = [
  {
    name: "xai",
    url: "https://api.x.ai/v1/chat/completions",
    model: "grok-4.5",
    key: () => process.env.XAI_API_KEY?.trim(),
  },
  {
    name: "kilo-free",
    url: "https://api.kilo.ai/api/gateway/chat/completions",
    model: "kilo-auto/free",
    key: () => "unused",
  },
];

let lastOk: Provider | null = null;

async function postChat(
  provider: Provider,
  system: string,
  user: string,
): Promise<{ ok: true; raw: string; provider: string } | { ok: false; error: string; status?: number }> {
  const key = provider.key();
  if (!key) return { ok: false, error: `${provider.name} has no key` };
  const signal = AbortSignal.timeout(12000);
  let res: Response;
  try {
    res = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        max_tokens: 420,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal,
    });
  } catch (err) {
    const why = signal.aborted ? "timed out" : err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${provider.name}: killed: ${why}` };
  }
  const body = await readBody(res, signal);
  if (!res.ok) return { ok: false, error: `${provider.name} ${res.status}: ${body.slice(0, 180)}`, status: res.status };
  const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
  return { ok: true, raw: data.choices?.[0]?.message?.content ?? "", provider: provider.name };
}

function readBody(res: Response, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("killed: no model output")), 4000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("killed: model timed out"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    res.text().then(
      (text) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(text.slice(0, 8000));
      },
      (err) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function chatJson(user: string, system = SYSTEM): Promise<{ ok: true; raw: string; provider: string } | { ok: false; error: string }> {
  const ordered = lastOk ? [lastOk, ...PROVIDERS.filter((p) => p.name !== lastOk!.name)] : PROVIDERS;
  const errors: string[] = [];
  for (const provider of ordered) {
    try {
      const result = await postChat(provider, system, user);
      if (result.ok) {
        lastOk = provider;
        return result;
      }
      errors.push(result.error);
      if (provider.name === "xai" && (result.status === 402 || result.status === 403)) continue;
    } catch (e) {
      errors.push(`${provider.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: false, error: errors.join(" | ") || "AI is not available in this environment" };
}

export async function completeTurn(
  state: LoopState,
  event: AgentEvent,
  desk: Desk,
): Promise<{ ok: true; reply: AgentReply; via: string } | { ok: false; error: string }> {
  const packet = buildPacket(state, event, desk);
  const chat = await chatJson(packet.user, packet.system);
  if (!chat.ok) return chat;
  return { ok: true, reply: parseReply(chat.raw, packet.job), via: chat.provider };
}

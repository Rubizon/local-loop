import type { CmdResult, Desk, PackedOutput, Snap } from "./types.ts";

export const INBOX = {
  "/demo/inbox/monday.txt": `Monday standup — Rae
The deploy slipped again. I'm angry about the silent timeout in checkout.
Decision: freeze features after Wednesday.
Owner: Nia. Due Friday.
`,
  "/demo/inbox/tuesday.txt": `Tuesday — Nia
Budget for the print run is approved at 400.
Checkout timeout is still open. Rae wants a written brief, not another thread.
`,
  "/demo/inbox/friday.txt": `Friday — Rae
Ship the brief as a one-page PDF.
Keep: feature freeze, print budget 400, checkout timeout still open.
Drop the joke about the vendor.
`,
} as const;

export function seedDesk(): Desk {
  return { files: { ...INBOX }, bins: {} };
}

const FULL = 5000;
const COMPRESS = 16000;
const CHUNK = 2500;
const MAX_CHUNKS = 4;

export function packOutput(stdout: string): PackedOutput {
  const n = stdout.length;
  if (n <= FULL) return { meta: `full · ${n} chars`, parts: [stdout] };
  if (n <= COMPRESS) {
    const head = stdout.slice(0, 1800);
    const tail = stdout.slice(-700);
    const text = `${head}\n… [${n - head.length - tail.length} chars omitted, head+tail kept] …\n${tail}`;
    return { meta: `compressed · ${n} chars → ${text.length} (head+tail)`, parts: [text] };
  }
  const parts: string[] = [];
  for (let i = 0; i < n && parts.length < MAX_CHUNKS; i += CHUNK) parts.push(stdout.slice(i, i + CHUNK));
  const rest = n > CHUNK * MAX_CHUNKS;
  return {
    meta: `chunked · ${n} chars into ${parts.length}${rest ? "+" : ""} · accumulate-summarize`,
    parts,
  };
}

function ascii(text: string): string {
  return text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ");
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of ascii(text).split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function pdfEsc(line: string): string {
  return line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function makePdf(text: string): { base64: string; bytes: number } {
  const lines = wrap(text.trim() || "Empty", 78).slice(0, 46);
  const stream = `BT\n/F1 11 Tf\n48 760 Td\n14 TL\n${lines.map((l) => `(${pdfEsc(l)}) Tj\nT*`).join("")}ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new TextEncoder().encode(out);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { base64: btoa(bin), bytes: bytes.length };
}

export function pdfToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function cleanPath(path: string): string | null {
  const p = path.trim();
  if (!p.startsWith("/demo/") && p !== "/demo") return null;
  if (p.includes("..") || p.includes("\0")) return null;
  return p.replace(/\/+$/, "") || "/demo";
}

function remember(snaps: Snap[], stepId: string, path: string, kind: Snap["kind"], before: string | null): Snap[] {
  if (snaps.some((s) => s.stepId === stepId && s.path === path && s.kind === kind)) return snaps;
  return [...snaps, { stepId, path, kind, before }];
}

function listDir(desk: Desk, path: string): string[] {
  const prefix = path === "/demo" ? "/demo/" : `${path}/`;
  const names = new Set<string>();
  for (const key of [...Object.keys(desk.files), ...Object.keys(desk.bins)]) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    names.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
  }
  return [...names].sort();
}

function parsePut(cmd: string): { path: string; body: string } | null {
  const heredoc = cmd.match(/^put\s+(\S+)\s*<<EOF\n([\s\S]*?)\nEOF\s*$/);
  if (heredoc) return { path: heredoc[1], body: heredoc[2] };
  const lines = cmd.match(/^put\s+(\S+)\n([\s\S]*)$/);
  if (lines) return { path: lines[1], body: lines[2].replace(/\s+$/, "") };
  return null;
}

export function splitScript(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const cmds: string[] = [];
  let buf: string[] = [];
  let heredoc = false;
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) cmds.push(text);
    buf = [];
  };
  for (const line of lines) {
    if (heredoc) {
      buf.push(line);
      if (line.trim() === "EOF") heredoc = false;
      continue;
    }
    if (/^(ls|cat|put|pdf)\b/.test(line.trim()) && buf.some((item) => item.trim())) flush();
    if (!line.trim() && !buf.length) continue;
    buf.push(line);
    if (/<<EOF\s*$/.test(line)) heredoc = true;
  }
  flush();
  return cmds;
}

function runOne(
  desk: Desk,
  cmd: string,
  snaps: Snap[],
  stepId: string,
): { desk: Desk; snaps: Snap[]; result: CmdResult } {
  const raw = cmd.replace(/\r\n/g, "\n").trim();
  const fail = (stderr: string, code = 1): { desk: Desk; snaps: Snap[]; result: CmdResult } => ({
    desk,
    snaps,
    result: { cmd: raw, code, stdout: "", stderr, meta: "error" },
  });
  if (!raw) return fail("empty command");
  if (raw.length > 80_000) return fail("killed: command too large", 124);

  const put = parsePut(raw);
  if (put) {
    const path = cleanPath(put.path);
    if (!path || path === "/demo") return fail("put only under /demo/…");
    if (put.body.length > 60_000) return fail("killed: body too large", 124);
    const files = { ...desk.files };
    const nextSnaps = remember(snaps, stepId, path, "file", files[path] ?? null);
    files[path] = put.body.endsWith("\n") ? put.body : `${put.body}\n`;
    const stdout = `wrote ${path} (${files[path].length} chars)`;
    return {
      desk: { ...desk, files },
      snaps: nextSnaps,
      result: { cmd: raw, code: 0, stdout, stderr: "", meta: packOutput(stdout).meta },
    };
  }

  const parts = raw.split(/\s+/);
  const bin = parts[0];
  if (bin === "ls") {
    const path = cleanPath(parts[1] || "/demo");
    if (!path) return fail("ls only under /demo");
    const names = listDir(desk, path);
    const stdout = names.length ? names.join("\n") : "(empty)";
    return { desk, snaps, result: { cmd: raw, code: 0, stdout, stderr: "", meta: packOutput(stdout).meta } };
  }
  if (bin === "cat") {
    const paths = parts.slice(1);
    if (!paths.length) return fail("cat needs a path");
    if (paths.length > 16) return fail("killed: too many paths", 124);
    const chunks: string[] = [];
    for (const item of paths) {
      const path = cleanPath(item);
      if (!path) return fail(`refused ${item}`);
      const text = desk.files[path];
      if (text == null) return fail(`no such file ${path}`, 2);
      chunks.push(`===== ${path} =====\n${text.replace(/\s+$/, "")}`);
    }
    const stdout = chunks.join("\n");
    return { desk, snaps, result: { cmd: raw, code: 0, stdout, stderr: "", meta: packOutput(stdout).meta } };
  }
  if (bin === "pdf") {
    const src = cleanPath(parts[1] || "");
    const dest = cleanPath(parts[2] || "");
    if (!src || !dest) return fail("pdf <source.txt> <dest.pdf>");
    const text = desk.files[src];
    if (text == null) return fail(`no such file ${src}`, 2);
    if (text.length > 60_000) return fail("killed: source too large", 124);
    const made = makePdf(text);
    const bins = { ...desk.bins };
    const nextSnaps = remember(snaps, stepId, dest, "bin", bins[dest] ?? null);
    bins[dest] = made.base64;
    const stdout = `wrote ${dest} (${made.bytes} bytes)`;
    return {
      desk: { ...desk, bins },
      snaps: nextSnaps,
      result: { cmd: raw, code: 0, stdout, stderr: "", meta: packOutput(stdout).meta },
    };
  }
  return fail(`unknown command ${bin}. Use ls, cat, put, or pdf.`, 127);
}

export function runCommand(
  desk: Desk,
  cmd: string,
  snaps: Snap[],
  stepId: string,
): { desk: Desk; snaps: Snap[]; result: CmdResult } {
  const raw = cmd.replace(/\r\n/g, "\n").trim();
  const parts = splitScript(raw);
  if (parts.length <= 1) return runOne(desk, raw, snaps, stepId);
  let nextDesk = desk;
  let nextSnaps = snaps;
  const outs: string[] = [];
  for (const part of parts) {
    const ran = runOne(nextDesk, part, nextSnaps, stepId);
    nextDesk = ran.desk;
    nextSnaps = ran.snaps;
    if (ran.result.code !== 0) {
      return {
        desk: nextDesk,
        snaps: nextSnaps,
        result: {
          cmd: raw,
          code: ran.result.code,
          stdout: outs.join("\n"),
          stderr: ran.result.stderr,
          meta: "error",
        },
      };
    }
    outs.push(ran.result.stdout);
  }
  const stdout = outs.join("\n");
  return {
    desk: nextDesk,
    snaps: nextSnaps,
    result: { cmd: raw, code: 0, stdout, stderr: "", meta: packOutput(stdout).meta },
  };
}

function restore(desk: Desk, snap: Snap): Desk {
  if (snap.kind === "file") {
    const files = { ...desk.files };
    if (snap.before == null) delete files[snap.path];
    else files[snap.path] = snap.before;
    return { ...desk, files };
  }
  const bins = { ...desk.bins };
  if (snap.before == null) delete bins[snap.path];
  else bins[snap.path] = snap.before;
  return { ...desk, bins };
}

export function rollbackStep(desk: Desk, snaps: Snap[], stepId: string): { desk: Desk; snaps: Snap[] } {
  const mine = snaps.filter((s) => s.stepId === stepId);
  let next = desk;
  for (const snap of [...mine].reverse()) next = restore(next, snap);
  return { desk: next, snaps: snaps.filter((s) => s.stepId !== stepId) };
}

export function rollbackAll(desk: Desk, snaps: Snap[]): { desk: Desk; snaps: Snap[] } {
  let next = desk;
  for (const snap of [...snaps].reverse()) next = restore(next, snap);
  return { desk: next, snaps: [] };
}

export function summarizeNotes(files: Record<string, string>): string {
  const blocks: string[] = [];
  const paths = Object.keys(files)
    .filter((p) => p.startsWith("/demo/inbox/"))
    .sort();
  for (const path of paths) {
    const name = path.split("/").pop();
    const lines = files[path]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const picked = lines.filter((l) =>
      /decision|owner|due|budget|keep:|angry|pdf|freeze|timeout|approved|brief/i.test(l),
    );
    blocks.push(`${name}\n${(picked.length ? picked : lines.slice(0, 3)).join("\n")}`);
  }
  if (!blocks.length) return "";
  return `Inbox brief\n\n${blocks.join("\n\n")}\n`;
}

export function harvestFacts(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < 12 || line.length > 180) continue;
    if (line.startsWith("=====")) continue;
    if (!/decision|owner|due|budget|keep:|angry|pdf|freeze|timeout|approved|brief|wrote /i.test(line)) continue;
    const fact = line.replace(/^keep:\s*/i, "KEEP ");
    const key = fact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fact);
    if (out.length >= 8) break;
  }
  return out;
}

export function deskPaths(desk: Desk): string[] {
  return [...Object.keys(desk.files), ...Object.keys(desk.bins)].sort();
}

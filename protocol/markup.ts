export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "code"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "h"; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: "p"; inlines: Inline[] }
  | { type: "ul"; items: Inline[][] }
  | { type: "ol"; items: Inline[][] }
  | { type: "pre"; text: string }
  | { type: "quote"; inlines: Inline[] };

const MARK = /(^|\n)\s{0,3}#{1,3}\s|\*\*|__|`|^[ \t]*[-*]\s|^[ \t]*\d+\.\s|```|\[[^\]]+\]\(https?:\/\//m;

export function looksLikeMarkup(text: string): boolean {
  return MARK.test(text);
}

export function safeHref(url: string): string | null {
  const t = url.trim();
  if (/^https?:\/\//i.test(t) && !/[\s<>]/.test(t)) return t;
  return null;
}

export function parseInlines(source: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`+)([^`]+)\1|\*\*([^*]+)\*\*|__([^_]+)__|(?<!\*)\*([^*]+)\*(?!\*)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of source.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ type: "text", text: source.slice(last, index) });
    if (match[2] != null) out.push({ type: "code", text: match[2] });
    else if (match[3] != null) out.push({ type: "strong", text: match[3] });
    else if (match[4] != null) out.push({ type: "strong", text: match[4] });
    else if (match[5] != null) out.push({ type: "em", text: match[5] });
    else if (match[6] != null) {
      const href = safeHref(match[7] || "");
      if (href) out.push({ type: "link", text: match[6], href });
      else out.push({ type: "text", text: match[6] });
    }
    last = index + match[0].length;
  }
  if (last < source.length) out.push({ type: "text", text: source.slice(last) });
  return out.length ? out : [{ type: "text", text: source }];
}

export function parseMarkup(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const pushParagraph = (buf: string[]) => {
    const text = buf.join(" ").trim();
    if (text) blocks.push({ type: "p", inlines: parseInlines(text) });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "pre", text: buf.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push({ type: "h", level, inlines: parseInlines(heading[2]) });
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line.trim())) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", inlines: parseInlines(buf.join(" ")) });
      continue;
    }
    if (/^[-*]\s+/.test(line.trim())) {
      const items: Inline[][] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(parseInlines(lines[i].trim().replace(/^[-*]\s+/, "")));
        i += 1;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\d+\.\s+/.test(line.trim())) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(parseInlines(lines[i].trim().replace(/^\d+\.\s+/, "")));
        i += 1;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i].trim()) &&
      !/^[-*]\s+/.test(lines[i].trim()) &&
      !/^\d+\.\s+/.test(lines[i].trim())
    ) {
      buf.push(lines[i].trim());
      i += 1;
    }
    pushParagraph(buf);
  }
  return blocks;
}

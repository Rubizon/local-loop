import type { ReactNode } from "react";
import { looksLikeMarkup, parseMarkup, type Inline } from "@/lib/loop/markup";

function bits(inlines: Inline[], key: string): ReactNode[] {
  return inlines.map((bit, i) => {
    const id = `${key}-${i}`;
    if (bit.type === "strong") return <strong key={id} className="font-medium text-fg">{bit.text}</strong>;
    if (bit.type === "em") return <em key={id}>{bit.text}</em>;
    if (bit.type === "code") {
      return (
        <code key={id} className="rounded bg-subtle px-1 font-mono text-[0.85em] text-fg">
          {bit.text}
        </code>
      );
    }
    if (bit.type === "link") {
      return (
        <a key={id} href={bit.href} target="_blank" rel="noreferrer" className="text-fg underline underline-offset-2">
          {bit.text}
        </a>
      );
    }
    return <span key={id}>{bit.text}</span>;
  });
}

export function Markup({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parseMarkup(text);
  return (
    <div className={`space-y-2 text-sm leading-relaxed text-muted ${className}`}>
      {blocks.map((block, i) => {
        const key = `b${i}`;
        if (block.type === "h") {
          const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          const size = block.level === 1 ? "font-display text-2xl text-fg" : block.level === 2 ? "text-lg text-fg" : "text-sm text-fg";
          return (
            <Tag key={key} className={`leading-snug tracking-tight ${size}`}>
              {bits(block.inlines, key)}
            </Tag>
          );
        }
        if (block.type === "ul" || block.type === "ol") {
          const Tag = block.type === "ul" ? "ul" : "ol";
          return (
            <Tag key={key} className={block.type === "ul" ? "list-disc space-y-1 pl-5" : "list-decimal space-y-1 pl-5"}>
              {block.items.map((item, n) => (
                <li key={`${key}-${n}`}>{bits(item, `${key}-${n}`)}</li>
              ))}
            </Tag>
          );
        }
        if (block.type === "pre") {
          return (
            <pre key={key} className="overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-xs leading-normal text-fg">
              {block.text}
            </pre>
          );
        }
        if (block.type === "quote") {
          return (
            <blockquote key={key} className="border-l-2 border-border pl-3 text-muted">
              {bits(block.inlines, key)}
            </blockquote>
          );
        }
        return <p key={key}>{bits(block.inlines, key)}</p>;
      })}
    </div>
  );
}

export function Report({ text }: { text: string }) {
  if (!looksLikeMarkup(text)) {
    return <p className="mt-2 font-display text-2xl leading-snug tracking-tight">{text}</p>;
  }
  return <Markup text={text} className="mt-3" />;
}

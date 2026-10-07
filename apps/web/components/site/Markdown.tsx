// A small Markdown renderer for first-party files (SKILL.md): headings, paragraphs, lists, tables, fenced code,
// and inline code, bold, italics and links. Output is React elements only; raw HTML in the source is shown as text.
import type { ReactNode } from "react";
import ui from "./ui.module.css";

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  let i = 0;
  while (m) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("`"))
      out.push(
        <code key={k} className={ui.inlineCode}>
          {t.slice(1, -1)}
        </code>,
      );
    else if (t.startsWith("**")) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
    else if (t.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
      const href = mm?.[2] ?? "#";
      const safe = /^(https?:|\/|#)/.test(href) ? href : "#";
      out.push(
        <a key={k} className={ui.textLink} href={safe}>
          {mm?.[1]}
        </a>,
      );
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
    m = re.exec(text);
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function Markdown({
  source,
  idPrefix = "md",
  headingOffset = 1,
}: {
  source: string;
  idPrefix?: string;
  headingOffset?: number;
}) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `${idPrefix}-${n++}`;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) body.push(lines[i++] ?? "");
      i++;
      blocks.push(
        <div key={key()} className={ui.code}>
          <pre>
            <code>{body.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(6, (h[1]?.length ?? 1) + headingOffset);
      const text = h[2] ?? "";
      const id = `${idPrefix}-${text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`;
      const Tag = `h${level}` as "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(
        <Tag key={key()} id={id}>
          {inline(text, id)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) rows.push(cells(lines[i++] ?? ""));
      const [head, sep, ...body] = rows;
      const hasHead = sep?.every((c) => /^:?-{2,}:?$/.test(c));
      const k = key();
      blocks.push(
        <div key={k} className={ui.tableScroll}>
          <table className={ui.table}>
            {hasHead && head && (
              <thead>
                <tr>
                  {head.map((c, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static markdown
                    <th key={j}>{inline(c, `${k}-h${j}`)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {(hasHead ? body : rows).map((r, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static markdown
                <tr key={ri}>
                  {r.map((c, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static markdown
                    <td key={j}>{inline(c, `${k}-${ri}-${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")) {
        let item = (lines[i] ?? "").replace(/^\s*([-*]|\d+\.)\s+/, "");
        i++;
        // continuation lines (indented, not a new item)
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i] ?? "") &&
          !/^\s*([-*]|\d+\.)\s+/.test(lines[i] ?? "")
        )
          item += ` ${(lines[i++] ?? "").trim()}`;
        items.push(item);
      }
      const k = key();
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={k}>
          {items.map((it, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static markdown
            <li key={j}>{inline(it, `${k}-${j}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(```|#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s+)/.test(lines[i] ?? "")
    )
      para.push((lines[i++] ?? "").trim());
    const k = key();
    blocks.push(<p key={k}>{inline(para.join(" "), k)}</p>);
  }
  return <>{blocks}</>;
}

/** Splits YAML-ish frontmatter (--- … ---) from a Markdown file; values are kept as raw text. */
export function frontmatter(src: string): { meta: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  return m ? { meta: m[1] ?? null, body: src.slice(m[0].length) } : { meta: null, body: src };
}

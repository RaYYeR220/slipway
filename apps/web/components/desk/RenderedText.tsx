"use client";
// Model text, rendered only from the server's data-render parts and only as text nodes. Slot parts become chips
// (the figure code filled in, its source on hover/focus); flag parts — anything the model typed that no tool
// produced — are shown struck as [unverified]. The only markup honoured is **bold**, "- " bullets and paragraph
// breaks, and those are parsed into React elements, never injected as HTML.
import { Fragment, type ReactNode } from "react";
import type { RenderPart } from "@/lib/desk/types";
import s from "./sheet.module.css";

type Inline =
  | { kind: "text"; text: string; bold: boolean }
  | { kind: "slot"; text: string; source: string; name: string; bold: boolean }
  | { kind: "flag"; bold: boolean };

const BULLET = /^\s*(?:[-•]|\*(?!\*))\s+/;
const HEADING = /^\s*#{1,4}\s+/;

function toLines(parts: RenderPart[]): Inline[][] {
  const lines: Inline[][] = [[]];
  let bold = false;
  const cur = () => lines[lines.length - 1] as Inline[];
  for (const p of parts) {
    if (p.kind === "text") {
      for (const tok of p.text.split(/(\*\*|\n)/)) {
        if (tok === "**") bold = !bold;
        else if (tok === "\n") lines.push([]);
        else if (tok) cur().push({ kind: "text", text: tok, bold });
      }
    } else if (p.kind === "slot")
      cur().push({ kind: "slot", text: p.text, source: p.source, name: p.name, bold });
    else cur().push({ kind: "flag", bold });
  }
  return lines;
}

const isBlank = (l: Inline[]) => l.every((x) => x.kind === "text" && !x.text.trim());

function strip(l: Inline[], re: RegExp): Inline[] {
  const first = l[0];
  if (first?.kind !== "text") return l;
  return [{ ...first, text: first.text.replace(re, "") }, ...l.slice(1)];
}

const isLive = (source: string) => source.startsWith("bitget");

// Short figures stay on one line in the mono face; longer code-filled text (labels, reasons) wraps like prose.
const isFigure = (text: string) => text.length <= 26 && /\d/.test(text);

function Chip({ text, source, name }: { text: string; source: string; name: string }) {
  const cls = [s.chip, isFigure(text) ? s.chipFigure : s.chipText, isLive(source) ? s.chipLive : ""].join(
    " ",
  );
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the chip is focusable so keyboard users can read its source
    <span className={cls} tabIndex={0} data-src={`${source} · ${name}`}>
      {text}
      <span className={s.sr}> (source: {source})</span>
    </span>
  );
}

function InlineRun({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((x, i) => {
        const key = `${i}-${x.kind}`;
        let node: ReactNode;
        if (x.kind === "text") node = x.text;
        else if (x.kind === "slot") node = <Chip text={x.text} source={x.source} name={x.name} />;
        else
          node = (
            <s className={s.flag} title="The model typed a figure no tool produced; the desk blanked it.">
              [unverified]
            </s>
          );
        return x.bold ? <strong key={key}>{node}</strong> : <Fragment key={key}>{node}</Fragment>;
      })}
    </>
  );
}

export function RenderedText({ parts }: { parts: RenderPart[] }) {
  const lines = toLines(parts);
  const blocks: ReactNode[] = [];
  let para: Inline[][] = [];
  let list: Inline[][] = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = para;
    blocks.push(
      <p key={`p${blocks.length}`} className={s.para}>
        {p.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of one rendered reply never reorder
          <Fragment key={`l${i}`}>
            {i ? <br /> : null}
            <InlineRun items={l} />
          </Fragment>
        ))}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const l = list;
    blocks.push(
      <ul key={`u${blocks.length}`} className={s.list}>
        {l.map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: bullets of one rendered reply never reorder
          <li key={`i${i}`}>
            <InlineRun items={item} />
          </li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const line of lines) {
    if (isBlank(line)) {
      flushPara();
      flushList();
      continue;
    }
    const first = line[0];
    if (first?.kind === "text" && BULLET.test(first.text)) {
      flushPara();
      list.push(strip(line, BULLET));
    } else if (first?.kind === "text" && HEADING.test(first.text)) {
      flushPara();
      flushList();
      blocks.push(
        <p key={`h${blocks.length}`} className={s.para}>
          <strong>
            <InlineRun items={strip(line, HEADING)} />
          </strong>
        </p>,
      );
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return <div className={s.rendered}>{blocks}</div>;
}

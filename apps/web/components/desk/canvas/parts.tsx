"use client";
// Shared canvas pieces: section heads, true-text skeletons, error blocks.
import type { ReactNode } from "react";
import type { ApiFailure } from "@/lib/desk/types";
import c from "./canvas.module.css";

export function SectionHead({
  id,
  title,
  lede,
  aside,
}: {
  id: string;
  title: string;
  lede?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className={c.sectionHead}>
      <div>
        <h2 id={id} className={c.h2}>
          {title}
        </h2>
        {lede ? <p className={c.lede}>{lede}</p> : null}
      </div>
      {aside ? <div className={c.headAside}>{aside}</div> : null}
    </header>
  );
}

/** A loading state that says what is actually happening, over a few placeholder rules. */
export function Working({ text, rows = 3 }: { text: string; rows?: number }) {
  return (
    <div className={c.working} role="status" aria-live="polite">
      <p className={c.workingText}>
        <span className={c.pulse} aria-hidden="true" />
        {text}
      </p>
      <div className={c.skeleton} aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
          <span key={i} style={{ width: `${88 - i * 17}%` }} />
        ))}
      </div>
    </div>
  );
}

export function Failure({ error, what, action }: { error: ApiFailure; what: string; action?: ReactNode }) {
  const down = error.sources.filter((s) => s.status === "unavailable");
  return (
    <div className={c.failure} role="alert">
      <p className={c.failureLead}>
        {what}: {error.message}
      </p>
      {down.length ? (
        <p className={c.failureMeta}>
          Unavailable: {down.map((s) => s.id).join(", ")}. The desk fails closed rather than guess.
        </p>
      ) : null}
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className={c.empty}>{children}</div>;
}

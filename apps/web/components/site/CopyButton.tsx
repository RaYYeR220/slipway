"use client";

import { useEffect, useRef, useState } from "react";
import ui from "./ui.module.css";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1800);
  };

  return (
    <button type="button" className={ui.copy} onClick={copy}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
        {state === "done" ? (
          <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        ) : (
          <>
            <rect
              x="5"
              y="5"
              width="8.5"
              height="8.5"
              rx="1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <path d="M3 11V3.5A1 1 0 0 1 4 2.5h7" fill="none" stroke="currentColor" strokeWidth="1.2" />
          </>
        )}
      </svg>
      <span aria-live="polite">
        {state === "done" ? "Copied" : state === "failed" ? "Select and copy" : label}
      </span>
    </button>
  );
}

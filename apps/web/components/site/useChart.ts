"use client";

import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";

/** Width of a container, tracked with ResizeObserver. Starts at `initial` so the server render has a layout. */
export function useWidth<T extends HTMLElement>(initial: number): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (cw: number | undefined) => {
      if (cw) setW((prev) => (Math.abs(cw - prev) > 0.5 ? Math.round(cw) : prev));
    };
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((es) => measure(es[0]?.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export interface Tip {
  x: number;
  y: number;
}

/** Place a ~180px tooltip beside its anchor, flipping left near the right edge, clamped into the chart. */
export function tipStyle(t: Tip, width: number, boxWidth = 190): CSSProperties {
  const right = t.x + 14 + boxWidth > width;
  const left = Math.max(0, Math.min(width - boxWidth, right ? t.x - 14 - boxWidth : t.x + 14));
  return { left, top: Math.max(0, t.y - 10), width: boxWidth };
}

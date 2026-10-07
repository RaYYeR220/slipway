"use client";

// Landing hero: the trading week as a current (design variant v05d "final"). The copy, figure caption and legend
// are server-rendered; the current itself lives in ./flow.ts and mounts once the faces are in, because its
// geometry is routed around the real line boxes and the figure is rasterised in Zodiak.
import Link from "next/link";
import { type CSSProperties, useEffect, useRef } from "react";
import { startFlow } from "./flow";
import styles from "./hero/hero.module.css";
import { depthScale } from "./hero/util";

export interface HeroProps {
  vol: number[];
  rng: number[];
  /** Regular-session hour ÷ overnight hour, rounded; null when the data is missing. */
  ratio: number | null;
  /** One line naming the series, window and source of `vol` and `ratio`. */
  source: string;
  /** Weeks behind each hourly median, for the hover readout. */
  weeks?: number;
}

const STOPS: [string, number][] = [
  ["1k", 3],
  ["1M", 6],
  ["100M", 8],
  ["1B+", 9],
];

/** Resolves once the hero's faces can be drawn on canvas, or after a cap so a slow font never blocks the current. */
function facesReady(): Promise<void> {
  const fonts = document.fonts;
  if (!fonts) return Promise.resolve();
  const loads = [
    "300 80px Zodiak",
    "400 80px Zodiak",
    "400 16px Switzer",
    "400 11px 'Azeret Mono'",
    "500 11px 'Azeret Mono'",
  ].map((f) => fonts.load(f).catch(() => []));
  return Promise.race([
    Promise.all(loads).then(() => fonts.ready.then(() => undefined)),
    new Promise<void>((r) => setTimeout(r, 2200)),
  ]);
}

export function Hero({ vol, rng, ratio, source, weeks }: HeroProps) {
  const sea = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const num = useRef<HTMLCanvasElement>(null);
  const figcap = useRef<HTMLParagraphElement>(null);
  const figsrc = useRef<HTMLElement>(null);
  const claim = useRef<HTMLHeadingElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const legend = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const probeLn = useRef<HTMLSpanElement>(null);
  const probeLb = useRef<HTMLSpanElement>(null);
  const live = vol.length === 168 && rng.length === 168;
  const depth = depthScale(live ? vol : []);

  useEffect(() => {
    if (!live) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const mount = () => {
      const s = sea.current;
      const h = host.current;
      const c = claim.current;
      const cp = copy.current;
      const lg = legend.current;
      const pr = probe.current;
      const pl = probeLn.current;
      const pb = probeLb.current;
      if (cancelled || !s || !h || !c || !cp || !lg || !pr || !pl || !pb) return;
      stop?.();
      stop = startFlow(
        {
          sea: s,
          host: h,
          num: ratio === null ? null : num.current,
          figcap: figcap.current,
          figsrc: figsrc.current,
          claim: c,
          copy: cp,
          legend: lg,
          probe: pr,
          probeLn: pl,
          probeLb: pb,
        },
        { vol, rng, ratio, weeks },
      );
    };
    facesReady().then(() => {
      mount();
      // the display face arrived after the cap: rebuild once so the figure and the routing use real Zodiak
      const fonts = document.fonts;
      if (fonts && !fonts.check("400 80px Zodiak"))
        fonts
          .load("400 80px Zodiak")
          .then(() => {
            if (fonts.check("400 80px Zodiak")) mount();
          })
          .catch(() => {});
    });
    return () => {
      cancelled = true;
      stop?.();
      stop = null;
    };
  }, [live, vol, rng, ratio, weeks]);

  return (
    <section className={styles.sea} ref={sea} aria-labelledby="hero-claim">
      <div className={styles.host} ref={host} aria-hidden="true" />
      <div className={styles.probe} ref={probe} aria-hidden="true">
        <span className={styles.ln} ref={probeLn} />
        <span className={styles.lb} ref={probeLb} />
      </div>
      <div className={styles.fig} hidden={ratio === null}>
        <span className={styles.numText} aria-hidden="true">
          {ratio}×
        </span>
        <canvas className={styles.num} ref={num} aria-hidden="true" tabIndex={-1} />
        <p className={styles.figcap} ref={figcap}>
          A New York regular-session hour trades {ratio ?? "n/a"} times what an overnight hour does.
        </p>
        <small className={styles.figsrc} ref={figsrc}>
          {source}
        </small>
      </div>
      <div
        className={styles.legend}
        ref={legend}
        role="img"
        aria-label="Current colour: median USDT traded per hour, from about one thousand to over one billion"
      >
        <span className={styles.legendCap}>USDT per hour</span>
        <span className={styles.ramp} />
        <span className={styles.stops}>
          {STOPS.map(([label, l]) => {
            const k = depth.k(l);
            return (
              <span
                key={label}
                style={{ "--k": k.toFixed(4) } as CSSProperties}
                data-edge={k < 0.02 ? "start" : k > 0.98 ? "end" : undefined}
                data-wide={label === "100M" ? "" : undefined}
              >
                {label}
              </span>
            );
          })}
        </span>
      </div>
      <div className={styles.copy} ref={copy}>
        <h1 className={styles.claim} id="hero-claim" ref={claim}>
          24/7 trading isn’t 24/7 liquidity.
        </h1>
        <p className={styles.sub}>
          Slipway prices your order across rTokens, stock perps and the New York sessions, hands you a dry-run
          ticket for every slice, then grades its own forecast against the tape.
        </p>
        <Link className={styles.cta} href="/desk">
          <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">
            <circle cx="5" cy="9" r="2.4" fill="currentColor" />
            <path d="M7.5 9 C10 6 12 12 16 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          Plan an order
        </Link>
      </div>
    </section>
  );
}

"use client";

// Placeholder hero: a faithful port of design variant v05 "current-flow". The flow lives in ./flow.ts so it can be
// swapped without touching this component's copy and layout.
import Link from "next/link";
import { useEffect, useRef } from "react";
import { startFlow } from "./flow";
import styles from "./hero.module.css";

export interface HeroProps {
  vol: number[];
  rng: number[];
  /** Regular-session hour ÷ overnight hour, rounded; null when the data is missing. */
  ratio: number | null;
  /** One line naming the series, window and source of `vol` and `ratio`. */
  source: string;
}

export function Hero({ vol, rng, ratio, source }: HeroProps) {
  const sea = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLCanvasElement>(null);
  const flow = useRef<HTMLCanvasElement>(null);
  const figure = useRef<HTMLCanvasElement>(null);
  const caption = useRef<HTMLDivElement>(null);
  const figureText = ratio === null ? "" : `${ratio}×`;

  useEffect(() => {
    if (!sea.current || !field.current || !flow.current || !figure.current || !caption.current) return;
    if (vol.length !== 168) return;
    return startFlow(
      {
        sea: sea.current,
        field: field.current,
        flow: flow.current,
        figure: figure.current,
        caption: caption.current,
      },
      { vol, rng, figure: figureText },
    );
  }, [vol, rng, figureText]);

  return (
    <section className={styles.sea} ref={sea} aria-labelledby="hero-claim">
      <canvas ref={field} className={styles.canvas} aria-hidden="true" tabIndex={-1} />
      <canvas ref={flow} className={`${styles.canvas} ${styles.flow}`} aria-hidden="true" tabIndex={-1} />
      <div className={styles.scrim} aria-hidden="true" />
      <canvas ref={figure} className={`${styles.canvas} ${styles.figure}`} aria-hidden="true" tabIndex={-1} />
      <div className={styles.fig} ref={caption} hidden={ratio === null}>
        <p>A New York regular-session hour trades {ratio ?? "n/a"} times what an overnight hour does.</p>
        <small>{source}</small>
      </div>
      <div
        className={styles.legend}
        role="img"
        aria-label="Current colour: median USDT traded per hour, from about one thousand to over one billion"
      >
        <span className={styles.cap}>USDT per hour</span>
        <span className={styles.ramp} />
        <span className={styles.stops}>
          <span>1B+</span>
          <span>100M</span>
          <span>10M</span>
          <span>1M</span>
          <span>1k</span>
        </span>
      </div>
      <div className={styles.copy}>
        <h1 className={styles.claim} id="hero-claim">
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

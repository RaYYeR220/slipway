import styles from "./site.module.css";

/** Two drifting current lines: the Slipway glyph from the landing's flow field. */
export function Glyph({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className ?? styles.glyph}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
    >
      <path className={styles.glyph1} d="M1 13 C5 9 8 15 12 11 S17 8 19 9" fill="none" strokeWidth="1.5" />
      <path className={styles.glyph2} d="M1 17 C5 13 8 19 12 15 S17 12 19 13" fill="none" strokeWidth="1.5" />
    </svg>
  );
}

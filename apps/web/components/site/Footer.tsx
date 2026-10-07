import Link from "next/link";
import { PUBLIC_BASE, REPO_URL } from "./data";
import styles from "./site.module.css";
import { Glyph } from "./Wordmark";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footMark}>
        <Link className={styles.mark} href="/" aria-label="Slipway, home">
          <Glyph />
          <span>Slipway</span>
        </Link>
        <p>
          The execution desk for Bitget tokenized US stocks. Tickets are dry runs: nothing is ever sent to the
          exchange.
        </p>
      </div>
      <nav className={styles.footNav} aria-label="Footer">
        <ul>
          <li>
            <Link href="/desk">Desk</Link>
          </li>
          <li>
            <Link href="/track-record">Track record</Link>
          </li>
          <li>
            <Link href="/atlas">Liquidity atlas</Link>
          </li>
          <li>
            <Link href="/docs">Docs</Link>
          </li>
          <li>
            <Link href="/docs#limits">Honest limits</Link>
          </li>
          <li>
            <a href={REPO_URL} rel="noopener">
              Source on GitHub
            </a>
          </li>
        </ul>
      </nav>
      <p className={styles.footNote}>
        Market data from Bitget&rsquo;s public endpoints, keyless. The recorded tape, forecast ledger and
        grades are public at{" "}
        <a href={`${PUBLIC_BASE}/derived/track-record.json`}>storage.googleapis.com/slipway-tape-c48c75</a>.
        Built for the Bitget AI Hackathon, season 2. Not investment advice.
      </p>
    </footer>
  );
}

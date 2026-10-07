import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_DESCRIPTIONS, TOPICS } from "@slipway/agent";
import { INSTRUCTIONS, PLAN_CARD_URI, SERVER_INFO } from "@slipway/mcp";
import type { Metadata } from "next";
import Link from "next/link";
import { OriginCode } from "@/components/landing/OriginCode";
import { CodeBlock } from "@/components/site/Code";
import { LISTING_BASE, PUBLIC_BASE, REPO_URL, TRACK_RECORD_URL } from "@/components/site/data";
import { Footer } from "@/components/site/Footer";
import { Header } from "@/components/site/Header";
import { frontmatter, Markdown } from "@/components/site/Markdown";
import ui from "@/components/site/ui.module.css";
import styles from "./docs.module.css";

// Static: SKILL.md and the protocol hash are read once, at build time.
export const dynamic = "force-static";
export const metadata: Metadata = {
  title: "Docs",
  description:
    "Use Slipway from the desk, over MCP, as a Bitget-format Skill, from the CLI, or over HTTP with the typed SDK. How to verify the track record, and the honest limits.",
};

async function skillSource(): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  for (const p of [
    join(process.cwd(), "../../skills/slipway/SKILL.md"),
    join(process.cwd(), "skills/slipway/SKILL.md"),
  ]) {
    try {
      return { ok: true, text: await readFile(/* turbopackIgnore: true */ p, "utf8") };
    } catch {
      /* try the next location */
    }
  }
  return { ok: false, error: "SKILL.md was not found next to this build" };
}

/** Protocol hash for the Verify section, fetched once at build (the page is static). */
async function protocolHash(): Promise<string | null> {
  try {
    const res = await fetch(TRACK_RECORD_URL, { cache: "force-cache" });
    if (!res.ok) return null;
    const j = (await res.json()) as { protocol?: { hash?: string } };
    return j.protocol?.hash ?? null;
  } catch {
    return null;
  }
}

const SYMBOL_ARG = "symbol (underlying, e.g. NVDA)";
const ORDER_ARGS =
  "symbol, side, exactly one of notionalUsd or qty, optional deadline (as the trader said it), venues, urgency, holdHorizonHours, profile";

const TOOLS: {
  name: keyof typeof TOOL_DESCRIPTIONS;
  title: string;
  args: string;
  extra?: string;
  ui?: boolean;
}[] = [
  { name: "price_options", title: "Price execution options", args: ORDER_ARGS },
  {
    name: "build_plan",
    title: "Build signed plan",
    args: `${ORDER_ARGS}, strategyId`,
    extra: "The result carries signedPlan: pass it unchanged to issue_tickets.",
    ui: true,
  },
  {
    name: "issue_tickets",
    title: "Issue dry-run tickets",
    args: "signedPlan, exactly as build_plan returned it",
    ui: true,
  },
  { name: "market_state", title: "Market state", args: SYMBOL_ARG },
  { name: "liquidity_tide", title: "Liquidity tide", args: SYMBOL_ARG },
  { name: "research", title: "Research", args: SYMBOL_ARG },
  { name: "explain", title: "Explain", args: "topic" },
  { name: "track_record", title: "Track record", args: "optional symbol" },
];

const ROUTES: { m: string; path: string; what: string }[] = [
  {
    m: "POST",
    path: "/api/plan/options",
    what: "Price every strategy: best plan, best per family, TWAP baseline, gate preview.",
  },
  { m: "POST", path: "/api/plan", what: "Re-price on fresh data, gate and sign one strategy." },
  {
    m: "POST",
    path: "/api/tickets",
    what: "Dry-run tickets for a signed ALLOW plan; a refusal returns ok: false with the fixes.",
  },
  {
    m: "GET",
    path: "/api/market/:symbol",
    what: "Live books, fees, funding, basis, sessions, events, integrity flags.",
  },
  {
    m: "GET",
    path: "/api/tide/:symbol",
    what: "Depth and spread per session and venue over the coming days, against the live book.",
  },
  {
    m: "GET",
    path: "/api/research/:symbol",
    what: "Context from Bitget’s skills; lists what was unavailable.",
  },
  {
    m: "GET",
    path: "/api/explain/:topic",
    what: "Plain-language explanation of a check, cost component or strategy.",
  },
  { m: "GET", path: "/api/track-record?symbol=", what: "The graded forecast record, if published." },
  { m: "GET", path: "/api/keys", what: "The desk’s Ed25519 plan-signing public key." },
  {
    m: "POST",
    path: "/api/chat",
    what: "The desk’s language agent (streaming). Rate-limited: 6 turns a minute per client.",
  },
];

const SECTIONS = [
  ["quickstart", "Quickstart"],
  ["mcp", "MCP"],
  ["skill", "Skill"],
  ["cli", "CLI"],
  ["api", "HTTP API and SDK"],
  ["verify", "Verify"],
  ["limits", "Honest limits"],
] as const;

export default async function DocsPage() {
  const [skill, hash] = await Promise.all([skillSource(), protocolHash()]);
  const fm = skill.ok ? frontmatter(skill.text) : null;

  return (
    <>
      <Header current="docs" />
      <main id="main" className={`${ui.page} ${styles.docs}`} data-paper>
        <aside className={styles.toc} aria-label="On this page">
          <p className={styles.tocTitle}>Sailing directions</p>
          <ol>
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`}>{label}</a>
              </li>
            ))}
          </ol>
        </aside>

        <article className={styles.body}>
          <header className={styles.title}>
            <h1 className={ui.h1}>Docs</h1>
            <p className={ui.lede}>
              One desk, five ways in: the web desk, MCP, a Bitget-format Skill, the CLI, and plain HTTP with a
              typed SDK. Every route is read-only or a dry run. No keys: market data is Bitget’s public
              endpoints.
            </p>
          </header>

          <section id="quickstart" className={styles.section}>
            <h2 className={styles.h2}>Quickstart</h2>
            <ol className={styles.steps}>
              <li>
                <strong>Open the desk.</strong> Go to <Link href="/desk">/desk</Link> and say what you have
                already decided: “Buy $40k of NVDA before Thursday, I’m patient.”
              </li>
              <li>
                <strong>Read the options.</strong> Slipway prices each venue (rToken, perp), session and
                slicing against the live book, and shows the best plan beside the TWAP baseline with an
                expected cost and a p10–p90 band.
              </li>
              <li>
                <strong>Build the plan.</strong> The gate runs its checks in code. Allow, hold or refuse comes
                with the failed check and its fix.
              </li>
              <li>
                <strong>Take the tickets.</strong> For an allowed plan you confirm, the desk issues one
                dry-run ticket per slice: the exact request Bitget’s agent SDK would send, and the matching{" "}
                <code className={ui.inlineCode}>bgc</code> command. Nothing is sent.
              </li>
            </ol>
          </section>

          <section id="mcp" className={styles.section}>
            <h2 className={styles.h2}>MCP</h2>
            <p>
              Streamable HTTP, stateless, MCP spec 2026-07-28 (2025-era clients are served too). Server{" "}
              <code className={ui.inlineCode}>
                {SERVER_INFO.name} {SERVER_INFO.version}
              </code>
              . Tool results carry structured content:{" "}
              <code className={ui.inlineCode}>{"{ data, slots, sources }"}</code>. Plans and tickets link an
              MCP Apps view, <code className={ui.inlineCode}>{PLAN_CARD_URI}</code>.
            </p>
            <OriginCode title="endpoint" code="{ORIGIN}/api/mcp" />
            <h3 className={styles.h3}>Connect a client</h3>
            <OriginCode
              title="Desktop clients, Cursor and other JSON-configured clients"
              code={`{
  "mcpServers": {
    "slipway": { "type": "http", "url": "{ORIGIN}/api/mcp" }
  }
}`}
            />
            <OriginCode
              title="Terminal agents with an MCP add command"
              code="<agent> mcp add --transport http slipway {ORIGIN}/api/mcp"
            />
            <CodeBlock
              title="stdio, from a built checkout"
              code={`{
  "mcpServers": {
    "slipway": { "command": "node", "args": ["<path-to>/slipway/packages/mcp/dist/bin.js"] }
  }
}`}
            />
            <h3 className={styles.h3}>Server instructions</h3>
            <blockquote className={styles.quote}>{INSTRUCTIONS}</blockquote>
            <h3 className={styles.h3}>Tools</h3>
            <p className={styles.small}>
              All tools are annotated read-only. Descriptions are the ones the server sends.
            </p>
            <dl className={styles.tools}>
              {TOOLS.map((t) => (
                <div key={t.name} className={styles.tool}>
                  <dt>
                    <code>{t.name}</code>
                    <span>{t.title}</span>
                  </dt>
                  <dd>
                    <p>
                      {t.name === "issue_tickets"
                        ? "Dry-run order tickets (Bitget agent SDK requests + bgc commands) for a signedPlan from build_plan. Refused unless the signature verifies with this desk’s key, the verdict is ALLOW and the plan was signed within the validity window. Only after the trader confirms. Nothing is sent."
                        : TOOL_DESCRIPTIONS[t.name]}
                      {t.extra ? ` ${t.extra}` : ""}
                    </p>
                    <p className={styles.args}>
                      <span>Arguments</span> {t.args}
                      {t.ui ? " · links the plan card" : ""}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
            <p className={styles.small}>
              <code className={ui.inlineCode}>explain</code> topics: {TOPICS.join(", ")}.
            </p>
          </section>

          <section id="skill" className={styles.section}>
            <h2 className={styles.h2}>Skill</h2>
            <p>
              <code className={ui.inlineCode}>skills/slipway/SKILL.md</code>, in Bitget’s skill format: when
              an agent should call Slipway rather than plain <code className={ui.inlineCode}>bgc</code>, the
              tool sequence, and the two gates before any ticket. Reproduced here from the repository.
            </p>
            {fm?.meta && <CodeBlock title="SKILL.md frontmatter" code={fm.meta} copy={false} />}
            {skill.ok && fm ? (
              <div className={styles.prose}>
                <Markdown source={fm.body} idPrefix="skill" headingOffset={2} />
              </div>
            ) : (
              <p className={ui.unavailable}>
                {skill.ok ? "" : skill.error}. Read it at{" "}
                <a href={`${REPO_URL}/blob/main/skills/slipway/SKILL.md`}>
                  {REPO_URL}/blob/main/skills/slipway/SKILL.md
                </a>
                .
              </p>
            )}
          </section>

          <section id="cli" className={styles.section}>
            <h2 className={styles.h2}>CLI</h2>
            <p>
              Three command lines matter. The MCP server runs over stdio for desktop clients. Every ticket is
              a <code className={ui.inlineCode}>bgc</code> command you can run yourself: with{" "}
              <code className={ui.inlineCode}>--dry-run</code> it prints the exact body Bitget would receive
              and sends nothing. And one command audits everything Slipway publishes.
            </p>
            <CodeBlock
              title="MCP over stdio"
              code={"pnpm install && pnpm build\nnode packages/mcp/dist/bin.js"}
            />
            <CodeBlock
              title="A ticket, as the desk issues it (values filled per slice)"
              copy={false}
              code={
                "bgc --read-only order --action place --category SPOT --symbol RNVDAUSDT \\\n  --side buy --orderType limit --price <walk cap> --qty <slice> \\\n  --timeInForce ioc --clientOid <id> --dry-run"
              }
            />
            <p className={styles.small}>
              Sending for real is the Bitget skill’s job, not Slipway’s: the same command without{" "}
              <code className={ui.inlineCode}>--read-only</code> and{" "}
              <code className={ui.inlineCode}>--dry-run</code>, behind that skill’s own confirmation.
            </p>
            <CodeBlock title="Audit the public record" code="pnpm verify" />
          </section>

          <section id="api" className={styles.section}>
            <h2 className={styles.h2}>HTTP API and SDK</h2>
            <p>
              JSON over HTTP on the same origin. Every success is{" "}
              <code className={ui.inlineCode}>{"{ data, slots, sources }"}</code>: the computed object, named
              figures with units and sources, and each input’s status (live, cached or unavailable). Errors
              are <code className={ui.inlineCode}>{"{ error: { code, message }, sources }"}</code>.
            </p>
            <div className={ui.tableScroll}>
              <table className={`${ui.table} ${styles.routes}`}>
                <caption className="sr-only">HTTP routes</caption>
                <thead>
                  <tr>
                    <th scope="col">Method</th>
                    <th scope="col">Route</th>
                    <th scope="col">Returns</th>
                  </tr>
                </thead>
                <tbody>
                  {ROUTES.map((r) => (
                    <tr key={r.m + r.path}>
                      <td>{r.m}</td>
                      <td>{r.path}</td>
                      <td>{r.what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className={styles.h3}>Request</h3>
            <OriginCode
              title="price an order"
              code={`curl -s {ORIGIN}/api/plan/options \\
  -H 'content-type: application/json' \\
  -d '{"intent":{"symbol":"NVDA","side":"buy","notionalUsd":40000,"deadline":"before thursday","urgency":"patient"}}'`}
            />
            <h3 className={styles.h3}>Response shape</h3>
            <CodeBlock
              title="POST /api/plan/options → 200"
              copy={false}
              code={`{
  "data": {
    "best":      Quote | null,      // id, label, expectedBps, sdBps, p10Bps, p90Bps, expectedCostUsd, sliceCount, …
    "baseline":  Quote | null,      // the Bitget-app TWAP
    "families":  { "<family>": Quote },
    "gate":      { "verdict": "allow" | "hold" | "refuse", "checks": [{ "code", "status", "detail", "fix" }] },
    "frontier":  [ … every priced candidate … ]
  },
  "slots":   { "<name>": { "value": number | string, "unit": "bps" | "usd" | …, "source": "<source id>" } },
  "sources": [ { "id": "bitget.spot.orderbook", "status": "live" | "cached" | "unavailable", "asOf": number | null } ]
}`}
            />
            <p className={styles.small}>
              Error codes: <code className={ui.inlineCode}>BAD_INPUT</code> 400 ·{" "}
              <code className={ui.inlineCode}>NOT_FOUND</code> 404 ·{" "}
              <code className={ui.inlineCode}>NO_MARKET</code> 503 ·{" "}
              <code className={ui.inlineCode}>UNAVAILABLE</code> 503 ·{" "}
              <code className={ui.inlineCode}>ERROR</code> 500. Try a live read:{" "}
              <a className={ui.textLink} href="/api/market/NVDA">
                /api/market/NVDA
              </a>
              .
            </p>
            <h3 className={styles.h3}>SDK</h3>
            <p>
              <code className={ui.inlineCode}>@slipway/sdk</code> (in the repository under{" "}
              <code className={ui.inlineCode}>packages/sdk</code>) wraps every route with types:{" "}
              <code className={ui.inlineCode}>options</code>, <code className={ui.inlineCode}>plan</code>,{" "}
              <code className={ui.inlineCode}>tickets</code>, <code className={ui.inlineCode}>market</code>,{" "}
              <code className={ui.inlineCode}>tide</code>, <code className={ui.inlineCode}>trackRecord</code>,{" "}
              <code className={ui.inlineCode}>research</code>, <code className={ui.inlineCode}>explain</code>,{" "}
              <code className={ui.inlineCode}>keys</code>. Errors throw{" "}
              <code className={ui.inlineCode}>SlipwayApiError</code> with the status and code.
            </p>
            <OriginCode
              title="plan.ts"
              code={`import { SlipwayClient } from "@slipway/sdk";

const slipway = new SlipwayClient({ baseUrl: "{ORIGIN}" });
const intent = { symbol: "NVDA", side: "buy", notionalUsd: 40000 } as const;

const { data: options } = await slipway.options({ intent });
const { data: plan } = await slipway.plan({ intent, strategyId: "best" });

if (plan.verdict === "allow") {
  // only after the trader confirms
  const { data: t } = await slipway.tickets({ signedPlan: plan.signedPlan });
  if (t.ok) for (const ticket of t.tickets) console.log(ticket.bgc);
} else {
  console.log(plan.checks.filter((c) => c.status !== "pass"));
}`}
            />
          </section>

          <section id="verify" className={styles.section}>
            <h2 className={styles.h2}>Verify</h2>
            <p>
              Forecasts are registered before their outcomes print, in a hash-chained ledger that anyone can
              download. The evaluation protocol was committed before the data; its canonical hash is{" "}
              {hash ? <code className={ui.inlineCode}>{hash}</code> : "published in the track record"}.
            </p>
            <CodeBlock
              title="shell"
              code={`git clone ${REPO_URL}\ncd slipway && pnpm install\npnpm verify`}
            />
            <p>The verifier, with no credentials:</p>
            <ul className={styles.list}>
              <li>downloads the public ledger and checks both hash chains (evaluation and trader);</li>
              <li>verifies every plan signature against the desk’s Ed25519 key;</li>
              <li>checks Merkle roots against the on-chain anchors, once anchors exist;</li>
              <li>re-grades a random sample of forecasts from the public tape;</li>
              <li>runs negative controls that must fail.</li>
            </ul>
            <h3 className={styles.h3}>Where everything lives</h3>
            <ul className={styles.paths}>
              <li>
                <code>ledger/&lt;chain&gt;/&lt;date&gt;/&lt;registeredAt&gt;-&lt;hash16&gt;.jsonl</code>
                <span>
                  one forecast entry per line, each carrying the previous entry’s hash; the tip in head.json
                </span>
                <a href={`${LISTING_BASE}?prefix=ledger/`}>list</a>
              </li>
              <li>
                <code>grades/eval/…json</code>
                <span>the grade of every entry, next to its ledger file</span>
                <a href={`${LISTING_BASE}?prefix=grades/`}>list</a>
              </li>
              <li>
                <code>eval/batches/…json</code>
                <span>each batch: seed, orders, plan hashes, the saved market snapshot</span>
                <a href={`${LISTING_BASE}?prefix=eval/`}>list</a>
              </li>
              <li>
                <code>anchors/&lt;i&gt;.json</code>
                <span>
                  Merkle roots posted to Arbitrum One every three hours, once the contract is deployed
                </span>
                <a href={`${LISTING_BASE}?prefix=anchors/`}>list</a>
              </li>
              <li>
                <code>derived/track-record.json</code>
                <span>everything on the track-record page</span>
                <a href={TRACK_RECORD_URL}>open</a>
              </li>
              <li>
                <code>tape/</code>
                <span>the recorded Bitget books and trades the grades are walked on</span>
                <a href={`${LISTING_BASE}?prefix=tape/`}>list</a>
              </li>
            </ul>
            <p className={styles.small}>
              Bucket: <code className={ui.inlineCode}>{PUBLIC_BASE}</code>. Results:{" "}
              <Link className={ui.textLink} href="/track-record">
                track record
              </Link>
              .
            </p>
          </section>

          <section id="limits" className={styles.section}>
            <h2 className={styles.h2}>Honest limits</h2>
            <p>
              What Slipway does not know, or cannot claim yet. Each of these shapes what the desk will say.
            </p>
            <dl className={styles.limits}>
              <div>
                <dt>rToken prints are not public</dt>
                <dd>
                  Routed rToken fills do not appear on Bitget’s public trade feed. rToken trade flow and
                  touch-hit rates are the public-print rates, which makes passive rToken fills look unlikely;
                  they are reported as measured, never imputed. The rToken’s 24-hour volume mirrors the US
                  tape and is never used as Bitget liquidity.
                </dd>
              </div>
              <div>
                <dt>No weekend books before the deadline</dt>
                <dd>
                  The recorder started on Monday 5 October 2026. The first weekend it will see is 10–11
                  October, after submission, so weekend claims rest on hourly candles only, and the atlas
                  shows the weekend as not recorded.
                </dd>
              </div>
              <div>
                <dt>bitget-mcp-server was down during the build</dt>
                <dd>
                  Its backend answered 503 for all of 5 October. Everything from it (earnings calendar,
                  dividends and splits, the cash quote, news, fear and greed) sits behind a cache that reports
                  “unavailable since” and is never on the critical path of a plan.
                </dd>
              </div>
              <div>
                <dt>The spelled-out-number guard is best-effort</dt>
                <dd>
                  Model-written text cannot contain a numeral of any script: every figure is a code-filled
                  slot. Spelled-out numbers are caught only from English, Russian and Chinese word lists;
                  other languages and paraphrases such as “a handful” pass. Every surface renders model text
                  as plain text, never as HTML.
                </dd>
              </div>
              <div>
                <dt>Shadow fills ignore our own impact, except where modelled</dt>
                <dd>
                  The headline grade (reproducible) walks each slice on the book as it was recorded, with no
                  carry-over of our own depletion. Modeled adds a carry-over that decays with the measured
                  refill half-life, 60 seconds where none was measured; bound assumes no refill at all. None
                  of them captures how other traders would have reacted to a real order.
                </dd>
              </div>
              <div>
                <dt>No paper trading, so dry-run tickets only</dt>
                <dd>
                  Bitget’s paper trading needs a verified account, so Slipway never places an order, real or
                  simulated. The evaluation grades pre-registered hypothetical orders against the recorded
                  book, not fills.
                </dd>
              </div>
              <div>
                <dt>Not anchored on-chain yet</dt>
                <dd>
                  Until the anchor contract is deployed, forecasts are ledger-timestamped only: the hash chain
                  proves order and integrity, the storage write times prove when.
                </dd>
              </div>
              <div>
                <dt>Assumptions in the cost model</dt>
                <dd>
                  The p10–p90 band assumes a normal error around the expected cost. Funding over a hold uses
                  the current rate as its forecast. Perps are treated as trading around the clock. Calibration
                  factors have not yet improved out-of-sample error and are reported as such.
                </dd>
              </div>
            </dl>
          </section>
        </article>
      </main>
      <Footer />
    </>
  );
}

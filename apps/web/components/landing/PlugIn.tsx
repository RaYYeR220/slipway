import Link from "next/link";
import { REPO_URL } from "../site/data";
import ui from "../site/ui.module.css";
import styles from "./landing.module.css";
import { OriginCode } from "./OriginCode";

const ENTRIES = [
  {
    id: "mcp",
    name: "MCP",
    line: "Streamable HTTP, stateless. Read-only and dry-run tools, with a plan card for MCP Apps hosts.",
    title: "mcp.json",
    code: `{
  "mcpServers": {
    "slipway": { "type": "http", "url": "{ORIGIN}/api/mcp" }
  }
}`,
  },
  {
    id: "skill",
    name: "Skill",
    line: "Bitget’s skill format: when to call which tool, and the confirm-before-ticket rule.",
    title: "shell",
    code: `git clone ${REPO_URL}
cp -r slipway/skills/slipway <your-agent-skills-dir>/slipway`,
  },
  {
    id: "sdk",
    name: "SDK",
    line: "A typed TypeScript client for the HTTP API. Fetch only: browsers, Node and edge runtimes.",
    title: "options.ts",
    code: `import { SlipwayClient } from "@slipway/sdk";

const slipway = new SlipwayClient({ baseUrl: "{ORIGIN}" });
const { data } = await slipway.options({
  intent: {
    symbol: "NVDA", side: "buy",
    notionalUsd: 40000, deadline: "before thursday",
  },
});
console.log(data.best?.label, data.best?.expectedBps);`,
  },
  {
    id: "api",
    name: "HTTP API",
    line: "JSON over HTTP, no keys. Every response is { data, slots, sources }.",
    title: "shell",
    code: `curl -s {ORIGIN}/api/plan/options \\
  -H 'content-type: application/json' \\
  -d '{"intent":{"symbol":"NVDA","side":"buy","notionalUsd":40000}}'`,
  },
];

export function PlugIn() {
  return (
    <div className={styles.plug}>
      {ENTRIES.map((e) => (
        <div key={e.id} className={styles.plugItem}>
          <h3 className={styles.plugName}>{e.name}</h3>
          <p className={styles.plugLine}>{e.line}</p>
          <OriginCode title={e.title} code={e.code} />
        </div>
      ))}
      <p className={styles.more}>
        Every tool, route and response shape is in the{" "}
        <Link className={ui.textLink} href="/docs">
          docs
        </Link>
        .
      </p>
    </div>
  );
}

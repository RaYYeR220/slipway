// Builds public/data/hour-of-week.json: median traded value (USDT) and median high-low range (bp) per New York
// hour-of-week for every symbol × venue, from Bitget's public 1h candles (keyless). Run from apps/web:
//   node app/atlas/_data/hour-of-week.mjs
// Index 0 = Sunday 00:00–01:00 America/New_York; 167 = Saturday 23:00. Incomplete (current) hours are dropped.
import { writeFile } from "node:fs/promises";

const ENDPOINT = "https://api.bitget.com/api/v3/market/history-candles";
const UNIVERSE = [
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "AMZN",
  "GOOGL",
  "META",
  "AMD",
  "MU",
  "INTC",
  "MSTR",
  "COIN",
  "CRCL",
  "HOOD",
  "PLTR",
  "SPY",
  "QQQ",
  "SOXL",
];
const VENUES = {
  rtoken: { category: "SPOT", sym: (s) => `R${s}USDT` },
  perp: { category: "USDT-FUTURES", sym: (s) => `${s}USDT` },
};
const PAGES = 8; // 8 × 100 h ≈ 33 days
const HOUR = 3_600_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});
const howOf = (ts) => {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return DAYS.indexOf(p.weekday) * 24 + (Number(p.hour) % 24);
};
const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function candles(category, symbol, now) {
  const rows = new Map();
  let end = now;
  for (let i = 0; i < PAGES; i++) {
    const url = `${ENDPOINT}?category=${category}&symbol=${symbol}&interval=1H&endTime=${end}&limit=100`;
    let body = null;
    for (let attempt = 0; attempt < 4 && !body; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}`);
        body = await res.json();
      } catch (e) {
        if (attempt === 3) throw e;
        await sleep(800 * (attempt + 1));
      }
    }
    const data = body.data ?? [];
    if (!data.length) break;
    for (const r of data) rows.set(Number(r[0]), r);
    end = Math.min(...data.map((r) => Number(r[0]))) - 1;
    await sleep(120);
  }
  return [...rows.values()].filter((r) => Number(r[0]) + HOUR <= now);
}

const now = Date.now();
const out = {
  generatedAt: new Date(now).toISOString(),
  source: {
    endpoint: ENDPOINT,
    params:
      "category=SPOT (rToken R<SYM>USDT) | USDT-FUTURES (perp <SYM>USDT), interval=1H, limit=100, paged by endTime",
    value: "quote volume (USDT), candle field 6; range = (high − low) / close in bp",
    statistic: "median across weeks per New York hour-of-week (index 0 = Sunday 00:00 ET)",
  },
  from: null,
  to: null,
  series: {},
};
for (const s of UNIVERSE) {
  out.series[s] = {};
  for (const [venue, v] of Object.entries(VENUES)) {
    const symbol = v.sym(s);
    let rows = [];
    try {
      rows = await candles(v.category, symbol, now);
    } catch (e) {
      console.error(symbol, e.message);
    }
    if (!rows.length) {
      out.series[s][venue] = null;
      continue;
    }
    const vol = Array.from({ length: 168 }, () => []);
    const rng = Array.from({ length: 168 }, () => []);
    for (const r of rows) {
      const ts = Number(r[0]);
      const h = howOf(ts);
      const close = Number(r[4]);
      vol[h].push(Number(r[6] ?? r[5]));
      if (close > 0) rng[h].push(((Number(r[2]) - Number(r[3])) / close) * 1e4);
      out.from = out.from === null ? ts : Math.min(out.from, ts);
      out.to = out.to === null ? ts + HOUR : Math.max(out.to, ts + HOUR);
    }
    const ts = rows.map((r) => Number(r[0]));
    out.series[s][venue] = {
      symbol,
      hours: rows.length,
      from: Math.min(...ts),
      to: Math.max(...ts) + HOUR,
      vol: vol.map((x) => (x.length ? Math.round(median(x)) : null)),
      rng: rng.map((x) => (x.length ? Math.round(median(x) * 10) / 10 : null)),
      weeks: vol.map((x) => x.length),
    };
    console.log(symbol, rows.length, "h");
  }
}
const target = new URL("../../../public/data/hour-of-week.json", import.meta.url);
await writeFile(target, JSON.stringify(out));
console.log("wrote", target.pathname);

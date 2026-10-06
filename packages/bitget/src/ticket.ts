// Per-slice order tickets built through Bitget's official agent SDK in dry-run mode: the body is exactly what
// `@bitget-ai/bitget-agent-sdk` would POST to /api/v3/trade/*, plus the equivalent `bgc` command.
// The SDK runs in readOnly mode with no credentials, so nothing can be sent even if dry-run were bypassed.
import { createRequire } from "node:module";
import {
  BitgetRestClient,
  buildTools,
  getOperation,
  loadConfig,
  safeInvoke,
  type ToolSpec,
} from "@bitget-ai/bitget-agent-sdk";
import type { Session, Side, Slice, Venue } from "@slipway/core";
import { exchangeSymbol, instTypeOf } from "./symbols.js";
import type { InstrumentRules } from "./types.js";

export const SDK_VERSION: string = (
  createRequire(import.meta.url)("@bitget-ai/bitget-agent-sdk/package.json") as { version: string }
).version;

export type TicketKind = "ioc_limit" | "post_only" | "gtc_limit" | "market" | "cancel_remaining_then_market";
export type OrderAction = "place" | "cancel";

export interface TicketRequest {
  operationId: string;
  method: string;
  path: string;
  body: Record<string, string>;
}

export interface CancelStep extends TicketRequest {
  targetIndex: number;
  targetClientOid: string;
  bgc: string;
}

export interface OrderTicket {
  index: number;
  clientOid: string;
  venue: Venue;
  symbol: string;
  side: Side;
  t: number;
  session: Session;
  kind: TicketKind;
  /** Sent only for the unfilled remainder of an earlier passive ticket, after `cancel`. */
  conditional: boolean;
  qty: number; // base units after rounding to the instrument step (an upper bound when conditional)
  limitPx: number | null; // after rounding to tick / clamping to the price band
  request: TicketRequest;
  bgc: string;
  cancel?: CancelStep;
  notes: string[];
  violations: string[];
  sdkVersion: string;
}

export interface TicketOptions {
  underlying: string;
  rules: Partial<Record<Venue, InstrumentRules>>;
  /** Arrival mid per venue: used for price-band checks, notional limits and spot market-buy sizing. */
  refPx?: Partial<Record<Venue, number>>;
  /** Short id that makes client order ids deterministic (e.g. the first hex chars of the signed plan hash). */
  clientOidPrefix: string;
  /** Cap for market slices that carry no limitPx: IOC limit at ref × (1 ± bps). Without it they stay market orders. */
  maxSlippageBps?: number;
  positionMode?: "one_way" | "hedge";
}

const EPS = 1e-9;

function onStep(x: number, step: number, mode: "up" | "down"): number {
  const raw = x / step;
  const near = Math.round(raw);
  const n = Math.abs(raw - near) < 1e-6 ? near : raw; // absorb binary representation noise
  return (mode === "up" ? Math.ceil(n) : Math.floor(n)) * step;
}

const fixed = (x: number, places: number): string => x.toFixed(places);
const usd = (x: number): string => `$${Math.round(x).toLocaleString("en-US")}`;

/** Rejects anything the SDK catalog would not accept for an operation: unknown fields, missing required, bad enums. */
export function validateOperation(operationId: string, body: Record<string, unknown>): string[] {
  const op = getOperation(operationId);
  if (!op) return [`SDK catalog has no ${operationId} operation`];
  const errs: string[] = [];
  const params = new Map(op.bodyParams.map((p) => [p.name, p]));
  for (const p of op.bodyParams) {
    if (p.required && body[p.name] === undefined) errs.push(`missing required field ${p.name}`);
  }
  for (const [k, v] of Object.entries(body)) {
    const p = params.get(k);
    if (!p) {
      errs.push(`unknown field ${k}`);
      continue;
    }
    if (typeof v !== "string") errs.push(`${k} must be a string`);
    else if (p.enum && !p.enum.includes(v)) errs.push(`${k}=${v} not in [${p.enum.join(", ")}]`);
  }
  return errs;
}

export function validatePlaceOrder(body: Record<string, unknown>): string[] {
  const errs = validateOperation("placeOrder", body);
  if (body.orderType === "limit" && (body.price === undefined || body.timeInForce === undefined)) {
    errs.push("limit orders need price and timeInForce");
  }
  if (body.orderType === "market" && body.price !== undefined)
    errs.push("market orders must not carry a price");
  return errs;
}

const FIELD_ORDER = [
  "category",
  "symbol",
  "side",
  "orderType",
  "price",
  "qty",
  "timeInForce",
  "posSide",
  "reduceOnly",
  "orderId",
  "clientOid",
];

/** `bgc` argv equivalent to an order body (read-only, dry-run). */
export function bgcArgs(body: Record<string, string>, action: OrderAction = "place"): string[] {
  const keys = [
    ...FIELD_ORDER.filter((k) => k in body),
    ...Object.keys(body).filter((k) => !FIELD_ORDER.includes(k)),
  ];
  return [
    "--read-only",
    "order",
    "--action",
    action,
    ...keys.flatMap((k) => [`--${k}`, body[k] as string]),
    "--dry-run",
  ];
}

const shellQuote = (s: string): string => (/^[\w.:/@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export const bgcCommand = (body: Record<string, string>, action: OrderAction = "place"): string =>
  ["bgc", ...bgcArgs(body, action)].map(shellQuote).join(" ");

let orderTool: {
  spec: ToolSpec;
  ctx: { config: ReturnType<typeof loadConfig>; client: BitgetRestClient };
} | null = null;

function sdkOrderTool() {
  if (!orderTool) {
    // loadConfig falls back to BITGET_* env vars and a stored OAuth file; strip any credentials it found.
    const loaded = loadConfig({ modules: "all", readOnly: true });
    const config = {
      ...loaded,
      apiKey: undefined,
      secretKey: undefined,
      passphrase: undefined,
      hasAuth: false,
      readOnly: true,
    };
    const spec = buildTools(config).find((t) => t.name === "order");
    if (!spec) throw new Error("SDK exposes no `order` tool");
    orderTool = { spec, ctx: { config, client: new BitgetRestClient(config) } };
  }
  return orderTool;
}

/** Runs the SDK `order` verb with dryRun and returns the request it would send. */
export async function sdkDryRun(
  body: Record<string, string>,
  action: OrderAction = "place",
): Promise<TicketRequest> {
  const { spec, ctx } = sdkOrderTool();
  const res = await safeInvoke(spec, { action, ...body, dryRun: true }, ctx);
  if (!res.ok) throw new Error(`SDK rejected the ${action}: ${JSON.stringify(res).slice(0, 200)}`);
  const d = res.data as {
    dryRun?: boolean;
    operationId?: string;
    method?: string;
    path?: string;
    wouldSend?: Record<string, unknown>;
  };
  if (d.dryRun !== true || !d.wouldSend || !d.path || !d.method || !d.operationId) {
    throw new Error("SDK did not return a dry-run preview");
  }
  const sent: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.wouldSend)) sent[k] = String(v);
  return { operationId: d.operationId, method: d.method, path: d.path, body: sent };
}

interface Draft {
  body: Record<string, string>;
  kind: Exclude<TicketKind, "cancel_remaining_then_market">;
  qty: number;
  limitPx: number | null;
  notes: string[];
  violations: string[];
}

/** Bitget's per-order maxima; a breach is refused with the split needed (splitting is the planner's job). */
function venueLimits(
  venue: Venue,
  market: boolean,
  qty: number,
  px: number | undefined,
  r: InstrumentRules,
): { notes: string[]; violations: string[] } {
  const notes: string[] = [];
  const violations: string[] = [];
  const parts = (n: number) => `split into at least ${Math.ceil(n)} orders`;
  if (venue === "perp") {
    const max = market ? r.maxMarketQty : r.maxLimitQty;
    const field = market ? "maxMarketOrderQty" : "maxOrderQty";
    if (max === null) notes.push(`Bitget publishes no ${field} for ${r.symbol}`);
    else if (qty > max + EPS)
      violations.push(
        `qty ${qty} exceeds Bitget's per-order ${field} ${max} for ${r.symbol}; ${parts(qty / max)}`,
      );
  } else {
    const max = market ? r.maxMarketNotional : r.maxLimitNotional;
    const field = market ? "maxMarketOrderValue" : "maxLimitOrderValue";
    if (max === null) notes.push(`Bitget publishes no ${field} for ${r.symbol}`);
    else if (px === undefined) notes.push(`no price to check ${field} ${usd(max)}`);
    else if (qty * px > max + EPS)
      violations.push(
        `notional ${usd(qty * px)} exceeds Bitget's per-order ${field} ${usd(max)} for ${r.symbol}; ${parts((qty * px) / max)}`,
      );
  }
  return { notes, violations };
}

function draft(
  slice: Slice,
  rules: InstrumentRules,
  ref: number | undefined,
  clientOid: string,
  reduceOnly: boolean,
  posSide: "long" | "short" | null,
  opts: TicketOptions,
): Draft {
  const notes: string[] = [];
  const violations: string[] = [];
  const buy = slice.side === "buy";
  const qty = onStep(slice.qty, rules.qtyStep, "down");
  if (qty < slice.qty - EPS)
    notes.push(`qty ${slice.qty} rounded down to step ${rules.qtyStep}: ${fixed(qty, rules.qtyPlace)}`);
  if (qty <= 0 || qty < rules.minQty - EPS)
    violations.push(`qty ${fixed(qty, rules.qtyPlace)} below minimum ${rules.minQty}`);

  let kind: Draft["kind"];
  let px: number | null = null;
  if (slice.type === "limit") {
    if (slice.limitPx === undefined) violations.push("limit slice without limitPx");
    kind = slice.postOnly ? "post_only" : "gtc_limit";
    px = slice.limitPx ?? null;
  } else if (slice.limitPx !== undefined) {
    kind = "ioc_limit";
    px = slice.limitPx;
  } else if (opts.maxSlippageBps !== undefined && ref !== undefined) {
    kind = "ioc_limit";
    px = ref * (1 + ((buy ? 1 : -1) * opts.maxSlippageBps) / 10_000);
    notes.push(`market slice capped at ${opts.maxSlippageBps} bps from ref ${ref}`);
  } else {
    kind = "market";
  }

  if (px !== null) {
    const passive = kind === "post_only" || kind === "gtc_limit";
    // Aggressive caps round away from the book so they still reach the walked level; passive quotes round inward.
    px = onStep(px, rules.priceTick, buy !== passive ? "up" : "down");
    if (ref !== undefined) {
      const band = buy ? rules.buyLimitPriceRatio : rules.sellLimitPriceRatio;
      if (band !== null) {
        const bound = onStep(ref * (buy ? 1 + band : 1 - band), rules.priceTick, buy ? "down" : "up");
        if (buy ? px > bound : px < bound) {
          notes.push(
            `limit ${fixed(px, rules.pricePlace)} outside Bitget's ${band * 100}% price band; clamped to ${fixed(bound, rules.pricePlace)}`,
          );
          px = bound;
        }
      }
    } else {
      notes.push("no reference price: price-band check skipped");
    }
  }

  const body: Record<string, string> = {
    category: instTypeOf(slice.venue),
    symbol: rules.symbol,
    side: slice.side,
    orderType: kind === "market" ? "market" : "limit",
  };
  if (px !== null) body.price = fixed(px, rules.pricePlace);
  if (kind === "market" && slice.venue === "rtoken" && buy) {
    if (ref === undefined) {
      violations.push("spot market buy is sized in USDT: a reference price is required");
      body.qty = fixed(qty, rules.qtyPlace);
    } else {
      body.qty = fixed(onStep(qty * ref, 10 ** -rules.quotePlace, "down"), rules.quotePlace);
      notes.push(
        `spot market buy: qty expressed in USDT (${body.qty} = ${fixed(qty, rules.qtyPlace)} sh x ref ${ref})`,
      );
    }
  } else {
    body.qty = fixed(qty, rules.qtyPlace);
  }
  if (kind === "ioc_limit") body.timeInForce = "ioc";
  if (kind === "post_only") body.timeInForce = "post_only";
  if (kind === "gtc_limit") body.timeInForce = "gtc";
  if (posSide) body.posSide = posSide;
  if (reduceOnly) body.reduceOnly = "yes";
  body.clientOid = clientOid;

  const notionalPx = px ?? ref;
  if (notionalPx !== undefined && qty * notionalPx < rules.minNotional - EPS) {
    violations.push(`notional ${(qty * notionalPx).toFixed(2)} USDT below minimum ${rules.minNotional}`);
  }
  const limits = venueLimits(slice.venue, kind === "market", qty, notionalPx, rules);
  return {
    body,
    kind,
    qty,
    limitPx: px,
    notes: [...notes, ...limits.notes],
    violations: [...violations, ...limits.violations],
  };
}

/**
 * Tickets for a schedule. Perp position is tracked across slices so legs that reduce it (the rotate-out leg of
 * perp_then_rotate) are reduce-only, or carry the position side in hedge mode. A `conditional` slice is the
 * cross-the-spread fallback of the preceding passive slice: it is rendered as cancel-remaining-then-market.
 */
export async function buildTickets(slices: Slice[], opts: TicketOptions): Promise<OrderTicket[]> {
  const out: OrderTicket[] = [];
  let perpPos = 0;
  const mode = opts.positionMode ?? "one_way";
  for (const [i, slice] of slices.entries()) {
    const rules = opts.rules[slice.venue];
    const symbol = exchangeSymbol(slice.venue, opts.underlying);
    if (!rules) throw new Error(`no instrument rules for ${slice.venue}`);
    if (rules.symbol !== symbol) throw new Error(`rules are for ${rules.symbol}, slice needs ${symbol}`);
    const conditional = slice.conditional === true;
    const signed = slice.side === "buy" ? slice.qty : -slice.qty;
    let reduceOnly = false;
    let posSide: "long" | "short" | null = null;
    if (slice.venue === "perp") {
      reduceOnly = slice.leg === "rotate_out" || (perpPos !== 0 && Math.sign(signed) !== Math.sign(perpPos));
      if (mode === "hedge") {
        const closing = reduceOnly
          ? perpPos !== 0
            ? perpPos > 0
              ? "long"
              : "short"
            : slice.side === "sell"
              ? "long"
              : "short"
          : null;
        posSide = closing ?? (signed > 0 ? "long" : "short");
      }
      if (!conditional) perpPos += signed;
    }
    const clientOid = `${opts.clientOidPrefix}${String(i).padStart(2, "0")}`.slice(0, 40);
    const d = draft(
      slice,
      rules,
      opts.refPx?.[slice.venue],
      clientOid,
      reduceOnly && mode === "one_way",
      posSide,
      opts,
    );
    if (reduceOnly && mode === "hedge") d.notes.push(`closes ${posSide} perp position (hedge mode)`);
    if (slice.venue === "perp" && mode === "one_way")
      d.notes.push("assumes one-way position mode; hedge-mode accounts need posSide");
    const violations = [...d.violations, ...validatePlaceOrder(d.body)];

    let cancel: CancelStep | undefined;
    if (conditional) {
      const target = [...out]
        .reverse()
        .find(
          (t) =>
            !t.conditional &&
            t.venue === slice.venue &&
            t.side === slice.side &&
            (t.kind === "post_only" || t.kind === "gtc_limit"),
        );
      if (!target) {
        violations.push("conditional slice has no preceding passive order on the same venue and side");
      } else {
        const body = { category: instTypeOf(slice.venue), clientOid: target.clientOid };
        violations.push(...validateOperation("cancelOrder", body));
        cancel = {
          ...(await sdkDryRun(body, "cancel")),
          targetIndex: target.index,
          targetClientOid: target.clientOid,
          bgc: bgcCommand(body, "cancel"),
        };
        d.notes.unshift(
          `cancel-remaining-then-market: at t, cancel ticket #${target.index} (${target.clientOid}); send this order only if it was not fully filled, for qty = ${fixed(d.qty, rules.qtyPlace)} minus its filled qty`,
        );
      }
    }

    const request = await sdkDryRun(d.body);
    out.push({
      index: i,
      clientOid,
      venue: slice.venue,
      symbol,
      side: slice.side,
      t: slice.t,
      session: slice.session,
      kind: conditional ? "cancel_remaining_then_market" : d.kind,
      conditional,
      qty: d.qty,
      limitPx: d.limitPx,
      request,
      bgc: bgcCommand(request.body),
      ...(cancel ? { cancel } : {}),
      notes: d.notes,
      violations,
      sdkVersion: SDK_VERSION,
    });
  }
  return out;
}

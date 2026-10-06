// Public WebSocket client for wss://ws.bitget.com/v2/ws/public (books1/5/15, trade, ticker) with heartbeat,
// liveness watchdog and jittered exponential reconnect. Uses the platform WebSocket (Node >= 22); no dependencies.
import type { Book, Venue } from "@slipway/core";
import { ParseError, parseTradeRow, parseWsBookData, parseWsTickerRow } from "./parse.js";
import { exchangeSymbol, instTypeOf, underlyingOf, venueOfInstType } from "./symbols.js";
import type { Trade, WsTicker } from "./types.js";

export const BITGET_WS_PUBLIC = "wss://ws.bitget.com/v2/ws/public";

export type WsChannel = "books1" | "books5" | "books15" | "trade" | "ticker";

export interface WsSubscription {
  venue: Venue;
  underlying: string;
  channel: WsChannel;
}

export type WsEvent =
  | {
      type: "book";
      venue: Venue;
      underlying: string;
      channel: WsChannel;
      book: Book;
      seq: number | null;
      receivedAt: number;
    }
  | {
      type: "trades";
      venue: Venue;
      underlying: string;
      trades: Trade[];
      snapshot: boolean;
      receivedAt: number;
    }
  | { type: "ticker"; venue: Venue; underlying: string; ticker: WsTicker; receivedAt: number }
  | { type: "subscribed"; venue: Venue; underlying: string; channel: string }
  | { type: "error"; code: number | null; detail: string; arg?: unknown }
  | { type: "pong"; receivedAt: number }
  | {
      type: "status";
      state: "connecting" | "open" | "closed" | "reconnecting";
      attempt: number;
      detail?: string;
    };

const BOOK_CHANNELS = new Set(["books1", "books5", "books15"]);

/** Pure decoder for one WS frame (exported for replaying recorded tape). */
export function parseWsMessage(raw: string, receivedAt: number): WsEvent[] {
  if (raw === "pong") return [{ type: "pong", receivedAt }];
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [{ type: "error", code: null, detail: `unparseable frame: ${raw.slice(0, 80)}` }];
  }
  const arg = (msg.arg ?? {}) as { instType?: string; channel?: string; instId?: string };
  const venue = venueOfInstType(arg.instType ?? "");
  if (msg.event === "error") {
    return [
      {
        type: "error",
        code: typeof msg.code === "number" ? msg.code : null,
        detail: String(msg.msg ?? "error"),
        arg,
      },
    ];
  }
  if (!venue || !arg.instId || !arg.channel) return [];
  let underlying: string;
  try {
    underlying = underlyingOf(venue, arg.instId);
  } catch {
    return [{ type: "error", code: null, detail: `unexpected instId ${arg.instId}`, arg }];
  }
  if (msg.event === "subscribe") return [{ type: "subscribed", venue, underlying, channel: arg.channel }];
  if (!Array.isArray(msg.data)) return [];
  try {
    if (BOOK_CHANNELS.has(arg.channel)) {
      return msg.data.map((d) => {
        const { seq, ...book } = parseWsBookData(d, venue, underlying);
        return { type: "book", venue, underlying, channel: arg.channel as WsChannel, book, seq, receivedAt };
      });
    }
    if (arg.channel === "trade") {
      return [
        {
          type: "trades",
          venue,
          underlying,
          trades: msg.data.map(parseTradeRow),
          snapshot: msg.action === "snapshot",
          receivedAt,
        },
      ];
    }
    if (arg.channel === "ticker") {
      return msg.data.map((t) => ({
        type: "ticker",
        venue,
        underlying,
        ticker: parseWsTickerRow(t),
        receivedAt,
      }));
    }
  } catch (err) {
    if (err instanceof ParseError) return [{ type: "error", code: null, detail: err.message, arg }];
    throw err;
  }
  return [];
}

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface BitgetWsOptions {
  url?: string;
  WebSocketImpl?: WebSocketCtor;
  /** Bitget drops idle connections; ping well under its 30 s window. */
  pingIntervalMs?: number;
  /** Reconnect when nothing (not even a pong) arrived for this long. */
  idleTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  clock?: () => number;
  random?: () => number;
}

const OPEN = 1;
const MAX_ARGS_PER_FRAME = 40;

const subKey = (s: WsSubscription): string => `${s.venue}|${s.underlying.toUpperCase()}|${s.channel}`;
const toArg = (s: WsSubscription) => ({
  instType: instTypeOf(s.venue),
  channel: s.channel,
  instId: exchangeSymbol(s.venue, s.underlying),
});

export class BitgetPublicWs {
  private ws: WebSocketLike | null = null;
  private readonly subs = new Map<string, WsSubscription>();
  private readonly listeners = new Set<(e: WsEvent) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastSeen = 0;
  private running = false;
  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: BitgetWsOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  onEvent(listener: (e: WsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get connected(): boolean {
    return this.ws?.readyState === OPEN;
  }

  subscribe(subs: WsSubscription[]): void {
    const fresh = subs.filter((s) => !this.subs.has(subKey(s)));
    for (const s of fresh) this.subs.set(subKey(s), s);
    if (this.connected) this.sendOp("subscribe", fresh);
  }

  unsubscribe(subs: WsSubscription[]): void {
    const gone = subs.filter((s) => this.subs.delete(subKey(s)));
    if (this.connected) this.sendOp("unsubscribe", gone);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close(1000, "client stop");
    }
    this.emit({ type: "status", state: "closed", attempt: this.attempt });
  }

  private emit(e: WsEvent): void {
    for (const l of this.listeners) l(e);
  }

  private sendOp(op: "subscribe" | "unsubscribe", subs: WsSubscription[]): void {
    for (let i = 0; i < subs.length; i += MAX_ARGS_PER_FRAME) {
      this.ws?.send(JSON.stringify({ op, args: subs.slice(i, i + MAX_ARGS_PER_FRAME).map(toArg) }));
    }
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private connect(): void {
    const Impl = this.opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    this.emit({ type: "status", state: "connecting", attempt: this.attempt });
    const ws = new Impl(this.opts.url ?? BITGET_WS_PUBLIC);
    this.ws = ws;
    ws.onopen = () => {
      this.lastSeen = this.clock();
      this.emit({ type: "status", state: "open", attempt: this.attempt });
      this.sendOp("subscribe", [...this.subs.values()]);
      const pingEvery = this.opts.pingIntervalMs ?? 25_000;
      const idle = this.opts.idleTimeoutMs ?? 2 * pingEvery + 5_000;
      this.pingTimer = setInterval(() => {
        if (this.clock() - this.lastSeen > idle) {
          ws.close(4000, "idle timeout");
          return;
        }
        if (ws.readyState === OPEN) ws.send("ping");
      }, pingEvery);
    };
    ws.onmessage = (ev) => {
      const now = this.clock();
      this.lastSeen = now;
      this.attempt = 0;
      for (const e of parseWsMessage(String(ev.data), now)) this.emit(e);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      this.clearTimers();
      this.ws = null;
      if (!this.running) return;
      const base = this.opts.reconnectBaseMs ?? 500;
      const cap = this.opts.reconnectMaxMs ?? 30_000;
      const delay = Math.round(Math.min(cap, base * 2 ** this.attempt) * (0.5 + this.random() / 2));
      this.attempt += 1;
      this.emit({
        type: "status",
        state: "reconnecting",
        attempt: this.attempt,
        detail: `closed (${ev.code ?? "?"}${ev.reason ? ` ${ev.reason}` : ""}); retry in ${delay} ms`,
      });
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }
}

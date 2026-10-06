import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BitgetPublicWs, parseWsMessage, type WebSocketCtor, type WsEvent } from "../src/ws.js";
import { fixture } from "./helpers.js";

interface Frame {
  dt: number;
  data: string;
}
const session = fixture<{ recordedAt: number; messages: Frame[] }>("ws/public-session.json");

describe("parseWsMessage on recorded frames", () => {
  const events = session.messages.flatMap((m) => parseWsMessage(m.data, session.recordedAt + m.dt));

  it("decodes acks, the pong and the error for an unknown instrument", () => {
    expect(events.filter((e) => e.type === "subscribed")).toHaveLength(6);
    expect(events.some((e) => e.type === "pong")).toBe(true);
    const err = events.find((e) => e.type === "error");
    expect(err).toMatchObject({ type: "error", code: 30001 });
  });

  it("decodes books15 for both venues into sorted numeric books", () => {
    const books = events.filter((e): e is Extract<WsEvent, { type: "book" }> => e.type === "book");
    const venues = new Set(books.map((b) => b.venue));
    expect(venues).toEqual(new Set(["rtoken", "perp"]));
    for (const b of books) {
      expect(b.underlying).toBe("NVDA");
      expect(b.book.bids).toHaveLength(15);
      expect(b.book.asks).toHaveLength(15);
      expect((b.book.bids[0] as { px: number }).px).toBeLessThan((b.book.asks[0] as { px: number }).px);
      expect(b.receivedAt - b.book.ts).toBeGreaterThan(0);
      expect(b.receivedAt - b.book.ts).toBeLessThan(2_000);
    }
  });

  it("decodes trades (snapshot then updates) and tickers with perp funding fields", () => {
    const trades = events.filter((e): e is Extract<WsEvent, { type: "trades" }> => e.type === "trades");
    expect(trades.some((t) => t.snapshot)).toBe(true);
    expect(trades.some((t) => !t.snapshot && t.venue === "perp")).toBe(true);
    const perpTicker = events.find(
      (e): e is Extract<WsEvent, { type: "ticker" }> => e.type === "ticker" && e.venue === "perp",
    );
    expect(perpTicker?.ticker.nextFundingTime).toBeGreaterThan(session.recordedAt);
    expect(perpTicker?.ticker.markPrice).toBeGreaterThan(0);
    const spotTicker = events.find(
      (e): e is Extract<WsEvent, { type: "ticker" }> => e.type === "ticker" && e.venue === "rtoken",
    );
    expect(spotTicker?.ticker.markPrice).toBeNull();
  });

  it("turns garbage into an error event instead of throwing", () => {
    expect(parseWsMessage("{not json", 0)[0]).toMatchObject({ type: "error" });
    const bad = JSON.stringify({
      action: "snapshot",
      arg: { instType: "SPOT", channel: "books15", instId: "RNVDAUSDT" },
      data: [{ ts: "x", bids: [], asks: [] }],
    });
    expect(parseWsMessage(bad, 0)[0]).toMatchObject({ type: "error" });
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(data: string) {
    this.onmessage?.({ data });
  }
}

describe("BitgetPublicWs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = () => {
    const ws = new BitgetPublicWs({
      WebSocketImpl: FakeSocket as unknown as WebSocketCtor,
      clock: () => Date.now(),
      random: () => 1,
      pingIntervalMs: 25_000,
      reconnectBaseMs: 500,
    });
    const events: WsEvent[] = [];
    ws.onEvent((e) => events.push(e));
    return { ws, events };
  };

  it("subscribes in frames of at most 40 args once open and emits decoded events", () => {
    const { ws, events } = make();
    const subs = Array.from({ length: 45 }, (_, i) => ({
      venue: "perp" as const,
      underlying: `S${i}`,
      channel: "books15" as const,
    }));
    ws.subscribe(subs);
    ws.subscribe([subs[0] as (typeof subs)[number]]);
    ws.start();
    const sock = FakeSocket.all[0] as FakeSocket;
    expect(sock.sent).toHaveLength(0);
    sock.open();
    const frames = sock.sent.map((s) => JSON.parse(s) as { op: string; args: unknown[] });
    expect(frames.map((f) => [f.op, f.args.length])).toEqual([
      ["subscribe", 40],
      ["subscribe", 5],
    ]);
    expect(frames[0]?.args[0]).toEqual({ instType: "USDT-FUTURES", channel: "books15", instId: "S0USDT" });
    const bookFrame = session.messages.find(
      (m) => m.data.includes('"books15"') && m.data.includes('"action"'),
    ) as Frame;
    sock.receive(bookFrame.data);
    expect(events.some((e) => e.type === "book")).toBe(true);
    ws.stop();
  });

  it("pings on schedule and reconnects with backoff when the link goes idle, resubscribing", () => {
    const { ws, events } = make();
    ws.subscribe([{ venue: "rtoken", underlying: "NVDA", channel: "trade" }]);
    ws.start();
    const first = FakeSocket.all[0] as FakeSocket;
    first.open();
    vi.advanceTimersByTime(25_000);
    expect(first.sent.at(-1)).toBe("ping");
    vi.advanceTimersByTime(25_000);
    vi.advanceTimersByTime(25_000);
    expect(first.readyState).toBe(3);
    const reconnecting = events.find((e) => e.type === "status" && e.state === "reconnecting");
    expect(reconnecting).toMatchObject({
      attempt: 1,
      detail: expect.stringMatching(/idle timeout.*retry in 500 ms/),
    });
    vi.advanceTimersByTime(500);
    const second = FakeSocket.all[1] as FakeSocket;
    second.open();
    expect(JSON.parse(second.sent[0] as string)).toEqual({
      op: "subscribe",
      args: [{ instType: "SPOT", channel: "trade", instId: "RNVDAUSDT" }],
    });
    ws.stop();
  });

  it("backs off exponentially across failed connects and stops cleanly", () => {
    const { ws, events } = make();
    ws.start();
    for (let i = 0; i < 3; i++) {
      (FakeSocket.all.at(-1) as FakeSocket).close(1006, "abnormal");
      const delay = Number(/retry in (\d+) ms/.exec((events.at(-1) as { detail: string }).detail)?.[1]);
      expect(delay).toBe(500 * 2 ** i);
      vi.advanceTimersByTime(delay);
    }
    expect(FakeSocket.all).toHaveLength(4);
    ws.stop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "status", state: "closed" });
  });
});

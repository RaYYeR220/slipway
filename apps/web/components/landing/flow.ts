// The landing's current field (ported from design variant v05 "current-flow"): particles drift through the trading
// week; the current's width and speed are a real hourly traded-value series, its wobble the real hourly range.
// Out of the flow, particles condense into one real figure. Canvas 2D only, no dependencies.
// Isolated on purpose: the hero component only mounts it and calls the returned cleanup.

export interface FlowData {
  /** 168 values, index 0 = Sunday 00:00 New York: median USDT traded in that hour. */
  vol: readonly number[];
  /** 168 values: median high-low range of that hour, in bp. */
  rng: readonly number[];
  /** The figure that condenses out of the flow, e.g. "228×". */
  figure: string;
}

export interface FlowElements {
  sea: HTMLElement;
  field: HTMLCanvasElement;
  flow: HTMLCanvasElement;
  figure: HTMLCanvasElement;
  caption: HTMLElement;
}

const TEMPO = [
  "#151D44",
  "#1B3C56",
  "#1B5968",
  "#117777",
  "#2A937F",
  "#69AB89",
  "#A1C1A1",
  "#D2D9C7",
  "#FFF6F4",
];
const SOLAR = ["#B66413", "#C78616", "#D4AB23", "#DDD236"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const at = (a: ArrayLike<number>, i: number) => a[i] as number;
const hex = (h: string): [number, number, number] => [
  Number.parseInt(h.slice(1, 3), 16),
  Number.parseInt(h.slice(3, 5), 16),
  Number.parseInt(h.slice(5, 7), 16),
];
const TRGB = TEMPO.map(hex);
const gauss = () => {
  let u = 0;
  let v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

function nowET(): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const o: Record<string, string> = {};
  for (const q of p) o[q.type] = q.value;
  return DAYS.indexOf(o.weekday ?? "Sun") * 24 + (Number(o.hour) % 24) + Number(o.minute) / 60;
}

interface Particle {
  s: number;
  a: number;
  age: number;
  life: number;
  ph: number;
}
interface Condenser {
  p: Particle;
  t: [number, number];
  x: number;
  y: number;
  px: number;
  py: number;
  sx: number;
  sy: number;
  j: number;
  col: string;
  started: boolean;
  delay: number;
}
interface State {
  W: number;
  H: number;
  S: number;
  vertical: boolean;
  sig: Float32Array;
  speed: Float32Array;
  wob: Float32Array;
  k: Float32Array;
  parts: Particle[];
  cond: Condenser[];
  toXY: (s: number, a: number) => [number, number];
  spawn: (p: Particle) => void;
  sample: () => [number, number][];
  drawField: () => void;
  t0: number;
  mx: number;
  my: number;
}

const colourIndex = (kk: number, a: number) =>
  Math.max(1, Math.min(8, Math.round(1 + kk * 7 * (1 - Math.min(1, Math.abs(a) / 3) * 0.45))));

/** Mounts the flow on the given canvases. Returns a cleanup that stops every loop and listener. */
export function startFlow(el: FlowElements, data: FlowData): () => void {
  const { sea, field: fc, flow: pc, figure: qc, caption: fig } = el;
  const F = fc.getContext("2d");
  const P = pc.getContext("2d");
  const Q = qc.getContext("2d");
  if (!F || !P || !Q) return () => {};
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const L = data.vol.map((v) => Math.log10(Math.max(v, 1)));
  const lw = (x: number) => {
    const u = x - 0.5;
    const i = Math.floor(u);
    const f = u - i;
    const g = (k: number) => at(L, ((k % 168) + 168) % 168);
    const p0 = g(i - 1);
    const p1 = g(i);
    const p2 = g(i + 1);
    const p3 = g(i + 2);
    return (
      0.5 *
      (2 * p1 +
        (-p0 + p2) * f +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f +
        (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f)
    );
  };
  const rg = (x: number) => at(data.rng, ((Math.floor(x) % 168) + 168) % 168);

  let G: State | null = null;
  let raf = 0;
  let disposed = false;
  let visible = true;
  let running = false;

  function setup(): State {
    const ctxF = F as CanvasRenderingContext2D;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const W = sea.clientWidth;
    const H = sea.clientHeight;
    const vertical = W <= 760;
    for (const c of [fc, pc, qc]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    for (const c of [F, P, Q] as CanvasRenderingContext2D[]) c.setTransform(dpr, 0, 0, dpr, 0, 0);
    // the week runs along s (x on desktop, y on phones)
    const S = Math.max(1, vertical ? H : W);
    const h0 = vertical ? 144 : 14;
    const h1 = vertical ? 308 : 148; // phones start on Saturday 00:00: still water under the figure
    const pxh = S / (h1 - h0);
    const centre = vertical ? W * 0.52 : H * 0.5;
    const maxSig = vertical ? W * 0.15 : H * 0.076;
    const k = new Float32Array(S);
    const sig = new Float32Array(S);
    const speed = new Float32Array(S);
    const wob = new Float32Array(S);
    for (let s = 0; s < S; s++) {
      const h = h0 + s / pxh;
      const v = lw(h);
      const kk = Math.max(0, Math.min(1, (v - 3.1) / 6.6));
      k[s] = kk;
      sig[s] = maxSig * kk ** 1.35 + 0.5;
      speed[s] = (0.12 + 2.5 * kk ** 1.7) * (vertical ? 0.8 : 1);
      wob[s] = Math.min(1, rg(h) / 160);
    }
    const toXY = (s: number, a: number): [number, number] => (vertical ? [centre + a, s] : [s, centre + a]);
    const drawField = () => {
      // scalar layer: a soft glow of the current, tinted by depth (cmocean tempo)
      ctxF.clearRect(0, 0, W, H);
      for (let s = 0; s < S; s++) {
        const c = TRGB[Math.max(1, Math.min(7, Math.round(1 + at(k, s) * 6)))] as [number, number, number];
        const r = at(sig, s) * 2.6;
        const a = 0.03 + 0.11 * at(k, s) * at(k, s);
        const grad = vertical
          ? ctxF.createLinearGradient(centre - r, 0, centre + r, 0)
          : ctxF.createLinearGradient(0, centre - r, 0, centre + r);
        grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        grad.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},${a})`);
        grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
        ctxF.fillStyle = grad;
        if (vertical) ctxF.fillRect(centre - r, s, 2 * r, 1);
        else ctxF.fillRect(s, centre - r, 1, 2 * r);
      }
      // day ticks, and the live now-line in Bitget teal
      ctxF.font = "400 10.5px 'Azeret Mono', monospace";
      ctxF.lineWidth = 1;
      for (let d = 0; d < 14; d++) {
        const m = d * 24;
        if (m <= h0 || m >= h1) continue;
        const s = Math.round((m - h0) * pxh) + 0.5;
        ctxF.strokeStyle = "rgba(141,166,170,.45)";
        ctxF.beginPath();
        if (vertical) {
          ctxF.moveTo(W - 12, s);
          ctxF.lineTo(W - 4, s);
        } else {
          ctxF.moveTo(s, H - 16);
          ctxF.lineTo(s, H - 6);
        }
        ctxF.stroke();
        ctxF.fillStyle = "rgba(141,166,170,.85)";
        if (vertical) {
          ctxF.textAlign = "right";
          ctxF.fillText(DAYS[d % 7] as string, W - 16, s + 4);
        } else {
          ctxF.textAlign = "left";
          ctxF.fillText(DAYS[d % 7] as string, s + 5, H - 7);
        }
      }
      let now = nowET();
      while (now < h0) now += 168;
      while (now > h1) now -= 168;
      const ns = Math.round((now - h0) * pxh) + 0.5;
      const reach = Math.max(36, at(sig, Math.max(0, Math.min(S - 1, ns | 0))) * 2.8 + 16);
      ctxF.strokeStyle = "rgba(38,191,212,.9)";
      ctxF.lineWidth = 1;
      ctxF.beginPath();
      if (vertical) {
        ctxF.moveTo(centre - reach, ns);
        ctxF.lineTo(centre + reach, ns);
      } else {
        ctxF.moveTo(ns, centre - reach);
        ctxF.lineTo(ns, centre + reach);
      }
      ctxF.stroke();
      ctxF.fillStyle = "#26BFD4";
      ctxF.font = "500 10.5px 'Azeret Mono', monospace";
      ctxF.textAlign = "left";
      if (vertical) ctxF.fillText("now", centre + reach + 6, ns + 4);
      else ctxF.fillText("now, live", ns + 6, centre - reach + 10);
    };
    drawField();
    // the figure: target points sampled from the number set in Zodiak (re-sampled once Zodiak 700 has loaded)
    const figH = vertical ? Math.min(136, W * 0.34) : Math.min(236, H * 0.27);
    const side = vertical ? 16 : Math.max(16, W * 0.044);
    const sample = (): [number, number][] => {
      const oc = document.createElement("canvas");
      const ow = Math.ceil(figH * 2.5);
      const oh = Math.ceil(figH * 1.1);
      oc.width = ow;
      oc.height = oh;
      const ox = oc.getContext("2d");
      if (!ox) return [];
      ox.fillStyle = "#fff";
      ox.font = `700 ${figH}px Zodiak, Georgia, serif`;
      const tw = ox.measureText(data.figure).width;
      ox.fillText(data.figure, 0, figH * 0.9);
      const id = ox.getImageData(0, 0, ow, oh).data;
      const pts: [number, number][] = [];
      const step = vertical ? 1.9 : 2.7;
      for (let y = 0; y < oh; y += step)
        for (let x = 0; x < ow; x += step) {
          const xx = x + (Math.random() - 0.5) * step * 0.5;
          const yy = y + (Math.random() - 0.5) * step * 0.5;
          if (at(id, (Math.floor(Math.max(0, yy)) * ow + Math.floor(Math.max(0, xx))) * 4 + 3) > 140)
            pts.push([xx, yy]);
        }
      const fx = vertical ? side : W - side - tw;
      const fy = vertical ? 112 : Math.max(56, H * 0.07); // phones: clear the two-row site header
      for (let i = pts.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [pts[i], pts[j]] = [pts[j] as [number, number], pts[i] as [number, number]];
      }
      fig.style.top = `${fy + figH * 0.98}px`;
      return pts.map(([x, y]) => [fx + x, fy + y]);
    };
    const targets = sample();
    if (vertical) {
      fig.style.left = "16px";
      fig.style.right = "62px";
      fig.style.textAlign = "left";
    } else {
      fig.style.left = "auto";
      fig.style.right = `${side}px`;
      fig.style.textAlign = "right";
    }
    // particles: s along the week, a = offset across the current in units of its local width (gaussian)
    const N = vertical ? 1100 : 3800;
    const parts: Particle[] = [];
    const spawn = (p: Particle) => {
      for (let t = 0; t < 30; t++) {
        const s = Math.random() * S;
        p.s = s;
        if (Math.random() < at(sig, s | 0) / maxSig + 0.004) break;
      }
      p.a = Math.max(-2.8, Math.min(2.8, gauss()));
      p.age = 0;
      p.life = 50 + Math.random() * 150;
      p.ph = Math.random() * 6.283;
    };
    for (let i = 0; i < N; i++) {
      const p: Particle = { s: 0, a: 0, age: 0, life: 1, ph: 0 };
      spawn(p);
      p.age = Math.random() * p.life;
      parts.push(p);
    }
    // condensers: drawn from the flow, assigned to the figure
    const C = Math.min(targets.length, vertical ? 1300 : 2300);
    const cond: Condenser[] = [];
    for (let i = 0; i < C; i++) {
      const p: Particle = { s: 0, a: 0, age: 0, life: 1, ph: 0 };
      spawn(p);
      cond.push({
        p,
        t: targets[i] as [number, number],
        x: 0,
        y: 0,
        px: 0,
        py: 0,
        sx: 0,
        sy: 0,
        j: Math.random() * 6.283,
        col: SOLAR[(Math.random() * SOLAR.length) | 0] as string,
        started: false,
        delay: 0,
      });
    }
    return {
      W,
      H,
      S,
      vertical,
      sig,
      speed,
      wob,
      k,
      parts,
      cond,
      toXY,
      spawn,
      sample,
      drawField,
      t0: performance.now(),
      mx: -1e4,
      my: -1e4,
    };
  }

  function step(p: Particle, g: State, t: number): boolean {
    const s0 = p.s | 0;
    if (s0 < 0 || s0 >= g.S) return false;
    const sp = at(g.speed, s0) * (1 - (0.18 * Math.min(4, p.a * p.a)) / 4);
    p.s += sp;
    p.a += Math.sin(p.s * 0.012 + p.a * 1.9 + t * 0.7 + p.ph) * 0.028 * (0.25 + at(g.wob, s0) * 1.6);
    p.a *= 0.9995;
    p.age++;
    return !(p.s >= g.S || p.age > p.life);
  }

  function frame(now: number) {
    const g = G;
    const ctxP = P as CanvasRenderingContext2D;
    const ctxQ = Q as CanvasRenderingContext2D;
    if (!g || disposed) return;
    const t = (now - g.t0) / 1000;
    ctxP.globalCompositeOperation = "destination-out";
    ctxP.fillStyle = "rgba(0,0,0,0.09)";
    ctxP.fillRect(0, 0, g.W, g.H);
    ctxP.globalCompositeOperation = "source-over";
    const buckets: number[][] = Array.from({ length: 9 }, () => []);
    for (const p of g.parts) {
      const s0 = p.s | 0;
      if (s0 < 0 || s0 >= g.S || at(g.sig, s0) < 0.8) {
        g.spawn(p);
        continue;
      }
      const [x0, y0] = g.toXY(p.s, p.a * at(g.sig, s0));
      if (!step(p, g, t)) {
        g.spawn(p);
        continue;
      }
      const s1 = p.s | 0;
      const [x1, y1] = g.toXY(p.s, p.a * at(g.sig, s1));
      (buckets[colourIndex(at(g.k, s0), p.a)] as number[]).push(x0, y0, x1, y1);
    }
    ctxP.lineWidth = 1.05;
    ctxP.lineCap = "round";
    for (let b = 1; b < 9; b++) {
      const a = buckets[b] as number[];
      if (!a.length) continue;
      ctxP.strokeStyle = TEMPO[b] as string;
      ctxP.globalAlpha = Math.min(1, 0.28 + b * 0.09);
      ctxP.beginPath();
      for (let i = 0; i < a.length; i += 4) {
        ctxP.moveTo(at(a, i), at(a, i + 1));
        ctxP.lineTo(at(a, i + 2), at(a, i + 3));
      }
      ctxP.stroke();
    }
    ctxP.globalAlpha = 1;
    // the figure: particles ride the current until 0.25 s, then leave it and settle; the pointer scatters them
    ctxQ.clearRect(0, 0, g.W, g.H);
    const T0 = 0.25;
    const T1 = 1.55;
    for (const c of g.cond) {
      const p = c.p;
      if (t < T0) {
        const s0 = p.s | 0;
        if (s0 < 0 || s0 >= g.S) {
          g.spawn(p);
          continue;
        }
        step(p, g, t);
        const s1 = Math.max(0, Math.min(g.S - 1, p.s | 0));
        [c.x, c.y] = g.toXY(p.s, p.a * at(g.sig, s1));
        c.px = c.x;
        c.py = c.y;
        continue;
      }
      if (!c.started) {
        c.started = true;
        c.sx = c.x;
        c.sy = c.y;
        c.delay = Math.random() * 0.3;
      }
      const q = Math.max(0, Math.min(1, (t - T0 - c.delay) / (T1 - T0 - 0.3)));
      const e = q < 0.5 ? 4 * q * q * q : 1 - (-2 * q + 2) ** 3 / 2;
      const tx = c.t[0] + Math.sin(t * 1.6 + c.j) * 0.45;
      const ty = c.t[1] + Math.cos(t * 1.2 + c.j) * 0.45;
      c.px = c.x;
      c.py = c.y;
      if (q < 1) {
        // curved path out of the flow
        const mx = (c.sx + tx) / 2 + (c.sy - ty) * 0.18;
        const my = (c.sy + ty) / 2 - (tx - c.sx) * 0.12;
        const u = 1 - e;
        c.x = u * u * c.sx + 2 * u * e * mx + e * e * tx;
        c.y = u * u * c.sy + 2 * u * e * my + e * e * ty;
      } else {
        const dx = c.x - g.mx;
        const dy = c.y - g.my;
        const d2 = dx * dx + dy * dy;
        if (d2 < 5000) {
          const f = ((5000 - d2) / 5000) * 8;
          const d = Math.sqrt(d2) || 1;
          c.x += (dx / d) * f;
          c.y += (dy / d) * f;
        }
        c.x += (tx - c.x) * 0.09;
        c.y += (ty - c.y) * 0.09;
      }
      ctxQ.globalAlpha = 0.5 + 0.5 * e;
      if (q < 1 && q > 0) {
        ctxQ.strokeStyle = c.col;
        ctxQ.lineWidth = 1.2;
        ctxQ.beginPath();
        ctxQ.moveTo(c.px, c.py);
        ctxQ.lineTo(c.x, c.y);
        ctxQ.stroke();
      }
      ctxQ.fillStyle = c.col;
      ctxQ.fillRect(c.x - 0.9, c.y - 0.9, 1.8, 1.8);
    }
    ctxQ.globalAlpha = 1;
    raf = requestAnimationFrame(frame);
  }

  function still() {
    const g = G;
    const ctxP = P as CanvasRenderingContext2D;
    const ctxQ = Q as CanvasRenderingContext2D;
    if (!g) return;
    ctxP.clearRect(0, 0, g.W, g.H);
    ctxQ.clearRect(0, 0, g.W, g.H);
    ctxP.lineWidth = 0.9;
    for (const p of g.parts) {
      ctxP.beginPath();
      let first = true;
      let s0 = p.s | 0;
      for (let n = 0; n < 30; n++) {
        s0 = p.s | 0;
        if (s0 < 0 || s0 >= g.S || at(g.sig, s0) < 0.8) break;
        const [x, y] = g.toXY(p.s, p.a * at(g.sig, s0));
        if (first) {
          ctxP.moveTo(x, y);
          first = false;
        } else ctxP.lineTo(x, y);
        p.s += at(g.speed, s0) * 1.6 + 0.4;
        p.a += Math.sin(p.s * 0.012 + p.a * 1.9 + p.ph) * 0.028 * (0.25 + at(g.wob, s0) * 1.6);
      }
      const sc = Math.max(0, Math.min(g.S - 1, s0));
      ctxP.strokeStyle = TEMPO[colourIndex(at(g.k, sc), p.a)] as string;
      ctxP.globalAlpha = 0.55;
      ctxP.stroke();
    }
    ctxP.globalAlpha = 1;
    for (const c of g.cond) {
      ctxQ.fillStyle = c.col;
      ctxQ.fillRect(c.t[0] - 0.9, c.t[1] - 0.9, 1.8, 1.8);
    }
  }

  const play = () => {
    if (reduce || disposed || running || !visible || document.hidden) return;
    running = true;
    raf = requestAnimationFrame(frame);
  };
  const pause = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  function start() {
    pause();
    G = setup();
    (P as CanvasRenderingContext2D).clearRect(0, 0, G.W, G.H);
    if (reduce) {
      still();
      return;
    }
    play();
  }

  const onMove = (e: PointerEvent) => {
    if (!G) return;
    const r = sea.getBoundingClientRect();
    G.mx = e.clientX - r.left;
    G.my = e.clientY - r.top;
  };
  const onLeave = () => {
    if (G) {
      G.mx = -1e4;
      G.my = -1e4;
    }
  };
  const onVisibility = () => (document.hidden ? pause() : play());
  // restart only on a real layout change (phones fire resize when the address bar slides)
  let rt: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (G && Math.abs(sea.clientWidth - G.W) < 2 && Math.abs(sea.clientHeight - G.H) < 120) return;
      start();
    }, 150);
  };
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((x) => x.isIntersecting);
    if (visible) play();
    else pause();
  });

  sea.addEventListener("pointermove", onMove);
  sea.addEventListener("pointerleave", onLeave);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);
  io.observe(sea);

  start();
  // when the faces arrive, redraw the labels and re-aim the condensing particles at the figure's true outline
  if (document.fonts) {
    document.fonts.ready.then(() => {
      if (!disposed && G) G.drawField();
    });
    document.fonts.load("700 100px Zodiak").then(() => {
      if (disposed || !G) return;
      const t = G.sample();
      if (!t.length) return;
      G.cond.forEach((c, i) => {
        c.t = t[i % t.length] as [number, number];
      });
      if (reduce) still();
    });
  }

  return () => {
    disposed = true;
    pause();
    clearTimeout(rt);
    io.disconnect();
    sea.removeEventListener("pointermove", onMove);
    sea.removeEventListener("pointerleave", onLeave);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("resize", onResize);
  };
}

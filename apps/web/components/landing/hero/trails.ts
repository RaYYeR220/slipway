// Trail renderer for the landing hero. Particle segments accumulate as light in a half-float buffer (additive,
// multiplicative fade, epsilon floor so nothing ghosts), then are tone-mapped with a mip bloom over the abyss
// through a feathered text mask. WebGL2; a Canvas 2D fallback draws the same segments with a destination fade.

import type { Rect } from "./util";

/** Floats per segment: x0 y0 x1 y1 r g b alpha width. */
export const STRIDE = 9;

export interface MaskRect {
  b: Rect;
  /** 1 = no light under it at all; 0.5 = half the light. */
  a: number;
  /** Padding in CSS px around the rect before the feather. */
  p: number;
}

export interface Trails {
  readonly webgl: boolean;
  resize(W: number, H: number, scale: number): void;
  setMask(rects: MaskRect[]): void;
  /** Fades the buffer, adds `count` segments; composites to the screen unless `composite` is false. */
  draw(data: Float32Array, count: number, composite?: boolean): void;
  dispose(): void;
}

const FADE = 0.968;
const EPS = 0.0009;
const GAIN = 1.12;
const BLOOM = 1.15;

const VS_FULL = `#version 300 es
const vec2 Q[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));out vec2 uv;
void main(){vec2 p=Q[gl_VertexID];uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}`;
const FS_FADE = `#version 300 es
precision highp float;in vec2 uv;uniform sampler2D T;uniform float fade,eps;out vec4 o;
void main(){o=max(texture(T,uv)*fade-eps,vec4(0.));}`;
// sub-pixel segments are stretched to 1 px so a resting particle still leaves a dot; longer ones join seamlessly
const VS_SEG = `#version 300 es
layout(location=0) in vec2 corner;layout(location=1) in vec4 seg;layout(location=2) in vec4 col;layout(location=3) in float wid;
uniform vec2 res;uniform float dpr;out vec3 vc;out float vd,vh,va;
void main(){vec2 p0=seg.xy*dpr,p1=seg.zw*dpr,d=p1-p0;float L=length(d);vec2 t=L>1e-4?d/L:vec2(1.,0.),n=vec2(-t.y,t.x);
float w=wid*dpr,ww=max(w,1.),hw=ww*.5+1.,c=max(0.,1.-L)*.5;vec2 p=mix(p0-t*c,p1+t*c,corner.x)+n*corner.y*hw;
vd=corner.y*hw;vh=ww*.5;vc=col.rgb;va=col.a*min(w,1.);
gl_Position=vec4(p/res*2.-1.,0.,1.);gl_Position.y=-gl_Position.y;}`;
const FS_SEG = `#version 300 es
precision highp float;in vec3 vc;in float vd,vh,va;out vec4 o;
void main(){float a=clamp(vh+.5-abs(vd),0.,1.)*va;o=vec4(vc*a,a);}`;
const FS_COMP = `#version 300 es
precision highp float;in vec2 uv;uniform sampler2D T,M;uniform vec3 bg;uniform float gain,bloom;out vec4 o;
void main(){vec3 c=texture(T,uv).rgb,b=textureLod(T,uv,2.5).rgb*.55+textureLod(T,uv,4.5).rgb*.45;float m=texture(M,uv).r;
vec3 g=vec3(1.)-exp(-(c*gain+b*bloom));o=vec4(bg+g*m*(vec3(1.)-bg),1.);}`;

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

function maskCanvas(W: number, H: number, rects: MaskRect[]): HTMLCanvasElement {
  const mw = Math.max(1, Math.ceil(W / 4));
  const mh = Math.max(1, Math.ceil(H / 4));
  const m = document.createElement("canvas");
  m.width = mw;
  m.height = mh;
  const x = m.getContext("2d");
  if (!x) return m;
  x.fillStyle = "#fff";
  x.fillRect(0, 0, mw, mh);
  x.filter = "blur(5px)";
  for (const q of rects) {
    x.fillStyle = `rgba(0,0,0,${q.a})`;
    x.fillRect(
      (q.b.x0 - q.p) / 4,
      (q.b.y0 - q.p) / 4,
      (q.b.x1 - q.b.x0 + 2 * q.p) / 4,
      (q.b.y1 - q.b.y0 + 2 * q.p) / 4,
    );
  }
  return m;
}

/** WebGL2 renderer, or null when WebGL2 is not available or its pipeline fails to build. */
export function createTrailsGL(
  canvas: HTMLCanvasElement,
  bg: [number, number, number],
  onLost: () => void,
  onRestored: () => void,
): Trails | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const g = gl;
  // WebGL's useProgram, renamed so the React hook lint does not mistake it for a hook
  const bindProgram: (p: WebGLProgram) => void = g.useProgram.bind(g);
  let half = false;
  let fade: Prog | null = null;
  let seg: Prog | null = null;
  let comp: Prog | null = null;
  let vaoSeg: WebGLVertexArrayObject | null = null;
  let vaoEmpty: WebGLVertexArrayObject | null = null;
  let qbuf: WebGLBuffer | null = null;
  let ibuf: WebGLBuffer | null = null;
  let bufBytes = 0;
  const tex: (WebGLTexture | null)[] = [null, null];
  const fb: (WebGLFramebuffer | null)[] = [null, null];
  let maskTex: WebGLTexture | null = null;
  let cur = 0;
  let Wd = 1;
  let Hd = 1;
  let cssW = 1;
  let cssH = 1;
  let scale = 1;
  let lastMask: MaskRect[] = [];

  const shader = (type: number, src: string) => {
    const s = g.createShader(type);
    if (!s) throw new Error("shader");
    g.shaderSource(s, src);
    g.compileShader(s);
    if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const program = (vs: string, fs: string, names: string[]): Prog => {
    const p = g.createProgram();
    const a = shader(g.VERTEX_SHADER, vs);
    const b = shader(g.FRAGMENT_SHADER, fs);
    g.attachShader(p, a);
    g.attachShader(p, b);
    g.linkProgram(p);
    g.deleteShader(a);
    g.deleteShader(b);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) ?? "link");
    const u: Prog["u"] = {};
    for (const n of names) u[n] = g.getUniformLocation(p, n);
    return { p, u };
  };

  function init() {
    half = !!g.getExtension("EXT_color_buffer_float") || !!g.getExtension("EXT_color_buffer_half_float");
    fade = program(VS_FULL, FS_FADE, ["T", "fade", "eps"]);
    seg = program(VS_SEG, FS_SEG, ["res", "dpr"]);
    comp = program(VS_FULL, FS_COMP, ["T", "M", "bg", "gain", "bloom"]);
    vaoEmpty = g.createVertexArray();
    vaoSeg = g.createVertexArray();
    g.bindVertexArray(vaoSeg);
    qbuf = g.createBuffer();
    g.bindBuffer(g.ARRAY_BUFFER, qbuf);
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), g.STATIC_DRAW);
    g.enableVertexAttribArray(0);
    g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
    ibuf = g.createBuffer();
    bufBytes = 0;
    g.bindBuffer(g.ARRAY_BUFFER, ibuf);
    const B = STRIDE * 4;
    g.enableVertexAttribArray(1);
    g.vertexAttribPointer(1, 4, g.FLOAT, false, B, 0);
    g.vertexAttribDivisor(1, 1);
    g.enableVertexAttribArray(2);
    g.vertexAttribPointer(2, 4, g.FLOAT, false, B, 16);
    g.vertexAttribDivisor(2, 1);
    g.enableVertexAttribArray(3);
    g.vertexAttribPointer(3, 1, g.FLOAT, false, B, 32);
    g.vertexAttribDivisor(3, 1);
    g.bindVertexArray(null);
    tex[0] = tex[1] = null;
    fb[0] = fb[1] = null;
    maskTex = null;
  }

  function targets() {
    for (let i = 0; i < 2; i++) {
      if (tex[i]) g.deleteTexture(tex[i] as WebGLTexture);
      if (fb[i]) g.deleteFramebuffer(fb[i] as WebGLFramebuffer);
      const t = g.createTexture();
      tex[i] = t;
      g.bindTexture(g.TEXTURE_2D, t);
      if (half) g.texImage2D(g.TEXTURE_2D, 0, g.RGBA16F, Wd, Hd, 0, g.RGBA, g.HALF_FLOAT, null);
      else g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, Wd, Hd, 0, g.RGBA, g.UNSIGNED_BYTE, null);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      const f = g.createFramebuffer();
      fb[i] = f;
      g.bindFramebuffer(g.FRAMEBUFFER, f);
      g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, t, 0);
      if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE && half) {
        half = false;
        targets();
        return;
      }
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.generateMipmap(g.TEXTURE_2D);
    }
    g.bindFramebuffer(g.FRAMEBUFFER, null);
  }

  try {
    init();
  } catch {
    return null;
  }

  const lost = (e: Event) => {
    e.preventDefault();
    onLost();
  };
  const restored = () => {
    try {
      init();
      onRestored();
    } catch {
      /* the context came back unusable: the engine stays paused on its last frame */
    }
  };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);

  return {
    webgl: true,
    resize(W, H, s) {
      cssW = W;
      cssH = H;
      scale = s;
      Wd = Math.max(1, Math.round(W * s));
      Hd = Math.max(1, Math.round(H * s));
      canvas.width = Wd;
      canvas.height = Hd;
      if (g.isContextLost()) return;
      targets();
      if (lastMask.length) this.setMask(lastMask);
    },
    setMask(rects) {
      lastMask = rects;
      if (g.isContextLost()) return;
      const m = maskCanvas(cssW, cssH, rects);
      if (!maskTex) maskTex = g.createTexture();
      g.bindTexture(g.TEXTURE_2D, maskTex);
      g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, true);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, m);
      g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    },
    draw(data, count, composite = true) {
      if (g.isContextLost() || !fade || !seg || !comp) return;
      g.bindFramebuffer(g.FRAMEBUFFER, fb[1 - cur] as WebGLFramebuffer);
      g.viewport(0, 0, Wd, Hd);
      g.disable(g.BLEND);
      bindProgram(fade.p);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, tex[cur] as WebGLTexture);
      g.uniform1i(fade.u.T as WebGLUniformLocation, 0);
      g.uniform1f(fade.u.fade as WebGLUniformLocation, FADE);
      g.uniform1f(fade.u.eps as WebGLUniformLocation, half ? EPS : 1.6 / 255);
      g.bindVertexArray(vaoEmpty);
      g.drawArrays(g.TRIANGLES, 0, 3);
      if (count > 0) {
        g.enable(g.BLEND);
        g.blendFunc(g.ONE, g.ONE);
        bindProgram(seg.p);
        g.uniform2f(seg.u.res as WebGLUniformLocation, Wd, Hd);
        g.uniform1f(seg.u.dpr as WebGLUniformLocation, scale);
        g.bindVertexArray(vaoSeg);
        g.bindBuffer(g.ARRAY_BUFFER, ibuf);
        if (data.byteLength > bufBytes) {
          bufBytes = data.byteLength;
          g.bufferData(g.ARRAY_BUFFER, bufBytes, g.DYNAMIC_DRAW);
        }
        g.bufferSubData(g.ARRAY_BUFFER, 0, data, 0, count * STRIDE);
        g.drawArraysInstanced(g.TRIANGLE_STRIP, 0, 4, count);
        g.disable(g.BLEND);
      }
      g.bindVertexArray(null);
      cur = 1 - cur;
      if (!composite) return;
      g.bindTexture(g.TEXTURE_2D, tex[cur] as WebGLTexture);
      g.generateMipmap(g.TEXTURE_2D);
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.viewport(0, 0, Wd, Hd);
      bindProgram(comp.p);
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, tex[cur] as WebGLTexture);
      g.uniform1i(comp.u.T as WebGLUniformLocation, 0);
      g.activeTexture(g.TEXTURE1);
      g.bindTexture(g.TEXTURE_2D, maskTex);
      g.uniform1i(comp.u.M as WebGLUniformLocation, 1);
      g.activeTexture(g.TEXTURE0);
      g.uniform3f(comp.u.bg as WebGLUniformLocation, bg[0], bg[1], bg[2]);
      g.uniform1f(comp.u.gain as WebGLUniformLocation, GAIN);
      g.uniform1f(comp.u.bloom as WebGLUniformLocation, BLOOM);
      g.bindVertexArray(vaoEmpty);
      g.drawArrays(g.TRIANGLES, 0, 3);
      g.bindVertexArray(null);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", lost);
      canvas.removeEventListener("webglcontextrestored", restored);
      if (!g.isContextLost()) {
        for (const t of [...tex, maskTex]) if (t) g.deleteTexture(t);
        for (const f of fb) if (f) g.deleteFramebuffer(f);
        for (const b of [qbuf, ibuf]) if (b) g.deleteBuffer(b);
        for (const v of [vaoSeg, vaoEmpty]) if (v) g.deleteVertexArray(v);
        for (const p of [fade, seg, comp]) if (p) g.deleteProgram(p.p);
      }
      g.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

/** Canvas 2D fallback: same segments, a destination-in fade, the mask as partial erasure. Needs a canvas with no
 * WebGL context on it. */
export function createTrails2D(canvas: HTMLCanvasElement): Trails | null {
  const x = canvas.getContext("2d");
  if (!x) return null;
  let W = 1;
  let H = 1;
  let mask: MaskRect[] = [];
  return {
    webgl: false,
    resize(w, h, s) {
      W = w;
      H = h;
      canvas.width = Math.max(1, Math.round(w * s));
      canvas.height = Math.max(1, Math.round(h * s));
      x.setTransform(s, 0, 0, s, 0, 0);
      x.clearRect(0, 0, W, H);
    },
    setMask(rects) {
      mask = rects;
    },
    draw(d, count, composite = true) {
      x.globalCompositeOperation = "destination-in";
      x.fillStyle = "rgba(0,0,0,0.93)";
      x.fillRect(0, 0, W, H);
      x.globalCompositeOperation = "lighter";
      x.lineCap = "round";
      for (let i = 0; i < count; i++) {
        const o = i * STRIDE;
        const a = d[o + 7] as number;
        if (a <= 0.01) continue;
        x.strokeStyle = `rgba(${((d[o + 4] as number) * 255) | 0},${((d[o + 5] as number) * 255) | 0},${((d[o + 6] as number) * 255) | 0},${Math.min(1, a)})`;
        x.lineWidth = d[o + 8] as number;
        x.beginPath();
        x.moveTo(d[o] as number, d[o + 1] as number);
        x.lineTo((d[o + 2] as number) + 0.01, d[o + 3] as number);
        x.stroke();
      }
      x.globalCompositeOperation = "source-over";
      if (!composite) return;
      x.globalCompositeOperation = "destination-out";
      x.fillStyle = "#000";
      for (const q of mask) {
        x.globalAlpha = q.a;
        x.fillRect(q.b.x0 - q.p, q.b.y0 - q.p, q.b.x1 - q.b.x0 + 2 * q.p, q.b.y1 - q.b.y0 + 2 * q.p);
      }
      x.globalAlpha = 1;
      x.globalCompositeOperation = "source-over";
    },
    dispose() {},
  };
}

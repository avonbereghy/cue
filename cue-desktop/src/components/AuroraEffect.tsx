import { useEffect, useRef } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";
import { useOnScreen } from "@/hooks/useOnScreen";
import { releaseGlContext } from "@/lib/webgl";

interface AuroraEffectProps {
  /** Overall opacity multiplier (0-1). */
  alpha?: number;
  /** Time-evolution multiplier. 1.0 = default slow drift. */
  speed?: number;
  /** Per-card seed string (session id) — shifts phase so sibling cards differ. */
  seed?: string;
  /**
   * Growth gate. `true` → fade in to full; `false` → fade out to zero.
   * Parent must delay unmount by at least AURORA_EXIT_MS so the retract plays.
   */
  active?: boolean;
}

export const AURORA_ENTER_MS = 900;
export const AURORA_EXIT_MS = 1400;

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

/* -------------------------------------------------------------------------
 * AuroraEffect — slow domain-warped FBM flowing across the card background.
 *
 * Runs while a session sits in the `done` state. Each card fades in on entry
 * and retracts on state change. The shader is passive (no mouse/audio input),
 * so the only per-frame cost is the ~6 octaves of FBM × the pixel count —
 * rendered at 0.5× DPR since the effect is soft and large-scale.
 * ---------------------------------------------------------------------- */

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform vec2 u_res;
uniform float u_time;
uniform float u_fade;
uniform float u_seed;

float hash(vec2 p){
  p = fract(p*vec2(123.34, 456.21));
  p += dot(p, p+45.32);
  return fract(p.x*p.y);
}
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  float a = hash(i);
  float b = hash(i+vec2(1.0,0.0));
  float c = hash(i+vec2(0.0,1.0));
  float d = hash(i+vec2(1.0,1.0));
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a*noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main(){
  vec2 uv = v_uv;
  vec2 p = uv;
  p.x *= u_res.x / u_res.y;

  // Slow-drift domain-warped FBM. Each octave uses the previous as its own
  // displacement field — that's what turns blobby noise into flowing currents.
  float t = u_time * 0.08;
  vec2 seedOff = vec2(u_seed * 7.31, u_seed * 4.17);
  vec2 q = p * 1.4 + seedOff;
  float n1 = fbm(q + vec2(t, -t*0.5));
  float n2 = fbm(q + vec2(n1*1.8, n1*1.2) + vec2(-t*0.6, t*0.8));
  float n3 = fbm(q*1.3 + vec2(n2*2.2, n2*1.4) - vec2(t*0.4, -t*0.3));

  // Palette: deep → teal → cobalt → violet, with soft highlight glints.
  vec3 deep   = vec3(0.02, 0.04, 0.09);
  vec3 teal   = vec3(0.08, 0.55, 0.62);
  vec3 cobalt = vec3(0.18, 0.38, 0.95);
  vec3 violet = vec3(0.55, 0.25, 0.85);
  vec3 glint  = vec3(0.75, 0.95, 0.98);

  float v = smoothstep(0.15, 0.95, n3);
  vec3 col = mix(deep, teal, smoothstep(0.10, 0.55, n3));
  col = mix(col, cobalt, smoothstep(0.45, 0.75, n3));
  col = mix(col, violet, smoothstep(0.70, 0.95, n3) * 0.55);
  col += glint * pow(v, 4.0) * 0.30;

  // Radial vignette — darkens corners so the aurora reads as a contained wash
  // inside the card instead of a flat tint at the edges.
  float vig = smoothstep(1.15, 0.30, length(uv - 0.5));
  col *= 0.55 + 0.45 * vig;

  // Faint grain breaks WebGL banding on the smooth gradient.
  col += (hash(gl_FragCoord.xy + u_time) - 0.5) * 0.012;

  // Standard (non-premultiplied) alpha. The alpha rises with the noise
  // value so dim areas stay transparent and bright currents feel volumetric
  // against the card surface. Aligned with FluxEffect so a co-mount
  // transition doesn't produce halo artifacts.
  float a = (0.35 + 0.55 * v) * u_fade;
  gl_FragColor = vec4(col, a);
}
`;

export function AuroraEffect({
  alpha = 0.9,
  speed = 1.0,
  seed = "",
  active = true,
}: AuroraEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const progRef = useRef<WebGLProgram | null>(null);
  const quadBufRef = useRef<WebGLBuffer | null>(null);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const timeRef = useRef(0);
  const growthRef = useRef(0);
  const uniformsRef = useRef<{
    res: WebGLUniformLocation | null;
    time: WebGLUniformLocation | null;
    fade: WebGLUniformLocation | null;
    seed: WebGLUniformLocation | null;
  }>({ res: null, time: null, fade: null, seed: null });
  const posAttribRef = useRef(-1);
  const sizeRef = useRef({ w: 0, h: 0 });

  const pageVisible = usePageVisible();
  const onScreen = useOnScreen(canvasRef);
  const renderActive = pageVisible && onScreen;

  const alphaRef = useRef(alpha);
  const speedRef = useRef(speed);
  const seedRef = useRef(hashSeed(seed));
  const activeRef = useRef(active);
  alphaRef.current = alpha;
  speedRef.current = speed;
  seedRef.current = hashSeed(seed);
  activeRef.current = active;

  const reducedMotionRef = useRef(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  if (reducedMotionRef.current) {
    growthRef.current = active ? 1 : 0;
  }

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => {
      reducedMotionRef.current = e.matches;
      if (e.matches) growthRef.current = activeRef.current ? 1 : 0;
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // One-time WebGL program + buffer setup.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Both Aurora and Flux are now non-premultiplied so they can safely
    // co-mount during cross-state transitions (e.g. thinking→done) without
    // the compositor producing wrong color math at the overlap.
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return;
    glRef.current = gl;

    const compile = (src: string, kind: number) => {
      const s = gl.createShader(kind)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        // eslint-disable-next-line no-console
        console.error("AuroraEffect shader error:", gl.getShaderInfoLog(s));
      }
      return s;
    };
    const vs = compile(VERT, gl.VERTEX_SHADER);
    const fs = compile(FRAG, gl.FRAGMENT_SHADER);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      // eslint-disable-next-line no-console
      console.error("AuroraEffect link error:", gl.getProgramInfoLog(prog));
    }
    progRef.current = prog;

    // Full-screen triangle strip — covers clip space with 4 verts.
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    quadBufRef.current = quadBuf;

    posAttribRef.current = gl.getAttribLocation(prog, "a_pos");
    uniformsRef.current = {
      res:  gl.getUniformLocation(prog, "u_res"),
      time: gl.getUniformLocation(prog, "u_time"),
      fade: gl.getUniformLocation(prog, "u_fade"),
      seed: gl.getUniformLocation(prog, "u_seed"),
    };

    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    return () => {
      cancelAnimationFrame(rafRef.current);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (quadBufRef.current) gl.deleteBuffer(quadBufRef.current);
      // Free the GL context itself (deleting resources doesn't) so long
      // multi-session uptime can't exhaust the browser's WebGL context cap.
      releaseGlContext(gl);
      glRef.current = null;
      progRef.current = null;
      quadBufRef.current = null;
    };
  }, []);

  // Render loop.
  useEffect(() => {
    const gl = glRef.current;
    const prog = progRef.current;
    if (!gl || !prog || !renderActive) {
      cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = 0;
      return;
    }

    let cleared = false;

    const render = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !gl || !prog) return;
      const quadBuf = quadBufRef.current;
      if (!quadBuf) return;

      const rect = canvas.getBoundingClientRect();
      const cssW = rect.width;
      const cssH = rect.height;
      if (cssW < 1 || cssH < 1) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }
      // Half-DPR is plenty for a soft wash — halves fragment cost vs full DPR.
      const dpr = Math.max(1, (window.devicePixelRatio || 1) * 0.5);
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(cssH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
        gl.viewport(0, 0, bw, bh);
      }
      sizeRef.current = { w: cssW, h: cssH };

      const last = lastTimeRef.current;
      const dt = last === 0 ? 1 / 60 : Math.min(1 / 30, (now - last) / 1000);
      lastTimeRef.current = now;

      // Growth ramp — fade in/out. Render-side `u_fade` multiplies the alpha
      // so the aurora dissolves evenly rather than snapping off.
      if (reducedMotionRef.current) {
        growthRef.current = activeRef.current ? 1 : 0;
      } else {
        const target = activeRef.current ? 1 : 0;
        const ms = activeRef.current ? AURORA_ENTER_MS : AURORA_EXIT_MS;
        const step = (dt * 1000) / ms;
        if (growthRef.current < target) {
          growthRef.current = Math.min(target, growthRef.current + step);
        } else if (growthRef.current > target) {
          growthRef.current = Math.max(target, growthRef.current - step);
        }
      }

      // Hard cut-off once fully retracted — stop the loop until reactivation.
      if (!activeRef.current && growthRef.current <= 0) {
        if (!cleared) {
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          cleared = true;
        }
        rafRef.current = 0;
        lastTimeRef.current = 0;
        return;
      }
      cleared = false;

      timeRef.current += dt * speedRef.current;

      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      const pos = posAttribRef.current;
      if (pos >= 0) {
        gl.enableVertexAttribArray(pos);
        gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
      }

      const u = uniformsRef.current;
      gl.uniform2f(u.res, bw, bh);
      gl.uniform1f(u.time, timeRef.current);
      gl.uniform1f(u.fade, growthRef.current * alphaRef.current);
      gl.uniform1f(u.seed, seedRef.current);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [renderActive, active]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-full pointer-events-none"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 0,
        borderRadius: "inherit",
      }}
    />
  );
}

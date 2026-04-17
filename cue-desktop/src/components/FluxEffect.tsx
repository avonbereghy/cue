import { useEffect, useRef } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";
import { getFrequencyData } from "@/lib/presetEngine";
import { getDisturbances } from "@/lib/fluxDisturbance";

interface FluxEffectProps {
  /** Theme tint color in hex (e.g. "#22c55e"). Lines blend toward this. */
  color: string;
  /** Overall opacity (0-1) applied at the end of the fragment shader. */
  alpha?: number;
  /**
   * Per-card seed string (typically session id). Shifts the flow field's
   * phase so sibling cards don't display the same pattern in lockstep.
   */
  seed?: string;
  /** Audio-reactivity strength — how much band energy modulates motion. 0 = off. */
  intensity?: number;
  /** Grid-density multiplier. Higher = more streamlines (finer spacing). */
  density?: number;
  /** Field-evolution speed multiplier. Higher = faster curling. */
  speed?: number;
  /** Line length multiplier (against the ~36px base). */
  lineLength?: number;
  /** Spatial turbulence multiplier — scales the field's wavenumber. */
  turbulence?: number;
  /** Band gates (passed through; "false" means the band contributes zero energy). */
  bass?: boolean;
  mids?: boolean;
  treble?: boolean;
  /**
   * Growth gate. When `true`, lines grow from zero length to their spring
   * targets (enter). When `false`, they retract back to zero (exit). The
   * parent is responsible for keeping this component mounted long enough for
   * the retract to play before unmounting — see EXIT_MS below.
   */
  active?: boolean;
}

/** How long the enter/exit growth ramp takes. Parent should delay unmount
 *  at least EXIT_MS after flipping active→false so the retract plays out. */
export const FLUX_ENTER_MS = 500;
export const FLUX_EXIT_MS = 400;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/* -------------------------------------------------------------------------
 * FluxEffect — streamlines through a curl-noise velocity field.
 *
 * Inspired by sandydoo/flux (https://github.com/sandydoo/flux). The reference
 * runs a full Navier-Stokes solver; a small card doesn't warrant that, so we
 * substitute an analytical curl-noise velocity field (sum of sines with its
 * 2D curl) which is divergence-free by construction and captures ~90% of the
 * visual. Per-line dynamics (spring toward `lineLength * V`, with momentum
 * and damping) and the quad-extrusion + tail-fade shaders are straight out of
 * Flux's `place_lines.vert` / `line.frag`.
 *
 *   line state  : basepoint (fixed) + endpoint vector + velocity (spring)
 *   per-frame   : sample curl-noise at basepoint, step spring, upload buffer
 *   draw        : instanced quads extruded along endpoint, taper + AA edges
 * ---------------------------------------------------------------------- */

// Stream-function sum. psi(x, y, t) = Σ A·sin(kx·x + ky·y + ω·t + φ).
// Velocity = 2D curl = (∂ψ/∂y, -∂ψ/∂x). Closed-form derivatives below.
const FLOW_COMPONENTS = [
  { A: 1.00, kx:  0.0100, ky:  0.0070, w: 0.30, p: 0.0 },
  { A: 0.65, kx: -0.0140, ky:  0.0160, w: 0.40, p: 1.7 },
  { A: 0.45, kx:  0.0220, ky: -0.0130, w: 0.24, p: 3.1 },
  { A: 0.32, kx:  0.0150, ky:  0.0240, w: 0.18, p: 5.0 },
];

function sampleField(
  x: number,
  y: number,
  t: number,
  seed: number,
  turbulenceMul: number,
): [number, number] {
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < FLOW_COMPONENTS.length; i++) {
    const c = FLOW_COMPONENTS[i];
    // Per-component seed phase — irrational multiplier so different cards land
    // in unrelated regions of each component, not just a global time shift.
    const seedPhase = seed * (i + 1) * 2.399;
    const kx = c.kx * turbulenceMul;
    const ky = c.ky * turbulenceMul;
    const cs = Math.cos(kx * x + ky * y + c.w * t + c.p + seedPhase);
    // Derivative scale tracks kx/ky so |V| stays roughly invariant under
    // turbulence changes — turbulence changes swirl frequency, not magnitude.
    vx += c.A * ky * cs;
    vy -= c.A * kx * cs;
  }
  // Normalize against the un-scaled amplitude (~0.025) so turbulence only
  // affects the spatial pattern, not the overall line speed.
  return [(vx / turbulenceMul) * 32, (vy / turbulenceMul) * 32];
}

// Cheap deterministic hash of a string → [0, 1). Used to turn session ids
// into a stable per-card phase seed.
function hashSeed(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 0xffffffff;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT = `
attribute vec2 a_quad;       // [0..1, 0..1] — unit quad vertex
attribute vec2 a_base;       // basepoint in CSS pixels
attribute vec2 a_end;        // endpoint vector in CSS pixels
attribute vec2 a_vel;        // velocity in CSS pixels/s
attribute float a_seed;      // per-line offset [0..1] — breaks color lockstep

uniform vec2 u_res;          // CSS width/height
uniform float u_width;       // base line width in CSS px
uniform vec3 u_tint;         // theme color — blended into palette
uniform float u_audio;       // audio drive factor, 1 at rest, >1 on peaks
uniform float u_growth;      // global growth [0, 1]; 0 = zero-length, 1 = full

varying vec2 v_uv;
varying float v_widthBoost;
varying vec3 v_color;
varying float v_growth;      // per-line growth after stagger, passed to frag

// Shade palette derived from u_tint so the effect always reads as the state
// color (green for done, orange for idle, etc.). Variation comes from
// brightness (dark→bright→washed), not hue rotation, so the card still
// unambiguously signals its state.
vec3 paletteAt(float a, vec3 tint) {
  // Keep all four stops clearly inside the tint's hue — the effect should
  // unambiguously carry the state color. Variation comes from brightness.
  vec3 c1 = mix(tint, vec3(1.0), 0.18) * 1.15;   // soft highlight
  vec3 c2 = tint * 1.35;                          // punchy saturated
  vec3 c3 = mix(tint, vec3(1.0), 0.08) * 1.22;   // bright mid
  vec3 c4 = tint * 0.55;                          // deep shadow
  float x = fract(a);
  if (x < 0.25) return mix(c1, c2, x / 0.25);
  if (x < 0.50) return mix(c2, c3, (x - 0.25) / 0.25);
  if (x < 0.75) return mix(c3, c4, (x - 0.50) / 0.25);
  return mix(c4, c1, (x - 0.75) / 0.25);
}

void main() {
  float len = length(a_end);
  vec2 tan = len > 0.001 ? a_end / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-tan.y, tan.x);

  // widthBoost: 0 when slow, 1 when fast. Slow lines effectively vanish,
  // matching Flux's behavior where still regions aren't drawn.
  float speed = length(a_vel);
  float wb = clamp(speed / 18.0, 0.0, 1.0);
  wb = wb * wb * (3.0 - 2.0 * wb); // smoothstep curve

  // Quad extrusion: y goes from basepoint (0) to endpoint (1) along tangent,
  // x from -halfW (0) to +halfW (1) along perpendicular. Lines are a fixed
  // short height — audio no longer extends the tip; it drives the field's
  // evolution speed instead (CPU side). Keeps u_audio in the uniform list for
  // future ideas but unused in geometry.
  float extY = a_quad.y;

  // Enter/exit growth: each line has an appear window inside the global
  // ramp u_growth, offset by its per-line seed. smoothstep gives a cubic
  // ease within the window, and the staggered starts produce the
  // "growing out of the card" cascade without an extra attribute.
  float appearT = a_seed * 0.5;
  float growth = smoothstep(appearT, appearT + 0.5, u_growth);

  float halfW = u_width * (0.35 + 0.65 * wb);
  vec2 offset = tan * (extY * len * growth)
              + nrm * ((a_quad.x - 0.5) * halfW * 2.0 * growth);
  vec2 pos = a_base + offset;

  vec2 ndc = (pos / u_res) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  gl_Position = vec4(ndc, 0.0, 1.0);

  v_uv = a_quad;
  v_widthBoost = wb;
  v_growth = growth;
  float angle = atan(a_end.y, a_end.x) / 6.28318 + 0.5; // [0..1]
  v_color = paletteAt(angle + a_seed, u_tint);
}
`;

const FRAG = `
#extension GL_OES_standard_derivatives : enable
precision mediump float;

varying vec2 v_uv;
varying float v_widthBoost;
varying vec3 v_color;
varying float v_growth;

uniform float u_alpha;

void main() {
  // Anti-aliased perpendicular edges.
  float xd = abs(v_uv.x - 0.5);
  float aa = fwidth(xd);
  float edge = 1.0 - smoothstep(0.5 - aa, 0.5, xd);

  // Tail-to-head alpha fade (Flux line.frag's smoothstep(offset, 1, y)).
  float taper = smoothstep(0.0, 0.6, v_uv.y);

  // Fold growth into alpha so sub-pixel-short stubs don't read as slivers
  // during enter/exit — they fade with their length.
  float a = edge * taper * v_widthBoost * u_alpha * v_growth;
  gl_FragColor = vec4(v_color * (0.65 + 0.35 * v_widthBoost), a);
}
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// Each line stores 7 floats: baseX, baseY, endX, endY, velX, velY, seed.
const FLOATS_PER_LINE = 7;

// Base values for the tunables. Runtime props multiply these.
const BASE_GRID_SPACING = 12;   // CSS pixels at density=1
const BASE_LINE_LENGTH = 36;    // pixels at lineLength=1
const LINE_WIDTH = 1.8;         // pixels, base width (speed-modulated)
const SPRING_K = 28;            // stiffness (rad²/s²)
const DAMP_K = 5.5;             // damping (1/s); ζ ≈ 0.52 → gently underdamped
const MAX_DT = 1 / 30;          // clamp dt after tab-hidden / stalls

export function FluxEffect({
  color,
  alpha = 0.9,
  seed = "",
  intensity = 1.0,
  density = 1.0,
  speed = 1.0,
  lineLength = 1.0,
  turbulence = 1.0,
  bass = true,
  mids = true,
  treble = true,
  active = true,
}: FluxEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const progRef = useRef<WebGLProgram | null>(null);
  const quadBufRef = useRef<WebGLBuffer | null>(null);
  const instBufRef = useRef<WebGLBuffer | null>(null);
  const linesRef = useRef<Float32Array | null>(null);
  const lineCountRef = useRef(0);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const fadeRef = useRef(0);
  // Accumulated "field time" — advanced each frame by
  // dt · speed · audioDrive. Separate from wall-clock so audio changes
  // modulate evolution rate without causing a phase jump.
  const fieldTimeRef = useRef(0);
  const sizeRef = useRef({ w: 0, h: 0 });
  const uniformsRef = useRef<{
    res: WebGLUniformLocation | null;
    width: WebGLUniformLocation | null;
    tint: WebGLUniformLocation | null;
    alpha: WebGLUniformLocation | null;
    audio: WebGLUniformLocation | null;
    growth: WebGLUniformLocation | null;
  }>({ res: null, width: null, tint: null, alpha: null, audio: null, growth: null });
  const attribsRef = useRef<{
    quad: number;
    base: number;
    end: number;
    vel: number;
    seed: number;
  }>({ quad: -1, base: -1, end: -1, vel: -1, seed: -1 });
  const instExtRef = useRef<ANGLE_instanced_arrays | null>(null);
  const pageVisible = usePageVisible();

  const colorRef = useRef(color);
  const alphaRef = useRef(alpha);
  const seedRef = useRef(hashSeed(seed));
  const intensityRef = useRef(intensity);
  const densityRef = useRef(density);
  const speedRef = useRef(speed);
  const lineLengthRef = useRef(lineLength);
  const turbulenceRef = useRef(turbulence);
  const bassRef = useRef(bass);
  const midsRef = useRef(mids);
  const trebleRef = useRef(treble);
  colorRef.current = color;
  alphaRef.current = alpha;
  seedRef.current = hashSeed(seed);
  intensityRef.current = intensity;
  densityRef.current = density;
  speedRef.current = speed;
  lineLengthRef.current = lineLength;
  turbulenceRef.current = turbulence;
  bassRef.current = bass;
  midsRef.current = mids;
  trebleRef.current = treble;

  // Enter/exit growth — starts at 0 and ramps to 1 on mount when active, or
  // ramps back to 0 before unmount. With prefers-reduced-motion, snap to end.
  const reducedMotionRef = useRef(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  const growthRef = useRef(reducedMotionRef.current ? (active ? 1 : 0) : 0);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Generate basepoints for a given CSS size. Endpoints are pre-settled to the
  // field's target at `t` so lines appear already flowing on the first frame;
  // velocity starts at zero and the spring keeps them tracking from there.
  const rebuildLines = (w: number, h: number, t: number, seedVal: number) => {
    const spacing = BASE_GRID_SPACING / Math.max(0.2, densityRef.current);
    const cols = Math.max(4, Math.floor(w / spacing));
    const rows = Math.max(3, Math.floor(h / spacing));
    const cellW = w / cols;
    const cellH = h / rows;
    const n = cols * rows;
    const lineLen = BASE_LINE_LENGTH * lineLengthRef.current;
    const turb = turbulenceRef.current;
    const arr = new Float32Array(n * FLOATS_PER_LINE);
    let idx = 0;
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const jx = (Math.random() - 0.5) * 0.5;
        const jy = (Math.random() - 0.5) * 0.5;
        const bx = (gx + 0.5 + jx) * cellW;
        const by = (gy + 0.5 + jy) * cellH;
        const [fx, fy] = sampleField(bx, by, t, seedVal, turb);
        arr[idx + 0] = bx;
        arr[idx + 1] = by;
        arr[idx + 2] = lineLen * fx;
        arr[idx + 3] = lineLen * fy;
        arr[idx + 4] = 0;
        arr[idx + 5] = 0;
        arr[idx + 6] = Math.random();
        idx += FLOATS_PER_LINE;
      }
    }
    linesRef.current = arr;
    lineCountRef.current = n;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) return;
    glRef.current = gl;

    // ANGLE_instanced_arrays is required (WebGL1). Universally available.
    const ext = gl.getExtension("ANGLE_instanced_arrays");
    if (!ext) return;
    instExtRef.current = ext;
    gl.getExtension("OES_standard_derivatives");

    const compile = (src: string, kind: number) => {
      const s = gl.createShader(kind)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        // eslint-disable-next-line no-console
        console.error("FluxEffect shader error:", gl.getShaderInfoLog(s));
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
      console.error("FluxEffect link error:", gl.getProgramInfoLog(prog));
    }
    progRef.current = prog;

    // Unit quad (0..1 x 0..1). Using triangle strip with 4 verts.
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW
    );
    quadBufRef.current = quadBuf;

    // Instance buffer (dynamic; rewritten each frame with updated state).
    const instBuf = gl.createBuffer();
    instBufRef.current = instBuf;

    attribsRef.current = {
      quad: gl.getAttribLocation(prog, "a_quad"),
      base: gl.getAttribLocation(prog, "a_base"),
      end:  gl.getAttribLocation(prog, "a_end"),
      vel:  gl.getAttribLocation(prog, "a_vel"),
      seed: gl.getAttribLocation(prog, "a_seed"),
    };
    uniformsRef.current = {
      res:    gl.getUniformLocation(prog, "u_res"),
      width:  gl.getUniformLocation(prog, "u_width"),
      tint:   gl.getUniformLocation(prog, "u_tint"),
      alpha:  gl.getUniformLocation(prog, "u_alpha"),
      audio:  gl.getUniformLocation(prog, "u_audio"),
      growth: gl.getUniformLocation(prog, "u_growth"),
    };

    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    // Premultiplied-alpha-style additive: source contributes color * alpha and
    // the destination color shows through (1 - alpha). This matches standard
    // alpha compositing on top of the card surface.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    fadeRef.current = 0;
    lastTimeRef.current = 0;

    return () => {
      cancelAnimationFrame(rafRef.current);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (quadBufRef.current) gl.deleteBuffer(quadBufRef.current);
      if (instBufRef.current) gl.deleteBuffer(instBufRef.current);
      glRef.current = null;
      progRef.current = null;
      quadBufRef.current = null;
      instBufRef.current = null;
      linesRef.current = null;
    };
  }, []);

  // Density and seed changes only take effect on a rebuild. Invalidate the
  // cached size so the next frame regenerates the grid.
  useEffect(() => {
    sizeRef.current = { w: 0, h: 0 };
  }, [density, seed]);

  useEffect(() => {
    const gl = glRef.current;
    const ext = instExtRef.current;
    const prog = progRef.current;
    if (!gl || !ext || !prog || !pageVisible) {
      cancelAnimationFrame(rafRef.current);
      lastTimeRef.current = 0;
      return;
    }

    const render = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !gl || !prog) return;
      const a = attribsRef.current;
      const u = uniformsRef.current;
      const quadBuf = quadBufRef.current;
      const instBuf = instBufRef.current;
      if (!quadBuf || !instBuf) return;

      // Size — check CSS rect; rebuild the line grid if dimensions changed.
      const rect = canvas.getBoundingClientRect();
      const cssW = rect.width;
      const cssH = rect.height;
      if (cssW < 1 || cssH < 1) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(cssH * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
        gl.viewport(0, 0, bw, bh);
      }
      if (sizeRef.current.w !== cssW || sizeRef.current.h !== cssH) {
        // Pre-settle endpoints at the current field time so lines appear in
        // their flowing positions immediately after a resize/rebuild.
        rebuildLines(cssW, cssH, fieldTimeRef.current, seedRef.current);
        sizeRef.current = { w: cssW, h: cssH };
      }
      const curLines = linesRef.current;
      if (!curLines) {
        rafRef.current = requestAnimationFrame(render);
        return;
      }

      // dt in seconds (clamped — if tab was hidden, don't integrate huge jumps).
      const last = lastTimeRef.current;
      const dt = last === 0 ? 1 / 60 : Math.min(MAX_DT, (now - last) / 1000);
      lastTimeRef.current = now;

      // Audio drive — shared preset engine. Average band bins → scalar E∈[0,1],
      // respecting the Bass/Mids/Treble band gates. Same feed strings/sand use.
      const freq = getFrequencyData();
      let energy = 0;
      let eCount = 0;
      // bass: bins 0..31, mids: 32..76, treble: 77..127 (matching presetEngine)
      if (bassRef.current) {
        for (let i = 0; i < 32; i++) energy += freq[i];
        eCount += 32;
      }
      if (midsRef.current) {
        for (let i = 32; i < 77; i++) energy += freq[i];
        eCount += 45;
      }
      if (trebleRef.current) {
        for (let i = 77; i < 128; i++) energy += freq[i];
        eCount += 51;
      }
      const E = eCount > 0 ? energy / (eCount * 255) : 0;
      // intensity now controls how strongly audio modulates the field's
      // evolution speed — NOT the line length. Lines stay a fixed short
      // height so the audio visibly animates the flow instead of stretching
      // geometry. See vertex shader comment.
      const audioDrive = 1 + E * intensityRef.current;

      // Advance field time as dt · speed · audioDrive. Accumulating (rather
      // than multiplying wall-clock) means audioDrive changes smoothly alter
      // the evolution rate without phase jumps.
      fieldTimeRef.current += dt * speedRef.current * audioDrive;
      const tField = fieldTimeRef.current;

      const lineLen = BASE_LINE_LENGTH * lineLengthRef.current;
      const turb = turbulenceRef.current;
      // Disturbances are read once per frame. Each one pushes nearby line
      // targets radially outward, producing the "strings displace the flux"
      // effect during the thinking → working handoff.
      const dists = getDisturbances(seed);

      // Step each line: sample field → spring toward target endpoint.
      const n = lineCountRef.current;
      for (let i = 0; i < n; i++) {
        const k = i * FLOATS_PER_LINE;
        const bx = curLines[k + 0];
        const by = curLines[k + 1];
        const ex = curLines[k + 2];
        const ey = curLines[k + 3];
        const vx = curLines[k + 4];
        const vy = curLines[k + 5];

        const [fx, fy] = sampleField(bx, by, tField, seedRef.current, turb);
        let tx = lineLen * fx;
        let ty = lineLen * fy;

        // Apply radial displacement from any active disturbances. Quadratic
        // falloff within the radius; direction from disturbance center to
        // basepoint, so lines bend AWAY from whatever is pushing through.
        for (let di = 0; di < dists.length; di++) {
          const d = dists[di];
          const ddx = bx - d.x;
          const ddy = by - d.y;
          const rr = Math.sqrt(ddx * ddx + ddy * ddy);
          if (rr < d.radius) {
            const falloff = 1 - rr / d.radius;
            const push = falloff * falloff * d.force * d.strength;
            if (rr > 0.01) {
              tx += (ddx / rr) * push;
              ty += (ddy / rr) * push;
            } else {
              // Line coincides exactly with disturbance center — pick a
              // deterministic-ish direction from the basepoint so the
              // line still moves instead of sitting at zero gradient.
              tx += Math.cos(bx * 0.17) * push;
              ty += Math.sin(by * 0.19) * push;
            }
          }
        }

        const ax = SPRING_K * (tx - ex) - DAMP_K * vx;
        const ay = SPRING_K * (ty - ey) - DAMP_K * vy;

        const nvx = vx + ax * dt;
        const nvy = vy + ay * dt;
        curLines[k + 2] = ex + nvx * dt;
        curLines[k + 3] = ey + nvy * dt;
        curLines[k + 4] = nvx;
        curLines[k + 5] = nvy;
      }

      // Fade in over ~1s so the card isn't suddenly strobing on state change.
      if (fadeRef.current < 1) {
        fadeRef.current = Math.min(1, fadeRef.current + dt);
      }

      // Growth ramp — reach 1 over FLUX_ENTER_MS when active, 0 over
      // FLUX_EXIT_MS when not. Linear is fine here because each line applies
      // its own cubic smoothstep in the shader (see vertex), so the JS ramp
      // just schedules when each stagger window opens.
      if (reducedMotionRef.current) {
        growthRef.current = activeRef.current ? 1 : 0;
      } else {
        const target = activeRef.current ? 1 : 0;
        const ms = activeRef.current ? FLUX_ENTER_MS : FLUX_EXIT_MS;
        const step = (dt * 1000) / ms;
        if (growthRef.current < target) {
          growthRef.current = Math.min(target, growthRef.current + step);
        } else if (growthRef.current > target) {
          growthRef.current = Math.max(target, growthRef.current - step);
        }
      }

      // Upload instance data.
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, curLines, gl.DYNAMIC_DRAW);

      const stride = FLOATS_PER_LINE * 4;
      if (a.base >= 0) {
        gl.enableVertexAttribArray(a.base);
        gl.vertexAttribPointer(a.base, 2, gl.FLOAT, false, stride, 0);
        ext.vertexAttribDivisorANGLE(a.base, 1);
      }
      if (a.end >= 0) {
        gl.enableVertexAttribArray(a.end);
        gl.vertexAttribPointer(a.end, 2, gl.FLOAT, false, stride, 8);
        ext.vertexAttribDivisorANGLE(a.end, 1);
      }
      if (a.vel >= 0) {
        gl.enableVertexAttribArray(a.vel);
        gl.vertexAttribPointer(a.vel, 2, gl.FLOAT, false, stride, 16);
        ext.vertexAttribDivisorANGLE(a.vel, 1);
      }
      if (a.seed >= 0) {
        gl.enableVertexAttribArray(a.seed);
        gl.vertexAttribPointer(a.seed, 1, gl.FLOAT, false, stride, 24);
        ext.vertexAttribDivisorANGLE(a.seed, 1);
      }

      // Per-vertex quad geometry.
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
      if (a.quad >= 0) {
        gl.enableVertexAttribArray(a.quad);
        gl.vertexAttribPointer(a.quad, 2, gl.FLOAT, false, 0, 0);
        ext.vertexAttribDivisorANGLE(a.quad, 0);
      }

      gl.useProgram(prog);
      gl.uniform2f(u.res, cssW, cssH);
      gl.uniform1f(u.width, LINE_WIDTH);
      const [tr, tg, tb] = hexToRgb(colorRef.current);
      gl.uniform3f(u.tint, tr, tg, tb);
      gl.uniform1f(u.alpha, alphaRef.current * fadeRef.current);
      gl.uniform1f(u.audio, audioDrive);
      gl.uniform1f(u.growth, growthRef.current);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 4, n);

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [pageVisible]);

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
        zIndex: 1,
        borderRadius: "inherit",
      }}
    />
  );
}

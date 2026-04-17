import { useRef, useEffect } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";

interface DriftEffectProps {
  /** Theme accent color in hex (e.g. "#00e5ff") */
  color: string;
  /** Overall opacity (0-1) */
  alpha?: number;
}

/** Parse hex to normalized RGB floats */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

// ---------------------------------------------------------------------------
// GLSL shaders — Drift-style flowing ribbons via layered simplex noise
// ---------------------------------------------------------------------------

const VERT = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// macOS Drift screensaver recreation — dense parallel strokes flowing along
// a smoothly varying vector field. Each pixel finds the local flow direction
// from noise, then samples stripe phase along the perpendicular axis. Colors
// come from a slow painterly palette sampled independently of the strokes —
// which gives the "fabric with shifting hues" quality instead of neon ribbons.
const FRAG = `
precision highp float;

varying vec2 v_uv;
uniform float u_time;
uniform vec3 u_color;
uniform float u_alpha;

// --- simplex noise (Ashima Arts / Stefan Gustavson) ---
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
  + i.y + vec4(0.0, i1.y, i2.y, 1.0))
  + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

void main() {
  vec2 uv = v_uv;
  float t = u_time * 0.04;

  // Local flow direction: smooth angular field from noise, plus a slow global
  // rotation so the pattern isn't frozen when the scene is still.
  float angle =
    snoise(vec3(uv * 1.1, t * 0.25)) * 3.14159
    + snoise(vec3(uv * 0.5 + 13.0, t * 0.15)) * 1.5
    + t * 0.15;
  vec2 flow = vec2(cos(angle), sin(angle));
  vec2 perp = vec2(-flow.y, flow.x);

  // Perpendicular coordinate drives stroke phase; high frequency → fine
  // fur-like density. Low-freq jitter breaks perfectly regular spacing.
  float across = dot(uv, perp) * 260.0;
  float jitter = snoise(vec3(uv * 2.2, t * 0.3)) * 3.2;
  float phase  = across + jitter;

  // Two sampling layers at slightly different frequencies, summed and
  // re-sharpened — this gives the dense, interleaved hair look instead of a
  // single set of stripes.
  float s1 = sin(phase);
  float s2 = sin(phase * 1.37 + jitter * 0.5);
  float mask = (max(s1, 0.0) * 0.65 + max(s2, 0.0) * 0.45);
  float stroke = pow(mask, 2.2);

  // Painterly palette — four hues, each driven by an independent low-freq
  // noise, then blended. Theme color acts as a subtle tint, not a hard
  // multiplier, so the pattern keeps its own chroma.
  vec3 tint = u_color;
  vec3 c1 = mix(vec3(1.10, 0.30, 0.85), tint, 0.35); // magenta
  vec3 c2 = mix(vec3(0.30, 0.75, 1.30), tint, 0.35); // cold blue
  vec3 c3 = mix(vec3(1.25, 0.85, 0.40), tint, 0.30); // warm gold
  vec3 c4 = mix(vec3(0.45, 1.05, 0.75), tint, 0.30); // mint green

  float p1 = smoothstep(-1.0, 1.0, snoise(vec3(uv * 1.30, t * 0.20)));
  float p2 = smoothstep(-1.0, 1.0, snoise(vec3(uv * 1.05 + 7.0, t * 0.17)));
  float p3 = smoothstep(-1.0, 1.0, snoise(vec3(uv * 0.85 + 13.0, t * 0.13)));

  vec3 palette = mix(c1, c2, p1);
  palette = mix(palette, c3, p2 * 0.65);
  palette = mix(palette, c4, p3 * 0.45);

  // Highlight sheen on the crest of each stroke — adds a bright edge without
  // widening the stroke (keeps the fine weave look).
  float sheen = pow(max(s1, 0.0), 8.0) * 0.6;
  vec3 col = palette * (stroke * 1.15) + palette * sheen;

  // Very faint ambient wash between strokes so gaps aren't pure black —
  // mimics the soft substrate the Drift strokes are painted onto.
  float ambient = smoothstep(-0.4, 0.9, snoise(vec3(uv * 1.8, t * 0.25))) * 0.03;
  col += palette * ambient;

  // Coverage for alpha. Strokes are thin; raise the floor slightly so the
  // card surface picks up a tint across the whole surface.
  float coverage = clamp(stroke + ambient * 1.5, 0.0, 1.0);
  float a = coverage * u_alpha;

  gl_FragColor = vec4(col * u_alpha, a);
}
`;

export function DriftEffect({ color, alpha = 0.7 }: DriftEffectProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const programRef = useRef<WebGLProgram | null>(null);
  const rafRef = useRef(0);
  const startTimeRef = useRef(0);
  const uniformsRef = useRef<{
    time: WebGLUniformLocation | null;
    color: WebGLUniformLocation | null;
    alpha: WebGLUniformLocation | null;
  }>({ time: null, color: null, alpha: null });
  const pageVisible = usePageVisible();
  const fadeRef = useRef(0); // 0..1 fade-in

  // Update color/alpha without recreating GL context
  const colorRef = useRef(color);
  const alphaRef = useRef(alpha);
  colorRef.current = color;
  alphaRef.current = alpha;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) return;
    glRef.current = gl;

    // Compile shaders
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, FRAG);
    gl.compileShader(fs);

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    programRef.current = prog;

    // Full-screen quad
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    uniformsRef.current = {
      time: gl.getUniformLocation(prog, "u_time"),
      color: gl.getUniformLocation(prog, "u_color"),
      alpha: gl.getUniformLocation(prog, "u_alpha"),
    };

    gl.useProgram(prog);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive — ribbons glow on dark bg

    startTimeRef.current = performance.now();
    fadeRef.current = 0;

    return () => {
      cancelAnimationFrame(rafRef.current);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      glRef.current = null;
      programRef.current = null;
    };
  }, []);

  // Animation loop — pauses when tab hidden
  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !pageVisible) {
      cancelAnimationFrame(rafRef.current);
      return;
    }

    const render = (now: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !gl || !programRef.current) return;

      // Resize canvas to match CSS size at native resolution
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }

      // Fade in over 2 seconds
      if (fadeRef.current < 1) {
        fadeRef.current = Math.min(1, fadeRef.current + 0.016); // ~60fps step
      }

      const t = (now - startTimeRef.current) / 1000;
      const [r, g, b] = hexToRgb(colorRef.current);
      const u = uniformsRef.current;

      gl.uniform1f(u.time, t);
      gl.uniform3f(u.color, r, g, b);
      gl.uniform1f(u.alpha, alphaRef.current * fadeRef.current);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

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

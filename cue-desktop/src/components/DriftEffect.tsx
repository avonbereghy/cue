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

// macOS Drift screensaver recreation — bright flowing light ribbons
// Uses domain warping + sinusoidal bands for distinct luminous streams
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

// Thin bright ribbon from sinusoidal band — sharp falloff creates light trail
float ribbon(float x, float width) {
  return pow(max(1.0 - abs(x) / width, 0.0), 3.0);
}

void main() {
  vec2 uv = v_uv;
  float t = u_time * 0.035;

  // Domain warping: warp UV coordinates with noise for fluid flow
  vec2 warp1 = vec2(
    snoise(vec3(uv * 1.5, t * 0.4)),
    snoise(vec3(uv * 1.5 + 7.0, t * 0.4 + 3.0))
  );
  vec2 warp2 = vec2(
    snoise(vec3((uv + warp1 * 0.3) * 2.0, t * 0.3 + 10.0)),
    snoise(vec3((uv + warp1 * 0.3) * 2.0 + 5.0, t * 0.3 + 13.0))
  );
  vec2 warped = uv + warp1 * 0.25 + warp2 * 0.15;

  // Create multiple ribbon streams at different angles and speeds
  float r1 = ribbon(sin(warped.x * 4.0 + warped.y * 2.0 + t * 1.2), 0.12);
  float r2 = ribbon(sin(warped.x * 3.0 - warped.y * 3.5 + t * 0.9 + 2.0), 0.10);
  float r3 = ribbon(sin(warped.y * 5.0 + warped.x * 1.5 - t * 0.7 + 4.5), 0.08);
  float r4 = ribbon(sin((warped.x + warped.y) * 3.5 + t * 1.1 + 1.0), 0.14);
  float r5 = ribbon(sin(warped.x * 6.0 - warped.y * 2.0 - t * 0.5 + 3.0), 0.06);

  // Color palette — shift hue around the base theme color
  // Rotate through warm/cool/saturated variants
  vec3 c1 = u_color * 1.4;                           // bright base
  vec3 c2 = u_color * vec3(0.5, 0.9, 1.5) * 1.3;   // cool shift
  vec3 c3 = u_color * vec3(1.5, 0.7, 0.9) * 1.2;   // warm shift
  vec3 c4 = u_color * vec3(0.8, 1.3, 0.6) * 1.1;   // green shift
  vec3 c5 = u_color * vec3(1.3, 0.5, 1.4) * 1.2;   // purple shift

  // Combine ribbons with distinct colors — additive for glow
  vec3 col = vec3(0.0);
  col += c1 * r1;
  col += c2 * r2;
  col += c3 * r3;
  col += c4 * r4;
  col += c5 * r5;

  // Boost brightness and add bloom-like glow on bright spots
  col += col * col * 0.8;

  // Overall intensity for alpha
  float intensity = max(max(r1, r2), max(max(r3, r4), r5));
  // Add a subtle ambient glow from the warped field
  float ambient = smoothstep(-0.3, 0.8, snoise(vec3(warped * 2.0, t * 0.5))) * 0.08;

  float a = (intensity + ambient) * u_alpha;

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

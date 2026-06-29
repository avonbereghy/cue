/**
 * Release a WebGL context promptly via the WEBGL_lose_context extension.
 *
 * Deleting programs/shaders/buffers does NOT free the underlying GL context.
 * Browsers cap simultaneous WebGL contexts (commonly ~16), so a long-running
 * session with many effect canvases mounting/unmounting can exhaust the pool
 * and leave later cards blank. Calling loseContext() on cleanup frees the
 * context immediately. Best-effort: it must never throw into a React cleanup.
 */
export function releaseGlContext(
  gl: WebGLRenderingContext | WebGL2RenderingContext | null | undefined,
): void {
  try {
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // Ignore: releasing a context must never break unmount cleanup.
  }
}

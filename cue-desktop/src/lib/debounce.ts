/**
 * Trailing-edge debounce. The wrapped `fn` runs once, `ms` after the last call.
 *
 * Used to coalesce settings auto-saves: dragging a slider fires a state change
 * per animation frame, and persisting each one is a Tauri IPC + disk write per
 * frame. Debouncing collapses a drag into a single write once it settles.
 *
 * `.flush()` runs any pending call immediately (call it on unmount so the last
 * change isn't lost); `.cancel()` drops a pending call.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: A | undefined;

  const run = () => {
    timer = undefined;
    const args = pending;
    pending = undefined;
    if (args) fn(...args);
  };

  const debounced = ((...args: A) => {
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Debounced<A>;

  debounced.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };

  debounced.flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      run();
    }
  };

  return debounced;
}

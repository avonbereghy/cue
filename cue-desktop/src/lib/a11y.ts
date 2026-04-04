let liveRegion: HTMLDivElement | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Announce a message to screen readers via an aria-live region.
 * Creates a visually-hidden div on first use, then sets its text content
 * to trigger the announcement. Clears after a short delay so repeated
 * identical messages are re-announced.
 */
export function announce(
  message: string,
  priority: "polite" | "assertive" = "polite",
): void {
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.setAttribute("role", "status");
    liveRegion.setAttribute("aria-live", priority);
    liveRegion.setAttribute("aria-atomic", "true");
    Object.assign(liveRegion.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      padding: "0",
      margin: "-1px",
      overflow: "hidden",
      clip: "rect(0, 0, 0, 0)",
      whiteSpace: "nowrap",
      border: "0",
    });
    document.body.appendChild(liveRegion);
  }

  // Update priority if it changed
  liveRegion.setAttribute("aria-live", priority);

  // Clear first so identical consecutive messages still trigger
  if (clearTimer) {
    clearTimeout(clearTimer);
  }
  liveRegion.textContent = "";

  // Set in next tick so the clear registers with the screen reader
  requestAnimationFrame(() => {
    if (liveRegion) {
      liveRegion.textContent = message;
    }
  });

  // Clear after a delay so the next announcement works
  clearTimer = setTimeout(() => {
    if (liveRegion) {
      liveRegion.textContent = "";
    }
    clearTimer = null;
  }, 3000);
}

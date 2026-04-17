/**
 * Shared registry of transient "disturbance" sources that perturb the Flux
 * streamline field. Used by the thinking → working transition: as the signal
 * strings deploy from the left edge, each band publishes a disturbance at its
 * leading edge, which FluxEffect reads each frame and converts into a radial
 * push on nearby line targets. Flux lines bend aside, spring back, then the
 * whole effect fades out once the strings have arrived.
 *
 * Inspired by the retenir activity-dashboard pattern where event dots push the
 * flux field as they traverse edge lines. We key the registry per-card (by
 * session id / seed) so sibling cards don't bleed displacement into each other.
 */

export interface FluxDisturbance {
  /** CSS-pixel x-coordinate within the card's flux canvas. */
  x: number;
  /** CSS-pixel y-coordinate within the card's flux canvas. */
  y: number;
  /** Effect radius in CSS pixels. Lines outside this radius are unaffected. */
  radius: number;
  /** Push magnitude at the center (in CSS pixels, applied to the spring target). */
  force: number;
  /**
   * Strength scalar in [0, 1] — ramped up on entry and down on exit so the
   * displacement fades rather than pops when strings begin/finish their sweep.
   */
  strength: number;
}

const registry: Map<string, FluxDisturbance[]> = new Map();

/**
 * Replace the full disturbance list for a card. Producers call this every
 * frame with the current positions of whatever is perturbing the flux.
 * Passing an empty array (or omitting) clears the card's entry.
 */
export function setDisturbances(key: string, list: FluxDisturbance[] | null): void {
  if (!list || list.length === 0) {
    registry.delete(key);
  } else {
    registry.set(key, list);
  }
}

/** Read the current disturbance list for a card. Returns a stable empty array
 *  when none are registered — callers iterate without null checks. */
const EMPTY: FluxDisturbance[] = [];
export function getDisturbances(key: string): FluxDisturbance[] {
  return registry.get(key) ?? EMPTY;
}

/** Drop a card's entry (e.g., on unmount or when transition fully completes). */
export function clearDisturbances(key: string): void {
  registry.delete(key);
}

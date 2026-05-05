/**
 * Cross-component "state transition in flight" registry.
 *
 * Each `SessionCard` registers its session id when it begins a state
 * commitHandoff (the 250ms window where strings retract / press-down /
 * effects cross-fade) and clears it when the post-effect settles. The list
 * shuffle in `SessionsTab` checks this registry before firing a FLIP — if
 * any card is mid-transition, the reorder is deferred until the registry
 * empties. This guarantees state animations and shuffle animations never
 * overlap (the user-stated invariant: "before or after a shuffle, never
 * during").
 *
 * Implementation note: this is intentionally a module-scoped mutable Set
 * rather than React context because the consumers are imperative (a setTimeout
 * callback in SessionsTab and a useEffect cleanup in SessionCard). A context
 * would force the registry through React's render path, defeating the
 * point — we want the most up-to-date value at the moment the timer fires.
 */

const inFlight = new Set<string>();
type Listener = () => void;
const listeners = new Set<Listener>();

export function beginTransition(sessionId: string): void {
  inFlight.add(sessionId);
  listeners.forEach((l) => l());
}

export function endTransition(sessionId: string): void {
  if (inFlight.delete(sessionId)) {
    listeners.forEach((l) => l());
  }
}

export function isAnyTransitionInFlight(): boolean {
  return inFlight.size > 0;
}

export function inFlightCount(): number {
  return inFlight.size;
}

/**
 * Subscribe to changes in the registry. Returns an unsubscribe fn. Called
 * by `SessionsTab` so that, when the last in-flight card clears, it can
 * re-evaluate any deferred reorder triggers.
 */
export function subscribeTransitions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

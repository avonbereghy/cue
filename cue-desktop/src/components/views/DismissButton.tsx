interface DismissButtonProps {
  sessionId: string;
  /** Session title, for the accessible label. */
  title: string;
  onDismiss: (id: string) => void;
}

/**
 * The card "X" — tucks a session into the recoverable Resting group. Shared by
 * the instrument card and every Look so the affordance, the a11y label, and the
 * click-guard behaviour can't drift per-skin (one source of truth). It's a
 * native <button>, which every card's open-project click guard
 * (`closest("button, …")`) already skips, and it `stopPropagation`s as
 * belt-and-suspenders. Positioning + the hover/focus reveal live in
 * `.card-dismiss` (globals.css), styled from `currentColor` so it reads on both
 * the dark instrument surface and the paper Looks.
 */
export function DismissButton({ sessionId, title, onDismiss }: DismissButtonProps) {
  return (
    <button
      type="button"
      className="card-dismiss"
      onClick={(e) => {
        e.stopPropagation();
        onDismiss(sessionId);
      }}
      aria-label={`Dismiss ${title} — hide until it's active again`}
      title="Dismiss (hide until active again)"
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <path d="M5 5l14 14M19 5L5 19" />
      </svg>
    </button>
  );
}

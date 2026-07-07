// Dashboard "Look" registry — the visual skin axis, independent of the
// flow/grouped layout and the color theme. "instrument" is the original
// signal/waveform card; the others are warm, hand-made alternatives that each
// ship their own palette + typography (see styles/almanac.css etc.).
//
// applyDashboardView() sets a `data-view` attribute on <html> for CSS scoping
// and, for a skinned look, overrides the shared shell surfaces (--app-bg /
// --app-text / --color-white) so the title-bar strip and any window gaps adopt
// the look — and so the toolbar's Tailwind `text-white/N` utilities resolve to
// the right ink on light paper. main.tsx calls this AFTER applyThemeCssVars so
// the skin wins; switching back to "instrument" hands control back to the theme.

export type DashboardViewId = "instrument" | "almanac" | "studio" | "night";

export interface DashboardViewMeta {
  id: DashboardViewId;
  label: string;
  /** Light/dark identity — used by the Settings picker swatch. */
  kind: "instrument" | "light" | "dark";
  blurb: string;
  /** Shared-shell overrides applied while this look is active ("" = leave the
   *  theme's value in place, used by instrument). */
  appBg: string;
  appText: string;
  /** Value for --color-white so the shared toolbar ink reads correctly. */
  ink: string;
}

export const DASHBOARD_VIEWS: DashboardViewMeta[] = [
  { id: "instrument", label: "Instrument", kind: "instrument", blurb: "The original signal / waveform cards", appBg: "", appText: "", ink: "" },
  { id: "almanac",    label: "Almanac",     kind: "light", blurb: "A naturalist's field log on warm paper", appBg: "#f4ecd8", appText: "#2b2118", ink: "#2b2118" },
  { id: "studio",     label: "Studio Paper", kind: "light", blurb: "Warm letterpress index cards",          appBg: "#ece4d6", appText: "#23201c", ink: "#23201c" },
  { id: "night",      label: "Night Study",  kind: "dark",  blurb: "A study under warm lamplight",           appBg: "#1f1810", appText: "#f3e7d2", ink: "#f3e7d2" },
];

export function normalizeView(view: string | undefined | null): DashboardViewId {
  const id = (view || "instrument") as DashboardViewId;
  return DASHBOARD_VIEWS.some((v) => v.id === id) ? id : "instrument";
}

export function applyDashboardView(view: string | undefined | null): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  const s = el.style;
  const id = normalizeView(view);

  if (id === "instrument") {
    el.removeAttribute("data-view");
    // Hand the shared toolbar ink back to the theme / light-dark stylesheet.
    // (--app-bg / --app-text are owned by applyThemeCssVars, which runs first.)
    s.removeProperty("--color-white");
    return;
  }

  const meta = DASHBOARD_VIEWS.find((v) => v.id === id);
  if (!meta) {
    // normalizeView already guarantees a known id, but narrow defensively
    // rather than asserting non-null.
    el.removeAttribute("data-view");
    s.removeProperty("--color-white");
    return;
  }
  el.setAttribute("data-view", id);
  s.setProperty("--app-bg", meta.appBg);
  s.setProperty("--app-text", meta.appText);
  s.setProperty("--color-white", meta.ink);
}

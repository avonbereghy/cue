# Phase 3: Dashboard Frontend

Read plans/cross_platform_final_plan.md for full context.

## Background
Phase 1's Tauri scaffold generated boilerplate frontend files (`src/App.tsx`, `package.json`, `index.html`, etc.). This phase **replaces** that boilerplate with the real dashboard implementation.

## Tasks
1. Update `package.json` — add dependencies: `@tauri-apps/api` v2, `tailwindcss` v4, `typescript`
2. Update `vite.config.ts` — configure for Tauri (internal port, HMR)
3. Update `tsconfig.json` — strict mode, path aliases
4. Create `tailwind.config.ts` — custom color palette matching macOS app, dark mode via `class` strategy
5. Create `src/styles/globals.css` — Tailwind imports, base dark theme, `tabular-nums`
6. Create `src/lib/types.ts` — TypeScript interfaces mirroring Rust models (camelCase):
   - `SessionInfo`, `SessionMetrics`, `EnrichedSession`, `WindowMetrics`, `Settings`, `UsageWindow`
7. Create `src/lib/format.ts` — port of Swift `Format` enum:
   - `formatTokens(n: number): string` — K/M abbreviation (e.g., "1.2M")
   - `formatDuration(secs: number): string` — "1h 23m" style
   - `formatCost(usd: number): string` — "$1.23" style
8. Create `src/hooks/useSessionMonitor.ts`:
   - Subscribe to `sessions-updated` Tauri event via `listen()`
   - Initial fetch via `invoke("get_sessions")`
   - Return `EnrichedSession[]`
9. Create `src/hooks/useUsageMetrics.ts`:
   - Subscribe to `usage-updated` Tauri event via `listen()`
   - Initial fetch via `invoke("get_usage_metrics")`
   - Return `Record<UsageWindow, WindowMetrics>`
10. Replace `src/App.tsx` — root component, renders `<Dashboard />`
11. Create `src/components/Dashboard.tsx` — tab bar (Sessions / Usage), persists selected tab
12. Create `src/components/SessionsTab.tsx` — stat badges row (sessions, messages, tokens) + scrollable session card list + empty state
13. Create `src/components/SessionCard.tsx` — all 4 rows matching macOS:
    - Row 1: Status dot (colored), title, state badge (capsule), git branch label, elapsed time
    - Row 2: Messages (user/assistant), input tokens, output tokens, tool count, model name
    - Row 3: Top 6 tool chips (monospace, `rounded-full`), cache hit rate %
    - Row 4: Context usage progress bar with percentage and token count
14. Create `src/components/UsageView.tsx` — plan picker (segmented control) + 3 `<WindowSection>` components
15. Create `src/components/WindowSection.tsx` — per-window aggregation:
    - Header: window name, percentage (if limit set), estimated cost
    - Progress bar (color-coded: green < 50%, orange 50-80%, red > 80%)
    - Reset timer: "Resets in 3h" countdown
    - Stats row: compact chips (tokens, input, output, sessions, messages, tools)
    - Tool breakdown: top 8 tools ranked by frequency
    - Model breakdown: per-model token totals (if multiple models)
16. Create `src/components/ProgressBar.tsx` — reusable, accepts `value`, `max`, renders colored fill
17. Create `src/components/StatBadge.tsx` — icon + label + value (used in header)
18. Update `index.html` — set title "Claude Cue Dashboard", dark background color

## Files to create (new)
- `claude-cue-desktop/src/components/Dashboard.tsx`
- `claude-cue-desktop/src/components/SessionsTab.tsx`
- `claude-cue-desktop/src/components/SessionCard.tsx`
- `claude-cue-desktop/src/components/UsageView.tsx`
- `claude-cue-desktop/src/components/WindowSection.tsx`
- `claude-cue-desktop/src/components/ProgressBar.tsx`
- `claude-cue-desktop/src/components/StatBadge.tsx`
- `claude-cue-desktop/src/hooks/useSessionMonitor.ts`
- `claude-cue-desktop/src/hooks/useUsageMetrics.ts`
- `claude-cue-desktop/src/lib/types.ts`
- `claude-cue-desktop/src/lib/format.ts`
- `claude-cue-desktop/src/styles/globals.css`
- `claude-cue-desktop/tailwind.config.ts`

## Files to modify (scaffold replacements)
- `claude-cue-desktop/src/App.tsx` — replace boilerplate with Dashboard root
- `claude-cue-desktop/package.json` — add dependencies
- `claude-cue-desktop/tsconfig.json` — strict mode
- `claude-cue-desktop/vite.config.ts` — Tauri config
- `claude-cue-desktop/index.html` — title, dark bg

## Files NOT to touch
- Everything in `Sources/` and `hooks/`
- Rust backend files in `src-tauri/` (import Tauri commands, don't modify)

## Verification
- `npm run build` succeeds with zero TypeScript errors
- `npm run tauri dev` shows dashboard window with live data from Rust backend
- Dashboard visually matches the macOS SwiftUI version (compare side-by-side)
- All components render correctly with 0 sessions (empty state), 1 session, and 8 sessions
- Dark theme applied correctly, system color scheme respected
- Empty states shown when no sessions / no usage data
- Progress bars change color at correct thresholds (green/orange/red)
- Tool chips show monospace text with correct counts
- Token counts update in real-time as Rust backend emits events

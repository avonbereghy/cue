import { invoke } from "@tauri-apps/api/core";
import type { EnrichedSession } from "./types";

/**
 * Open a session from a click. Tries to focus the *exact* terminal tab running
 * that session's Claude process (iTerm2 / Apple Terminal, matched by the
 * process TTY) so that, when several sessions share one project, clicking a card
 * lands on the right one. Falls back to opening the project in its editor / the
 * file manager when the terminal can't be targeted (VS Code, Cursor, unknown
 * sources, non-macOS, or no matching tab). Never throws.
 */
export async function openSession(session: EnrichedSession): Promise<void> {
  const { source, pid, workspace } = session.info;
  try {
    const focused = await invoke<boolean>("focus_session_terminal", {
      source: source ?? null,
      pid: pid ?? null,
    });
    if (focused) return;
  } catch {
    // fall through to opening the project
  }
  await invoke("open_session_workspace", { workspace, source: source ?? null }).catch(() => {});
}

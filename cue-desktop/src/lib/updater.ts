/**
 * Auto-update. Cue checks on launch (silent) and via a manual "Check for
 * Updates…" menu item (with feedback). With `dialog: true` in the updater config
 * Tauri prompts before installing; we then downloadAndInstall + relaunch. All of
 * this no-ops in dev (`tauri dev` builds have no updater artifacts) and when the
 * manifest is missing.
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus = "idle" | "checking" | "uptodate" | "updating" | "error";

/** Core check shared by the silent launch path and the manual menu path.
 *  Installs + relaunches when an update is found (relaunch usually terminates
 *  the app before this returns). */
async function performUpdateCheck(): Promise<"updating" | "uptodate"> {
  const update = await check();
  if (!update) return "uptodate";
  await update.downloadAndInstall();
  await relaunch();
  return "updating";
}

/** Launch-time check: silent, best-effort. A stranded version self-heals on the
 *  next launch — but because Cue is an always-on app that rarely relaunches, the
 *  manual check below is the reliable path. */
export async function runUpdateCheck(): Promise<void> {
  try {
    await performUpdateCheck();
  } catch (err) {
    // Network failure, missing manifest, signature mismatch — log and skip.
    console.warn("update check failed:", err);
  }
}

/** Manual "Check for Updates…": returns the outcome so the menu can give honest
 *  feedback. The silent launch check no-ops when there's nothing to do, which on
 *  a deliberate click would read as a dead button — so the manual path always
 *  resolves to a result the UI can show. */
export async function checkForUpdatesManually(): Promise<"updating" | "uptodate" | "error"> {
  try {
    return await performUpdateCheck();
  } catch (err) {
    console.warn("manual update check failed:", err);
    return "error";
  }
}

/** The menu label for the current check status. Pure, so it's unit-testable and
 *  identical across both surfaces that show the item. */
export function updateStatusLabel(status: UpdateStatus): string {
  switch (status) {
    case "checking":
      return "Checking for updates…";
    case "uptodate":
      return "You’re up to date";
    case "updating":
      return "Update available — installing…";
    case "error":
      return "Update check failed";
    default:
      return "Check for Updates…";
  }
}

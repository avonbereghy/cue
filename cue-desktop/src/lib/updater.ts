/**
 * Auto-update. Cue checks on launch (silent) and via a manual "Check for
 * Updates…" menu item (with feedback). When an update is found we ask the user
 * to confirm — the Tauri v2 updater does NOT prompt on its own (the v1
 * `dialog: true` config key is ignored), so consent is enforced here in JS
 * before downloadAndInstall + relaunch. Signature verification is unchanged
 * (endpoint + pubkey live in tauri.conf.json). All of this no-ops in dev
 * (`tauri dev` builds have no updater artifacts) and when the manifest is
 * missing.
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ask } from "@tauri-apps/plugin-dialog";

export type UpdateStatus = "idle" | "checking" | "uptodate" | "updating" | "error";

/** Core check shared by the silent launch path and the manual menu path. Asks
 *  for explicit consent before installing anything; on decline it does nothing
 *  (no download, no relaunch). Installs + relaunches when the user agrees
 *  (relaunch usually terminates the app before this returns). */
async function performUpdateCheck(): Promise<"updating" | "uptodate" | "declined"> {
  const update = await check();
  if (!update) return "uptodate";
  const approved = await ask(
    `Cue ${update.version} is available (you have ${update.currentVersion}).\n\n` +
      `Download and install it now? Cue will restart to finish updating.`,
    {
      title: "Update Cue",
      kind: "info",
      okLabel: "Install & Restart",
      cancelLabel: "Not Now",
    },
  );
  if (!approved) return "declined";
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
export async function checkForUpdatesManually(): Promise<"updating" | "uptodate" | "error" | "idle"> {
  try {
    const outcome = await performUpdateCheck();
    // Declining the install returns the menu to its neutral, actionable
    // "Check for Updates…" state rather than falsely claiming "up to date"
    // (there IS an update — the user just chose not to install it now).
    return outcome === "declined" ? "idle" : outcome;
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

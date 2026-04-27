/**
 * Auto-update check. Tauri's `dialog: true` updater config shows a native
 * "Update available" dialog if `check()` returns an update; the user accepts
 * and we downloadAndInstall + relaunch. No-ops in dev (`tauri dev` builds do
 * not have updater artifacts) and on platforms where the manifest is missing.
 */
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export async function runUpdateCheck(): Promise<void> {
  try {
    const update = await check();
    if (!update) return;
    await update.downloadAndInstall();
    await relaunch();
  } catch (err) {
    // Network failure, missing manifest, signature mismatch — log and skip.
    // Update will retry on the next launch.
    console.warn("update check failed:", err);
  }
}

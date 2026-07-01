import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri plugins the updater drives so we can assert consent gating
// without a real webview.
const { checkMock, downloadAndInstallMock, relaunchMock, askMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  downloadAndInstallMock: vi.fn(),
  relaunchMock: vi.fn(),
  askMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: askMock }));

import { updateStatusLabel, checkForUpdatesManually, runUpdateCheck } from "./updater";

function fakeUpdate() {
  return {
    version: "1.2.3",
    currentVersion: "1.2.0",
    downloadAndInstall: downloadAndInstallMock,
  };
}

beforeEach(() => {
  checkMock.mockReset();
  downloadAndInstallMock.mockReset().mockResolvedValue(undefined);
  relaunchMock.mockReset().mockResolvedValue(undefined);
  askMock.mockReset();
});

describe("updateStatusLabel", () => {
  it("defaults to the actionable 'Check for Updates…' when idle", () => {
    expect(updateStatusLabel("idle")).toBe("Check for Updates…");
  });

  it("gives honest, distinct feedback for every terminal status", () => {
    // A manual check must say what happened — never a silent no-op (#7).
    expect(updateStatusLabel("checking")).toBe("Checking for updates…");
    expect(updateStatusLabel("uptodate")).toBe("You’re up to date");
    expect(updateStatusLabel("updating")).toBe("Update available — installing…");
    expect(updateStatusLabel("error")).toBe("Update check failed");
  });

  it("returns a non-empty label for each status (no dead button text)", () => {
    for (const s of ["idle", "checking", "uptodate", "updating", "error"] as const) {
      expect(updateStatusLabel(s).length).toBeGreaterThan(0);
    }
  });
});

describe("update consent", () => {
  it("installs only after the user confirms (manual path)", async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    askMock.mockResolvedValue(true);
    const outcome = await checkForUpdatesManually();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallMock).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("updating");
  });

  it("does NOT download or relaunch when the user declines (manual path)", async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    askMock.mockResolvedValue(false);
    const outcome = await checkForUpdatesManually();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallMock).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
    // Neutral, actionable state — not a false "up to date".
    expect(outcome).toBe("idle");
  });

  it("never prompts when there is no update available", async () => {
    checkMock.mockResolvedValue(null);
    const outcome = await checkForUpdatesManually();
    expect(askMock).not.toHaveBeenCalled();
    expect(downloadAndInstallMock).not.toHaveBeenCalled();
    expect(outcome).toBe("uptodate");
  });

  it("surfaces a failure as 'error' (manual path)", async () => {
    checkMock.mockRejectedValue(new Error("network down"));
    const outcome = await checkForUpdatesManually();
    expect(outcome).toBe("error");
  });

  it("launch-time check never installs without consent", async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    askMock.mockResolvedValue(false);
    await runUpdateCheck();
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallMock).not.toHaveBeenCalled();
    expect(relaunchMock).not.toHaveBeenCalled();
  });

  it("launch-time check installs after consent", async () => {
    checkMock.mockResolvedValue(fakeUpdate());
    askMock.mockResolvedValue(true);
    await runUpdateCheck();
    expect(downloadAndInstallMock).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
  });
});

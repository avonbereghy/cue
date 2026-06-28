import "./styles/globals.css";
import "./styles/skin-fonts.css";
import "./styles/almanac.css";
import "./styles/night.css";
import "./styles/studio.css";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dashboard } from "./components/Dashboard";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { SignalSettingsPage } from "./components/SignalSettingsPage";
import { KeyboardPage } from "./components/KeyboardPanel";
import { ThemePickerPage } from "./components/ThemePickerPage";
import { TrayPopoverPage } from "./components/TrayPopover";
import { runUpdateCheck } from "./lib/updater";
import type { Settings } from "./lib/types";

function App() {
  const [loading, setLoading] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);

  const isSignalSettings = window.location.hash === "#/signal-settings";
  const isKeyboard = window.location.hash === "#/keyboard";
  const isThemePicker = window.location.hash === "#/theme-picker";
  const isTrayPopover = window.location.hash === "#/tray-popover";

  useEffect(() => {
    if (isTrayPopover) {
      // Mark the root so global CSS can force a transparent background — the
      // NSWindow underneath provides the vibrancy/blur surface.
      document.documentElement.classList.add("tray-popover-root");
    }
    if (isSignalSettings || isKeyboard || isThemePicker || isTrayPopover) {
      setLoading(false);
      return;
    }
    invoke<Settings>("get_settings")
      .then((settings) => {
        setOnboardingComplete(settings.onboardingComplete);
        // Auto-update check fires only on the main window, after onboarding
        // is already complete — skipped on first launch so the wizard can
        // run uninterrupted.
        if (settings.onboardingComplete) {
          void runUpdateCheck();
        }
      })
      .catch((err) => {
        console.error("Failed to load settings:", err);
        setOnboardingComplete(false);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [isSignalSettings, isKeyboard, isThemePicker, isTrayPopover]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-white/40 text-sm">
        Loading...
      </div>
    );
  }

  if (isSignalSettings) {
    return <SignalSettingsPage />;
  }

  if (isKeyboard) {
    return <KeyboardPage />;
  }

  if (isThemePicker) {
    return <ThemePickerPage />;
  }

  if (isTrayPopover) {
    return <TrayPopoverPage />;
  }

  if (!onboardingComplete) {
    return (
      <OnboardingWizard
        onComplete={() => setOnboardingComplete(true)}
      />
    );
  }

  return <Dashboard />;
}

export default App;

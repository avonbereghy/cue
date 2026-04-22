import "./styles/globals.css";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dashboard } from "./components/Dashboard";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { SignalSettingsPage } from "./components/SignalSettingsPage";
import { KeyboardPage } from "./components/KeyboardPanel";
import { ThemePickerPage } from "./components/ThemePickerPage";
import { TrayPopoverPage } from "./components/TrayPopover";
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

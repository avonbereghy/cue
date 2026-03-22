import "./styles/globals.css";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dashboard } from "./components/Dashboard";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { SignalSettingsPage } from "./components/SignalSettingsPage";
import type { Settings } from "./lib/types";

function App() {
  const [loading, setLoading] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);

  const isSignalSettings = window.location.hash === "#/signal-settings";

  useEffect(() => {
    if (isSignalSettings) {
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
  }, [isSignalSettings]);

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

import "./styles/globals.css";
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dashboard } from "./components/Dashboard";
import { OnboardingWizard } from "./components/OnboardingWizard";
import type { Settings } from "./lib/types";

function App() {
  const [loading, setLoading] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((settings) => {
        setOnboardingComplete(settings.onboardingComplete);
      })
      .catch((err) => {
        console.error("Failed to load settings:", err);
        // Default to showing onboarding on error
        setOnboardingComplete(false);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-white/40 text-sm">
        Loading...
      </div>
    );
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

//! Settings management with plan presets.
//!
//! Wraps file-based settings with permission enforcement via security.rs.

use crate::models::{PlanPreset, Settings};
use crate::paths;
use crate::security;

/// Load settings from disk, returning defaults if not found.
pub fn load_settings() -> Settings {
    let path = paths::settings_path();

    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => {
            let defaults = Settings::default();
            // Write defaults on first load
            let _ = save_settings(&defaults);
            defaults
        }
    }
}

/// Save settings to disk with atomic write and permission enforcement.
pub fn save_settings(settings: &Settings) -> Result<(), String> {
    let path = paths::settings_path();

    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {}", e))?;

    security::atomic_write(&path, content.as_bytes())
        .map_err(|e| format!("Failed to write settings: {}", e))?;

    Ok(())
}

/// Apply a plan preset to settings.
pub fn apply_plan_preset(preset: &PlanPreset) -> Settings {
    let (five_hour, daily, weekly) = preset.limits();
    Settings {
        five_hour_token_limit: five_hour,
        daily_token_limit: daily,
        weekly_token_limit: weekly,
        plan_preset: preset.display_name().to_string(),
        onboarding_complete: false,
        permissions_enabled: false,
    }
}

/// Get the token limit for a specific usage window.
pub fn token_limit_for_window(window: &crate::models::UsageWindow) -> i64 {
    let settings = load_settings();
    match window {
        crate::models::UsageWindow::FiveHour => settings.five_hour_token_limit,
        crate::models::UsageWindow::Daily => settings.daily_token_limit,
        crate::models::UsageWindow::Weekly => settings.weekly_token_limit,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings() {
        let s = Settings::default();
        assert_eq!(s.five_hour_token_limit, 2_000_000);
        assert_eq!(s.daily_token_limit, 8_000_000);
        assert_eq!(s.weekly_token_limit, 40_000_000);
    }

    #[test]
    fn test_apply_plan_preset_pro() {
        let s = apply_plan_preset(&PlanPreset::Pro);
        assert_eq!(s.five_hour_token_limit, 500_000);
        assert_eq!(s.daily_token_limit, 2_000_000);
        assert_eq!(s.weekly_token_limit, 10_000_000);
        assert_eq!(s.plan_preset, "Pro ($20/mo)");
    }

    #[test]
    fn test_apply_plan_preset_max_standard() {
        let s = apply_plan_preset(&PlanPreset::MaxStandard);
        assert_eq!(s.five_hour_token_limit, 2_000_000);
        assert_eq!(s.daily_token_limit, 8_000_000);
        assert_eq!(s.weekly_token_limit, 40_000_000);
    }

    #[test]
    fn test_apply_plan_preset_max_plus() {
        let s = apply_plan_preset(&PlanPreset::MaxPlus);
        assert_eq!(s.five_hour_token_limit, 4_000_000);
        assert_eq!(s.daily_token_limit, 16_000_000);
        assert_eq!(s.weekly_token_limit, 80_000_000);
    }

    #[test]
    fn test_settings_roundtrip() {
        let dir = std::env::temp_dir().join("claude_cue_test_settings");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("settings.json");
        let settings = Settings {
            five_hour_token_limit: 1_000_000,
            daily_token_limit: 4_000_000,
            weekly_token_limit: 20_000_000,
            plan_preset: "Custom".to_string(),
            onboarding_complete: false,
            permissions_enabled: false,
        };

        let content = serde_json::to_string_pretty(&settings).unwrap();
        crate::security::atomic_write(&path, content.as_bytes()).unwrap();

        let loaded: Settings = serde_json::from_str(
            &std::fs::read_to_string(&path).unwrap()
        ).unwrap();

        assert_eq!(loaded.five_hour_token_limit, 1_000_000);
        assert_eq!(loaded.plan_preset, "Custom");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

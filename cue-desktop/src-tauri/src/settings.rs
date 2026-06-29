//! Settings management.
//!
//! Wraps file-based settings with permission enforcement via security.rs.

use crate::models::Settings;
use crate::paths;
use crate::security;

/// Current settings schema version. Bump when defaults change in a way that
/// should override existing user customizations (e.g. sand particle defaults).
/// Migrations in `apply_migrations` run for each version below this.
pub const CURRENT_SETTINGS_VERSION: u32 = 2;

/// Load settings from disk, returning defaults if not found. Runs one-shot
/// migrations when the stored `settings_version` lags behind CURRENT.
pub fn load_settings() -> Settings {
    let path = paths::settings_path();

    // Bound the read at 4 MiB. Cue is the only legitimate writer of this
    // file, but it lives in a user-writable dir and load_settings is called
    // on the UI-blocking startup path — a multi-GiB blob would freeze the
    // app boot. Real settings.json is well under 64 KiB.
    const SETTINGS_MAX_BYTES: u64 = 4 * 1024 * 1024;
    match security::read_to_string_bounded(&path, SETTINGS_MAX_BYTES) {
        Ok(content) => {
            let mut loaded: Settings = serde_json::from_str(&content).unwrap_or_default();
            if loaded.settings_version < CURRENT_SETTINGS_VERSION {
                apply_migrations(&mut loaded);
                loaded.settings_version = CURRENT_SETTINGS_VERSION;
                let _ = save_settings(&loaded);
            }
            loaded
        }
        Err(_) => {
            let defaults = Settings::default();
            // Write defaults on first load
            let _ = save_settings(&defaults);
            defaults
        }
    }
}

/// Apply migrations for each version upgrade.
fn apply_migrations(s: &mut Settings) {
    // v0/v1 → v2: sand particle defaults changed. Wipe saved per-theme
    // customizations so every theme picks up the new SAND_OFF baseline and
    // reset the top-level sand fields to the new defaults.
    if s.settings_version < 2 {
        s.theme_customizations.clear();
        let d = Settings::default();
        s.sand_intensity = d.sand_intensity;
        s.sand_direction = d.sand_direction;
        s.sand_density = d.sand_density;
        s.sand_speed = d.sand_speed;
        s.sand_grain_size = d.sand_grain_size;
        s.sand_turbulence = d.sand_turbulence;
        s.sand_alpha = d.sand_alpha;
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings() {
        let s = Settings::default();
        assert_eq!(s.title_animation, "none");
        assert!((s.animation_speed - 1.2).abs() < f64::EPSILON);
        assert!(!s.random_animation);
        assert!(!s.permissions_enabled);
    }

    #[test]
    fn test_settings_roundtrip() {
        let dir = std::env::temp_dir().join("cue_test_settings");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let path = dir.join("settings.json");
        let settings = Settings {
            onboarding_complete: false,
            permissions_enabled: true,
            title_animation: "glow".to_string(),
            animation_speed: 0.8,
            random_animation: true,
            ..Default::default()
        };

        let content = serde_json::to_string_pretty(&settings).unwrap();
        crate::security::atomic_write(&path, content.as_bytes()).unwrap();

        let loaded: Settings =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();

        assert_eq!(loaded.title_animation, "glow");
        assert!((loaded.animation_speed - 0.8).abs() < f64::EPSILON);
        assert!(loaded.random_animation);
        assert!(loaded.permissions_enabled);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_migration_v1_to_v2_clears_theme_customizations_and_resets_sand() {
        use crate::models::ThemeCustomization;
        let mut s = Settings {
            settings_version: 1,
            sand_intensity: 0.8,
            sand_direction: -40.0,
            sand_density: 2.5,
            sand_speed: 0.7,
            sand_grain_size: 0.5,
            sand_turbulence: 0.2,
            sand_alpha: 0.75,
            ..Default::default()
        };
        s.theme_customizations.insert(
            "neon".to_string(),
            ThemeCustomization {
                sand_intensity: 0.8,
                ..Default::default()
            },
        );
        apply_migrations(&mut s);
        assert!(s.theme_customizations.is_empty());
        let d = Settings::default();
        assert!((s.sand_intensity - d.sand_intensity).abs() < f64::EPSILON);
        assert!((s.sand_direction - d.sand_direction).abs() < f64::EPSILON);
        assert!((s.sand_turbulence - d.sand_turbulence).abs() < f64::EPSILON);
    }

    #[test]
    fn test_migration_skipped_when_version_current() {
        use crate::models::ThemeCustomization;
        let mut s = Settings {
            settings_version: CURRENT_SETTINGS_VERSION,
            sand_intensity: 9.99, // deliberately non-default
            ..Default::default()
        };
        s.theme_customizations
            .insert("neon".to_string(), ThemeCustomization::default());
        apply_migrations(&mut s);
        // Nothing should have changed: both customizations and sand value retained.
        assert!(!s.theme_customizations.is_empty());
        assert!((s.sand_intensity - 9.99).abs() < f64::EPSILON);
    }

    #[test]
    fn test_settings_deserialize_without_legacy_fields() {
        // Frontend sends Settings without legacy token/plan fields
        let json = r#"{
            "onboardingComplete": true,
            "permissionsEnabled": false,
            "titleAnimation": "flip",
            "animationSpeed": 1.2,
            "randomAnimation": false
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(s.onboarding_complete);
        assert_eq!(s.five_hour_token_limit, 0); // serde default
        assert_eq!(s.plan_preset, ""); // serde default
    }

    #[test]
    fn test_flux_settings_round_trip() {
        // Regression for the flux data-loss bug: the 7 flux* fields existed only
        // on the TS side, so serde silently dropped them on save and the UI
        // reset them to defaults on every restart. They must now survive a
        // serialize -> deserialize cycle under their camelCase wire names.
        let settings = Settings {
            flux_enabled: false,
            flux_alpha: 0.33,
            flux_intensity: 4.2,
            flux_density: 2.5,
            flux_speed: 0.7,
            flux_line_length: 1.8,
            flux_turbulence: 0.4,
            ..Default::default()
        };

        let json = serde_json::to_string(&settings).unwrap();
        // Persisted under the camelCase names the TS frontend reads/writes.
        assert!(json.contains("\"fluxEnabled\""), "json was: {json}");
        assert!(json.contains("\"fluxAlpha\""), "json was: {json}");

        let loaded: Settings = serde_json::from_str(&json).unwrap();
        assert!(!loaded.flux_enabled);
        assert!((loaded.flux_alpha - 0.33).abs() < f64::EPSILON);
        assert!((loaded.flux_intensity - 4.2).abs() < f64::EPSILON);
        assert!((loaded.flux_density - 2.5).abs() < f64::EPSILON);
        assert!((loaded.flux_speed - 0.7).abs() < f64::EPSILON);
        assert!((loaded.flux_line_length - 1.8).abs() < f64::EPSILON);
        assert!((loaded.flux_turbulence - 0.4).abs() < f64::EPSILON);
    }

    #[test]
    fn test_flux_defaults_match_ui_fallbacks() {
        // The Rust defaults must equal the TS UI's `?? <literal>` fallbacks
        // (SettingsView.tsx / SessionsTab.tsx) so a fresh install behaves
        // identically to before flux was persisted — no silent behavior change.
        let d = Settings::default();
        assert!(d.flux_enabled);
        assert!((d.flux_alpha - 0.9).abs() < f64::EPSILON);
        assert!((d.flux_intensity - 1.5).abs() < f64::EPSILON);
        assert!((d.flux_density - 1.0).abs() < f64::EPSILON);
        assert!((d.flux_speed - 1.0).abs() < f64::EPSILON);
        assert!((d.flux_line_length - 0.55).abs() < f64::EPSILON);
        assert!((d.flux_turbulence - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_notifier_defaults_match_ui_fallbacks() {
        // Same contract as the flux test, for the notification settings: Rust
        // `Settings::default()` must equal the TS UI's `?? <literal>` fallbacks
        // (SettingsView.tsx) so a fresh install and a saved-with-missing-field
        // file behave identically. No notifier parity test existed before P1.
        let d = Settings::default();
        assert!(d.notifications_enabled);
        assert!(d.notify_waiting);
        assert!(d.notify_error);
        assert!(d.notify_done);
        assert!((d.notify_done_min_secs - 30.0).abs() < f64::EPSILON);
        assert!(d.suppress_done_when_focused);
        assert!(d.notify_rate_limit_reset);
    }

    #[test]
    fn test_claude_config_dir_round_trip_and_default() {
        // Defaults to empty (auto-detect) and survives a camelCase round-trip,
        // guarding the flux-class silent-drop bug for the new override field.
        let d = Settings::default();
        assert_eq!(d.claude_config_dir, "");

        let settings = Settings {
            claude_config_dir: "~/alt-claude".to_string(),
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("\"claudeConfigDir\""), "json was: {json}");
        let loaded: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded.claude_config_dir, "~/alt-claude");

        // A file written before the field existed still loads, defaulting empty.
        let legacy: Settings = serde_json::from_str(r#"{"notifyDone": true}"#).unwrap();
        assert_eq!(legacy.claude_config_dir, "");
    }

    #[test]
    fn test_notifier_settings_round_trip() {
        // Guard against the flux-class data-loss bug for the notifier fields:
        // they must survive serialize -> deserialize under their camelCase wire
        // names, or a save silently resets them on the next restart.
        let settings = Settings {
            notify_done: false,
            suppress_done_when_focused: false,
            notify_rate_limit_reset: false,
            ..Default::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(
            json.contains("\"suppressDoneWhenFocused\""),
            "json was: {json}"
        );
        assert!(
            json.contains("\"notifyRateLimitReset\""),
            "json was: {json}"
        );
        let loaded: Settings = serde_json::from_str(&json).unwrap();
        assert!(!loaded.notify_done);
        assert!(!loaded.suppress_done_when_focused);
        assert!(!loaded.notify_rate_limit_reset);
        // A file written before these fields existed still loads, defaulting true.
        let legacy: Settings = serde_json::from_str(r#"{"notifyDone": true}"#).unwrap();
        assert!(legacy.suppress_done_when_focused);
        assert!(legacy.notify_rate_limit_reset);
    }
}

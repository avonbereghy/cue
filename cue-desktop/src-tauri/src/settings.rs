//! Settings management.
//!
//! Wraps file-based settings with permission enforcement via security.rs.

use crate::models::Settings;
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

        let loaded: Settings = serde_json::from_str(
            &std::fs::read_to_string(&path).unwrap()
        ).unwrap();

        assert_eq!(loaded.title_animation, "glow");
        assert!((loaded.animation_speed - 0.8).abs() < f64::EPSILON);
        assert!(loaded.random_animation);
        assert!(loaded.permissions_enabled);

        let _ = std::fs::remove_dir_all(&dir);
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
}

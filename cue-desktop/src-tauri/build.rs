fn main() {
    // Compile the Swift sidecar for live audio capture (macOS only)
    #[cfg(target_os = "macos")]
    {
        let sidecar_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar");
        let swift_src = sidecar_dir.join("cue-audio-tap.swift");
        let binary = sidecar_dir.join("cue-audio-tap");

        if swift_src.exists() {
            // Only rebuild if source is newer than binary
            let needs_build = !binary.exists() || {
                let src_modified = std::fs::metadata(&swift_src)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                let bin_modified = std::fs::metadata(&binary)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                src_modified > bin_modified
            };

            if needs_build {
                // Match tauri.conf.json's `bundle.macOS.minimumSystemVersion`;
                // the Core Audio Taps API (AudioHardwareCreateProcessTap) was
                // added in macOS 14.2, and CI runners default to an older
                // deployment target that fails the availability check. The
                // env var alone is unreliable across swiftc versions, so we
                // also pass an explicit -target triple keyed off host arch.
                let target = if cfg!(target_arch = "aarch64") {
                    "arm64-apple-macos14.2"
                } else {
                    "x86_64-apple-macos14.2"
                };
                let status = std::process::Command::new("swiftc")
                    .env("MACOSX_DEPLOYMENT_TARGET", "14.2")
                    .args([
                        "-O",
                        "-target",
                        target,
                        "-o",
                        binary.to_str().unwrap(),
                        swift_src.to_str().unwrap(),
                        "-framework",
                        "CoreAudio",
                        "-framework",
                        "AudioToolbox",
                        "-framework",
                        "Accelerate",
                    ])
                    .status()
                    .expect("Failed to run swiftc — is Xcode installed?");

                assert!(status.success(), "Swift sidecar compilation failed");
            }

            println!("cargo:rerun-if-changed=sidecar/cue-audio-tap.swift");
        }
    }

    tauri_build::build()
}

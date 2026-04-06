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
                let status = std::process::Command::new("swiftc")
                    .args([
                        "-O",
                        "-o", binary.to_str().unwrap(),
                        swift_src.to_str().unwrap(),
                        "-framework", "CoreAudio",
                        "-framework", "AudioToolbox",
                        "-framework", "Accelerate",
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

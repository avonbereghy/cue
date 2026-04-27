//! Live audio capture via Swift sidecar + FFT analysis.
//!
//! Spawns `cue-audio-tap` (Swift CLI) which streams mono Float32 PCM to stdout.
//! Reads the stream, runs FFT, and emits frequency band data as Tauri events.

use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

const FFT_SIZE: usize = 2048;
const SAMPLE_RATE: f32 = 48000.0;
// Band boundaries in Hz
const BASS_LOW: f32 = 20.0;
const BASS_HIGH: f32 = 300.0;
const MIDS_LOW: f32 = 300.0;
const MIDS_HIGH: f32 = 2000.0;
const TREBLE_LOW: f32 = 2000.0;
const TREBLE_HIGH: f32 = 20000.0;

#[derive(Clone, Serialize)]
pub struct LiveAudioData {
    pub bass: f32,
    pub mids: f32,
    pub treble: f32,
}

#[derive(Clone, Serialize)]
pub struct LiveAudioStatus {
    pub active: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct LiveAudioState {
    child: Option<Child>,
    active: bool,
    error: Option<String>,
}

impl Drop for LiveAudioState {
    fn drop(&mut self) {
        // Kill+reap any running sidecar so app shutdown doesn't orphan it.
        // On Unix, Child's default drop neither kills nor waits — the tap
        // would keep running and the zombie would persist until init reaps.
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn hann_window(size: usize) -> Vec<f32> {
    (0..size)
        .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / (size - 1) as f32).cos()))
        .collect()
}

fn band_energy(
    spectrum: &[f32],
    sample_rate: f32,
    fft_size: usize,
    low_hz: f32,
    high_hz: f32,
) -> f32 {
    let bin_width = sample_rate / fft_size as f32;
    let low_bin = (low_hz / bin_width).ceil() as usize;
    let high_bin = ((high_hz / bin_width).floor() as usize).min(spectrum.len() - 1);
    if low_bin >= high_bin {
        return 0.0;
    }
    let sum: f32 = spectrum[low_bin..=high_bin].iter().sum();
    sum / (high_bin - low_bin + 1) as f32
}

fn find_sidecar_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    // Look in the app bundle's Resources directory (Tauri bundles resources/ as-is)
    if let Ok(resource_dir) = app.path().resource_dir() {
        // Tauri preserves the directory structure: sidecar/cue-audio-tap
        let path = resource_dir.join("sidecar").join("cue-audio-tap");
        if path.exists() {
            return Some(path);
        }
        // Also check flat (in case bundled without subdirectory)
        let flat = resource_dir.join("cue-audio-tap");
        if flat.exists() {
            return Some(flat);
        }
    }
    // Fallback: look next to the Cargo.toml (dev mode)
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("sidecar")
        .join("cue-audio-tap");
    if dev_path.exists() {
        return Some(dev_path);
    }
    None
}

pub fn start(app: &AppHandle, state: &Arc<Mutex<LiveAudioState>>) -> Result<(), String> {
    log::info!("[live_audio] start() called");
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if guard.active {
        return Err("Live audio already active".into());
    }

    let sidecar_path = find_sidecar_path(app).ok_or_else(|| {
        log::error!("[live_audio] sidecar binary not found");
        "cue-audio-tap sidecar binary not found".to_string()
    })?;
    log::info!("[live_audio] sidecar path: {:?}", sidecar_path);

    let mut child = Command::new(&sidecar_path)
        .stdin(Stdio::piped()) // Keep stdin open so sidecar can detect parent exit
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            log::error!("[live_audio] spawn failed: {e}");
            format!("Failed to spawn cue-audio-tap: {e}")
        })?;

    log::info!("[live_audio] sidecar spawned (pid={})", child.id());

    let stdout = child.stdout.take().ok_or("No stdout from sidecar")?;
    let stderr = child.stderr.take().ok_or("No stderr from sidecar")?;

    guard.child = Some(child);
    guard.active = true;
    guard.error = None;
    drop(guard);

    let app_handle = app.clone();
    let state_clone = Arc::clone(state);

    // Stderr reader thread — log sidecar messages
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buf = [0u8; 512];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(msg) = std::str::from_utf8(&buf[..n]) {
                        log::info!("[cue-audio-tap] {}", msg.trim());
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Main PCM reader + FFT thread
    thread::spawn(move || {
        log::info!("[live_audio] PCM reader thread started");
        let mut reader = std::io::BufReader::new(stdout);
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        let window = hann_window(FFT_SIZE);
        let mut sample_buf: Vec<f32> = Vec::with_capacity(FFT_SIZE * 2);
        let mut raw_buf = [0u8; 4096]; // 1024 samples worth
                                       // Carry bytes from reads that ended mid-sample (n % 4 != 0). Without
                                       // this, subsequent reads are byte-misaligned and every f32 is garbage.
        let mut carry: Vec<u8> = Vec::with_capacity(4);
        let mut emit_count: u64 = 0;

        loop {
            match reader.read(&mut raw_buf) {
                Ok(0) => break, // EOF — sidecar exited
                Ok(n) => {
                    // Prepend any leftover bytes from the previous read, then
                    // decode as many complete f32 samples as we can.
                    let total = carry.len() + n;
                    let sample_count = total / 4;
                    let consumed = sample_count * 4;
                    for i in 0..sample_count {
                        let offset = i * 4;
                        let b = |k: usize| {
                            if offset + k < carry.len() {
                                carry[offset + k]
                            } else {
                                raw_buf[offset + k - carry.len()]
                            }
                        };
                        let bytes = [b(0), b(1), b(2), b(3)];
                        sample_buf.push(f32::from_le_bytes(bytes));
                    }
                    // Stash remainder for the next read.
                    let new_carry_start = consumed.saturating_sub(carry.len());
                    carry = raw_buf[new_carry_start..n].to_vec();

                    // Process when we have enough samples
                    while sample_buf.len() >= FFT_SIZE {
                        let chunk: Vec<f32> = sample_buf.drain(..FFT_SIZE).collect();

                        // Apply window and convert to complex
                        let mut fft_input: Vec<Complex<f32>> = chunk
                            .iter()
                            .zip(window.iter())
                            .map(|(s, w)| Complex::new(s * w, 0.0))
                            .collect();

                        fft.process(&mut fft_input);

                        // Compute magnitude spectrum (only first half — Nyquist)
                        let half = FFT_SIZE / 2;
                        let spectrum: Vec<f32> = fft_input[..half]
                            .iter()
                            .map(|c| (c.re * c.re + c.im * c.im).sqrt() / FFT_SIZE as f32)
                            .collect();

                        let bass =
                            band_energy(&spectrum, SAMPLE_RATE, FFT_SIZE, BASS_LOW, BASS_HIGH);
                        let mids =
                            band_energy(&spectrum, SAMPLE_RATE, FFT_SIZE, MIDS_LOW, MIDS_HIGH);
                        let treble =
                            band_energy(&spectrum, SAMPLE_RATE, FFT_SIZE, TREBLE_LOW, TREBLE_HIGH);

                        // Normalize to 0-1 range (empirical scaling)
                        let scale = 40.0;
                        let data = LiveAudioData {
                            bass: (bass * scale).min(1.0),
                            mids: (mids * scale).min(1.0),
                            treble: (treble * scale * 2.0).min(1.0), // treble is typically quieter
                        };

                        let _ = app_handle.emit("live-audio-data", data.clone());
                        emit_count += 1;
                        if emit_count <= 5 || emit_count.is_multiple_of(500) {
                            log::info!(
                                "[live_audio] emit #{}: bass={:.3} mids={:.3} treble={:.3}",
                                emit_count,
                                data.bass,
                                data.mids,
                                data.treble
                            );
                        }
                    }
                }
                Err(e) => {
                    log::error!("Error reading sidecar stdout: {e}");
                    break;
                }
            }
        }

        // Sidecar exited
        if let Ok(mut guard) = state_clone.lock() {
            guard.active = false;
            guard.error = Some("Sidecar process exited".into());
            guard.child = None;
        }
        let _ = app_handle.emit(
            "live-audio-status",
            LiveAudioStatus {
                active: false,
                error: Some("Sidecar process exited".into()),
            },
        );
    });

    Ok(())
}

pub fn stop(state: &Arc<Mutex<LiveAudioState>>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = guard.child {
        // Drop stdin to signal the sidecar
        drop(child.stdin.take());
        // Give it a moment, then kill
        let _ = child.kill();
        let _ = child.wait();
    }
    guard.child = None;
    guard.active = false;
    guard.error = None;
    Ok(())
}

pub fn status(state: &Arc<Mutex<LiveAudioState>>) -> LiveAudioStatus {
    if let Ok(guard) = state.lock() {
        LiveAudioStatus {
            active: guard.active,
            error: guard.error.clone(),
        }
    } else {
        LiveAudioStatus {
            active: false,
            error: Some("State lock failed".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hann_window() {
        // Hann: 0.5 * (1 - cos(2πi / (N-1))).
        // For N=5: endpoints 0.0, peak 1.0 at the midpoint, symmetric.
        let w = hann_window(5);
        assert!((w[0] - 0.0).abs() < 0.001, "w[0] = {}", w[0]);
        assert!((w[4] - 0.0).abs() < 0.001, "w[4] = {}", w[4]);
        assert!((w[2] - 1.0).abs() < 0.001, "w[2] = {}", w[2]);
        assert!((w[1] - w[3]).abs() < 0.001, "window should be symmetric");
    }

    #[test]
    fn test_band_energy() {
        let spectrum = vec![0.0; 1024];
        let energy = band_energy(&spectrum, 48000.0, 2048, 20.0, 300.0);
        assert_eq!(energy, 0.0);
    }
}

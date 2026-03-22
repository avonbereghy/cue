//! System tray icon rendering — port of `renderDotGrid()` from the macOS Swift app.
//!
//! Uses `tiny-skia` to rasterize filled/outlined circles and the `png` crate to
//! encode RGBA pixel data. The public API returns raw PNG bytes suitable for
//! `tauri::tray::TrayIcon::set_icon`.

use crate::models::EnrichedSession;

// ---------------------------------------------------------------------------
// Layout constants (matches Swift exactly)
// ---------------------------------------------------------------------------

const DOT_SIZE: f32 = 16.0;
const H_SPACING: f32 = 3.0;
const V_SPACING: f32 = 3.0;
const PADDING: f32 = 3.0;
const MAX_PER_COLUMN: usize = 2;
const MAX_SESSIONS: usize = 8;

// ---------------------------------------------------------------------------
// Colors by state
// ---------------------------------------------------------------------------

struct Rgba {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}

fn color_for_state(state: &str, blink_on: bool) -> Rgba {
    match state {
        "working" => {
            let a = if blink_on { 255 } else { 38 }; // 0.15 * 255 ≈ 38
            Rgba { r: 255, g: 255, b: 255, a } // white (flashing)
        }
        "waiting" => Rgba { r: 255, g: 204, b: 0, a: 255 }, // yellow (255,204,0)
        "error" => Rgba { r: 255, g: 69, b: 58, a: 255 },   // red (255,69,58)
        "subagent" => {
            let a = if blink_on { 255 } else { 38 };
            Rgba { r: 0, g: 255, b: 255, a } // cyan (0,255,255)
        }
        "idle" => Rgba { r: 255, g: 255, b: 255, a: 89 }, // 35% ≈ 89
        _ => Rgba { r: 48, g: 209, b: 88, a: 255 },  // green (48,209,88) done/default
    }
}

// ---------------------------------------------------------------------------
// Pixmap helpers
// ---------------------------------------------------------------------------

/// Build a circle path using cubic Bezier approximation.
fn circle_path(cx: f32, cy: f32, radius: f32) -> tiny_skia::Path {
    let mut pb = tiny_skia::PathBuilder::new();
    let k = 0.5522848; // magic constant for cubic bezier circle approximation
    let kr = k * radius;
    pb.move_to(cx + radius, cy);
    pb.cubic_to(cx + radius, cy + kr, cx + kr, cy + radius, cx, cy + radius);
    pb.cubic_to(cx - kr, cy + radius, cx - radius, cy + kr, cx - radius, cy);
    pb.cubic_to(cx - radius, cy - kr, cx - kr, cy - radius, cx, cy - radius);
    pb.cubic_to(cx + kr, cy - radius, cx + radius, cy - kr, cx + radius, cy);
    pb.close();
    pb.finish().unwrap()
}

fn paint_for_color(color: &Rgba) -> tiny_skia::Paint<'static> {
    let mut paint = tiny_skia::Paint::default();
    paint.set_color_rgba8(color.r, color.g, color.b, color.a);
    paint.anti_alias = true;
    paint
}

/// Draw a filled circle onto a tiny-skia Pixmap.
fn draw_filled_circle(
    pixmap: &mut tiny_skia::Pixmap,
    cx: f32,
    cy: f32,
    radius: f32,
    color: &Rgba,
) {
    let path = circle_path(cx, cy, radius);
    let paint = paint_for_color(color);
    pixmap.fill_path(
        &path,
        &paint,
        tiny_skia::FillRule::Winding,
        tiny_skia::Transform::identity(),
        None,
    );
}

/// Draw a stroked circle (ring) onto a tiny-skia Pixmap.
fn draw_stroked_circle(
    pixmap: &mut tiny_skia::Pixmap,
    cx: f32,
    cy: f32,
    radius: f32,
    stroke_width: f32,
    color: &Rgba,
) {
    let path = circle_path(cx, cy, radius);
    let paint = paint_for_color(color);
    let stroke = tiny_skia::Stroke {
        width: stroke_width,
        ..Default::default()
    };
    pixmap.stroke_path(
        &path,
        &paint,
        &stroke,
        tiny_skia::Transform::identity(),
        None,
    );
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

/// Encode an RGBA pixmap as PNG bytes using the `png` crate.
fn encode_png(width: u32, height: u32, data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("png header");
        writer.write_image_data(data).expect("png data");
    }
    buf
}

// ---------------------------------------------------------------------------
// Public API: render_dot_grid
// ---------------------------------------------------------------------------

/// Render the dot-grid tray icon for the given sessions.
///
/// Returns RGBA PNG bytes at the requested `size` (e.g. 64).
/// `blink_on` controls the blink phase for working/subagent dots.
pub fn render_dot_grid(sessions: &[EnrichedSession], blink_on: bool, size: u32) -> Vec<u8> {
    render_impl(sessions, blink_on, size, false)
}

/// High-contrast variant: outlined circles with white stroke + fill color.
/// Better visibility on light taskbars.
pub fn render_dot_grid_high_contrast(
    sessions: &[EnrichedSession],
    blink_on: bool,
    size: u32,
) -> Vec<u8> {
    render_impl(sessions, blink_on, size, true)
}

fn render_impl(
    sessions: &[EnrichedSession],
    blink_on: bool,
    size: u32,
    high_contrast: bool,
) -> Vec<u8> {
    let pixmap = render_pixmap(sessions, blink_on, size, high_contrast);
    encode_png(pixmap.width(), pixmap.height(), pixmap.data())
}

fn render_pixmap(
    sessions: &[EnrichedSession],
    blink_on: bool,
    size: u32,
    high_contrast: bool,
) -> tiny_skia::Pixmap {
    let count = sessions.len().min(MAX_SESSIONS);

    // Compute "native" layout dimensions
    let (native_w, native_h) = if count == 0 {
        // Hollow ring — use dot_size + padding*2
        let s = DOT_SIZE + PADDING * 2.0;
        (s, s)
    } else {
        let active_cols = ((count as f32) / MAX_PER_COLUMN as f32).ceil() as usize;
        // Always use MAX_PER_COLUMN for layout dimensions so dots stay a
        // fixed size regardless of how many sessions are active.
        let layout_rows = MAX_PER_COLUMN;
        let w = active_cols as f32 * DOT_SIZE
            + (active_cols.saturating_sub(1)) as f32 * H_SPACING
            + PADDING * 2.0;
        let h = layout_rows as f32 * DOT_SIZE
            + (layout_rows.saturating_sub(1)) as f32 * V_SPACING
            + PADDING * 2.0;
        (w, h)
    };

    // Height is fixed at `size` (matches menu bar). Width grows with columns
    // so dots are never clipped.
    let scale = size as f32 / native_h;
    let pixel_w = ((native_w * scale).ceil() as u32).max(size);
    let mut pixmap = tiny_skia::Pixmap::new(pixel_w, size).expect("pixmap");

    let offset_x = (pixel_w as f32 - native_w * scale) / 2.0;
    let offset_y = (size as f32 - native_h * scale) / 2.0;

    if count == 0 {
        // Draw hollow white ring
        let cx = size as f32 / 2.0;
        let cy = size as f32 / 2.0;
        let stroke_w = 1.5 * scale;
        let inset = 0.75 * scale;
        let radius = (size as f32 / 2.0) - inset - stroke_w / 2.0;
        let color = Rgba { r: 255, g: 255, b: 255, a: 255 };
        draw_stroked_circle(&mut pixmap, cx, cy, radius, stroke_w, &color);
    } else {
        let active_cols = ((count as f32) / MAX_PER_COLUMN as f32).ceil() as usize;

        for (i, session) in sessions.iter().enumerate().take(count) {
            let col = i / MAX_PER_COLUMN;
            let row = i % MAX_PER_COLUMN;

            let x = PADDING + (active_cols - 1 - col) as f32 * (DOT_SIZE + H_SPACING);
            let y = PADDING + row as f32 * (DOT_SIZE + V_SPACING);

            let cx = (x + DOT_SIZE / 2.0) * scale + offset_x;
            let cy = (y + DOT_SIZE / 2.0) * scale + offset_y;
            let r = (DOT_SIZE / 2.0) * scale;

            let color = color_for_state(&session.info.state, blink_on);

            if high_contrast {
                // Fill with state color, then stroke with white
                draw_filled_circle(&mut pixmap, cx, cy, r, &color);
                let white = Rgba { r: 255, g: 255, b: 255, a: 255 };
                draw_stroked_circle(&mut pixmap, cx, cy, r, 1.0 * scale, &white);
            } else {
                draw_filled_circle(&mut pixmap, cx, cy, r, &color);
            }
        }
    }

    pixmap
}

// ---------------------------------------------------------------------------
// IconCache
// ---------------------------------------------------------------------------

/// Caches the last rendered icon to avoid redundant re-renders.
#[derive(Default)]
pub struct IconCache {
    last_key: Option<String>,
    last_png: Vec<u8>,
}

impl IconCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return cached PNG if the session states + blink phase haven't changed,
    /// otherwise re-render and cache.
    pub fn get_or_render(
        &mut self,
        sessions: &[EnrichedSession],
        blink_on: bool,
        size: u32,
    ) -> &[u8] {
        let key = Self::cache_key(sessions, blink_on, size);
        if self.last_key.as_deref() != Some(&key) {
            self.last_png = render_dot_grid(sessions, blink_on, size);
            self.last_key = Some(key);
        }
        &self.last_png
    }

    /// Convenience method — returns a cloned `Vec<u8>` of the cached icon.
    pub fn get_icon(
        &mut self,
        sessions: &[EnrichedSession],
        blink_on: bool,
        size: u32,
    ) -> Vec<u8> {
        self.get_or_render(sessions, blink_on, size).to_vec()
    }

    /// Force the next call to `get_or_render` to re-render.
    pub fn invalidate(&mut self) {
        self.last_key = None;
        self.last_png.clear();
    }

    fn cache_key(sessions: &[EnrichedSession], blink_on: bool, size: u32) -> String {
        let mut key = String::new();
        for (i, session) in sessions.iter().enumerate().take(MAX_SESSIONS) {
            if i > 0 {
                key.push(',');
            }
            key.push_str(&session.info.state);
        }
        key.push_str(&format!("|{}|{}", blink_on, size));
        key
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SessionInfo, SessionMetrics};

    fn make_session(state: &str) -> EnrichedSession {
        let info = SessionInfo {
            id: "test".to_string(),
            workspace: "/tmp/test-project".to_string(),
            state: state.to_string(),
            last_activity: 0.0,
            started_at: 0.0,
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
        };
        EnrichedSession::from_info_and_metrics(info, SessionMetrics::default())
    }

    fn verify_png(data: &[u8]) {
        assert!(!data.is_empty(), "PNG data must not be empty");
        // PNG magic bytes: 137 80 78 71 13 10 26 10
        assert!(data.len() >= 8, "PNG too short");
        assert_eq!(data[0], 0x89, "PNG magic byte 0");
        assert_eq!(data[1], b'P', "PNG magic byte 1");
        assert_eq!(data[2], b'N', "PNG magic byte 2");
        assert_eq!(data[3], b'G', "PNG magic byte 3");
        assert_eq!(data[4], 0x0D, "PNG magic byte 4");
        assert_eq!(data[5], 0x0A, "PNG magic byte 5");
        assert_eq!(data[6], 0x1A, "PNG magic byte 6");
        assert_eq!(data[7], 0x0A, "PNG magic byte 7");
    }

    #[test]
    fn test_render_zero_sessions() {
        let png = render_dot_grid(&[], true, 64);
        verify_png(&png);
    }

    #[test]
    fn test_render_one_session() {
        let sessions = vec![make_session("working")];
        let png = render_dot_grid(&sessions, true, 64);
        verify_png(&png);
    }

    #[test]
    fn test_render_four_sessions() {
        let sessions = vec![
            make_session("working"),
            make_session("waiting"),
            make_session("error"),
            make_session("idle"),
        ];
        let png = render_dot_grid(&sessions, true, 64);
        verify_png(&png);
    }

    #[test]
    fn test_render_eight_sessions() {
        let sessions: Vec<_> = (0..8)
            .map(|i| {
                let state = match i % 4 {
                    0 => "working",
                    1 => "waiting",
                    2 => "subagent",
                    _ => "done",
                };
                make_session(state)
            })
            .collect();
        let png = render_dot_grid(&sessions, false, 64);
        verify_png(&png);
    }

    #[test]
    fn test_render_blink_off_changes_output() {
        let sessions = vec![make_session("working")];
        let on = render_dot_grid(&sessions, true, 64);
        let off = render_dot_grid(&sessions, false, 64);
        verify_png(&on);
        verify_png(&off);
        // Blink on vs off should produce different images for "working"
        assert_ne!(on, off, "blink on/off should differ for working state");
    }

    #[test]
    fn test_high_contrast_variant() {
        let sessions = vec![make_session("waiting"), make_session("error")];
        let normal = render_dot_grid(&sessions, true, 64);
        let hc = render_dot_grid_high_contrast(&sessions, true, 64);
        verify_png(&normal);
        verify_png(&hc);
        assert_ne!(normal, hc, "high-contrast should differ from normal");
    }

    #[test]
    fn test_icon_cache_reuse() {
        let sessions = vec![make_session("working")];
        let mut cache = IconCache::new();

        let first = cache.get_or_render(&sessions, true, 64).to_vec();
        let second = cache.get_or_render(&sessions, true, 64).to_vec();
        assert_eq!(first, second, "cache should return same data");
    }

    #[test]
    fn test_icon_cache_invalidate() {
        let sessions = vec![make_session("working")];
        let mut cache = IconCache::new();

        let _ = cache.get_or_render(&sessions, true, 64);
        cache.invalidate();
        assert!(cache.last_key.is_none());
    }

    #[test]
    fn test_render_more_than_max_sessions() {
        // Should clamp to 8
        let sessions: Vec<_> = (0..12).map(|_| make_session("working")).collect();
        let png = render_dot_grid(&sessions, true, 64);
        verify_png(&png);
    }

    #[test]
    fn test_icon_cache_get_icon() {
        let sessions = vec![make_session("waiting"), make_session("error")];
        let mut cache = IconCache::new();
        let icon = cache.get_icon(&sessions, true, 32);
        verify_png(&icon);
    }

    #[test]
    fn test_render_target_sizes() {
        let sessions = vec![make_session("working"), make_session("idle")];
        for &sz in &[16u32, 22, 24, 32, 64] {
            let png = render_dot_grid(&sessions, true, sz);
            verify_png(&png);
        }
    }
}

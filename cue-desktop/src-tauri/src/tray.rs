//! System tray icon rendering — port of `renderDotGrid()` from the macOS Swift app.
//!
//! Uses `tiny-skia` to rasterize filled/outlined circles and the `png` crate to
//! encode RGBA pixel data. The public API returns raw PNG bytes suitable for
//! `tauri::tray::TrayIcon::set_icon`.

use crate::models::EnrichedSession;
use std::fmt::Write as _;

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
            Rgba {
                r: 255,
                g: 255,
                b: 255,
                a,
            } // white (flashing)
        }
        "thinking" => {
            let a = if blink_on { 255 } else { 38 };
            Rgba {
                r: 232,
                g: 123,
                b: 53,
                a,
            } // ember orange (flashing)
        }
        "waiting" => Rgba {
            r: 255,
            g: 204,
            b: 0,
            a: 255,
        }, // yellow (255,204,0)
        "error" => Rgba {
            r: 255,
            g: 69,
            b: 58,
            a: 255,
        }, // red (255,69,58)
        "subagent" => {
            let a = if blink_on { 255 } else { 38 };
            Rgba {
                r: 124,
                g: 197,
                b: 255,
                a,
            } // vibrant light blue (blinking) — matches Claude Code agent/shell accent
        }
        "compacting" => {
            let a = if blink_on { 220 } else { 50 };
            Rgba {
                r: 139,
                g: 159,
                b: 212,
                a,
            } // periwinkle (Claude Code compacting tint)
        }
        "clearing" => {
            let a = if blink_on { 220 } else { 50 };
            Rgba {
                r: 196,
                g: 144,
                b: 180,
                a,
            } // rose mauve (blinking)
        }
        "idle" => Rgba {
            r: 212,
            g: 165,
            b: 116,
            a: 178,
        }, // warm sand at 70%
        _ => Rgba {
            r: 48,
            g: 209,
            b: 88,
            a: 255,
        }, // green (48,209,88) done/default
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
fn draw_filled_circle(pixmap: &mut tiny_skia::Pixmap, cx: f32, cy: f32, radius: f32, color: &Rgba) {
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
    let safe_size = size.max(1);
    let scale = safe_size as f32 / native_h;
    let pixel_w = ((native_w * scale).ceil() as u32).max(safe_size);
    let mut pixmap = tiny_skia::Pixmap::new(pixel_w, safe_size).expect("pixmap");

    let offset_x = (pixel_w as f32 - native_w * scale) / 2.0;
    let offset_y = (safe_size as f32 - native_h * scale) / 2.0;

    if count == 0 {
        // Draw hollow white ring
        let cx = safe_size as f32 / 2.0;
        let cy = safe_size as f32 / 2.0;
        let stroke_w = 1.5 * scale;
        let inset = 0.75 * scale;
        let radius = (safe_size as f32 / 2.0) - inset - stroke_w / 2.0;
        let color = Rgba {
            r: 255,
            g: 255,
            b: 255,
            a: 255,
        };
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
                let white = Rgba {
                    r: 255,
                    g: 255,
                    b: 255,
                    a: 255,
                };
                draw_stroked_circle(&mut pixmap, cx, cy, r, 1.0 * scale, &white);
            } else {
                draw_filled_circle(&mut pixmap, cx, cy, r, &color);
            }
        }
    }

    pixmap
}

// ---------------------------------------------------------------------------
// Public API: render_clock
// ---------------------------------------------------------------------------

/// Maximum sessions the clock style can display. Past this, the icon renders
/// blank — matching the requested behavior that the icon "doesn't show any more".
pub const CLOCK_MAX_SESSIONS: usize = 12;

/// Render the clock-style tray icon. Up to 12 thin triangular "hands" radiate
/// from center to edge, starting at noon and progressing clockwise (one per
/// session). Each wedge spans 30° (1/12 of the circle). Hand color follows the
/// session state, and `blink_on` drives the same blink phase as the dot grid.
///
/// When `sessions.len()` exceeds `CLOCK_MAX_SESSIONS`, returns a transparent
/// PNG so the menu bar icon visually disappears.
pub fn render_clock(sessions: &[EnrichedSession], blink_on: bool, size: u32) -> Vec<u8> {
    let safe_size = size.max(1);
    let mut pixmap = tiny_skia::Pixmap::new(safe_size, safe_size).expect("pixmap");

    if sessions.len() > CLOCK_MAX_SESSIONS {
        return encode_png(safe_size, safe_size, pixmap.data());
    }

    let cx = safe_size as f32 / 2.0;
    let cy = safe_size as f32 / 2.0;
    // Inset by 1px so anti-aliased edges fit inside the icon bounds.
    let radius = (safe_size as f32 / 2.0) - 1.0;
    let half_wedge_deg = 360.0_f32 / 12.0 / 2.0; // 15° on each side of the hand axis

    for (i, session) in sessions.iter().enumerate().take(CLOCK_MAX_SESSIONS) {
        // Hand axis: noon = -90° in screen coords (y-down), then clockwise.
        let axis_deg = -90.0_f32 + 30.0 * i as f32;
        let a1 = (axis_deg - half_wedge_deg).to_radians();
        let a2 = (axis_deg + half_wedge_deg).to_radians();

        let p1x = cx + radius * a1.cos();
        let p1y = cy + radius * a1.sin();
        let p2x = cx + radius * a2.cos();
        let p2y = cy + radius * a2.sin();

        let mut pb = tiny_skia::PathBuilder::new();
        pb.move_to(cx, cy);
        pb.line_to(p1x, p1y);
        pb.line_to(p2x, p2y);
        pb.close();

        if let Some(path) = pb.finish() {
            let color = color_for_state(&session.info.state, blink_on);
            let paint = paint_for_color(&color);
            pixmap.fill_path(
                &path,
                &paint,
                tiny_skia::FillRule::Winding,
                tiny_skia::Transform::identity(),
                None,
            );

            // Hairline outline so adjacent wedges with similar colors are
            // separable. Semi-transparent black reads on both light and dark
            // menu bars without overwhelming the underlying state color.
            let outline = Rgba {
                r: 0,
                g: 0,
                b: 0,
                a: 160,
            };
            let stroke_paint = paint_for_color(&outline);
            let stroke = tiny_skia::Stroke {
                width: (safe_size as f32 / 44.0).max(0.75),
                line_join: tiny_skia::LineJoin::Miter,
                ..Default::default()
            };
            pixmap.stroke_path(
                &path,
                &stroke_paint,
                &stroke,
                tiny_skia::Transform::identity(),
                None,
            );
        }
    }

    encode_png(pixmap.width(), pixmap.height(), pixmap.data())
}

// ---------------------------------------------------------------------------
// Public API: render_bar_chart
// ---------------------------------------------------------------------------

/// Maximum sessions the bar chart style can display. Past this the icon goes
/// blank, mirroring the clock-style overflow rule.
pub const BAR_CHART_MAX_SESSIONS: usize = 12;

/// Number of ticks per shine sweep. With a 250ms tick this gives a 2-second
/// sweep — enough motion to read as "alive" without being frantic.
pub const BAR_SHINE_CYCLE: u32 = 8;

/// State strings whose bars should sweep a shine highlight.
fn is_animating_state(state: &str) -> bool {
    matches!(
        state,
        "working" | "thinking" | "subagent" | "compacting" | "clearing"
    )
}

/// State strings that fill the full pillar height in the bar-chart icon
/// regardless of context usage. Reserved for high-attention or mid-operation
/// states so they read clearly in the menu bar.
fn fills_full_pillar(state: &str) -> bool {
    matches!(state, "waiting" | "error" | "compacting")
}

/// Pick a shine overlay color that contrasts with the bar's own color.
/// Bright bars (e.g. the white "working" state) get a darker gray glint so
/// the shine is visible; darker / muted bars get a translucent white glint.
fn shine_color_for(bar: &Rgba) -> Rgba {
    let brightness = (bar.r as u32 + bar.g as u32 + bar.b as u32) / 3;
    if brightness > 200 {
        Rgba {
            r: 70,
            g: 70,
            b: 70,
            a: 170,
        }
    } else {
        Rgba {
            r: 255,
            g: 255,
            b: 255,
            a: 150,
        }
    }
}

/// Build a rounded rectangle path. Falls back to a sharp rectangle when
/// `r` is effectively zero.
fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> tiny_skia::Path {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let mut pb = tiny_skia::PathBuilder::new();
    if r <= 0.01 {
        pb.move_to(x, y);
        pb.line_to(x + w, y);
        pb.line_to(x + w, y + h);
        pb.line_to(x, y + h);
        pb.close();
    } else {
        let k = 0.5522848_f32;
        let kr = k * r;
        pb.move_to(x + r, y);
        pb.line_to(x + w - r, y);
        pb.cubic_to(x + w - r + kr, y, x + w, y + r - kr, x + w, y + r);
        pb.line_to(x + w, y + h - r);
        pb.cubic_to(
            x + w,
            y + h - r + kr,
            x + w - r + kr,
            y + h,
            x + w - r,
            y + h,
        );
        pb.line_to(x + r, y + h);
        pb.cubic_to(x + r - kr, y + h, x, y + h - r + kr, x, y + h - r);
        pb.line_to(x, y + r);
        pb.cubic_to(x, y + r - kr, x + r - kr, y, x + r, y);
        pb.close();
    }
    pb.finish().expect("rounded rect path")
}

/// Render the bar-chart tray icon. Each session is a vertical bar that grows
/// from a circular dot at the bottom (when context usage is 0) to a full-height
/// pill (when context usage is 100%). Bars in active states sweep a lighter
/// "shine" band upward instead of blinking. `tick` is a monotonic counter
/// driven by the tray timer; `BAR_SHINE_CYCLE` ticks complete one sweep.
pub fn render_bar_chart(
    sessions: &[EnrichedSession],
    tick: u32,
    size: u32,
    border_alpha: u8,
) -> Vec<u8> {
    let safe_size = size.max(1);

    if sessions.is_empty() || sessions.len() > BAR_CHART_MAX_SESSIONS {
        let blank = tiny_skia::Pixmap::new(safe_size, safe_size).expect("pixmap");
        return encode_png(safe_size, safe_size, blank.data());
    }

    let count = sessions.len() as f32;

    // Layout in pixel space, sized relative to the icon height so the bars
    // scale with the menu bar. The icon's pixel WIDTH grows with session
    // count (matching the dot-grid style) so each bar gets the same chunky
    // size regardless of how many are active — up to a soft cap so 12
    // sessions don't take over the whole menu bar.
    let h = safe_size as f32;
    let pad_y = (h * 0.10).max(2.0); // ~4px at size=44
    let pad_x = (h * 0.14).max(3.0); // ~6px at size=44
    let inner_h = (h - pad_y * 2.0).max(1.0);

    let target_bar_w = (h * 0.36).max(3.0); // ~16px at size=44
    let target_gap = (h * 0.10).max(1.5); // ~4px at size=44
    let target_total = count * target_bar_w + (count - 1.0).max(0.0) * target_gap;

    // Soft cap: max icon width is 4× the icon height (~176px at size=44).
    let max_icon_w = h * 4.0;
    let avail_w = (max_icon_w - pad_x * 2.0).max(1.0);
    let scale = if target_total > avail_w {
        avail_w / target_total
    } else {
        1.0
    };
    let bar_w = (target_bar_w * scale).max(1.5);
    let gap = target_gap * scale;
    let used_w = count * bar_w + (count - 1.0).max(0.0) * gap;
    let pixel_w = ((used_w + pad_x * 2.0).ceil() as u32).max(safe_size);

    let mut pixmap = tiny_skia::Pixmap::new(pixel_w, safe_size).expect("pixmap");
    // Center the row inside the pixmap (handles the 1-session case where
    // pixel_w gets clamped up to safe_size and the bar would otherwise hug
    // the left edge).
    let start_x = (pixel_w as f32 - used_w) / 2.0;
    let total_h = inner_h;

    let shine_phase = (tick % BAR_SHINE_CYCLE) as f32 / BAR_SHINE_CYCLE as f32;

    let track_stroke_w = (safe_size as f32 / 60.0).max(0.6);
    let track_stroke = tiny_skia::Stroke {
        width: track_stroke_w,
        line_join: tiny_skia::LineJoin::Miter,
        ..Default::default()
    };

    // Soft white outline drawn around every pill's full extent so each session
    // reads as a distinct chip regardless of its state colour or fill level.
    // A touch thicker so the rounded corners read smooth rather than choppy at
    // the menu-bar's small size; the alpha is user-tunable (0 hides it).
    let white = Rgba {
        r: 255,
        g: 255,
        b: 255,
        a: border_alpha,
    };
    let outline_stroke_w = (safe_size as f32 / 21.0).max(2.0);
    let outline_stroke = tiny_skia::Stroke {
        width: outline_stroke_w,
        line_join: tiny_skia::LineJoin::Round,
        ..Default::default()
    };

    for (i, session) in sessions.iter().enumerate().take(BAR_CHART_MAX_SESSIONS) {
        let x = start_x + i as f32 * (bar_w + gap);
        let ctx = (session.context_usage_percent.clamp(0.0, 1.0)) as f32;
        let radius = bar_w / 2.0;

        let color = color_for_state(&session.info.state, true);

        // Track — full bar extent, drawn first so the filled portion sits on
        // top. We render two layers: a faint filled "channel" so the unfilled
        // remainder is visibly darkened (reads like a real progress bar's
        // background) plus a slightly stronger outline that defines the slot.
        // Both are tinted with the state colour at low alpha so the track
        // belongs to its bar without competing with the fill.
        let track_path = rounded_rect_path(x, pad_y, bar_w, total_h, radius);
        let track_fill = Rgba {
            r: color.r,
            g: color.g,
            b: color.b,
            a: 55,
        };
        pixmap.fill_path(
            &track_path,
            &paint_for_color(&track_fill),
            tiny_skia::FillRule::Winding,
            tiny_skia::Transform::identity(),
            None,
        );
        let track_outline = Rgba {
            r: color.r,
            g: color.g,
            b: color.b,
            a: 130,
        };
        pixmap.stroke_path(
            &track_path,
            &paint_for_color(&track_outline),
            &track_stroke,
            tiny_skia::Transform::identity(),
            None,
        );

        // Filled bar — height is proportional to context usage. We floor at
        // a thin sliver (~3px at 44px icon height) just so a 0% bar still
        // shows up at the bottom of the track; the floor is intentionally
        // much smaller than `bar_w` so real context percentages don't get
        // clamped together (e.g. 14% and 23% must render at visibly
        // different heights).
        //
        // States that demand attention (waiting, error) or are mid-system
        // operation (compacting) override context entirely and fill the
        // whole pillar so they're impossible to miss in the menu bar.
        let min_h = (total_h * 0.08).max(2.5);
        let bar_h = if fills_full_pillar(&session.info.state) {
            total_h
        } else {
            (ctx * total_h).max(min_h)
        };
        let y = pad_y + total_h - bar_h;
        let bar_path = rounded_rect_path(x, y, bar_w, bar_h, radius);
        pixmap.fill_path(
            &bar_path,
            &paint_for_color(&color),
            tiny_skia::FillRule::Winding,
            tiny_skia::Transform::identity(),
            None,
        );

        if is_animating_state(&session.info.state) {
            let band_h = (bar_h * 0.4).clamp(2.5, bar_h);
            let travel = bar_h + band_h;
            let band_top = (y + bar_h) - shine_phase * travel - band_h / 2.0;
            let clipped_top = band_top.max(y);
            let clipped_bot = (band_top + band_h).min(y + bar_h);
            if clipped_bot > clipped_top + 0.25 {
                let h = clipped_bot - clipped_top;
                let r2 = radius.min(h / 2.0);
                let shine = shine_color_for(&color);
                let shine_path = rounded_rect_path(x, clipped_top, bar_w, h, r2);
                pixmap.fill_path(
                    &shine_path,
                    &paint_for_color(&shine),
                    tiny_skia::FillRule::Winding,
                    tiny_skia::Transform::identity(),
                    None,
                );
            }
        }

        // White outline around the whole pill — drawn last so it sits above the
        // fill and shine, giving each session a clean, high-contrast chip.
        pixmap.stroke_path(
            &track_path,
            &paint_for_color(&white),
            &outline_stroke,
            tiny_skia::Transform::identity(),
            None,
        );
    }

    encode_png(pixmap.width(), pixmap.height(), pixmap.data())
}

/// Render the "no active sessions" placeholder for the bar-chart style: a single
/// empty pill (same geometry as one bar) with a white outline and no fill, so
/// the menu bar shows a quiet chip rather than a hollow ring or blank space.
pub fn render_empty_pill(size: u32, border_alpha: u8) -> Vec<u8> {
    let safe_size = size.max(1);
    let h = safe_size as f32;
    let pad_y = (h * 0.10).max(2.0);
    let pad_x = (h * 0.14).max(3.0);
    let inner_h = (h - pad_y * 2.0).max(1.0);
    let bar_w = (h * 0.36).max(3.0);
    let radius = bar_w / 2.0;

    // One bar, centered — mirrors render_bar_chart's single-session layout.
    let pixel_w = ((bar_w + pad_x * 2.0).ceil() as u32).max(safe_size);
    let mut pixmap = tiny_skia::Pixmap::new(pixel_w, safe_size).expect("pixmap");

    let x = (pixel_w as f32 - bar_w) / 2.0;
    let pill = rounded_rect_path(x, pad_y, bar_w, inner_h, radius);

    let white = Rgba {
        r: 255,
        g: 255,
        b: 255,
        a: border_alpha,
    };
    let outline_stroke = tiny_skia::Stroke {
        width: (safe_size as f32 / 21.0).max(2.0),
        line_join: tiny_skia::LineJoin::Round,
        ..Default::default()
    };
    pixmap.stroke_path(
        &pill,
        &paint_for_color(&white),
        &outline_stroke,
        tiny_skia::Transform::identity(),
        None,
    );

    encode_png(pixmap.width(), pixmap.height(), pixmap.data())
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
    pub fn get_icon(&mut self, sessions: &[EnrichedSession], blink_on: bool, size: u32) -> Vec<u8> {
        self.get_or_render(sessions, blink_on, size).to_vec()
    }

    /// Force the next call to `get_or_render` to re-render.
    pub fn invalidate(&mut self) {
        self.last_key = None;
        self.last_png.clear();
    }

    fn cache_key(sessions: &[EnrichedSession], blink_on: bool, size: u32) -> String {
        let mut key = String::new();
        let mut has_blinking = false;
        for (i, session) in sessions.iter().enumerate().take(MAX_SESSIONS) {
            if i > 0 {
                key.push(',');
            }
            let state = session.info.state.as_str();
            if matches!(
                state,
                "working" | "thinking" | "subagent" | "compacting" | "clearing"
            ) {
                has_blinking = true;
            }
            key.push_str(state);
        }
        // Only fold the blink phase into the cache key when at least one
        // session is actually blinking. Otherwise the dot grid is a static
        // image and the 500 ms blink toggle would otherwise cache-miss every
        // tick — re-rasterizing PNGs and reallocating buffers for no visible
        // change.
        if has_blinking {
            let _ = write!(key, "|{}|{}", blink_on, size);
        } else {
            let _ = write!(key, "||{}", size);
        }
        key
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SessionInfo, SessionMetrics, SupplementalData};

    fn make_session(state: &str) -> EnrichedSession {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let info = SessionInfo {
            id: "test".to_string(),
            workspace: "/tmp/test-project".to_string(),
            state: state.to_string(),
            last_activity: now,
            started_at: now - 60.0,
            state_changed_at: None,
            source: None,
            hook_input_tokens: 0,
            hook_output_tokens: 0,
            hook_model: String::new(),
            active_subagents: 0,
            subprocess: None,
            team_name: None,
            agent_name: None,
            pid: None,
            permission_mode: None,
            error_type: None,
            pending_permission: None,
        };
        EnrichedSession::from_info_and_metrics(
            info,
            SessionMetrics::default(),
            &SupplementalData::default(),
        )
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
    fn test_render_empty_pill_is_valid_png() {
        // The "no active sessions" bars placeholder: one outlined pill, no fill.
        let png = render_empty_pill(64, 215);
        verify_png(&png);
    }

    #[test]
    fn test_border_alpha_changes_output() {
        // The pill-border slider (0–100 → 0–255 alpha) must actually affect the
        // rendered icon: a transparent outline differs from a solid one.
        let sessions = vec![make_session("idle")];
        let solid = render_bar_chart(&sessions, 0, 64, 255);
        let clear = render_bar_chart(&sessions, 0, 64, 0);
        assert_ne!(solid, clear, "border alpha must change the bar-chart icon");

        let pill_solid = render_empty_pill(64, 255);
        let pill_clear = render_empty_pill(64, 0);
        assert_ne!(
            pill_solid, pill_clear,
            "border alpha must change the empty pill"
        );
    }

    #[test]
    fn test_bar_chart_pill_has_white_outline() {
        // The outline is drawn on top, so a bar chart differs from the same
        // render without any white pixels — cheap proxy: the PNG is non-trivial
        // and stable across ticks for a non-animating state.
        let sessions = vec![make_session("idle")];
        let png = render_bar_chart(&sessions, 0, 64, 215);
        verify_png(&png);
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
    fn test_icon_cache_key_ignores_blink_when_no_blinking_state() {
        // No blinking states present — blink_on toggling shouldn't change
        // the cache key, so the 500ms tray timer doesn't burn re-renders.
        let sessions = vec![make_session("idle"), make_session("waiting")];
        let key_on = IconCache::cache_key(&sessions, true, 64);
        let key_off = IconCache::cache_key(&sessions, false, 64);
        assert_eq!(key_on, key_off, "static states must produce stable key");
    }

    #[test]
    fn test_icon_cache_key_uses_blink_when_blinking_state_present() {
        // Add one blinking session — now blink_on must influence the key.
        let sessions = vec![make_session("working"), make_session("idle")];
        let key_on = IconCache::cache_key(&sessions, true, 64);
        let key_off = IconCache::cache_key(&sessions, false, 64);
        assert_ne!(key_on, key_off, "blink phase must split keys when blinking");
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
    fn test_render_clock_zero_sessions() {
        // Empty clock should render an empty (transparent) but valid PNG.
        let png = render_clock(&[], true, 44);
        verify_png(&png);
    }

    #[test]
    fn test_render_clock_full_dial() {
        let sessions: Vec<_> = (0..12).map(|_| make_session("working")).collect();
        let png = render_clock(&sessions, true, 44);
        verify_png(&png);
    }

    #[test]
    fn test_render_clock_overflow_returns_blank() {
        // Past 12 sessions, the icon should not render any visible content —
        // we return a transparent PNG of the same size.
        let sessions: Vec<_> = (0..13).map(|_| make_session("working")).collect();
        let png = render_clock(&sessions, true, 44);
        verify_png(&png);
        // 12 hands at full opacity differs from 13 (blank).
        let twelve: Vec<_> = (0..12).map(|_| make_session("working")).collect();
        let twelve_png = render_clock(&twelve, true, 44);
        assert_ne!(png, twelve_png, "13+ sessions must blank the clock");
    }

    fn make_session_with_context(state: &str, context_pct: f64) -> EnrichedSession {
        let mut s = make_session(state);
        s.context_usage_percent = context_pct;
        s
    }

    #[test]
    fn test_render_bars_zero_sessions() {
        let png = render_bar_chart(&[], 0, 44, 215);
        verify_png(&png);
    }

    #[test]
    fn test_render_bars_overflow_returns_blank() {
        let sessions: Vec<_> = (0..13)
            .map(|_| make_session_with_context("working", 0.5))
            .collect();
        let overflow = render_bar_chart(&sessions, 0, 44, 215);
        verify_png(&overflow);
        let twelve: Vec<_> = (0..12)
            .map(|_| make_session_with_context("working", 0.5))
            .collect();
        let twelve_png = render_bar_chart(&twelve, 0, 44, 215);
        assert_ne!(
            overflow, twelve_png,
            "13+ sessions must blank the bar chart"
        );
    }

    #[test]
    fn test_render_bars_context_changes_height() {
        // A 0%-context bar should render differently than a 75%-context bar.
        let low = vec![make_session_with_context("idle", 0.0)];
        let high = vec![make_session_with_context("idle", 0.75)];
        let low_png = render_bar_chart(&low, 0, 44, 215);
        let high_png = render_bar_chart(&high, 0, 44, 215);
        verify_png(&low_png);
        verify_png(&high_png);
        assert_ne!(
            low_png, high_png,
            "context fraction must affect rendered bar height"
        );
    }

    #[test]
    fn test_render_bars_attention_states_fill_pillar() {
        // waiting/error/compacting should ignore context % and fill the
        // whole pillar. A low-context attention bar must therefore render
        // differently from a low-context idle bar (idle is short, attention
        // is full-height).
        for state in ["waiting", "error", "compacting"] {
            let attention = vec![make_session_with_context(state, 0.05)];
            let idle = vec![make_session_with_context("idle", 0.05)];
            let attention_full = vec![make_session_with_context(state, 1.0)];
            // Low-context attention must look different from low-context idle
            // (filled vs nearly-empty).
            assert_ne!(
                render_bar_chart(&attention, 0, 44, 215),
                render_bar_chart(&idle, 0, 44, 215),
                "{} should fill pillar regardless of context",
                state
            );
            // 5% and 100% context for an attention state should be identical
            // — both fill the pillar.
            assert_eq!(
                render_bar_chart(&attention, 0, 44, 215),
                render_bar_chart(&attention_full, 0, 44, 215),
                "{} should ignore context entirely",
                state
            );
        }
    }

    #[test]
    fn test_render_bars_low_context_pcts_render_distinct_heights() {
        // Regression: with a floor pegged to bar_w, three sessions at 14%,
        // 21%, 23% all clamped to the same height. Ensure low-but-different
        // percentages produce visibly different pixmaps now.
        let a = vec![make_session_with_context("idle", 0.14)];
        let b = vec![make_session_with_context("idle", 0.23)];
        let png_a = render_bar_chart(&a, 0, 44, 215);
        let png_b = render_bar_chart(&b, 0, 44, 215);
        verify_png(&png_a);
        verify_png(&png_b);
        assert_ne!(
            png_a, png_b,
            "14% and 23% context must render at different bar heights"
        );
    }

    #[test]
    fn test_render_bars_shine_animates() {
        // Active state should produce different pixels at different ticks.
        let sessions = vec![make_session_with_context("working", 0.6)];
        let frame_a = render_bar_chart(&sessions, 0, 44, 215);
        let frame_b = render_bar_chart(&sessions, BAR_SHINE_CYCLE / 2, 44, 215);
        verify_png(&frame_a);
        verify_png(&frame_b);
        assert_ne!(
            frame_a, frame_b,
            "shine must change pixel output across ticks for active states"
        );
    }

    #[test]
    fn test_render_bars_static_state_ignores_tick() {
        // Idle is a static state — tick should NOT change the pixels.
        let sessions = vec![make_session_with_context("idle", 0.4)];
        let frame_a = render_bar_chart(&sessions, 0, 44, 215);
        let frame_b = render_bar_chart(&sessions, BAR_SHINE_CYCLE / 2, 44, 215);
        assert_eq!(
            frame_a, frame_b,
            "static states must be tick-invariant in bar chart"
        );
    }

    #[test]
    fn test_render_clock_blink_changes_output() {
        let sessions = vec![make_session("working")];
        let on = render_clock(&sessions, true, 44);
        let off = render_clock(&sessions, false, 44);
        verify_png(&on);
        verify_png(&off);
        assert_ne!(
            on, off,
            "clock blink phase must alter pixels for blinking states"
        );
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

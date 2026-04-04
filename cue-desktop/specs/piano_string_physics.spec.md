# Piano String Physics — Spec

## Overview

Replace the Signal String's free-running sine waves with a physics-based model where animated title letters act as piano hammers. Each letter "strike" (at the peak of its CSS animation cycle) sends a damped traveling wave pulse along the Signal String. Multiple simultaneous strikes from different letters create natural interference patterns.

## Scope

**In scope:**
- Mathematical strike detection based on known animation delay/duration per character
- Traveling damped sinusoid pulse model
- Pulse buffer with automatic expiry
- Integration with existing frequency slider (controls propagation speed + wave frequency)
- Works with both uniform and random animation modes

**Out of scope:**
- New settings or UI controls (reuses existing frequency slider)
- Changes to Rust backend
- Changes to CSS animations

## Architecture

### Data Flow

```
CSS Animation Timing (delay, duration per char)
  → Mathematical Phase Computation (RAF loop in SessionCard)
    → Strike Detection (phase crosses threshold)
      → Pulse Buffer (shared ref)
        → SignalString draw() reads pulses
          → Traveling wave summation per pixel
            → tanh() bounding → canvas render
```

### Strike Detection (Mathematical)

Each animated character has deterministic timing:
- `delay`: seconds until first cycle starts
- `duration`: seconds per full cycle
- Strike phase: 0.5 for flip/ripple/glow, 0.6 for bounce

At any time `t`, character phase = `((t - delay) % duration) / duration`

A strike fires when the phase crosses the threshold between frames. To avoid double-firing, track `lastStrikeTime` per character.

### Pulse Physics

Each pulse:
```ts
interface StrikePulse {
  originX: number;   // 0..1 normalized position on canvas
  startTime: number; // performance.now()
  amplitude: number; // initial strength (1.0 default)
}
```

Displacement at pixel `x` from pulse `p`:
```
dist = |x - p.originX * canvasWidth|
travelTime = dist / propagationSpeed
localAge = (now - p.startTime) / 1000 - travelTime / canvasWidth
if (localAge < 0) → pulse hasn't reached this point yet
y += amplitude * sin(omega * localAge) * exp(-decay * localAge)
```

Sum all pulses, then `tanh(sum * gain)` for smooth bounding.

### Key Parameters (derived from frequency slider)
- **propagationSpeed**: 200-800 px/s (frequency * 400)
- **omega (ω)**: 8-24 rad/s (frequency * 12)
- **decay**: 1.5-3.0 /s (higher frequency = faster decay)
- **maxPulses**: 50 (expire oldest when exceeded)
- **pulseLifetime**: 4s max

### State Behavior
- **Working/Subagent**: Letters animate → strikes generate pulses → string vibrates
- **Idle/Done**: No animation → no strikes → pulses drain → flat line naturally
- **Revived**: Red flat line (unchanged)
- **Reduced motion**: Flat line (unchanged)
- **Signal string disabled**: Nothing renders (unchanged)

## Files Modified
1. `src/components/SessionCard.tsx` — Create pulse buffer, compute strikes, pass to SignalString
2. `src/components/SignalString.tsx` — Accept pulses prop, replace sine waves with pulse summation

## Functional Requirements

1. FR-STRIKE: Each animated title character generates a strike pulse when its animation phase crosses the peak displacement threshold
2. FR-TRAVEL: Pulses propagate bidirectionally from strike origin at speed proportional to frequency setting
3. FR-DECAY: Pulse amplitude decays exponentially over time with configurable rate
4. FR-INTERFERENCE: Multiple simultaneous pulses sum naturally, creating constructive/destructive interference
5. FR-BOUND: Total displacement is bounded via tanh() — no clipping
6. FR-DRAIN: When animation stops (state change to idle/done), existing pulses decay naturally to silence
7. FR-RANDOM: Random animation mode produces more varied/chaotic patterns due to per-character speed/delay variation
8. FR-PERF: Max 50 active pulses, expired pulses pruned each frame, no DOM event listeners for strike detection

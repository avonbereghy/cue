interface ProgressBarProps {
  value: number;
  max: number;
  height?: string;
  label?: string;
}

export function ProgressBar({ value, max, height = "h-2", label }: ProgressBarProps) {
  const percent = max > 0 ? Math.min(1, value / max) : 0;
  const pct100 = Math.round(percent * 100);

  // Solid color: green(0) → yellow(200K) → red(400K+)
  let color: string;
  if (value >= 400_000) {
    color = "#dc2626"; // red-600
  } else if (value >= 200_000) {
    const t = (value - 200_000) / 200_000;
    const r = Math.round(234 + (220 - 234) * t);
    const g = Math.round(179 - 179 * t);
    const b = Math.round(8 + (30 - 8) * t);
    color = `rgb(${r},${g},${b})`;
  } else {
    const t = Math.min(value / 200_000, 1);
    const r = Math.round(22 + (234 - 22) * t);
    const g = Math.round(200 + (179 - 200) * t);
    const b = Math.round(50 + (8 - 50) * t);
    color = `rgb(${r},${g},${b})`;
  }

  return (
    <div
      className={`${height} w-full rounded-full bg-white/10 overflow-hidden border border-white/10`}
      role="progressbar"
      aria-valuenow={pct100}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? `${pct100}% used`}
    >
      <div
        className={`${height} rounded-full progress-fill transition-all duration-300`}
        style={{
          width: `${Math.max(1, pct100)}%`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}

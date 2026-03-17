interface ProgressBarProps {
  value: number;
  max: number;
  height?: string;
  label?: string;
}

export function ProgressBar({ value, max, height = "h-2", label }: ProgressBarProps) {
  const percent = max > 0 ? Math.min(1, value / max) : 0;
  const pct100 = Math.round(percent * 100);

  let colorClass: string;
  if (pct100 > 80) {
    colorClass = "bg-red-500";
  } else if (pct100 > 50) {
    colorClass = "bg-orange-400";
  } else {
    colorClass = "bg-green-500";
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
        className={`${height} rounded-full ${colorClass} progress-fill transition-all duration-300`}
        style={{ width: `${Math.max(1, pct100)}%` }}
      />
    </div>
  );
}

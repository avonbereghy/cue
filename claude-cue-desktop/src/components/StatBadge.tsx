interface StatBadgeProps {
  icon: string;
  label: string;
  value: string;
  color: string;
}

export function StatBadge({ icon, label, value, color }: StatBadgeProps) {
  return (
    <div className="flex items-center gap-2" aria-label={`${label}: ${value}`}>
      <span className={`text-xs ${color}`} aria-hidden="true">{icon}</span>
      <div className="flex flex-col">
        <span className="text-[10px] text-white/50">{label}</span>
        <span className="text-sm font-semibold mono-nums">{value}</span>
      </div>
    </div>
  );
}

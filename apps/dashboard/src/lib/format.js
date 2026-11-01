/** Formats a number of seconds as a compact human duration, e.g. "2h 05m", "45s". */
export function formatDuration(totalSeconds) {
  if (totalSeconds == null || Number.isNaN(Number(totalSeconds))) return '—';
  const s = Math.max(0, Math.round(Number(totalSeconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}


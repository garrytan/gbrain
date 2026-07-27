// v0.42.x — Life Chronicle (#2390) narrative rendering (Phase A.6 delight).
// Pure function: turn timeline projection rows into a readable prose day-by-day
// summary (the `--narrative` flag on `gbrain day`). No SQL, no I/O.
import type { ChronicleTimelineRow } from '../types.ts';

export function renderTimelineNarrative(rows: ChronicleTimelineRow[]): string {
  if (!rows.length) return 'No events in this window.';
  const byDate = new Map<string, ChronicleTimelineRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }
  const lines: string[] = [];
  for (const [date, rs] of byDate) {
    const items = rs
      .map((r) => (r.kind ? `${r.summary} (${r.kind})` : r.summary))
      .join('; ');
    lines.push(`${date} — ${rs.length} event${rs.length === 1 ? '' : 's'}: ${items}`);
  }
  return lines.join('\n');
}

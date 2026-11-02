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
    const head = `${date} — ${rs.length} event${rs.length === 1 ? '' : 's'}:`;
    // A quoted summary or kind (GST-687, #8384, a fenced block) keeps its fence whole: each event on its own lines, the kind above it.
    if (rs.some((r) => r.summary.includes('\n') || r.kind?.includes('\n'))) {
      lines.push(head, ...rs.map((r) => (r.kind ? `${r.kind.includes('\n') ? r.kind : `(${r.kind})`}\n${r.summary}` : r.summary)));
      continue;
    }
    lines.push(`${head} ${rs.map((r) => (r.kind ? `${r.summary} (${r.kind})` : r.summary)).join('; ')}`);
  }
  return lines.join('\n');
}

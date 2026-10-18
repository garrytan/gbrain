/**
 * Date honesty in search rows (Cat 40 Hard F4). A row's `effective_date` is
 * the page's own date, chosen by a precedence chain whose winner is
 * `effective_date_source` (`types.ts` EffectiveDateSource): an `event_date`
 * is when the event happened, `date` / `published` / `filename` date the
 * document, and `created` / `fallback` are only when the page was created or
 * imported. None of them is a contract's effective or validity date, which
 * lives in the text ("Effective 2026-03-01"). Agents read `effective_date`
 * as that date, so every `search` / `query` reply whose rows carry dates gets
 * one model-visible line naming what each source present means.
 */

const LABELS: ReadonlyArray<{ sources: readonly string[]; label: string }> = [
  { sources: ['date', 'published', 'filename'], label: 'document date' },
  { sources: ['event_date'], label: 'event date' },
  { sources: ['created', 'fallback'], label: 'fallback (page created/imported, not from its text)' },
];

/** The label for one `effective_date_source` value. */
export function effectiveDateLabel(source: unknown): string {
  return LABELS.find(l => l.sources.includes(String(source)))?.label ?? 'date of unrecorded origin';
}

/** One line for the rows' dates, naming only the sources present; null when no row carries a date. */
export function dateLabelLine(rows: unknown): string | null {
  if (!Array.isArray(rows)) return null;
  const present = new Set<string>();
  for (const row of rows) {
    const r = row as { effective_date?: unknown; effective_date_source?: unknown } | null;
    if (r?.effective_date == null) continue;
    present.add(typeof r.effective_date_source === 'string' ? r.effective_date_source : 'unrecorded');
  }
  if (present.size === 0) return null;
  const parts: string[] = [];
  for (const l of LABELS) {
    const hit = l.sources.filter(src => present.has(src));
    if (hit.length > 0) parts.push(`${hit.join('/')} = ${l.label}`);
  }
  if ([...present].some(src => !LABELS.some(l => l.sources.includes(src)))) parts.push(`no source = ${effectiveDateLabel(null)}`);
  return `[gbrain dates] effective_date by effective_date_source: ${parts.join('; ')}. Never a contract's effective or validity date (read the text).`;
}

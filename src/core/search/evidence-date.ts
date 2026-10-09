/**
 * Dated evidence blocks (C1, `search.evidence_date_header`): the one-line
 * date header evidence delivery puts at the top of every delivered block, and
 * the day formatter it shares with think's page dates.
 *
 * Header grammar (fixed, one line, parsed by agents and eval harnesses):
 *
 *   page block:  [observed 2026-03-05]
 *   fact:        [observed unknown; valid 2026-03-01 to unknown]
 *
 * Each date is YYYY-MM-DD or the literal `unknown`. `observed` is when the
 * source text was written or said (date grounding's observation time,
 * #6020): the page's filename/slug date,
 * frontmatter `date`, `published` or a created key, in effective-date
 * precedence with `event_date` removed. An event date is when something
 * happened, not when the note was written, and row timestamps are when GBrain
 * stored it, so neither is ever shown as observed. Facts carry no observation
 * date on master, so a fact's `observed` is `unknown` and its validity window
 * (`valid_from` to `valid_until`, an open end shown as `unknown`) follows.
 *
 * Seam: `pageObservationDate` mirrors `resolveObservationDate` from
 * src/core/ai/date-grounding.ts (#6020); once that lands, call it here
 * instead. Days render through `formatBrainDay` (effective-date.ts), the
 * same function think's `<page date>` attribute uses, so both surfaces print
 * the same day. The header's `observed` is when the text was written or
 * said, never the event date think shows as content date.
 */
import { computeEffectiveDate, formatBrainDay } from '../effective-date.ts';

export const EVIDENCE_DATE_HEADER_KEY = 'search.evidence_date_header';
export const UNKNOWN_DATE = 'unknown';

const OBSERVATION_SOURCES = new Set(['filename', 'date', 'published', 'created']);

/** When the page's text was written or said; null when it states no such date. Never a row timestamp. */
export function pageObservationDate(page: {
  slug: string;
  frontmatter?: Record<string, unknown> | null;
  filename?: string | null;
  timeZone?: string | null;
}): Date | null {
  const { event_date: _eventDate, ...frontmatter } = page.frontmatter ?? {};
  const invalid = new Date(Number.NaN);
  const result = computeEffectiveDate({
    slug: page.slug,
    frontmatter,
    filename: page.filename ?? page.slug.split('/').pop() ?? null,
    timeZone: page.timeZone ?? undefined,
    createdAt: invalid,
    updatedAt: invalid,
  });
  return result.date && result.source && OBSERVATION_SOURCES.has(result.source) ? result.date : null;
}

export function pageDateHeader(observed: string | null): string {
  return `[observed ${observed ?? UNKNOWN_DATE}]`;
}

/** A valid_from within this of created_at is the write-time default, not a known start of validity. */
const WRITE_TIME_DEFAULT_MS = 60_000;

/**
 * `observed` is when the fact was said: the observation date of the page it
 * came from, when the caller supplies it. `valid FROM` is the fact's
 * valid_from, except a valid_from that only records the write time (the
 * default when `remember` gets no date) renders `unknown`: the header never
 * presents when a fact was written as when it became true.
 */
export function factDateHeader(
  fact: { valid_from?: Date | string | null; valid_until?: Date | string | null; created_at?: Date | string | null },
  timeZone?: string | null,
  observed?: string | null,
): string {
  const writeTimeDefault = fact.valid_from && fact.created_at
    && Math.abs(new Date(fact.valid_from).getTime() - new Date(fact.created_at).getTime()) < WRITE_TIME_DEFAULT_MS;
  const from = (writeTimeDefault ? null : formatBrainDay(fact.valid_from, timeZone)) ?? UNKNOWN_DATE;
  const until = formatBrainDay(fact.valid_until, timeZone) ?? UNKNOWN_DATE;
  return `[observed ${observed ?? UNKNOWN_DATE}; valid ${from} to ${until}]`;
}

/**
 * The page header for each page id: one read of the stored frontmatter and
 * import filename (only the derived day leaves this function) plus
 * `brain.timezone`. Ids missing from the result render `unknown`.
 */
export async function loadPageDateHeaders(
  engine: { executeRaw<T>(sql: string, params?: unknown[]): Promise<T[]>; getConfig(key: string): Promise<string | null> },
  pageIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = [...new Set(pageIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return out;
  const timeZone = (await engine.getConfig('brain.timezone').catch(() => null))?.trim() || null;
  const rows = await engine.executeRaw<{ id: number; slug: string; frontmatter: unknown; import_filename: string | null }>(
    'SELECT id, slug, frontmatter, import_filename FROM pages WHERE id = ANY($1::int[])', [ids]);
  for (const r of rows) {
    const fm = typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter;
    const observed = pageObservationDate({ slug: String(r.slug), frontmatter: fm && typeof fm === 'object' ? fm as Record<string, unknown> : null, filename: r.import_filename, timeZone });
    out.set(Number(r.id), pageDateHeader(formatBrainDay(observed, timeZone)));
  }
  return out;
}

/** `recall` fact rows plus `date_header` when `search.evidence_date_header` is on; unchanged otherwise. */
export async function withFactDateHeaders<T extends { id: number; valid_from: string | null; valid_until: string | null; created_at?: string | null; entity_slug?: string | null; source_id?: string }>(
  engine: { getConfig(key: string): Promise<string | null>; executeRaw<R>(sql: string, params?: unknown[]): Promise<R[]> },
  facts: T[],
): Promise<Array<T & { date_header?: string }>> {
  if (!await evidenceDateHeaderEnabled(engine)) return facts;
  const timeZone = (await engine.getConfig('brain.timezone').catch(() => null))?.trim() || null;
  const observed = await factObservationDates(engine, facts, timeZone).catch(() => new Map<number, string>());
  return facts.map(f => ({ ...f, date_header: factDateHeader(f, timeZone, observed.get(f.id)) }));
}

/**
 * When each fact was said: the observation date of the page the fact came
 * from (`facts.source_markdown_slug`, e.g. the conversation it was extracted
 * from). A fact stored in its own entity page's facts fence has no such page,
 * so it stays unknown. One facts read and one pages read per call.
 */
async function factObservationDates(
  engine: { executeRaw<R>(sql: string, params?: unknown[]): Promise<R[]> },
  facts: Array<{ id: number; entity_slug?: string | null }>,
  timeZone: string | null,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = facts.map(f => f.id).filter(id => Number.isInteger(id) && id > 0);
  if (!ids.length) return out;
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string | null; entity_slug: string | null }>(
    'SELECT id, source_id, source_markdown_slug AS slug, entity_slug FROM facts WHERE id = ANY($1::bigint[])', [ids]);
  const wanted = rows.filter(r => r.slug && r.slug !== r.entity_slug);
  if (!wanted.length) return out;
  const pages = await engine.executeRaw<{ source_id: string; slug: string; frontmatter: unknown; import_filename: string | null }>(
    `SELECT p.source_id, p.slug, p.frontmatter, p.import_filename FROM pages p
     JOIN unnest($1::text[], $2::text[]) AS w(source_id, slug) ON p.source_id = w.source_id AND p.slug = w.slug WHERE p.deleted_at IS NULL`,
    [wanted.map(r => r.source_id), wanted.map(r => r.slug!)]);
  const byKey = new Map(pages.map(p => {
    const fm = typeof p.frontmatter === 'string' ? JSON.parse(p.frontmatter) : p.frontmatter;
    const day = formatBrainDay(pageObservationDate({ slug: p.slug, frontmatter: fm && typeof fm === 'object' ? fm as Record<string, unknown> : null, filename: p.import_filename, timeZone }), timeZone);
    return [`${p.source_id}\u0000${p.slug}`, day] as const;
  }));
  for (const r of wanted) {
    const day = byKey.get(`${r.source_id}\u0000${r.slug}`);
    if (day) out.set(Number(r.id), day);
  }
  return out;
}

/**
 * The date header line (with its newline) for each delivered block, read for
 * every hit page in one query. A failed read renders `unknown` for every page
 * and calls `onUnavailable` once. A facts-arm row gets its fact header unless
 * its text already starts with one.
 */
export async function blockDateHeaders(engine: Parameters<typeof loadPageDateHeaders>[0],
  hits: Array<{ page_id: number; chunk_text?: string | null; fact_row?: { valid_from: string; valid_until: string | null } }>,
  onUnavailable: () => void): Promise<(hit: { page_id: number; chunk_text?: string | null; fact_row?: { valid_from: string; valid_until: string | null } }) => string> {
  let headers: Map<number, string>;
  try { headers = await loadPageDateHeaders(engine, hits.map(h => h.page_id)); } catch { headers = new Map(); onUnavailable(); }
  return hit => hit.fact_row ? (hit.chunk_text?.startsWith('[observed ') ? '' : `${factDateHeader(hit.fact_row)}\n`) : `${headers.get(hit.page_id) ?? pageDateHeader(null)}\n`;
}

/** `search.evidence_date_header` is on ('true' | 'on' | '1' | 'yes'); off by default and on any read error. */
export async function evidenceDateHeaderEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(EVIDENCE_DATE_HEADER_KEY))?.trim().toLowerCase();
    return raw === 'true' || raw === 'on' || raw === '1' || raw === 'yes';
  } catch {
    return false;
  }
}

/**
 * Shared batch-insert row builders (gbrain#1861).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `addLinksBatch` / `addTimelineEntriesBatch` / `addTakesBatch` used to bind
 * free text through `unnest(${arr}::text[])`. postgres.js serializes a JS
 * string[] into a Postgres `text[]` literal (`{"...","..."}`); calendar/Zoom
 * context strings (commas, quotes, braces, em-dashes) produced a literal that
 * Postgres `array_in` rejected -> "malformed array literal", which aborted the
 * whole `extract links --stale` sweep. The fix passes the batch as a single
 * JSONB document via `jsonb_to_recordset((($1::jsonb)->'rows'))`, which encodes
 * arbitrary free text safely and dodges the 65535-bind-param cap.
 *
 * Both engines (postgres.js and PGLite) must build the SAME row objects or they
 * drift, so the object construction lives here once and both engines import it.
 *
 *   LinkBatchInput[] ---+
 *   TimelineInput[] ----+--> build*Rows() --> [{...}, ...] --> { rows } wrapper
 *   TakeBatchInput[] ---+         |                              |
 *                          sanitizeForJsonb              executeRawJsonb
 *                          free-text fields only         $1::jsonb -> 'rows'
 *                                                         jsonb_to_recordset(...)
 *
 * NUL + SURROGATE POLICY (codex P0 hardening; #2011): Postgres `jsonb` rejects
 * both the Unicode NUL escape AND an unpaired UTF-16 surrogate half, and Postgres
 * `text` cannot store a NUL either, so the OLD `unnest(::text[])` path rejected
 * (errored) any row carrying either. We deliberately PRESERVE that reject
 * semantics for IDENTITY and security-relevant fields: slugs, source_ids,
 * `holder`, `kind`, dates, and the enum-ish `link_type` / `link_source` /
 * `origin_slug` / `origin_field`. Those are left UN-sanitized, so junk in them
 * still errors the batch and can never silently retarget a row to a different
 * page/source or normalize a `holder` past the read-side `holder = ANY(allowlist)`
 * privacy filter.
 *
 * `sanitizeForJsonb` (strip NUL + well-form lone surrogates) is applied ONLY to
 * genuinely free-prose body fields where junk plausibly arrives from
 * calendar/meeting/LLM/OCR content and where dropping the whole batch would be
 * the worse outcome: `context` (links), `summary` + `detail` + `source`
 * (timeline), `claim` + `source` (takes). A lone surrogate is normalized to
 * U+FFFD; NUL is removed. Timeline `source` is free-text here (it round-trips
 * arbitrary provenance labels and is treated as free text by both engines), so it
 * is sanitized too even though it participates in `idx_timeline_dedup` — replacing
 * a malformed half-char before dedup is correct, not lossy (#2011). Takes `source`
 * is likewise free-text LLM-extracted provenance (not an identity/dedup field —
 * the takes key is `(page_id, row_num)`), so it is sanitized as well. Commas, quotes,
 * braces, and em-dashes are exactly what JSONB encodes correctly and are never
 * touched; stripping them would corrupt user data.
 *
 * DEFAULTING NOTE: the builders reproduce each method's exact pre-#1861
 * defaulting. `|| ''` / `|| 'markdown'` / `|| 'default'` collapse empty strings;
 * `origin_slug` / `origin_field` use truthy-`|| null` (empty string -> null,
 * which the LEFT JOIN treats as no-match); `link_kind` uses `?? null` (empty
 * string preserved). Do NOT "simplify" `||` to `??`; it changes empty-string
 * behavior.
 *
 * BATCH SIZE: one JSONB parameter dodges the 65535-param cap but is not
 * unbounded; it has a server-side datum/parse-memory ceiling. In-tree callers
 * batch small (extract links ~100/batch, NER ~500), well within budget. Direct
 * engine callers passing arbitrarily large batches should chunk (~1-5K rows).
 */

import type { LinkBatchInput, TimelineBatchInput, TakeBatchInput } from './engine.ts';
import { normalizeWeightForStorage } from './takes-fence.ts';
import { ensureWellFormed } from './text-safe.ts';

/**
 * Strip Unicode NUL (U+0000) from a free-text body field. Fast-path the common
 * case (no NUL) so the regex replace only runs when a NUL is actually present.
 * Only call this on free-prose columns, never on identity/security fields (see
 * the NUL POLICY note above).
 *
 * This is the NUL-only primitive. For anything serialized into a `::jsonb` cast,
 * prefer `sanitizeForJsonb` below — NUL alone does not protect against the lone
 * surrogate that aborts a jsonb batch (#2011). Exported only as the building
 * block for `sanitizeForJsonb`; don't reach for it directly on a jsonb path.
 */
export const stripNul = (s: string): string => (s.includes('\0') ? s.replace(/\0/g, '') : s);

/**
 * Sanitize a free-text body field for JSONB serialization: strip NUL (#1861)
 * AND well-form unpaired UTF-16 surrogates (#2011). A lone surrogate half (left
 * behind when a slicer like `excerpt()` cuts a window boundary through an emoji)
 * is rejected by Postgres inside a `::jsonb` cast and aborts the whole batch;
 * `ensureWellFormed` replaces it with U+FFFD. Like `stripNul`, call this ONLY on
 * free-prose body columns, NEVER on identity/security fields (see NUL POLICY).
 */
export const sanitizeForJsonb = (s: string): string => ensureWellFormed(stripNul(s));

/** One links row, keys === the jsonb_to_recordset column list. */
export interface LinkRow {
  from_slug: string;
  to_slug: string;
  link_type: string;
  context: string;
  link_source: string;
  origin_slug: string | null;
  origin_field: string | null;
  from_source_id: string;
  to_source_id: string;
  origin_source_id: string;
  link_kind: string | null;
}

/** One timeline row, keys === the jsonb_to_recordset column list. */
export interface TimelineRow {
  slug: string;
  date: string;
  source: string;
  summary: string;
  detail: string;
  source_id: string;
}

/** One takes row, keys === the jsonb_to_recordset column list. Numbers/booleans
 * stay JSON-native so the recordset can declare native column types. */
export interface TakeRow {
  page_id: number;
  row_num: number;
  claim: string;
  kind: string;
  holder: string;
  weight: number;
  since_date: string | null;
  until_date: string | null;
  source: string | null;
  superseded_by: number | null;
  active: boolean;
}

export function buildLinkRows(links: LinkBatchInput[]): LinkRow[] {
  return links.map(l => ({
    from_slug: l.from_slug,
    to_slug: l.to_slug,
    link_type: l.link_type || '',
    context: sanitizeForJsonb(l.context || ''), // free-text body: NUL + lone-surrogate sanitized
    link_source: l.link_source || 'markdown',
    origin_slug: l.origin_slug || null,
    origin_field: l.origin_field || null,
    from_source_id: l.from_source_id || 'default',
    to_source_id: l.to_source_id || 'default',
    origin_source_id: l.origin_source_id || 'default',
    link_kind: l.link_kind ?? null,
  }));
}

export function buildTimelineRows(entries: TimelineBatchInput[]): TimelineRow[] {
  return entries.map(e => ({
    slug: e.slug,
    date: e.date,
    source: sanitizeForJsonb(e.source || ''), // free-text body: NUL + lone-surrogate sanitized (#2011)
    summary: sanitizeForJsonb(e.summary), // free-text body: NUL + lone-surrogate sanitized
    detail: sanitizeForJsonb(e.detail || ''), // free-text body: NUL + lone-surrogate sanitized
    source_id: e.source_id || 'default',
  }));
}

/**
 * Build takes rows AND report how many weights were clamped, so the caller can
 * emit the TAKES_WEIGHT_CLAMPED stderr counter exactly as before. Weight
 * normalization (clamp to [0,1] + round to 0.05 grid) stays centralized here.
 */
export function buildTakeRows(rowsIn: TakeBatchInput[]): { rows: TakeRow[]; weightClamped: number } {
  let weightClamped = 0;
  const rows = rowsIn.map(r => {
    const { weight, clamped } = normalizeWeightForStorage(r.weight);
    if (clamped) weightClamped++;
    return {
      page_id: r.page_id,
      row_num: r.row_num,
      claim: sanitizeForJsonb(r.claim), // free-text body: NUL + lone-surrogate sanitized
      kind: r.kind,
      holder: r.holder,
      weight,
      since_date: r.since_date ?? null,
      until_date: r.until_date ?? null,
      // free-text provenance → NUL + lone-surrogate sanitized (#2011); same
      // jsonb crash class as claim. null/undefined stay null; '' stays ''.
      source: r.source == null ? null : sanitizeForJsonb(r.source),
      superseded_by: r.superseded_by ?? null,
      active: r.active ?? true,
    };
  });
  return { rows, weightClamped };
}

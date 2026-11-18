/**
 * Converts what the Rust store returns into the shapes the BrainEngine members return on PGLite. The store speaks plain
 * JSON values (rust/README.md, "The brain store"): dates are ISO strings with microsecond precision, never `Date`.
 */

import { validDate } from '../valid-time.ts';
import { guardSegmentedBody } from '../page-body/page-shape.ts';

type Row = Record<string, unknown>;

/** An ISO string (or null/undefined) to a `Date`; null and undefined stay as they are. */
function reviveDate(value: unknown): unknown {
  return typeof value === 'string' ? new Date(value) : value;
}

/** A copy of `row` with the named date fields turned into `Date`. A field the row lacks stays absent. */
export function withDates<T extends object>(row: T, fields: readonly string[]): T {
  const out: Row = { ...(row as Row) };
  for (const field of fields) if (field in out) out[field] = reviveDate(out[field]);
  return out as T;
}

/** A `PageInput` or any write body with its `Date` values as ISO strings, which is what the store reads. */
export function withIsoDates<T extends object>(row: T): T {
  const out: Row = { ...(row as Row) };
  for (const [key, value] of Object.entries(out)) if (value instanceof Date) out[key] = value.toISOString();
  return out as T;
}

/** Every date column of `Page`, including `salience_touched_at`, which a family adds through the store's page-columns hook. */
const PAGE_DATES = ['created_at', 'updated_at', 'deleted_at', 'effective_date', 'ingested_at', 'salience_touched_at'] as const;

/**
 * What PGLite's page rows carry that the page record has no field for. A family that owns one of these columns adds it
 * through the store's page-columns hook (`page_columns.rs`); the store's value then replaces the default here, so no
 * family edits this list.
 */
const PAGE_ROW_DEFAULTS = { contextual_retrieval_mode: null, emotional_weight: 0, salience_touched_at: null, withheld_source_path: null } as const;

function pageDates(page: Row): Row {
  const { page_kind: _kind, ...rest } = page;
  return withDates(rest, PAGE_DATES);
}

/**
 * Nullable page fields (shared item 12, `PageText` in `rust/crates/gbrain-store/src/pages.rs`). The store sends a
 * segmented shell page's `compiled_truth` and `timeline` as null, the only page PGLite's `pages_body_storage_chk` lets
 * hold NULL there. PGLite's `rowToPage` reads them as `''` behind getters that throw `page_body_segmented`; this does
 * the same, last, because spreading a guarded page would run the getters. `content_hash` stays null, as PGLite's row
 * has it.
 */
function guardNullBody(page: Row): Row {
  if (page.compiled_truth !== null && page.timeline !== null) return page;
  return guardSegmentedBody({ ...page, compiled_truth: '', timeline: '' }, 'rowToPage');
}

/**
 * The page `putPage` returns. PGLite's `RETURNING` list names neither `source_path`, `deleted_at` nor `updated_at_iso`,
 * and its `emotional_weight` key is present and undefined.
 */
export function toPutPage<T extends object>(page: T): T {
  const { source_path: _path, deleted_at: _deleted, updated_at_iso: _iso, ...rest } = pageDates(page as Row);
  return { ...rest, emotional_weight: undefined } as T;
}

/** The page `getPage` and `readPageSnapshot` return: PGLite's row has the defaulted columns and no `updated_at_iso`. */
export function toGetPage<T extends object>(page: T): T {
  const { updated_at_iso: _iso, ...rest } = pageDates(page as Row);
  return guardNullBody({ ...PAGE_ROW_DEFAULTS, ...rest }) as T;
}

/** A row of `listPages`: the table's columns plus `updated_at_iso`. */
export function toListPage<T extends object>(page: T): T {
  return guardNullBody({ ...PAGE_ROW_DEFAULTS, ...pageDates(page as Row) }) as T;
}

/** The nullable columns of a chunk row, which PGLite returns as null when a chunk has no value. */
const CHUNK_DEFAULTS = {
  language: null, symbol_name: null, symbol_type: null, start_line: null, end_line: null, parent_symbol_path: null,
  doc_comment: null, symbol_name_qualified: null, projected_byte_start: null, projected_byte_end: null, token_count: null,
} as const;

/** A chunk as PGLite's `getChunks` returns it: every nullable column present, and no vector (the store keeps none). */
export function toChunk<T extends object>(chunk: T): T {
  const { has_embedding: _has, ...rest } = chunk as Row;
  return { embedding: null, ...CHUNK_DEFAULTS, ...rest, embedded_at: null, embedding_is_null: true } as T;
}

/** The provenance columns PGLite's timeline rows carry and the store does not keep. */
const TIMELINE_DEFAULTS = {
  write_request_id: null, write_principal_kind: null, write_principal_id: null, last_write_request_id: null,
  last_write_principal_kind: null, last_write_principal_id: null, last_written_at: null, trust_tier: 'unknown', write_origin: null,
} as const;

/** A timeline row. The entry's `date` (a calendar day, "2026-03-04") reads back as the Date at that day's midnight UTC, as PGLite's DATE column does. */
export function toTimelineEntry<T extends object>(entry: T): T {
  const row = { ...TIMELINE_DEFAULTS, ...withDates(entry, ['created_at']) } as Record<string, unknown>;
  if (typeof row.date === 'string') row.date = new Date(`${row.date.slice(0, 10)}T00:00:00.000Z`);
  return row as T;
}

/**
 * A version as `getVersions` returns it: the frontmatter's valid-time dates (`validDate`, as the SQL twin reads
 * them), the reason the next write gave (none is kept), and no `content_hash`, which PGLite's list leaves out.
 */
export function toVersion<T extends object>(version: T): T {
  const { content_hash: _hash, ...rest } = withDates(version, ['snapshot_at']) as Row;
  const frontmatter = (rest.frontmatter ?? {}) as Row;
  return { ...rest, replaced_because: null, valid_from: validDate(frontmatter.valid_from), valid_until: validDate(frontmatter.valid_until) } as T;
}

/** The row `createVersion` returns: PGLite hands back the whole inserted row, columns and defaults included. */
export function toCreatedVersion<T extends object>(version: T): T {
  const { content_hash: _hash, ...rest } = withDates(version, ['snapshot_at']) as Row;
  return {
    archived_principal_id: null, archived_principal_kind: null, archived_write_request_id: null, body_bytes: null,
    body_generation: null, body_storage: 'inline', change_reason: null, content_hash: null, successor_pruned: null,
    trust_tier: 'unknown', write_origin: null, write_principal_id: null, write_principal_kind: null, write_request_id: null,
    ...rest,
  } as T;
}

export function toSource<T extends object>(source: T): T {
  const { incarnation: _incarnation, ...rest } = source as Row;
  return withDates(rest as T, ['last_sync_at']);
}

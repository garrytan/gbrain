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

/**
 * The lowercase hyphenated text of a uuid, read as Postgres reads `$1::uuid`: optional braces, a hyphen optional after
 * any group of four hex digits, any case. Anything else throws Postgres's own message, so a Rust member keyed by a
 * token id refuses the ids a SQL engine refuses and finds the ones it finds.
 */
export function uuidText(value: string): string {
  const bare = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  if (!/^[0-9a-f]{4}(?:-?[0-9a-f]{4}){7}$/i.test(bare)) throw new Error(`invalid input syntax for type uuid: "${value}"`);
  const hex = bare.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A copy of `row` with the named date fields turned into `Date`. A field the row lacks stays absent. */
export function withDates<T extends object>(row: T, fields: readonly string[]): T {
  const out: Row = { ...(row as Row) };
  for (const field of fields) if (field in out) out[field] = reviveDate(out[field]);
  return out as T;
}

/** The write-journal request columns PGLite returns as a Date (timestamptz). */
const REQUEST_DATES = ['claim_expires_at', 'created_at', 'updated_at', 'completed_at', 'published_at', 'next_attempt_at'];

/** A stored write-journal request row as PGLite returns it: the timestamps as Dates, every other column as stored. */
export function requestRow<R extends object>(row: unknown): R | null {
  return row === null || row === undefined ? null : withDates(row as R, REQUEST_DATES);
}

/**
 * A store ISO time (`2026-08-10T12:00:00.000120Z`) as `row_to_json` prints a timestamptz in a UTC session:
 * `2026-08-10T12:00:00.00012+00:00`, trailing zero digits of the fraction dropped, no fraction when it is zero.
 */
function jsonTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(value);
  if (!m) return value;
  const frac = (m[2] ?? '').replace(/0+$/, '');
  return `${m[1]}${frac ? `.${frac}` : ''}+00:00`;
}

/** A stored write-journal request row as `row_to_json(p)` returns it: the timestamps as UTC text, every other column as stored. */
export function requestJsonRow<R extends object>(row: unknown): R {
  const out: Row = { ...(row as Row) };
  for (const field of REQUEST_DATES) if (field in out) out[field] = jsonTimestamp(out[field]);
  return out as R;
}

/** A stored topology change row as PGLite returns it: created_at and updated_at as Dates. */
export function topologyRow<R extends object>(row: unknown): R | null {
  return row === null || row === undefined ? null : withDates(row as R, ['created_at', 'updated_at']);
}

/**
 * A `PageInput` or any write body with its `Date` values as ISO strings, which is what the store reads. `frontmatter`
 * goes as the JSON text Postgres and PGLite store for it (`jsonbParam`), so a YAML date nested in it is its ISO string
 * there too; the addon would send it as an empty object.
 */
export function withIsoDates<T extends object>(row: T): T {
  const out: Row = { ...(row as Row) };
  for (const [key, value] of Object.entries(out)) if (value instanceof Date) out[key] = value.toISOString();
  if (out.frontmatter !== null && typeof out.frontmatter === 'object') out.frontmatter = JSON.parse(JSON.stringify(out.frontmatter));
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

/**
 * A chunk as PGLite's `getChunks` returns it: every nullable column present, `embedded_at` a Date, and the vector a
 * Float32Array when the read asked for it (null otherwise).
 */
export function toChunk<T extends object>(chunk: T): T {
  const row = { embedding: null, ...CHUNK_DEFAULTS, ...withDates(chunk, ['embedded_at']) } as Row;
  row.embedding = Array.isArray(row.embedding) ? new Float32Array(row.embedding as number[]) : null;
  return row as T;
}

/**
 * A timeline row. The store returns its trust columns and write receipt. The entry's `date` (a calendar day,
 * "2026-03-04") reads back as the Date at that day's midnight UTC, as PGLite's DATE column does; `created_at` and the
 * receipt's `last_written_at` read back as Dates.
 */
export function toTimelineEntry<T extends object>(entry: T): T {
  const row = withDates(entry, ['created_at', 'last_written_at']) as Record<string, unknown>;
  if (typeof row.date === 'string') row.date = new Date(`${row.date.slice(0, 10)}T00:00:00.000Z`);
  return row as T;
}

/**
 * A version as `getVersions` returns it: the frontmatter's valid-time dates (`validDate`, as the SQL twin reads
 * them), the reason the next write gave (the store's `replaced_because`, its stamped `change_reason`), and no
 * `content_hash`, which PGLite's list leaves out.
 */
/**
 * The store keeps every snapshot's content_hash; PGLite's page_versions holds it only on a segmented snapshot
 * (insertSegmentedVersion), so an inline snapshot's goes.
 */
function versionHash(version: object): Row {
  const row = withDates(version, ['snapshot_at']) as Row;
  if (row.body_storage === 'segmented') return row;
  const { content_hash: _hash, ...rest } = row;
  return rest;
}

export function toVersion<T extends object>(version: T): T {
  const rest = versionHash(version);
  const frontmatter = (rest.frontmatter ?? {}) as Row;
  return { ...rest, replaced_because: (rest as Row).replaced_because ?? null, valid_from: validDate(frontmatter.valid_from), valid_until: validDate(frontmatter.valid_until) } as T;
}

/**
 * The row `createVersion` returns: PGLite hands back the whole inserted row, columns and defaults included. The store
 * sends the snapshot's `trust_tier` and `write_origin` (copied from the page, as `snapshot_version_trust` does), which
 * replace the defaults here.
 */
export function toCreatedVersion<T extends object>(version: T): T {
  const rest = versionHash(version);
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

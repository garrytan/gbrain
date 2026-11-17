/**
 * Converts what the Rust store returns into the shapes the BrainEngine members return on PGLite. The store speaks plain
 * JSON values (rust/README.md, "The brain store"): dates are ISO strings with microsecond precision, never `Date`.
 */

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

const PAGE_DATES = ['created_at', 'updated_at', 'deleted_at', 'effective_date', 'ingested_at'] as const;

/** A store `Page` as PGLite's `Page`: dates are `Date`; `page_kind`, which PGLite's page does not carry, is dropped. */
export function toPage<T extends object>(page: T): T {
  const { page_kind: _kind, ...rest } = page as Row;
  return withDates(rest as T, PAGE_DATES);
}

export function toChunk<T extends object>(chunk: T): T {
  const { has_embedding: hasEmbedding, ...rest } = chunk as Row;
  return withDates({ ...rest, embedding_is_null: !hasEmbedding } as T, ['embedded_at']);
}

/** A timeline row. The entry's `date` (a calendar day, "2026-03-04") reads back as the Date at that day's midnight UTC, as PGLite's DATE column does. */
export function toTimelineEntry<T extends object>(entry: T): T {
  const row = withDates(entry, ['created_at']) as Record<string, unknown>;
  if (typeof row.date === 'string') row.date = new Date(`${row.date.slice(0, 10)}T00:00:00.000Z`);
  return row as T;
}

export function toVersion<T extends object>(version: T): T {
  return withDates(version, ['snapshot_at']);
}

export function toSource<T extends object>(source: T): T {
  const { incarnation: _incarnation, ...rest } = source as Row;
  return withDates(rest as T, ['last_sync_at']);
}

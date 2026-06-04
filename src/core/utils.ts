import { createHash, randomBytes } from 'crypto';
import type { Page, PageInput, PageType, Chunk, SearchResult, StalePageRow } from './types.ts';
import type { Take, TakeKind } from './engine.ts';

/**
 * SHA-256 hash a token/secret for storage. Never store plaintext tokens.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generate a cryptographically random token with a prefix.
 */
export function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('hex')}`;
}

/**
 * Validate and normalize a slug. Slugs are lowercased repo-relative paths.
 * Rejects empty slugs, path traversal (..), and leading /.
 */
export function validateSlug(slug: string): string {
  if (!slug || /(^|\/)\.\.($|\/)/.test(slug) || /^\//.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs cannot be empty, start with /, or contain path traversal.`);
  }
  return slug.toLowerCase();
}

/**
 * SHA-256 hash of page content, used for import idempotency.
 * Hashes all PageInput fields to match importFromContent's hash algorithm.
 */
export function contentHash(page: PageInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: page.title,
      type: page.type,
      compiled_truth: page.compiled_truth,
      timeline: page.timeline || '',
      frontmatter: page.frontmatter || {},
    }))
    .digest('hex');
}

/**
 * Validate a `source_id` is safe for use as a filesystem path segment AND
 * as a SQL identifier value. Used by the per-source disk-layout code in
 * patterns.ts/synthesize.ts before any `join(brainDir, source_id, ...)`
 * call, and at `putSource()` time so invalid ids never make it into the DB.
 *
 * **v0.38 (codex r2 P1-C, P1-D):** consolidated to import from
 * `src/core/source-id.ts` (dependency-free canonical module). The regex
 * TIGHTENED from the permissive `^[a-z0-9_-]+$` to the strict kebab-case
 * `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$` — same regex `sources-ops` has
 * always enforced at creation time. Closes the drift between path-safety
 * and creation-time validation; no production source IDs break (none had
 * underscores, since `sources-ops` always rejected them).
 *
 * Re-exported here for back-compat with the pre-v0.38 `validateSourceId`
 * import. New code should import directly from `source-id.ts`.
 */
export { assertValidSourceId as validateSourceId } from './source-id.ts';

function readOptionalDate(raw: unknown): Date | null | undefined {
  // Three-state read for columns that may or may not be in the SELECT
  // projection: undefined (not selected), null (selected, NULL value),
  // Date (selected, populated). Mirrors the v0.26.5 deleted_at pattern.
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return new Date(raw as string);
}

export function rowToPage(row: Record<string, unknown>): Page {
  const deletedAt = readOptionalDate(row.deleted_at);
  const effectiveDate = readOptionalDate(row.effective_date);
  const salienceTouchedAt = readOptionalDate(row.salience_touched_at);
  const effectiveDateSource = row.effective_date_source as Page['effective_date_source'] | undefined;
  const importFilename = row.import_filename as string | null | undefined;
  // v0.39.3.0 CV5 — three-state read for provenance columns. Matches the
  // v0.26.5 deleted_at pattern: undefined when the SELECT projection didn't
  // include the column (older code paths); null when the column is NULL
  // (historical pre-v0.38 row); populated when v0.38+ ingestion stamped it.
  const sourceKind = row.source_kind === undefined ? undefined : (row.source_kind as string | null);
  const sourceUri = row.source_uri === undefined ? undefined : (row.source_uri as string | null);
  const ingestedVia = row.ingested_via === undefined ? undefined : (row.ingested_via as string | null);
  const ingestedAt = readOptionalDate(row.ingested_at);
  return {
    id: row.id as number,
    slug: row.slug as string,
    type: row.type as string,
    title: row.title as string,
    compiled_truth: row.compiled_truth as string,
    timeline: row.timeline as string,
    frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown>,
    content_hash: row.content_hash as string | undefined,
    // v0.29 (column added in migration v40). Old brains pre-migration return undefined.
    emotional_weight: row.emotional_weight == null ? undefined : Number(row.emotional_weight),
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
    ...(deletedAt !== undefined && { deleted_at: deletedAt }),
    // v0.29.1 (columns added in migration v41). Optional in SELECT projection.
    ...(effectiveDate !== undefined && { effective_date: effectiveDate }),
    ...(effectiveDateSource !== undefined && { effective_date_source: effectiveDateSource }),
    ...(importFilename !== undefined && { import_filename: importFilename }),
    ...(salienceTouchedAt !== undefined && { salience_touched_at: salienceTouchedAt }),
    // v0.39.3.0 (columns added in migration v81 — WARN-8 + CV5). Three-state
    // optional read; absent SELECT projections compile unchanged.
    ...(sourceKind !== undefined && { source_kind: sourceKind }),
    ...(sourceUri !== undefined && { source_uri: sourceUri }),
    ...(ingestedVia !== undefined && { ingested_via: ingestedVia }),
    ...(ingestedAt !== undefined && { ingested_at: ingestedAt }),
    // v0.31.12: propagate source_id so downstream callers (embed, reconcile-links)
    // can thread it through getChunks / upsertChunks without defaulting to 'default'.
    // v0.32.8: Page.source_id is required. Every SELECT feeding rowToPage now
    // projects the column (enforced by scripts/check-source-id-projection.sh).
    // Fail-loud default to 'default' if the row genuinely lacks it (would mean
    // an upstream caller bypassed the projection check; better to surface than
    // silently mis-attribute).
    source_id: (row.source_id as string | undefined) ?? 'default',
  };
}

/**
 * v0.42.7 (#1696) — map a DB row to a StalePageRow for the extraction
 * freshness sweep. Shared by both engines so frontmatter JSONB parsing can't
 * drift. Mirrors rowToPage's `typeof === 'string' ? JSON.parse` idiom; tolerates
 * NULL compiled_truth/timeline/frontmatter (empty-string / {} fallback).
 */
export function rowToStalePage(row: Record<string, unknown>): StalePageRow {
  const fm = row.frontmatter;
  return {
    id: row.id as number,
    slug: row.slug as string,
    source_id: (row.source_id as string | undefined) ?? 'default',
    type: row.type as string,
    title: (row.title as string | null) ?? '',
    compiled_truth: (row.compiled_truth as string | null) ?? '',
    timeline: (row.timeline as string | null) ?? '',
    frontmatter: (fm == null ? {} : (typeof fm === 'string' ? JSON.parse(fm) : fm)) as Record<string, unknown>,
    updated_at: new Date(row.updated_at as string),
    // #1768: full-µs UTC string projected by the SELECT (`updated_at_iso`).
    // Fallback derives an ISO string from the Date — NEVER String(Date), which
    // yields "Mon Jun 02 2026 …" that `::timestamptz` misparses. Pre-#1768
    // callers that don't project the column still get a valid (ms) ISO value.
    updated_at_iso: row.updated_at_iso != null
      ? String(row.updated_at_iso)
      : new Date(row.updated_at as string).toISOString(),
  };
}

/**
 * Normalize an embedding value into a Float32Array.
 *
 * pgvector returns embeddings in different shapes depending on driver/path:
 *   - postgres.js (Postgres): often a string like `"[0.1,0.2,...]"`
 *   - pglite: typically a numeric array or Float32Array
 *   - pgvector node binding: numeric array
 *   - Some queries that JSON-aggregate embeddings: JSON-string array
 *
 * Without normalization, downstream cosine math sees a string and produces
 * NaN scores silently. This helper guarantees a Float32Array or throws
 * loudly on malformed input — never returns NaN.
 */
export function parseEmbedding(value: unknown): Float32Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return new Float32Array(0);
    if (typeof value[0] !== 'number') {
      throw new Error(`parseEmbedding: array contains non-numeric element (${typeof value[0]})`);
    }
    return Float32Array.from(value as number[]);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Plain non-vector strings: treat as "no embedding here", return null.
    // Strings that LOOK like vector literals but contain garbage: throw,
    // because that's a real corruption signal worth surfacing loudly.
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return new Float32Array(0);
    const parts = inner.split(',');
    const out = new Float32Array(parts.length);
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i].trim());
      if (!Number.isFinite(n)) {
        throw new Error(`parseEmbedding: non-finite value at index ${i}: ${parts[i]}`);
      }
      out[i] = n;
    }
    return out;
  }
  return null;
}

/**
 * Detect a Postgres "undefined column" error (SQLSTATE 42703) without depending
 * on the postgres.js driver-specific error class.
 *
 * Used for forward-compat probes — code that does `SELECT foo FROM bar` against
 * schemas where `foo` may not exist yet on legacy installs (column was added in
 * a later migration). Bare `try { ... } catch {}` swallows EVERY error
 * (network blips, lock timeouts, auth failures) which masks real bugs as
 * "column missing." This predicate keeps the probe narrow.
 *
 * Matches on either:
 *   - SQLSTATE code `42703` (postgres.js sets this on the error)
 *   - the column name appearing in the message alongside a "does not exist" /
 *     "no such column" / "undefined column" clause (PGLite + various driver
 *     wraps)
 *
 * Anything else falls through and the caller MUST re-throw.
 */
export function isUndefinedColumnError(error: unknown, column: string): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === '42703') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(column) && /does not exist|no such column|undefined column/i.test(message);
}

/**
 * v0.42 (T1 sibling): undefined-table predicate for defense-in-depth on
 * pre-migration brains. Matches SQLSTATE `42P01` (postgres) plus the common
 * "relation ... does not exist" / "no such table" message variants (PGLite +
 * driver-wrapped paths). Use on read paths where a missing table should
 * degrade to "no rows" rather than crash (e.g. resolveSlugWithAlias on
 * pre-v104 brains, dangling_aliases doctor check on pre-v104 brains).
 *
 * Anything else falls through and caller MUST re-throw.
 */
export function isUndefinedTableError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === '42P01') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /relation .* does not exist|no such table|undefined table/i.test(message);
}

const _warnedKeys = new Set<string>();

/**
 * v0.42 (T2): emit a stderr warning at most once per process-key. Used by
 * `resolveSlugWithAlias` to surface multi-source alias ambiguity without
 * spamming hot paths.
 *
 * Test seam: `_resetWarnOnceForTests()` clears the set so per-process
 * warn-once contracts can be reasserted across test cases.
 */
export function warnOncePerProcess(key: string, message: string): void {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  console.warn(message);
}

/** @internal test seam */
export function _resetWarnOnceForTests(): void {
  _warnedKeys.clear();
}

let _tryParseEmbeddingWarned = false;

/**
 * Availability-path sibling of parseEmbedding(). Returns null + warns once
 * on any shape parseEmbedding would throw on. Use this on read/rescore paths
 * where one corrupt row should degrade ranking, not kill the whole query.
 * Use parseEmbedding() (throws) on ingest/migrate paths where silent skips
 * would be data loss.
 */
export function tryParseEmbedding(value: unknown): Float32Array | null {
  try {
    return parseEmbedding(value);
  } catch (err) {
    if (!_tryParseEmbeddingWarned) {
      _tryParseEmbeddingWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`tryParseEmbedding: skipping corrupt embedding row (${msg}). Further warnings suppressed this session.`);
    }
    return null;
  }
}

export function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline' | 'fenced_code',
    embedding: includeEmbedding ? parseEmbedding(row.embedding) : null,
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
    // v0.19.0 code-chunk metadata (nullable for markdown chunks).
    language: (row.language as string | null | undefined) ?? null,
    symbol_name: (row.symbol_name as string | null | undefined) ?? null,
    symbol_type: (row.symbol_type as string | null | undefined) ?? null,
    start_line: (row.start_line as number | null | undefined) ?? null,
    end_line: (row.end_line as number | null | undefined) ?? null,
    // v0.20.0 Cathedral II Layer 1 additions (nullable for markdown chunks).
    parent_symbol_path: (row.parent_symbol_path as string[] | null | undefined) ?? null,
    doc_comment: (row.doc_comment as string | null | undefined) ?? null,
    symbol_name_qualified: (row.symbol_name_qualified as string | null | undefined) ?? null,
  };
}

export function rowToSearchResult(row: Record<string, unknown>): SearchResult {
  const result: SearchResult = {
    slug: row.slug as string,
    page_id: row.page_id as number,
    title: row.title as string,
    type: row.type as string,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
    chunk_id: row.chunk_id as number,
    chunk_index: row.chunk_index as number,
    score: Number(row.score),
    stale: Boolean(row.stale),
  };
  // v0.17.0: source_id comes from the p.source_id column in search
  // SELECTs. Keep the field optional so pre-v0.17 engines that didn't
  // join sources don't crash on the absent column — rowToSearchResult
  // is shared by both paths.
  if (typeof row.source_id === 'string') {
    result.source_id = row.source_id;
  }
  // v0.34: effective_date / effective_date_source carried through from the
  // pages join. Same three-state read as readOptionalDate elsewhere: the
  // field is left UNTOUCHED when the column isn't in the projection (so
  // legacy callers see undefined), set to null when the column was selected
  // but the page row has no date, and to YYYY-MM-DD when populated. Postgres
  // returns Date objects via postgres.js; PGLite returns strings. Normalize
  // to date-only ISO so downstream prompt-builders don't see noise from
  // midnight-UTC timestamps.
  if ('effective_date' in row) {
    const raw = row.effective_date;
    if (raw === null) {
      result.effective_date = null;
    } else if (raw instanceof Date) {
      result.effective_date = raw.toISOString().slice(0, 10);
    } else if (typeof raw === 'string' && raw) {
      // Postgres TIMESTAMPTZ already serializes as "YYYY-MM-DD ..." — slice
      // the date portion. PGLite returns the same shape via its parser.
      result.effective_date = raw.slice(0, 10);
    }
  }
  if ('effective_date_source' in row) {
    const raw = row.effective_date_source;
    if (raw === null) {
      result.effective_date_source = null;
    } else if (typeof raw === 'string' && raw) {
      result.effective_date_source = raw;
    }
  }
  return result;
}

/**
 * Convert a takes-table SQL row (joined with pages.slug AS page_slug) to the
 * `Take` shape. Handles Date → ISO string conversion for timestamp/date columns.
 */
export function takeRowToTake(row: Record<string, unknown>): Take {
  const isoOrNull = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  // since/until_date are TEXT (since v0.28 — DATE was too restrictive for
  // partial dates like '2017-01' that the spec uses).
  const dateOrNull = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v);
  };
  return {
    id: Number(row.id),
    page_id: Number(row.page_id),
    page_slug: String(row.page_slug ?? ''),
    row_num: Number(row.row_num),
    claim: String(row.claim),
    kind: row.kind as string,
    holder: String(row.holder),
    weight: Number(row.weight),
    since_date: dateOrNull(row.since_date),
    until_date: dateOrNull(row.until_date),
    source: row.source == null ? null : String(row.source),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    active: Boolean(row.active),
    resolved_at: isoOrNull(row.resolved_at),
    resolved_outcome: row.resolved_outcome == null ? null : Boolean(row.resolved_outcome),
    resolved_quality: row.resolved_quality == null
      ? null
      : (String(row.resolved_quality) as 'correct' | 'incorrect' | 'partial' | 'unresolvable'),
    resolved_value: row.resolved_value == null ? null : Number(row.resolved_value),
    resolved_unit: row.resolved_unit == null ? null : String(row.resolved_unit),
    resolved_source: row.resolved_source == null ? null : String(row.resolved_source),
    resolved_by: row.resolved_by == null ? null : String(row.resolved_by),
    created_at: isoOrNull(row.created_at) ?? '',
    updated_at: isoOrNull(row.updated_at) ?? '',
  };
}

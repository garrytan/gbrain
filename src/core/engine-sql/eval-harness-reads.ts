/**
 * The harness reads the memory-trust evals (gbrain-evals Cat 37-39) set up and score through, typed so they run on
 * every engine instead of as raw SQL. SQL once for both engines; the Rust engine answers from its store
 * (rust-engine/store-members/eval-harness-reads.ts, rust/crates/gbrain-store/src/eval_harness_reads.rs).
 *
 * These reads are trusted local harness reads: they see every source and every row, private ones included, and are
 * not reachable from an operation.
 */
import type { BrainEngine } from '../engine.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { withoutReadDeadline } from '../read-deadline.ts';
import { withoutRequestSignal } from '../request-signal.ts';
import { engineCacheKey, withStatementDeadline } from '../statement-deadline.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A fact's identity, text and lifecycle: whether and by what it was superseded. */
export interface FactStateRow {
  id: number;
  source_id: string;
  fact: string;
  entity_slug: string | null;
  expired_at: Date | null;
  superseded_by: number | null;
}

/** A page's id and key, a soft-deleted page included. */
export interface PageIdSlugRow { id: number; slug: string; source_id: string; deleted_at: Date | null }

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));
const toId = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const FACTS_BY_IDS_SQL = 'SELECT id, source_id, fact, entity_slug, expired_at, superseded_by FROM facts WHERE id = ANY($1::bigint[]) ORDER BY id';
export const LIVE_FACTS_BY_TEXT_SQL = 'SELECT id, fact FROM facts WHERE source_id = $1 AND fact = ANY($2::text[]) AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) ORDER BY id';
export const PAGE_ID_SLUGS_SQL = 'SELECT id, slug, source_id, deleted_at FROM pages ORDER BY id';

/** The facts with these ids in any source, by id; a missing id answers nothing and a repeated id answers once. */
export async function getFactsByIds(engine: Raw, ids: readonly number[]): Promise<FactStateRow[]> {
  if (!ids.length) return [];
  const rows = await engine.executeRaw<Record<string, unknown>>(FACTS_BY_IDS_SQL, [[...ids]]);
  return rows.map(r => ({
    id: Number(r.id), source_id: String(r.source_id), fact: String(r.fact), entity_slug: (r.entity_slug as string | null) ?? null,
    expired_at: toDate(r.expired_at), superseded_by: toId(r.superseded_by),
  }));
}

/**
 * The live facts of `sourceId` whose text is exactly one of `texts`, by id: not expired and not past their
 * `valid_until` (the active-fact predicate of the fact reads, engine-sql/facts.ts).
 */
export async function findLiveFactsByText(engine: Raw, sourceId: string, texts: readonly string[]): Promise<Array<{ id: number; fact: string }>> {
  if (!texts.length) return [];
  const rows = await engine.executeRaw<{ id: number | string; fact: string }>(LIVE_FACTS_BY_TEXT_SQL, [sourceId, [...texts]]);
  return rows.map(r => ({ id: Number(r.id), fact: r.fact }));
}

/** Every page of every source, a soft-deleted one included, with its id, by id. */
export async function listPageIdSlugs(engine: Raw): Promise<PageIdSlugRow[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(PAGE_ID_SLUGS_SQL);
  return rows.map(r => ({ id: Number(r.id), slug: String(r.slug), source_id: String(r.source_id), deleted_at: toDate(r.deleted_at) }));
}

/** One text-bearing column: text, varchar, json, jsonb or an array of text or varchar. */
export interface TextColumnRow { table: string; column: string; data_type: string; udt_name: string }

/** `scanTextColumns`: a case-insensitive substring over text-bearing columns. */
export interface TextScanSpec {
  /** The text to find; it and each value are lowercased before the match. */
  pattern: string;
  /** Only these tables (every table when absent). */
  tables?: readonly string[];
  /** Leave out an expired row, a deleted row, an inactive take and any row of a deleted page. */
  activeOnly: boolean;
  /** At most this many hits. */
  limit?: number;
}

/**
 * One value that contains the pattern: its table and column, the slug the row is about (its own slug column, a fact's
 * entity or source page, else the page its page_id names), its page id, a fact's entity and the value as text.
 */
export interface TextScanHit { table: string; column: string; slug: string | null; page_id: number | null; entity_slug: string | null; value: string }

export const HAS_TABLE_SQL = 'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1) AS present';
export const HAS_COLUMN_SQL = 'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2) AS present';
export const TEXT_BEARING_COLUMNS_SQL = `SELECT c.table_name AS "table", c.column_name AS "column", c.data_type, c.udt_name
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
      AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb') OR c.udt_name IN ('_text', '_varchar'))
    ORDER BY c.table_name COLLATE "C", c.ordinal_position`;
export const TABLE_COLUMNS_SQL = 'SELECT table_name AS "table", column_name AS "column", data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])';

/** Whether the current schema has a table of that name. */
export async function hasTable(engine: Raw, name: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ present: boolean }>(HAS_TABLE_SQL, [name]);
  return row?.present === true;
}

/** Whether that table of the current schema has a column of that name. */
export async function hasColumn(engine: Raw, table: string, column: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ present: boolean }>(HAS_COLUMN_SQL, [table, column]);
  return row?.present === true;
}

/** Every text-bearing column of every base table of the current schema, by table then column position. */
export async function listTextBearingColumns(engine: Raw): Promise<TextColumnRow[]> {
  return engine.executeRaw<TextColumnRow>(TEXT_BEARING_COLUMNS_SQL);
}

/** A catalog identifier (a table or column name read from information_schema), double-quoted with any double quote doubled. */
export function catalogIdentifierSql(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** What a scanned table carries besides its text columns: its schema and every column (a page_id kept only when it is an integer). */
export interface TextScanTable { schema: string; table: string; text: readonly string[]; all: ReadonlySet<string> }

/** The page a row of the table is about: a page's own id, a wanted link's origin page, else its page_id. */
const scanPageId = (t: TextScanTable): string | null => (t.table === 'pages' ? 'x."id"'
  : t.table === 'wanted_links' && t.all.has('origin_page_id') ? 'x."origin_page_id"' : t.all.has('page_id') ? 'x."page_id"' : null);
const qualified = (t: TextScanTable, table: string): string => `${catalogIdentifierSql(t.schema)}.${catalogIdentifierSql(table)}`;

/** The slug, page id and entity columns of one scanned table's arm (catalog identifiers quoted by catalogIdentifierSql). */
export function catalogScanHeadSql(t: TextScanTable): string {
  const ownSlug = (t.table === 'facts' ? ['entity_slug', 'source_markdown_slug'] : ['slug', 'page_slug', 'entity_slug']).filter(c => t.all.has(c));
  const pageId = scanPageId(t);
  const slugParts = [...ownSlug.map(c => `x.${catalogIdentifierSql(c)}::text`), ...(pageId ? ['p."slug"'] : [])];
  const slug = slugParts.length ? `COALESCE(${slugParts.join(', ')})` : 'NULL::text';
  const entity = t.all.has('entity_slug') ? 'x."entity_slug"::text' : 'NULL::text';
  return `${slug} AS slug, ${pageId ? `${pageId}::bigint` : 'NULL::bigint'} AS page_id, ${entity} AS entity_slug`;
}

/** One scanned column as text (a catalog identifier quoted by catalogIdentifierSql). */
export function catalogScanColumnSql(column: string): string {
  return `x.${catalogIdentifierSql(column)}::text`;
}

/** The schema-qualified table of one arm and the pages join of a table that names a page (none otherwise). */
export function catalogScanJoinSql(t: TextScanTable): string {
  const pageId = scanPageId(t);
  return `${qualified(t, t.table)} x${pageId ? ` LEFT JOIN ${qualified(t, 'pages')} p ON p."id" = ${pageId}` : ''}`;
}

/**
 * The live-row filters of activeOnly: an unexpired, undeleted row, a fact not past its valid_until, an active take, a
 * row of no deleted page (by its page id or a wanted link's origin page, a fence row by its source and
 * source_markdown_slug), and a page alias of a live page by its source and slug (a hard-deleted page leaves its alias
 * rows behind).
 */
export function catalogScanLiveSql(t: TextScanTable, activeOnly: boolean): string {
  if (!activeOnly) return '';
  return [
    t.all.has('expired_at') ? ' AND x."expired_at" IS NULL' : '',
    t.all.has('deleted_at') ? ' AND x."deleted_at" IS NULL' : '',
    t.table === 'facts' && t.all.has('valid_until') ? ' AND (x."valid_until" IS NULL OR x."valid_until" > now())' : '',
    t.table === 'takes' && t.all.has('active') ? ' AND x."active"' : '',
    scanPageId(t) ? ' AND (p."id" IS NULL OR p."deleted_at" IS NULL)' : '',
    t.all.has('source_id') && t.all.has('source_markdown_slug')
      ? ` AND NOT EXISTS (SELECT 1 FROM ${qualified(t, 'pages')} q WHERE q."source_id" = x."source_id" AND q."slug" = x."source_markdown_slug" AND q."deleted_at" IS NOT NULL)`
      : '',
    t.table === 'page_aliases' && t.all.has('source_id') && t.all.has('slug')
      ? ` AND EXISTS (SELECT 1 FROM ${qualified(t, 'pages')} q WHERE q."source_id" = x."source_id" AND q."slug" = x."slug" AND q."deleted_at" IS NULL)`
      : '',
  ].join('');
}

/**
 * The SELECT that scans one table's text columns for `pattern`: one UNION ALL arm per column, each value and the
 * pattern lowercased by the database. Schema, table and column names come from the catalog and are quoted by
 * catalogIdentifierSql; the pattern and the table's and each column's name as values are bound.
 */
export function catalogTextScanSql(t: TextScanTable, activeOnly: boolean, pattern: string): SqlFragment {
  return joinFragments(t.text.map((c) => sqlFragment`SELECT ${t.table}::text AS "table", ${c}::text AS "column", ${trustedSql(catalogScanHeadSql(t))}, ${trustedSql(catalogScanColumnSql(c))} AS value FROM ${trustedSql(catalogScanJoinSql(t))} WHERE strpos(lower(${trustedSql(catalogScanColumnSql(c))}), lower(${pattern}::text)) > 0${trustedSql(catalogScanLiveSql(t, activeOnly))}`), ' UNION ALL ');
}

/**
 * The current schema, and the tables of it the running role cannot read in full (no SELECT, or row security applies),
 * among every base table with a text-bearing column (only those named in $1 when it is not null) and pages. A column
 * of a domain counts by the domain's base type, as information_schema's data_type reads it. It reads pg_catalog,
 * which lists every table whatever the role's privileges; information_schema hides a table the role has no privilege
 * on.
 */
export const SCAN_VISIBILITY_SQL = `SELECT current_schema()::text AS schema,
      COALESCE(array_agg(c.relname::text ORDER BY c.relname::text COLLATE "C") FILTER (WHERE NOT pg_catalog.has_table_privilege(c.oid, 'SELECT') OR pg_catalog.row_security_active(c.oid)), '{}') AS hidden
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      AND (c.relname = 'pages' OR (($1::text[] IS NULL OR c.relname = ANY($1::text[]))
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          AND (CASE WHEN ty.typtype = 'd' THEN ty.typbasetype ELSE a.atttypid END)
            IN ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype, 'varchar[]'::regtype))))`;

/**
 * The scan's hit order: table, column and value, then the slug, page id and entity a tie of equal values is about, each
 * in UTF-8 byte order with a missing one first (the Rust store sorts the same way), so a limit keeps the same hits on
 * every engine.
 */
export const SCAN_ORDER_SQL = `convert_to(hit."table", 'UTF8'), convert_to(hit."column", 'UTF8'), convert_to(hit.value, 'UTF8'), `
  + `convert_to(hit.slug, 'UTF8') NULLS FIRST, hit.page_id NULLS FIRST, convert_to(hit.entity_slug, 'UTF8') NULLS FIRST`;

/** A limit the scan accepts: absent, or a whole number of zero or more. */
export function assertScanLimit(limit: number | undefined): void {
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit >= 0)) throw new Error('scanTextColumns: a limit that is not a whole number');
}

/**
 * Each value of a text-bearing column that contains the pattern (case-insensitive), in SCAN_ORDER_SQL order (table,
 * column, value, then the slug, page id and entity of a tie), at most `limit`. One statement reads every table, so it sees one snapshot and the database keeps
 * only `limit` hits. Refuses first, naming them, when the running role cannot read a table it would scan in full: an
 * empty answer from a table it cannot see would read as "the text is gone".
 */
export async function scanTextColumns(engine: Raw, spec: TextScanSpec): Promise<TextScanHit[]> {
  if (!spec.pattern) throw new Error('scanTextColumns: the pattern is empty');
  assertScanLimit(spec.limit);
  const [seen] = await engine.executeRaw<{ schema: string; hidden: string[] }>(SCAN_VISIBILITY_SQL, [spec.tables ? [...spec.tables] : null]);
  if (seen?.hidden.length) {
    throw new Error(`scanTextColumns: the running role cannot read every row of ${seen.hidden.join(', ')}; run the scan as the table owner or a BYPASSRLS role`);
  }
  const wanted = spec.tables ? new Set(spec.tables) : null;
  const byTable = new Map<string, string[]>();
  for (const c of await listTextBearingColumns(engine)) {
    if (wanted && !wanted.has(c.table)) continue;
    byTable.set(c.table, [...(byTable.get(c.table) ?? []), c.column]);
  }
  if (!byTable.size) return [];
  const all = new Map<string, Set<string>>();
  for (const r of await engine.executeRaw<{ table: string; column: string; data_type: string }>(TABLE_COLUMNS_SQL, [[...byTable.keys()]])) {
    if (r.column === 'page_id' && !['bigint', 'integer', 'smallint'].includes(r.data_type)) continue;
    all.set(r.table, (all.get(r.table) ?? new Set<string>()).add(r.column));
  }
  const schema = seen!.schema;
  const arms = joinFragments([...byTable].map(([table, text]) => catalogTextScanSql({ schema, table, text, all: all.get(table) ?? new Set() }, spec.activeOnly, spec.pattern)), ' UNION ALL ');
  const limit = spec.limit === undefined ? sqlFragment`` : sqlFragment` LIMIT ${spec.limit}`;
  const { text: sql, params } = renderFragment(sqlFragment`SELECT * FROM (${arms}) hit ORDER BY ${trustedSql(SCAN_ORDER_SQL)}${limit}`);
  const rows = await engine.executeRaw<Record<string, unknown>>(sql, params);
  return rows.map(r => ({ table: String(r.table), column: String(r.column), slug: (r.slug as string | null) ?? null, page_id: toId(r.page_id),
    entity_slug: (r.entity_slug as string | null) ?? null, value: String(r.value) }));
}

/**
 * The brain row's managed state before a harness pause: `enabled`, `mode_epoch` and the count of recorded brain-wide
 * topology changes (`source_id = '*'`), each as text. A change to one source (a source add, claim, removal or a
 * company-brain connect) does not change the brain's own state, so it is not counted. The count is named
 * `brain_topology_changes`: a pause token from an older gbrain holds `topology_changes`, a count of every change, which
 * the restore cannot compare, so it refuses that token (see assertCurrentPauseToken).
 */
export interface ManagedPausePrior { enabled: boolean; mode_epoch: string; brain_topology_changes: string }

/** The code of the refusal of a pause token whose count the restore cannot compare. */
export const PAUSE_TOKEN_OUTDATED = 'managed_pause_token_outdated';

/**
 * Refuses, before anything is written, a pause token with no `brain_topology_changes`: one an older gbrain took (an
 * owner upgrade between the pause and the restore). Its `topology_changes` counted every topology change, so after a
 * brain-wide deactivation it can equal the brain-wide count and the compare-and-set would turn the brain back on. The
 * brain stays paused (enabled=false); `gbrain sources writer activate` turns it back on.
 */
export function assertCurrentPauseToken(prior: ManagedPausePrior): void {
  if (typeof (prior as { brain_topology_changes?: unknown }).brain_topology_changes === 'string') return;
  throw Object.assign(new Error('restoreManagedPersistence: this pause token was taken by an older gbrain, which counted every '
    + 'topology change, so the restore cannot tell whether this brain changed during the pause; managed persistence stays off. '
    + 'Run `gbrain sources writer activate` to turn it back on.'), { code: PAUSE_TOKEN_OUTDATED });
}

/** What withManagedPersistencePaused reports: fn's result and whether the prior state was put back. */
export interface ManagedPauseOutcome<T> { result: T; restore: 'restored' | 'paused_state_changed' }

/** Reads the brain row's enabled, mode_epoch and brain-wide topology change count and turns enabled off in one statement, moving nothing else. */
export const PAUSE_MANAGED_SQL = `WITH prior AS (SELECT enabled, mode_epoch, (SELECT count(*) FROM persistence_topology_changes WHERE source_id = '*') AS topology_changes
        FROM persistence_brain WHERE singleton = 1 FOR UPDATE),
      paused AS (UPDATE persistence_brain SET enabled = false WHERE singleton = 1)
    SELECT enabled, mode_epoch::text AS mode_epoch, topology_changes::text AS brain_topology_changes FROM prior`;
/**
 * Puts `enabled` back only while the row is still paused at the epoch the pause read and no brain-wide topology change
 * was recorded since (compare-and-set). A deactivation of a disabled brain releases its claims without moving the
 * epoch, but it records a brain-wide topology change.
 */
export const RESTORE_MANAGED_SQL = `UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1 AND enabled = false AND mode_epoch = $2::bigint
      AND (SELECT count(*) FROM persistence_topology_changes WHERE source_id = '*') = $3::bigint RETURNING true AS restored`;

/** Takes the brain row's lock, so the statement after it sees every topology change committed before it. */
export const LOCK_BRAIN_SQL = 'SELECT 1 FROM persistence_brain WHERE singleton = 1 FOR UPDATE';

/**
 * Turns managed persistence off with no mode_epoch bump; returns the prior state. Refuses a brain with no brain row.
 * One transaction: the brain row lock first, then the pause in a later statement, whose snapshot then counts a
 * deactivation that held the lock (a statement's snapshot is taken before it waits for a lock).
 */
export async function pauseManagedPersistence(engine: Pick<BrainEngine, 'transaction'>): Promise<ManagedPausePrior> {
  const [row] = await engine.transaction(async tx => {
    await tx.executeRaw(LOCK_BRAIN_SQL);
    return tx.executeRaw<{ enabled: boolean; mode_epoch: string; brain_topology_changes: string }>(PAUSE_MANAGED_SQL);
  });
  if (!row) throw new Error('pauseManagedPersistence: this brain has no persistence brain row');
  return { enabled: row.enabled === true, mode_epoch: String(row.mode_epoch), brain_topology_changes: String(row.brain_topology_changes) };
}

/**
 * Puts the prior enabled value back when nothing moved during the pause; false (nothing written) otherwise. One
 * transaction: the brain row lock first, then the compare-and-set in a later statement, whose snapshot then includes a
 * deactivation that held the lock (a statement's snapshot is taken before it waits for a lock).
 */
export async function restoreManagedPersistence(engine: Pick<BrainEngine, 'transaction'>, prior: ManagedPausePrior): Promise<boolean> {
  assertCurrentPauseToken(prior);
  return engine.transaction(async tx => {
    await tx.executeRaw(LOCK_BRAIN_SQL);
    const rows = await tx.executeRaw<{ restored: boolean }>(RESTORE_MANAGED_SQL, [prior.enabled, prior.mode_epoch, prior.brain_topology_changes]);
    return rows.length > 0;
  });
}

/** The message of the error thrown when fn failed and the restore failed too, and fn's error cannot carry the restore error. */
export const PAUSE_BOTH_FAILED = 'withManagedPersistencePaused: fn failed and the restore failed; the brain may still be paused';

/**
 * The error to throw when fn threw `error` and the restore threw `restoreError`: fn's error with `restoreError`
 * attached when it is an object that takes the property, else an AggregateError of both (also with `restoreError`),
 * so neither error hides the other.
 */
function withRestoreError(error: unknown, restoreError: unknown): unknown {
  if (error && typeof error === 'object') {
    try {
      Object.assign(error, { restoreError });
      if ((error as { restoreError?: unknown }).restoreError === restoreError) return error;
    } catch { /* a frozen or non-extensible error: fall through to the AggregateError */ }
  }
  return Object.assign(new AggregateError([error, restoreError], PAUSE_BOTH_FAILED), { restoreError });
}

/** The engines (in this process) that hold a harness pause now. */
const pausesHeld = new WeakSet<object>();

/**
 * The restore on the engine itself (not a deadline wrapper), outside the request's abort signal and the read and
 * statement deadlines: a cancelled request or a callback that outlasted its deadline must not leave the brain paused.
 */
const restoreUncancelled = (engine: Pick<BrainEngine, 'restoreManagedPersistence'>, prior: ManagedPausePrior) => {
  const real = engineCacheKey(engine) as Pick<BrainEngine, 'restoreManagedPersistence'>;
  return withoutRequestSignal(() => withoutReadDeadline(() => withStatementDeadline(null, () => real.restoreManagedPersistence(prior))));
};

/**
 * Runs `fn` with managed persistence paused (a harness step such as one import), on any engine: pause with no
 * mode_epoch bump, run fn, then compare-and-set the prior enabled value back. An activation or deactivation that ran
 * during fn moved the epoch or recorded a brain-wide topology change, so it is kept and the outcome reports
 * paused_state_changed; a change to one source only is not, so the brain is restored. When fn throws, the restore still
 * runs and fn's error is rethrown; a failed restore is attached to it as `restoreError`, or, when fn's error cannot
 * take the property (not an object, or frozen), an AggregateError of both is thrown instead.
 * The restore runs outside the request's abort signal and the read and statement deadlines.
 *
 * Contract: this is the eval harness's hook only, one pause at a time per brain. A second pause on the same engine
 * object while one is held is refused (`managed_pause_held`); nothing records a pause, so pauses through two engine
 * objects or two processes are not seen. A pause whose process dies before the restore leaves the brain at
 * enabled=false at the same epoch; `gbrain sources writer activate` turns it back on (and moves the epoch).
 */
export async function withManagedPersistencePaused<T>(
  engine: Pick<BrainEngine, 'pauseManagedPersistence' | 'restoreManagedPersistence'>, fn: () => Promise<T>,
): Promise<ManagedPauseOutcome<T>> {
  const key = engineCacheKey(engine);
  if (pausesHeld.has(key)) {
    throw Object.assign(new Error('withManagedPersistencePaused: this brain already holds a harness pause; pauses do not nest'), { code: 'managed_pause_held' });
  }
  pausesHeld.add(key);
  try {
    const prior = await engine.pauseManagedPersistence();
    let result: T;
    try {
      result = await fn();
    } catch (error) {
      // try/catch, not .catch(): a restore that throws before it returns a promise must not hide fn's error.
      try {
        await restoreUncancelled(engine, prior);
      } catch (restoreError) {
        throw withRestoreError(error, restoreError);
      }
      throw error;
    }
    const restored = await restoreUncancelled(engine, prior);
    return { result, restore: restored ? 'restored' : 'paused_state_changed' };
  } finally {
    pausesHeld.delete(key);
  }
}

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
export const LIVE_FACTS_BY_TEXT_SQL = 'SELECT id, fact FROM facts WHERE source_id = $1 AND fact = ANY($2::text[]) AND expired_at IS NULL ORDER BY id';
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

/** The live (unexpired) facts of `sourceId` whose text is exactly one of `texts`, by id. */
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
  /** The text to find; lowercased before the match. */
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
export const TABLE_COLUMNS_SQL = 'SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1::text[])';

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

/** What a scanned table carries besides its text columns. */
export interface TextScanTable { table: string; text: readonly string[]; all: ReadonlySet<string> }

const scanPageId = (t: TextScanTable): string | null => (t.table === 'pages' ? 'x."id"' : t.all.has('page_id') ? 'x."page_id"' : null);

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

/** The pages join of a table that names a page (none otherwise). */
export function catalogScanJoinSql(t: TextScanTable): string {
  const pageId = scanPageId(t);
  return pageId ? ` LEFT JOIN "pages" p ON p."id" = ${pageId}` : '';
}

/** The live-row filters of activeOnly: an unexpired, undeleted row, an active take, a row of no deleted page. */
export function catalogScanLiveSql(t: TextScanTable, activeOnly: boolean): string {
  if (!activeOnly) return '';
  return [
    t.all.has('expired_at') ? ' AND x."expired_at" IS NULL' : '',
    t.all.has('deleted_at') ? ' AND x."deleted_at" IS NULL' : '',
    t.table === 'takes' && t.all.has('active') ? ' AND x."active"' : '',
    scanPageId(t) ? ' AND (p."id" IS NULL OR p."deleted_at" IS NULL)' : '',
  ].join('');
}

/**
 * The SELECT that scans one table's text columns for `pattern` (already lowercased): one UNION ALL arm per column.
 * Table and column names come from the catalog and are quoted by catalogIdentifierSql; the pattern and each column's
 * name as a value are bound.
 */
export function catalogTextScanSql(t: TextScanTable, activeOnly: boolean, pattern: string): SqlFragment {
  return joinFragments(t.text.map((c) => sqlFragment`SELECT ${c}::text AS "column", ${trustedSql(catalogScanHeadSql(t))}, ${trustedSql(catalogScanColumnSql(c))} AS value FROM ${trustedSql(catalogIdentifierSql(t.table))} x${trustedSql(catalogScanJoinSql(t))} WHERE strpos(lower(${trustedSql(catalogScanColumnSql(c))}), ${pattern}) > 0${trustedSql(catalogScanLiveSql(t, activeOnly))}`), ' UNION ALL ');
}

/** Each value of a text-bearing column that contains the pattern (case-insensitive), by table, column and value. */
export async function scanTextColumns(engine: Raw, spec: TextScanSpec): Promise<TextScanHit[]> {
  const pattern = spec.pattern.toLowerCase();
  if (!pattern) throw new Error('scanTextColumns: the pattern is empty');
  const wanted = spec.tables ? new Set(spec.tables) : null;
  const byTable = new Map<string, string[]>();
  for (const c of await listTextBearingColumns(engine)) {
    if (wanted && !wanted.has(c.table)) continue;
    byTable.set(c.table, [...(byTable.get(c.table) ?? []), c.column]);
  }
  const all = new Map<string, Set<string>>();
  for (const r of await engine.executeRaw<{ table: string; column: string }>(TABLE_COLUMNS_SQL, [[...byTable.keys()]])) {
    all.set(r.table, (all.get(r.table) ?? new Set<string>()).add(r.column));
  }
  const hits: TextScanHit[] = [];
  for (const [table, text] of byTable) {
    const { text: sql, params } = renderFragment(catalogTextScanSql({ table, text, all: all.get(table) ?? new Set() }, spec.activeOnly, pattern));
    const rows = await engine.executeRaw<Record<string, unknown>>(sql, params);
    for (const r of rows) {
      hits.push({ table, column: String(r.column), slug: (r.slug as string | null) ?? null, page_id: toId(r.page_id),
        entity_slug: (r.entity_slug as string | null) ?? null, value: String(r.value) });
    }
  }
  hits.sort((a, b) => cmp(a.table, b.table) || cmp(a.column, b.column) || cmp(a.value, b.value));
  return spec.limit === undefined ? hits : hits.slice(0, spec.limit);
}

/** Byte order on the UTF-16 code units, as the Rust store sorts its UTF-8 (equal for the ASCII names it sorts). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The brain row's managed state before a harness pause: `enabled` and `mode_epoch` (text). */
export interface ManagedPausePrior { enabled: boolean; mode_epoch: string }

/** What withManagedPersistencePaused reports: fn's result and whether the prior state was put back. */
export interface ManagedPauseOutcome<T> { result: T; restore: 'restored' | 'paused_state_changed' }

/** Reads the brain row's enabled and mode_epoch and turns enabled off in one statement, moving nothing else. */
export const PAUSE_MANAGED_SQL = `WITH prior AS (SELECT enabled, mode_epoch FROM persistence_brain WHERE singleton = 1 FOR UPDATE),
      paused AS (UPDATE persistence_brain SET enabled = false WHERE singleton = 1)
    SELECT enabled, mode_epoch::text AS mode_epoch FROM prior`;
/** Puts `enabled` back only while the row is still paused at the epoch the pause read (compare-and-set). */
export const RESTORE_MANAGED_SQL = 'UPDATE persistence_brain SET enabled = $1 WHERE singleton = 1 AND enabled = false AND mode_epoch = $2::bigint RETURNING true AS restored';

/** Turns managed persistence off with no mode_epoch bump; returns the prior state. Refuses a brain with no brain row. */
export async function pauseManagedPersistence(engine: Raw): Promise<ManagedPausePrior> {
  const [row] = await engine.executeRaw<{ enabled: boolean; mode_epoch: string }>(PAUSE_MANAGED_SQL);
  if (!row) throw new Error('pauseManagedPersistence: this brain has no persistence brain row');
  return { enabled: row.enabled === true, mode_epoch: String(row.mode_epoch) };
}

/** Puts the prior enabled value back when the row is still paused at the prior epoch; false (nothing written) otherwise. */
export async function restoreManagedPersistence(engine: Raw, prior: ManagedPausePrior): Promise<boolean> {
  const rows = await engine.executeRaw<{ restored: boolean }>(RESTORE_MANAGED_SQL, [prior.enabled, prior.mode_epoch]);
  return rows.length > 0;
}

/**
 * Runs `fn` with managed persistence paused (a harness step such as one import), on any engine: pause with no
 * mode_epoch bump, run fn, then compare-and-set the prior enabled value back. A real activation or deactivation that
 * ran during fn moved the epoch, so it is kept and the outcome reports paused_state_changed. When fn throws, the restore
 * still runs and fn's error is rethrown.
 */
export async function withManagedPersistencePaused<T>(
  engine: Pick<BrainEngine, 'pauseManagedPersistence' | 'restoreManagedPersistence'>, fn: () => Promise<T>,
): Promise<ManagedPauseOutcome<T>> {
  const prior = await engine.pauseManagedPersistence();
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await engine.restoreManagedPersistence(prior);
    throw error;
  }
  const restored = await engine.restoreManagedPersistence(prior);
  return { result, restore: restored ? 'restored' : 'paused_state_changed' };
}

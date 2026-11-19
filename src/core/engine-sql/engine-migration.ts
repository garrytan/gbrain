/**
 * The source-side reads of `gbrain migrate --to <engine>` (src/commands/migrate-engine.ts): the write history the legacy
 * copier refuses to discard, the table rows it copies verbatim, a page's origin and provenance columns, its manual
 * dated link statements, and the live timeline count the verify step compares. SQL once for both engines; a Rust brain
 * answers the same members from its store (rust/docs/store/engine-migration.md), so a Rust brain can be the source of a
 * migration. The target is always PGLite or Postgres and keeps its own statements in the copier.
 *
 * Each read is the statement the copier ran through `executeRaw`, with the ties it left to the planner broken
 * bytewise (`COLLATE "C"`, the order a Rust store sorts in).
 */
import type { BrainEngine } from '../engine.ts';
import type { EffectiveDateSource, PageKind } from '../types.ts';
import { isMissingSchemaObject } from '../utils.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The four write-history tables, in the order the refusal names them. */
export const ENGINE_MIGRATION_HISTORY_TABLES = ['belief_events', 'persistence_requests', 'fact_withdrawals', 'persistence_worktrees'] as const;

/** One constant statement per history table: whether it holds any row. */
const HISTORY_EXISTS_SQL = {
  belief_events: 'SELECT EXISTS(SELECT 1 FROM belief_events) AS present',
  persistence_requests: 'SELECT EXISTS(SELECT 1 FROM persistence_requests) AS present',
  fact_withdrawals: 'SELECT EXISTS(SELECT 1 FROM fact_withdrawals) AS present',
  persistence_worktrees: 'SELECT EXISTS(SELECT 1 FROM persistence_worktrees) AS present',
} as const;

/** What `readEngineMigrationHistory` answers. */
export interface EngineMigrationHistory {
  /** The history tables (of `ENGINE_MIGRATION_HISTORY_TABLES`, in that order) that hold at least one row. */
  held: string[];
  /** Rows of `page_versions` (0 when the schema predates it). */
  pageVersions: number;
}

/**
 * The write history a copy would discard. A source schema can predate any of these tables, so a missing table counts
 * as empty; no other database failure is read as an empty history.
 */
export async function readEngineMigrationHistory(exec: Raw): Promise<EngineMigrationHistory> {
  const present = await exec.executeRaw<{ name: string }>(
    'SELECT name FROM unnest($1::text[]) AS t(name) WHERE to_regclass(name) IS NOT NULL', [[...ENGINE_MIGRATION_HISTORY_TABLES]]);
  const held: string[] = [];
  for (const table of ENGINE_MIGRATION_HISTORY_TABLES) {
    if (!present.some(row => row.name === table)) continue;
    const [row] = await exec.executeRaw<{ present: boolean }>(HISTORY_EXISTS_SQL[table]);
    if (row?.present) held.push(table);
  }
  const [versions] = await exec.executeRaw<{ n: number | null }>(
    "SELECT CASE WHEN to_regclass('page_versions') IS NULL THEN 0 ELSE (SELECT count(*)::int FROM page_versions) END AS n");
  return { held, pageVersions: Number(versions?.n ?? 0) };
}

/** The tables the copier reads whole. */
export type MigrationTable = 'sources' | 'facts' | 'open_loops' | 'loop_suppressions';

/** A table's rows: `columns` names every key of each row, in the table's column order. */
export interface MigrationRows { columns: string[]; rows: Array<Record<string, unknown>> }

/** The `sources` columns the copier carries; `config_json` is `config` as JSON text. */
export const MIGRATION_SOURCE_COLUMNS = [
  'id', 'name', 'local_path', 'last_commit', 'last_sync_at', 'config_json', 'archived', 'archived_at', 'archive_expires_at',
  'contextual_retrieval_mode', 'trust_frontmatter_overrides', 'newest_content_at', 'created_at',
] as const;

const TEXT_COLUMN = '__gbrain_migration_text';

/**
 * The whole-table reads, one constant statement each. `t.*` keeps the schema's own column set, so an older source
 * schema still copies; where the table has a column read as text (a vector parses into `vector` and `halfvec` alike,
 * JSON into `jsonb`), `withText` also returns it as `TEXT_COLUMN`, which replaces the column in each row.
 */
const ROWS_SQL = {
  facts: { column: 'embedding', plain: 'SELECT t.* FROM facts t ORDER BY id',
    withText: 'SELECT t.*, t.embedding::text AS __gbrain_migration_text FROM facts t ORDER BY id' },
  open_loops: { column: 'evidence', plain: 'SELECT t.* FROM open_loops t ORDER BY id',
    withText: 'SELECT t.*, t.evidence::text AS __gbrain_migration_text FROM open_loops t ORDER BY id' },
  loop_suppressions: { column: null, plain: 'SELECT t.* FROM loop_suppressions t ORDER BY id', withText: null },
} as const;

/**
 * Every row of `table` by id (`sources`: `default` first, then by id), or null when the schema has no such table.
 * `facts`, `open_loops` and `loop_suppressions` carry every column the schema has, so an older source schema still
 * copies; `facts.embedding` and `open_loops.evidence` read as text.
 */
export async function readMigrationRows(exec: Raw, table: MigrationTable): Promise<MigrationRows | null> {
  if (table === 'sources') {
    const rows = await exec.executeRaw<Record<string, unknown>>(`
    SELECT id, name, local_path, last_commit, last_sync_at, config::text AS config_json, archived,
           archived_at, archive_expires_at, contextual_retrieval_mode,
           trust_frontmatter_overrides, newest_content_at, created_at
      FROM sources
     ORDER BY (id = 'default') DESC, id COLLATE "C"`);
    return { columns: [...MIGRATION_SOURCE_COLUMNS], rows };
  }
  const columns = (await exec.executeRaw<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
      ORDER BY ordinal_position`, [table])).map(r => r.column_name);
  if (columns.length === 0) return null;
  const read = ROWS_SQL[table];
  if (read.column === null || read.withText === null || !columns.includes(read.column)) {
    return { columns, rows: await exec.executeRaw<Record<string, unknown>>(read.plain) };
  }
  const column = read.column;
  const rows = (await exec.executeRaw<Record<string, unknown>>(read.withText)).map(row => {
    const { [TEXT_COLUMN]: text, ...rest } = row;
    return { ...rest, [column]: text };
  });
  return { columns, rows };
}

/** A page's origin, kind and provenance columns, which `Page` does not carry, and whether its projection is sealed. */
export interface MigrationPageColumns {
  page_kind: PageKind | null; source_path: string | null; effective_date: Date | string | null; effective_date_source: EffectiveDateSource | null;
  import_filename: string | null; source_kind: string | null; source_uri: string | null; ingested_via: string | null; ingested_at: Date | string | null;
  /** The text projection is at the knowledge revision. */
  sealed: boolean;
}

/** The page's migration columns in any deletion state, or null for no such page. */
export async function readMigrationPageColumns(exec: Raw, slug: string, sourceId: string): Promise<MigrationPageColumns | null> {
  const [row] = await exec.executeRaw<MigrationPageColumns>(
    `SELECT page_kind,source_path,effective_date,effective_date_source,import_filename,source_kind,source_uri,ingested_via,ingested_at,
            text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed
       FROM pages WHERE slug=$1 AND source_id=$2`, [slug, sourceId]);
  return row ?? null;
}

/** One manual dated statement (`add_link` valid_from / valid_until) of a relationship the page starts. */
export interface ManualLinkTransition { to_slug: string; to_source_id: string; link_type: string; kind: string; occurred_on: string }

/**
 * The manual statements of the relationships `slug` starts, by target slug, link type, kind and day. A schema that
 * predates `link_transitions` has none.
 */
export async function listManualLinkTransitions(exec: Raw, slug: string, sourceId: string): Promise<ManualLinkTransition[]> {
  try {
    return await exec.executeRaw<ManualLinkTransition>(
      `SELECT t.slug AS to_slug, t.source_id AS to_source_id, lt.link_type, lt.kind, lt.occurred_on::text AS occurred_on
         FROM link_transitions lt JOIN pages f ON f.id = lt.from_page_id JOIN pages t ON t.id = lt.to_page_id
        WHERE f.slug = $1 AND f.source_id = $2 AND lt.producer = 'manual'
        ORDER BY t.source_id COLLATE "C", t.slug COLLATE "C", lt.link_type COLLATE "C", lt.kind COLLATE "C", lt.occurred_on`, [slug, sourceId]);
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', 'link_transitions')) return [];
    throw error;
  }
}

/**
 * Timeline rows of live pages: the set the copier carries (it copies live pages only, so a whole-table count warned
 * whenever a soft-deleted page still owned rows), so the verify step compares the same predicate on both sides. A
 * schema without `deleted_at` throws; the verify callers treat that as "skip the parity check".
 */
export const COPIED_TIMELINE_COUNT_SQL =
  `SELECT count(*)::text AS count
     FROM timeline_entries te
     JOIN pages p ON p.id = te.page_id
    WHERE p.deleted_at IS NULL`;

export async function countLiveTimelineEntries(exec: Raw): Promise<number> {
  const [row] = await exec.executeRaw<{ count: string | number }>(COPIED_TIMELINE_COUNT_SQL);
  return Number(row?.count ?? 0);
}

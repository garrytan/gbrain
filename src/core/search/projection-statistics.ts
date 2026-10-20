import type { BrainEngine } from '../engine.ts';
import { analyzeDeferred, lockTableForAnalyze } from '../analyze-lock.ts';
import { beginFullAnalyze, maybeRefreshPlannerStats, plannerAutoAnalyzeEnabled } from '../planner-stats.ts';

export const PROJECTION_STATISTICS_NAME = 'pages_text_projection_current_stats';

export const PROJECTION_STATISTICS_SQL = `
CREATE STATISTICS IF NOT EXISTS ${PROJECTION_STATISTICS_NAME}
  ON ((text_projection_revision = knowledge_revision)) FROM pages;
ANALYZE pages(text_projection_revision, knowledge_revision);
`;

type ProjectionStatisticsState = 'collected' | 'undefined' | 'uninspectable' | 'uncollected';

async function readProjectionStatistics(engine: Pick<BrainEngine, 'executeRaw'>): Promise<ProjectionStatisticsState> {
  const rows = await engine.executeRaw<{
    expression: string;
    correct_table: boolean;
    sampled_rows: number;
    can_inspect: boolean;
    collected: boolean;
  }>(`SELECT pg_get_expr(e.stxexprs, e.stxrelid) AS expression,
       e.stxrelid = 'pages'::regclass AS correct_table,
       p.reltuples AS sampled_rows,
       has_table_privilege(p.oid, 'SELECT') AND NOT row_security_active(p.oid) AS can_inspect,
       x.null_frac IS NOT NULL AS collected
     FROM pg_class p JOIN pg_statistic_ext e ON e.stxnamespace = p.relnamespace
     LEFT JOIN pg_stats_ext_exprs x
       ON x.statistics_schemaname = (SELECT nspname FROM pg_namespace WHERE oid = e.stxnamespace)
       AND x.statistics_name = e.stxname
       AND x.expr = pg_get_expr(e.stxexprs, e.stxrelid)
     WHERE p.oid = 'pages'::regclass AND e.stxname = $1`, [PROJECTION_STATISTICS_NAME]);
  const state = rows[0];
  if (!state || !state.correct_table || state.expression !== '(text_projection_revision = knowledge_revision)') return 'undefined';
  if (!state.can_inspect) return 'uninspectable';
  if (Number(state.sampled_rows) < 0 || (Number(state.sampled_rows) > 0 && !state.collected)) return 'uncollected';
  return 'collected';
}

export async function verifyProjectionStatistics(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  const state = await readProjectionStatistics(engine);
  if (state === 'undefined') {
    throw new Error('Projection planner statistics are missing or have the wrong definition; the schema migration was not verified.');
  }
  if (state === 'uninspectable') {
    throw new Error('Projection planner statistics cannot be inspected by this database role or its row-security policy; run schema maintenance with an authorized maintenance role.');
  }
  if (state === 'uncollected') {
    throw new Error('Projection planner statistics have not been collected; run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner.');
  }
}

/**
 * The columns the Postgres refresh collects (SEARCH_PAGE_STATISTICS_SQL, CHUNK_STATISTICS_SQL) and the ones
 * `missingSearchStatistics` requires. Without them search's visibility-filtered statements estimate one page per
 * source scope and run as pages-by-pages nested loops: at 5,000 pages a search took 50-60 s instead of 0.5 s.
 */
export const SEARCH_STATISTICS_COLUMNS = {
  pages: ['text_projection_revision', 'knowledge_revision', 'deleted_at', 'source_id', 'type', 'slug', 'body_generation'],
  content_chunks: ['model', 'modality', 'page_id', 'body_generation'],
} as const;

/**
 * The content_chunks columns vector search's candidate statement is estimated
 * from: its generation and modality filters (cc.model, cc.modality) and its
 * page join (cc.page_id). Without them Postgres prices each equality at 0.5%,
 * expects a handful of eligible chunks, and sorts every candidate instead of
 * walking the HNSW index: at 1M to 2M chunks that runs past the 8 s vector
 * budget (docs/eval/hnsw-scale-bench.md, "Statistics states and EXPLAIN").
 */
export const CHUNK_STATISTICS_SQL = `ANALYZE content_chunks(${SEARCH_STATISTICS_COLUMNS.content_chunks.join(', ')})`;

/**
 * The Postgres page refresh: the projection columns plus the page columns
 * every search filter reads (`p.deleted_at IS NULL`, source, type and slug
 * scopes). Without `deleted_at` statistics Postgres prices `IS NULL` at 0.5%
 * and drives the vector candidate statement from a few pages into their
 * chunks and a sort, even with content_chunks analyzed. Wide columns
 * (frontmatter, compiled_truth) stay out, so the sample stays cheap.
 */
export const SEARCH_PAGE_STATISTICS_SQL = `ANALYZE pages(${SEARCH_STATISTICS_COLUMNS.pages.join(', ')})`;

const CHUNK_STATISTICS_WARNING = `[search] Chunk planner statistics could not be refreshed (the 30 s bound or a missing privilege). Vector search may skip its index until autovacuum analyzes content_chunks; run ${CHUNK_STATISTICS_SQL} as the table owner to fix it now.`;
const CHUNK_STATISTICS_DEFERRED = '[search] Chunk planner statistics refresh deferred: another session (a vacuum, an ANALYZE or an index build) holds content_chunks, and this refresh never waits on it (#7083). Autovacuum analyzes the table, and the next import, sync or embed drain refreshes it again.';

/**
 * The chunk ANALYZE inside a caller's bounded Postgres transaction, in a nested
 * transaction (a savepoint the driver rolls back, so a failed statement never
 * aborts the caller's transaction): a vacuum, ANALYZE or index build holding
 * the table's lock defers this step alone (`lockTableForAnalyze`, which never
 * waits, so it never cancels an autovacuum), never the caller's page
 * statistics. A role that does not own the table gets Postgres's skip warning,
 * not an error.
 */
async function analyzeChunkColumns(tx: BrainEngine): Promise<boolean> {
  try {
    await tx.transaction(async step => {
      await lockTableForAnalyze(step, 'content_chunks');
      await step.executeRaw(CHUNK_STATISTICS_SQL);
    });
    return true;
  } catch (error) {
    console.warn(analyzeDeferred(error) ? CHUNK_STATISTICS_DEFERRED : CHUNK_STATISTICS_WARNING);
    return false;
  }
}

/**
 * #7083: whether a drain that changed `changedRows` chunks can leave the chunk statistics alone: content_chunks was
 * sampled with rows, its `SEARCH_STATISTICS_COLUMNS` statistics exist, the configured embedding model (the
 * provenance the drain writes to content_chunks.model) is among the sampled common models, and the drain changed fewer
 * than 50 + 10% of the sampled rows (autovacuum's analyze threshold, as `statisticsStillCurrent` for pages). Such a
 * drain barely moves them, and autovacuum's own analyze covers what small drains add up to. A model the sample has
 * never seen (a partial or source-scoped model switch) refreshes, or vector search would estimate one row for it and
 * sort every candidate. An unknown model refreshes too. Without this, every import's embed drain on a 10M-chunk
 * table ran a 2-6 s ANALYZE.
 */
async function chunkStatisticsStillCurrent(engine: BrainEngine, changedRows: number): Promise<boolean> {
  if (!Number.isFinite(changedRows)) return false;
  let model: string | null = null;
  try { model = (await import('../ai/gateway.ts')).getEmbeddingModelProvenance(); } catch { return false; } // engine-dynamic-import-ok
  if (!model) return false;
  const [state] = await engine.executeRaw<{ reltuples: number; sampled: boolean }>(
    `SELECT c.reltuples::float8 AS reltuples,
            EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = current_schema() AND s.tablename = 'content_chunks' AND s.attname = 'model'
                      AND $1 = ANY (s.most_common_vals::text::text[])) AS sampled
       FROM pg_class c WHERE c.oid = 'content_chunks'::regclass`, [model]);
  const rows = Number(state?.reltuples ?? -1);
  if (rows <= 0 || !state?.sampled || changedRows >= 50 + 0.1 * rows) return false;
  return !(await missingSearchStatistics(engine)).some(column => column.startsWith('content_chunks.'));
}

/**
 * Postgres only (PGLite's planner-stats deltas own its chunk statistics): one
 * bounded narrow ANALYZE of content_chunks after an embed drain that changed
 * `changedRows` chunks (omitted: always), which moves content_chunks.model on
 * every row it embeds. A drain `chunkStatisticsStillCurrent` vouches for
 * skips it. Import, sync and reindex get the same step inside
 * refreshProjectionStatistics.
 */
export async function refreshChunkStatistics(engine: BrainEngine, changedRows = Infinity): Promise<boolean> {
  if (engine.kind !== 'postgres') return false;
  try {
    if (await chunkStatisticsStillCurrent(engine, changedRows)) return true;
    return await engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL statement_timeout = '30s'");
      await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
      return analyzeChunkColumns(tx);
    });
  } catch {
    console.warn(CHUNK_STATISTICS_WARNING);
    return false;
  }
}

/** Runs an embed drain, then refreshes the chunk statistics once for the `changed()` chunks it embedded (none: no refresh; a drain moves content_chunks.model on every row it embeds). */
export async function withChunkStatisticsRefresh<T>(engine: BrainEngine, changed: () => number, drain: () => Promise<T>): Promise<T> {
  const out = await drain();
  const rows = changed();
  if (rows > 0) await refreshChunkStatistics(engine, rows);
  return out;
}

/**
 * Below this many rows (pg_class.reltuples, which pg_upgrade and a deleted pg_statistic both keep) a table's missing
 * statistics cost search nothing measurable, and autovacuum leaves a small table unanalyzed until 50 + 10% of it
 * changes; a table never sampled at all (reltuples -1) is a fresh one that import's refresh or autovacuum samples.
 */
const SEARCH_STATISTICS_MIN_ROWS = 500;

/** Each SEARCH_STATISTICS_COLUMNS column whose table holds SEARCH_STATISTICS_MIN_ROWS rows but has no pg_stats row ($1 tables, $2 columns). */
const MISSING_SEARCH_STATISTICS_SQL = `SELECT r.tablename || '.' || r.attname AS col
  FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS r(tablename, attname, position)
  JOIN pg_class t ON t.oid = to_regclass(quote_ident(current_schema()) || '.' || r.tablename)
 WHERE t.reltuples >= ${SEARCH_STATISTICS_MIN_ROWS}
   AND has_table_privilege(t.oid, 'SELECT') AND NOT row_security_active(t.oid)
   AND NOT EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = current_schema() AND s.tablename = r.tablename AND s.attname = r.attname)
 ORDER BY r.position`;

/**
 * Postgres: the planner statistics search needs that are absent, as `table.column` (plus PROJECTION_STATISTICS_NAME
 * when the projection statistics are not collected on such a table). Empty when every one exists, the tables hold fewer
 * than SEARCH_STATISTICS_MIN_ROWS sampled rows, or this role
 * cannot see a table's statistics (pg_stats hides them under row security; that is not absence). Absent
 * statistics outlive autovacuum after pg_upgrade (it carries no statistics and resets the modification counters) or
 * a deleted pg_statistic; a restore regains them at autovacuum's next pass. The one test behind the write-pass skip
 * (`statisticsStillCurrent`), the search guard (`ensureSearchStatistics`) and doctor `planner_stats_stale`.
 */
export async function missingSearchStatistics(engine: Pick<BrainEngine, 'executeRaw' | 'kind'>): Promise<string[]> {
  if (engine.kind !== 'postgres') return [];
  const pairs = Object.entries(SEARCH_STATISTICS_COLUMNS).flatMap(([table, columns]) => columns.map(column => [table, column] as const));
  const rows = await engine.executeRaw<{ col: string }>(MISSING_SEARCH_STATISTICS_SQL, [pairs.map(p => p[0]), pairs.map(p => p[1])]);
  const missing = rows.map(row => row.col);
  const [pages] = await engine.executeRaw<{ reltuples: number }>(`SELECT reltuples::float8 AS reltuples FROM pg_class WHERE oid = 'pages'::regclass`);
  if (Number(pages?.reltuples ?? -1) >= SEARCH_STATISTICS_MIN_ROWS && await readProjectionStatistics(engine) === 'uncollected') missing.push(PROJECTION_STATISTICS_NAME);
  return missing;
}

/** Whether this role may ANALYZE pages (owner or superuser), as the refresh requires. */
export async function canAnalyzePages(engine: Pick<BrainEngine, 'executeRaw'>): Promise<boolean> {
  const [role] = await engine.executeRaw<{ can_analyze: boolean }>(
    `SELECT pg_has_role(current_user, p.relowner, 'USAGE') OR r.rolsuper AS can_analyze
     FROM pg_class p CROSS JOIN pg_roles r
     WHERE p.oid = 'pages'::regclass AND r.rolname = current_user`,
  );
  return !!role?.can_analyze;
}

/**
 * Whether a write pass that changed `changedPages` pages can leave the planner statistics alone: pages were sampled
 * with rows, the statistics this refresh collects exist, and the pass changed fewer than 50 + 10% of the sampled
 * pages (autovacuum's analyze threshold, as the projection-recovery debt in page-state/projections.ts). Such a pass
 * barely moves them, and the refresh cost ~650 ms per one-page sync at 50k pages on Postgres and a full ANALYZE of
 * every table on PGLite.
 */
async function statisticsStillCurrent(engine: BrainEngine, changedPages: number): Promise<boolean> {
  if (!Number.isFinite(changedPages)) return false;
  // PGLite has no autovacuum, and its full ANALYZE is what covers the tables outside the planner-stats deltas: a brain
  // under 500 pages (where it is cheap), or a table holding rows it never sampled or grown more than 10% (+8 pages)
  // past the size it last sampled, refreshes.
  const [state] = await engine.executeRaw<{ reltuples: number; columns: boolean }>(
    `SELECT c.reltuples::float8 AS reltuples,
            $1::text = 'postgres' OR NOT EXISTS (SELECT 1 FROM pg_class t WHERE t.relnamespace = c.relnamespace AND t.relkind = 'r' AND pg_relation_size(t.oid) > 0
              AND (t.reltuples < 0 OR pg_relation_size(t.oid) / current_setting('block_size')::int > t.relpages * 1.1 + 8)) AS columns
       FROM pg_class c WHERE c.oid = 'pages'::regclass`, [engine.kind]);
  const rows = Number(state?.reltuples ?? -1);
  if (!state?.columns || rows <= (engine.kind === 'pglite' ? 500 : 0) || changedPages >= 50 + 0.1 * rows) return false;
  if ((await missingSearchStatistics(engine)).length > 0) return false;
  return verifyProjectionStatistics(engine).then(() => true, () => false);
}

/**
 * The Postgres search guard (`guardSearchStatistics` runs it once per engine, in the background): when
 * `missingSearchStatistics` finds statistics absent and this role may ANALYZE, run the full refresh. Returns what
 * was missing. Never throws; a role that may not ANALYZE is left to doctor `planner_stats_stale`.
 */
export async function ensureSearchStatistics(engine: BrainEngine): Promise<string[]> {
  try {
    const missing = await missingSearchStatistics(engine);
    if (missing.length > 0 && await canAnalyzePages(engine)) await refreshProjectionStatistics(engine);
    return missing;
  } catch {
    return [];
  }
}

const searchStatisticsGuards = new WeakSet<object>();

/**
 * PostgresEngine's searchKeyword and searchVector: once per engine, on its first search outside a transaction,
 * `ensureSearchStatistics` in the background. The search never waits on it (a caller's transaction may hold the
 * pool's only connection); disconnect waits for it, bounded by the refresh's 30 s statement timeout.
 */
export function guardSearchStatistics(engine: BrainEngine & { registerBeforeDisconnect(stop: () => Promise<void>): () => void },
  inTransaction: boolean): void {
  if (inTransaction || searchStatisticsGuards.has(engine)) return;
  searchStatisticsGuards.add(engine);
  const run = ensureSearchStatistics(engine);
  const unregister = engine.registerBeforeDisconnect(async () => { await run; });
  void run.finally(unregister);
}

/**
 * Refreshes the planner statistics after a write pass that changed `changedPages` pages (omitted: always). A pass
 * `statisticsStillCurrent` vouches for skips the ANALYZE; PGLite then analyzes only the hot tables its row deltas
 * mark stale.
 */
export async function refreshProjectionStatistics(engine: BrainEngine, changedPages = Infinity): Promise<boolean> {
  try {
    if (await statisticsStillCurrent(engine, changedPages)) {
      await maybeRefreshPlannerStats(engine, 'import', { throttle: false });
      return true;
    }
    if (!await canAnalyzePages(engine)) {
      console.warn('[search] Projection planner statistics were not refreshed: database-owner maintenance is required. Run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner.');
      return false;
    }
    // F4b: `planner.auto_analyze=false` keeps PGLite on the narrow refresh the projection statistics need.
    const full = engine.kind === 'pglite' && await plannerAutoAnalyzeEnabled(engine);
    await engine.transaction(async tx => {
      if (engine.kind === 'postgres') {
        await tx.executeRaw("SET LOCAL statement_timeout = '30s'");
        await tx.executeRaw("SET LOCAL lock_timeout = '2s'");
        await lockTableForAnalyze(tx, 'pages');
      }
      // PGLite has no autovacuum, so nothing else ever collects planner statistics there. Without them the
      // planner sees empty tables and runs search's graph joins as pages-by-pages nested loops (about 50 s
      // per search on a freshly imported 4,000-page brain; 6 ms after ANALYZE). Postgres keeps the narrow
      // refresh (the search filter columns of pages, then content_chunks behind a savepoint) and leaves the rest to autovacuum.
      // F4b: the full ANALYZE covers every hot table, so it publishes their planner-stats watermarks too.
      const publishWatermarks = full ? await beginFullAnalyze(tx) : async () => {};
      await tx.executeRaw(full ? 'ANALYZE' : engine.kind === 'postgres' ? SEARCH_PAGE_STATISTICS_SQL : 'ANALYZE pages(text_projection_revision, knowledge_revision)');
      if (!full && engine.kind === 'postgres') await analyzeChunkColumns(tx);
      await publishWatermarks();
      await verifyProjectionStatistics(tx);
    });
    return true;
  } catch (error) {
    console.warn(analyzeDeferred(error)
      ? '[search] Projection planner statistics refresh deferred: another session (a vacuum, an ANALYZE or an index build) holds pages, and this refresh never waits on it (#7083). Completed page writes were retained; the next import or sync refreshes them.'
      : '[search] Projection planner statistics could not be refreshed. Run ANALYZE pages(text_projection_revision, knowledge_revision) as the table owner; completed page writes were retained.');
    return false;
  }
}

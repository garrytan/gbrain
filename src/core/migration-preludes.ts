/**
 * #7108: runner-side preludes for published schema migrations whose SQL
 * rewrites a large table in one transaction.
 *
 * A published migration file never changes: brains that applied it never run
 * it again, so an edit would land only on some brains, and release restamp
 * refuses one. A migration's SQL runs in a single transaction under the
 * runner's statement budget (10 minutes), so a backfill that updates every row
 * of a large table can time out on every attempt and roll back, leaving the
 * brain below that migration for good (#7108: v221 on 1.7 million chunks
 * without a vector).
 *
 * A prelude does that migration's row writes first, right before the runner
 * applies the migration on a brain that has not applied it yet, in id-ordered
 * batches of a bounded size, each its own committed transaction with its own
 * statement budget. Progress is the data itself: a batch writes only rows the
 * migration's own predicate still selects, so an interrupted run resumes and
 * never rewrites a row it already wrote. The migration's SQL then runs
 * unchanged and finds nothing the prelude could write, and it still covers rows
 * another process wrote after the last batch. A prelude adds a column the migration
 * would add first, in the migration's own column order, so fresh and upgraded
 * brains keep the same column ordinals.
 *
 * Only a backfill whose predicate excludes the rows it already wrote can be
 * moved here; docs/guides/troubleshooting.md#migration-statement-timeout lists
 * the migrations that cannot and the operator budget for them.
 */
import type { BrainEngine } from './engine.ts';
import { dropInvalidConcurrentIndex, migrationNotice } from './schema-migrations/helpers.ts';
import { migrationStatementTimeoutMs } from './migration-timeout.ts';
import { isLockTimeoutError } from './retry-matcher.ts';
import { resolveSchemaLockTimeoutMs, schemaLockBlockedError } from './postgres-engine/schema-lock-timeout.ts';

export interface PreludeContext {
  /** Statement budget for each batch transaction (Postgres). */
  statementTimeoutMs: number;
  /** Lock wait budget for each batch transaction (Postgres). */
  lockTimeoutMs: number;
}

export type MigrationPrelude = (engine: BrainEngine, ctx: PreludeContext) => Promise<void>;

/** Rows one backfill batch may visit; a batch is one short transaction. */
const BACKFILL_BATCH_ROWS = 5_000;
let backfillBatchRows = BACKFILL_BATCH_ROWS;

/** Test-only: shrink the batch so a small fixture spans many batches; null restores the default. */
export function __setBackfillBatchRowsForTests(rows: number | null): void {
  backfillBatchRows = rows ?? BACKFILL_BATCH_ROWS;
}

/** Progress lines at most this often, so a long backfill shows it is moving without a line per batch. */
const PROGRESS_INTERVAL_MS = 15_000;

async function boundedTransaction<T>(engine: BrainEngine, ctx: PreludeContext, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async tx => {
    if (engine.kind === 'postgres') {
      await tx.executeRaw(`SET LOCAL statement_timeout = '${ctx.statementTimeoutMs}ms'`);
      await tx.executeRaw(`SET LOCAL lock_timeout = '${ctx.lockTimeoutMs}ms'`);
    }
    return run(tx);
  });
}

interface BatchedUpdate {
  version: number;
  /** Table updated as alias `t`, batched on its integer `id` key; a table without one is left to the migration. */
  table: string;
  /** SET list over `t` (and `from` aliases), identical to the migration's. */
  set: string;
  /** The migration's own predicate over `t`; it must stop matching a row once the row is written. */
  where: string;
  /** Extra FROM items joined beside the batch, as in the migration's UPDATE ... FROM. */
  from?: string;
  what: string;
  /** Runs inside a batch transaction that wrote at least one row. */
  onWritten?: (tx: BrainEngine) => Promise<unknown>;
}

/**
 * The cursor and batch size are inlined, not bound: a named prepared statement
 * switches to a generic plan after a few runs, and a generic `id > $1 LIMIT $2`
 * can plan a sequential scan and sort of the whole table for every batch.
 */
async function batchedUpdate(engine: BrainEngine, ctx: PreludeContext, u: BatchedUpdate): Promise<void> {
  const [keyed] = await engine.executeRaw<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'id') AS ok`, [u.table]);
  if (!keyed?.ok) return;
  let cursor = 0;
  let written = 0;
  let announced = false;
  let lastProgress = Date.now();
  for (;;) {
    const row = await boundedTransaction(engine, ctx, async tx => {
      const [batch] = await tx.executeRaw<{ last_id: number | null; written: number }>(
        `-- chunk-visibility-ok: a migration backfill writes every row its published UPDATE writes, staged and retired chunks included
         WITH b AS (SELECT id FROM ${u.table} WHERE id > ${Math.trunc(cursor)} ORDER BY id LIMIT ${Math.trunc(backfillBatchRows)}),
              w AS (UPDATE ${u.table} t SET ${u.set} FROM b${u.from ? `, ${u.from}` : ''} WHERE t.id = b.id AND (${u.where}) RETURNING 1)
         SELECT (SELECT max(id) FROM b) AS last_id, (SELECT count(*) FROM w)::int AS written`);
      if (Number(batch?.written ?? 0) > 0) await u.onWritten?.(tx);
      return batch;
    });
    if (row?.last_id == null) break;
    cursor = Number(row.last_id);
    written += Number(row.written);
    if (!announced && written > 0) {
      announced = true;
      migrationNotice(`  [${u.version}] ${u.what}, ${backfillBatchRows} rows per committed batch; `
        + 'an interrupted run resumes where it stopped: foresights apply-migrations --yes\n');
    }
    if (announced && Date.now() - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = Date.now();
      migrationNotice(`  [${u.version}] ${written} ${u.table} row(s) written, through id ${cursor}\n`);
    }
  }
  if (announced) migrationNotice(`  [${u.version}] wrote ${written} ${u.table} row(s)\n`);
}

const addColumn = (engine: BrainEngine, ctx: PreludeContext, ddl: string) => boundedTransaction(engine, ctx, tx => tx.executeRaw(ddl));

/** v011 links_provenance_columns: legacy edges become link_source 'markdown'. Below Postgres 15 the migration refuses on its own, so nothing runs here. */
async function v011(engine: BrainEngine, ctx: PreludeContext): Promise<void> {
  const [pg] = await engine.executeRaw<{ n: number }>(`SELECT current_setting('server_version_num')::int AS n`);
  if (Number(pg?.n ?? 0) < 150000) return;
  await addColumn(engine, ctx, 'ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT');
  await batchedUpdate(engine, ctx, { version: 11, table: 'links', set: `link_source = 'markdown'`, where: 't.link_source IS NULL', what: 'setting link_source on legacy links' });
}

/** v028 cathedral_ii_chunk_fts_backfill: chunk keyword vectors, with the migration's exact weights. */
async function v028(engine: BrainEngine, ctx: PreludeContext): Promise<void> {
  await batchedUpdate(engine, ctx, {
    version: 28, table: 'content_chunks', what: 'building chunk keyword vectors',
    set: `search_vector =
        setweight(to_tsvector('english', COALESCE(t.doc_comment, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(t.symbol_name_qualified, '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(t.chunk_text, '')), 'B')`,
    where: 't.search_vector IS NULL',
  });
}

/**
 * v033 admin_dashboard_columns_v0_26_3: request-log agent names, resolved as the
 * migration resolves them. A row with no token resolves to NULL and would stay
 * selected, so it is left to the migration's own UPDATE.
 */
async function v033(engine: BrainEngine, ctx: PreludeContext): Promise<void> {
  await addColumn(engine, ctx, 'ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS agent_name TEXT');
  await batchedUpdate(engine, ctx, {
    version: 33, table: 'mcp_request_log', what: 'resolving request-log agent names',
    set: `agent_name = COALESCE(
        (SELECT client_name FROM oauth_clients WHERE client_id = t.token_name LIMIT 1),
        (SELECT name FROM access_tokens WHERE name = t.token_name LIMIT 1),
        t.token_name)`,
    where: 't.agent_name IS NULL AND t.token_name IS NOT NULL',
  });
}

/** v116 code_edges_source_backfill_and_callee_index: each edge takes its source chunk's page source. */
async function v116(engine: BrainEngine, ctx: PreludeContext): Promise<void> {
  for (const table of ['code_edges_symbol', 'code_edges_chunk']) {
    await batchedUpdate(engine, ctx, {
      version: 116, table, what: `setting ${table}.source_id`,
      set: `source_id = COALESCE(p.source_id, 'default')`,
      from: 'content_chunks c JOIN pages p ON p.id = c.page_id',
      where: 'c.id = t.from_chunk_id AND t.source_id IS NULL',
    });
  }
}

const V161_INDEX = 'idx_pages_projection_pending';

/**
 * v161 index_pending_text_projections (Postgres): the migration builds this
 * partial index on pages under its own 30-second statement cap, which no
 * runner budget lifts. It is built here concurrently, under the migration
 * statement budget, so the migration's CREATE INDEX IF NOT EXISTS finds a valid
 * index and does nothing. The budget is a session setting on a reserved
 * connection, reset afterwards, as runMigrationSQL does for a transaction:false
 * migration. Another session's build in progress, or a build that ends invalid,
 * stops the run, because the migration's IF NOT EXISTS would accept an invalid
 * index. PGLite builds it in the migration itself, which has no cap there.
 */
async function v161(engine: BrainEngine, ctx: PreludeContext): Promise<void> {
  if (engine.kind !== 'postgres') return;
  const state = async () => (await engine.executeRaw<{ valid: boolean; building: boolean }>(
    `SELECT i.indisvalid AS valid, EXISTS (SELECT 1 FROM pg_stat_progress_create_index p
        WHERE p.relid = i.indrelid AND p.index_relid IN (i.indexrelid, 0)) AS building
       FROM pg_index i WHERE i.indexrelid = to_regclass($1)`, [V161_INDEX]))[0];
  const before = await state();
  if (before?.valid) return;
  if (before?.building) throw new Error(`Index ${V161_INDEX} is being built by another session; once that build ends, run foresights apply-migrations --yes again.`);
  if (before) await dropInvalidConcurrentIndex(engine, 161, V161_INDEX);
  migrationNotice(`  [161] building ${V161_INDEX} concurrently; this can take minutes and is safe to interrupt (the next run rebuilds it)\n`);
  await engine.withReservedConnection(async conn => {
    await conn.executeRaw(`SET statement_timeout = '${ctx.statementTimeoutMs}'`);
    try {
      await conn.executeRaw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${V161_INDEX} ON pages(source_id, page_kind, slug)
        WHERE deleted_at IS NULL AND text_projection_revision IS DISTINCT FROM knowledge_revision`);
    } finally {
      await conn.executeRaw('RESET statement_timeout').catch(() => {});
    }
  }, { selfContained: true });
  if (!(await state())?.valid) throw new Error(`Index ${V161_INDEX} is not valid after its concurrent build; run foresights apply-migrations --yes again to rebuild it.`);
}

/**
 * v221 chunk_embedding_pending_since: stamps every chunk whose active embedding
 * column is NULL with its created_at. The active column is chosen exactly as
 * v221 chooses it (`search_embedding_column` when it names an existing
 * content_chunks column, else `embedding`). The first batch that stamps a row
 * also records `embedding_pending_since_backfilled_at` in the same transaction
 * (kept on a resume), which doctor uses to label those ages as a created_at
 * backfill; v221 records it only when it stamped a row, and so does this.
 */
async function v221(engine: BrainEngine, ctx: PreludeContext): Promise<void> {
  await addColumn(engine, ctx, 'ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_pending_since TIMESTAMPTZ');
  const [active] = await engine.executeRaw<{ column_name: string }>(
    `SELECT c.column_name FROM config k
       JOIN information_schema.columns c
         ON c.table_schema = current_schema() AND c.table_name = 'content_chunks' AND c.column_name = k.value
      WHERE k.key = 'search_embedding_column'`);
  const column = `"${(active?.column_name ?? 'embedding').replaceAll('"', '""')}"`;
  await batchedUpdate(engine, ctx, {
    version: 221, table: 'content_chunks', what: 'stamping embedding_pending_since on chunks without a vector',
    set: 'embedding_pending_since = t.created_at',
    where: `t.${column} IS NULL AND t.embedding_pending_since IS NULL`,
    onWritten: tx => tx.executeRaw(`INSERT INTO config (key, value) VALUES ('embedding_pending_since_backfilled_at', now()::text)
      ON CONFLICT (key) DO NOTHING`),
  });
}

/** Preludes by migration version. */
export const MIGRATION_PRELUDES: ReadonlyMap<number, MigrationPrelude> = new Map<number, MigrationPrelude>([
  [11, v011], [28, v028], [33, v033], [116, v116], [161, v161], [221, v221],
]);

/** The runner calls this right before a migration's SQL; a lock wait that runs out is the schema-lock refusal, as for the SQL. */
export async function runMigrationPrelude(engine: BrainEngine, version: number): Promise<void> {
  const prelude = MIGRATION_PRELUDES.get(version);
  if (!prelude) return;
  const lockTimeoutMs = resolveSchemaLockTimeoutMs();
  try {
    await prelude(engine, { statementTimeoutMs: migrationStatementTimeoutMs(), lockTimeoutMs });
  } catch (error) {
    if (engine.kind === 'postgres' && isLockTimeoutError(error)) {
      throw schemaLockBlockedError({ step: `migration v${version} batched backfill`, timeoutMs: lockTimeoutMs, sessions: null, sampledDuringWait: false });
    }
    throw error;
  }
}

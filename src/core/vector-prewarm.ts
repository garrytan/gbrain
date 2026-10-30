/**
 * Opt-in vector (HNSW) index prewarm for Postgres brains (GBRA-156).
 *
 * A search whose embedding has not been seen walks HNSW pages nobody has read
 * since the last restart or eviction: on a brain whose index exceeds the cache
 * that is 2-4.5k uncached index pages and 1.2-2.7 s of first-touch vector time.
 * `gbrain embeddings prewarm` (and `serve.vector_prewarm` at serve start) loads
 * every HNSW index of the brain's schema into shared_buffers with
 * pg_prewarm(..., 'buffer') once, so later searches find those pages cached.
 *
 * Which cache decides: shared_buffers. pg_prewarm's 'buffer' mode loads pages
 * into Postgres's own buffer cache, the one cache whose size the server knows
 * (current_setting('shared_buffers')) and whose contents it keeps. The total
 * HNSW size must fit in PREWARM_SHARED_BUFFERS_SHARE of it; past that the
 * prewarm would evict the heap, keyword-index and catalog pages every other
 * read needs, trading vector first touches for keyword ones. Nothing is read
 * before this check passes: index sizes come from pg_relation_size (file
 * sizes, no relation pages) and the settings from current_setting.
 * effective_cache_size is read when it can be and reported, but it decides
 * nothing: it is a planner hint the operator types in, the server never
 * allocates it, and it says nothing about what the OS page cache holds or can
 * keep, so a fit against it could not be honest.
 *
 * Local operator only: a CLI-only command (never an operation, so no MCP
 * caller can reach it) that thin clients refuse, plus an opt-in serve-start
 * hook that is off by default. PGLite has no server buffer cache that
 * outlives the process, so it is refused.
 */
import type { BrainEngine } from './engine.ts';
import type { Action } from './agent-output.ts';
import { opError } from './ops/contract.ts';

/** At most this share of shared_buffers may go to prewarmed HNSW pages; the rest stays for heap, keyword-index and catalog pages. */
export const PREWARM_SHARED_BUFFERS_SHARE = 0.5;

export interface VectorIndexSize { index: string; table: string; bytes: number }

export interface VectorPrewarmPlan {
  indexes: VectorIndexSize[];
  total_bytes: number;
  shared_buffers_bytes: number;
  /** Reported for context only; null when the server would not say. */
  effective_cache_size_bytes: number | null;
  budget_bytes: number;
  decided_by: 'shared_buffers';
  fits: boolean;
  /** Installed pg_prewarm version, null when the extension is not created in this database. */
  extension_version: string | null;
  extension_available: boolean;
}

export interface VectorPrewarmResult extends VectorPrewarmPlan {
  dry_run: boolean;
  mode: 'buffer';
  /** Per index: blocks pg_prewarm loaded and how long it took (empty on a dry run). */
  loaded: Array<{ index: string; blocks: number; ms: number }>;
  elapsed_ms: number;
}

const MB = 1024 * 1024;
const mb = (bytes: number) => `${Math.ceil(bytes / MB)} MB`;

/** The fit decision: shared_buffers alone, against PREWARM_SHARED_BUFFERS_SHARE of it. */
export function prewarmFits(totalBytes: number, sharedBuffersBytes: number): { fits: boolean; budget_bytes: number } {
  const budget = Math.floor(sharedBuffersBytes * PREWARM_SHARED_BUFFERS_SHARE);
  return { fits: totalBytes <= budget, budget_bytes: budget };
}

/** Index sizes, cache settings and extension state; reads catalogs and file sizes only, never a relation page. */
export async function readVectorPrewarmPlan(engine: BrainEngine): Promise<VectorPrewarmPlan> {
  const indexes = (await engine.executeRaw<{ index: string; table: string; bytes: string | number }>(
    `SELECT c.relname AS index, t.relname AS "table", pg_relation_size(c.oid)::bigint AS bytes
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_am am ON am.oid = c.relam
      WHERE am.amname = 'hnsw' AND i.indisvalid AND n.nspname = current_schema()
      ORDER BY 3 DESC, 1`)).map(r => ({ index: r.index, table: r.table, bytes: Number(r.bytes) }));
  const [s] = await engine.executeRaw<{ shared_buffers: string | number; effective_cache_size: string | number | null; extension_version: string | null; extension_available: boolean }>(
    `SELECT pg_size_bytes(current_setting('shared_buffers'))::bigint AS shared_buffers,
            pg_size_bytes(current_setting('effective_cache_size', true))::bigint AS effective_cache_size,
            (SELECT extversion FROM pg_extension WHERE extname = 'pg_prewarm') AS extension_version,
            EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_prewarm') AS extension_available`);
  const total = indexes.reduce((sum, i) => sum + i.bytes, 0);
  const sharedBuffers = Number(s!.shared_buffers);
  const { fits, budget_bytes } = prewarmFits(total, sharedBuffers);
  return {
    indexes, total_bytes: total, shared_buffers_bytes: sharedBuffers,
    effective_cache_size_bytes: s!.effective_cache_size === null ? null : Number(s!.effective_cache_size),
    budget_bytes, decided_by: 'shared_buffers', fits,
    extension_version: s!.extension_version, extension_available: s!.extension_available === true,
  };
}

const VERIFY: Action['verify'] = { argv: ['gbrain', 'embeddings', 'prewarm', '--dry-run', '--json'] };

function tooLarge(plan: VectorPrewarmPlan) {
  const needed = Math.ceil(plan.total_bytes / PREWARM_SHARED_BUFFERS_SHARE / MB);
  return opError('vector_prewarm_wont_fit',
    `The vector indexes total ${mb(plan.total_bytes)}, more than the ${mb(plan.budget_bytes)} prewarm budget (${PREWARM_SHARED_BUFFERS_SHARE * 100}% of shared_buffers ${mb(plan.shared_buffers_bytes)}); nothing was read.`,
    `Raise shared_buffers to at least ${needed} MB on the database host and restart Postgres, or leave the indexes cold.`,
    {
      why: 'pg_prewarm loads the indexes into shared_buffers; past half of it the prewarm would evict the heap and keyword-index pages other reads need, so the next searches would pay first-touch reads on those instead. effective_cache_size is not used: it is a planner hint, not memory the server holds.',
      fix: {
        argv: ['psql', '-c', `ALTER SYSTEM SET shared_buffers = '${needed}MB'`], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: `shared_buffers takes effect only after a Postgres restart, and the host needs that much RAM to spare (a managed database sets it through its instance size).`,
        user_message: `Prewarming the vector index needs shared_buffers of at least ${needed} MB on the database (it is ${mb(plan.shared_buffers_bytes)}). That is a database setting and a restart; search keeps working without it.`,
        verify: VERIFY,
      },
    });
}

function extensionMissing(plan: VectorPrewarmPlan) {
  return opError('vector_prewarm_extension_missing',
    plan.extension_available
      ? 'The pg_prewarm extension is not created in this database; nothing was read.'
      : 'This Postgres server does not ship the pg_prewarm extension; nothing was read.',
    plan.extension_available
      ? 'Create it once as a role that may create extensions: CREATE EXTENSION IF NOT EXISTS pg_prewarm;'
      : 'Install the PostgreSQL contrib package on the database host (pg_prewarm is part of it), then CREATE EXTENSION IF NOT EXISTS pg_prewarm;',
    {
      why: 'gbrain loads index pages with pg_prewarm, the Postgres contrib function that reads a relation into shared_buffers; without it there is no supported way to fill the buffer cache.',
      fix: {
        argv: ['psql', '-c', 'CREATE EXTENSION IF NOT EXISTS pg_prewarm'], consent: [], actor: 'host_admin', requires_exclusive: false,
        why: 'Creating an extension needs a database owner or superuser (on a managed database, its extensions page).',
        user_message: 'Prewarming the vector index needs the pg_prewarm extension in the database. Creating it is a one-time step for whoever administers the database.',
        verify: VERIFY,
      },
    });
}

export function vectorPrewarmUnsupported() {
  return opError('vector_prewarm_unsupported_engine',
    'Vector index prewarm runs on Postgres brains only; this brain is PGLite, and nothing was read.',
    'Nothing to do: PGLite runs inside this process, with no server buffer cache that outlives it.',
    { why: 'Prewarm fills Postgres shared_buffers so later processes find index pages cached; PGLite has no shared server cache to fill.' });
}

/** Check the fit, then (unless a dry run) prewarm every HNSW index into shared_buffers, largest first. */
export async function runVectorPrewarm(engine: BrainEngine, opts: { dryRun?: boolean } = {}): Promise<VectorPrewarmResult> {
  if (engine.kind !== 'postgres') throw vectorPrewarmUnsupported();
  const t0 = performance.now();
  const plan = await readVectorPrewarmPlan(engine);
  if (!plan.fits) throw tooLarge(plan);
  if (!plan.extension_version && !opts.dryRun) throw extensionMissing(plan);
  const loaded: VectorPrewarmResult['loaded'] = [];
  if (!opts.dryRun) {
    for (const ix of plan.indexes) {
      const t = performance.now();
      const blocks = await engine.transaction(async tx => {
        await tx.executeRaw('SET LOCAL statement_timeout = 0');
        const [row] = await tx.executeRaw<{ blocks: string | number }>(`SELECT pg_prewarm(format('%I.%I', current_schema(), $1::text)::regclass, 'buffer')::bigint AS blocks`, [ix.index]);
        return Number(row?.blocks ?? 0);
      });
      loaded.push({ index: ix.index, blocks, ms: Math.round(performance.now() - t) });
    }
  }
  return { ...plan, dry_run: opts.dryRun === true, mode: 'buffer', loaded, elapsed_ms: Math.round(performance.now() - t0) };
}

/** serve.vector_prewarm: one prewarm after the serve boots, logged; a refusal or failure is logged and never stops the serve. */
export async function prewarmAtServeStart(engine: BrainEngine, log: (line: string) => void): Promise<void> {
  if (engine.kind !== 'postgres') { log('[gbrain serve] vector prewarm: skipped (Postgres only; this brain is PGLite)'); return; }
  try {
    const r = await runVectorPrewarm(engine);
    const blocks = r.loaded.reduce((sum, l) => sum + l.blocks, 0);
    log(`[gbrain serve] vector prewarm: loaded ${r.loaded.length} index(es), ${mb(blocks * 8192)}, into shared_buffers in ${(r.elapsed_ms / 1000).toFixed(1)} s`);
  } catch (error) {
    const e = error as { code?: string; message?: string };
    log(`[gbrain serve] vector prewarm: skipped (${e.code ?? 'error'}): ${e.message ?? String(error)}`);
  }
}

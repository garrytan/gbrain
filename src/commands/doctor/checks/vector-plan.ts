/**
 * vector_plan (#5824): EXPLAINs (no ANALYZE) the statement `searchVector`
 * would run for the active embedding column, through the same builder,
 * scoped read transaction and scan settings (PostgresEngine.explainVectorSearch),
 * and warns when an HNSW-indexed column's plan does not use its HNSW index.
 * A sequential scan there can push vector candidates past the 8 s budget, and
 * hybrid search then answers from the keyword arm alone.
 *
 * Skipped on PGLite, on columns wider than pgvector's HNSW cap (exact scan by
 * design) and below 10,000 embedded chunks (`pg_class.reltuples`; a seq scan
 * is the right plan for a small brain). The legacy guard rollback is reported
 * as configured, because a running service only picks it up on restart.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { PostgresEngine } from '../../../core/postgres-engine.ts';
import type { ResolvedColumn } from '../../../core/types.ts';
import type { Check } from '../../doctor.ts';
import { hnswIndexExpected } from '../../../core/vector-index.ts';
import { readContentChunksColumnDim } from '../../../core/embedding-dim-check.ts';
import { loadConfig, loadConfigWithEngine, type GBrainConfig } from '../../../core/config.ts';
import { resolveEmbeddingColumn } from '../../../core/search/embedding-column.ts';
import { readVectorLegacyGuard, VECTOR_LEGACY_GUARD_ENV, VECTOR_LEGACY_GUARD_KEY } from '../../../core/search/vector-legacy-guard.ts';

const NAME = 'vector_plan';
const DOCS = 'docs/guides/troubleshooting.md#hybrid-search-returns-only-keyword-hits';
export const VECTOR_PLAN_MIN_CHUNKS = 10_000;
const STALE_SAMPLE = 5_000;
const STALE_WARN = 0.05;

interface PlanNode { 'Node Type'?: string; 'Index Name'?: string; 'Relation Name'?: string; Plans?: PlanNode[] }

function planNodes(node: PlanNode | undefined, out: PlanNode[] = []): PlanNode[] {
  if (!node) return out;
  out.push(node);
  for (const child of node.Plans ?? []) planNodes(child, out);
  return out;
}

/** Scan nodes over content_chunks, e.g. `Index Scan using idx_chunks_embedding` or `Seq Scan`. */
function describeChunkScans(nodes: PlanNode[]): string[] {
  return nodes.filter(n => n['Relation Name'] === 'content_chunks')
    .map(n => n['Index Name'] ? `${n['Node Type']} using ${n['Index Name']}` : String(n['Node Type']));
}

export interface VectorPlanOpts {
  /** Active column override (tests); production resolves it from the brain config. */
  column?: ResolvedColumn;
  env?: NodeJS.ProcessEnv;
}

export async function vectorPlanCheck(engine: BrainEngine, opts: VectorPlanOpts = {}): Promise<Check> {
  if (engine.kind !== 'postgres') {
    return { name: NAME, status: 'ok', message: 'Skipped: PGLite runs vector search in-process; the plan check applies to Postgres brains.',
      details: { outcome: 'skipped', reason: 'pglite' } };
  }
  try {
    const cfg = await loadConfigWithEngine(engine).catch(() => loadConfig());
    const guard = readVectorLegacyGuard(cfg, opts.env);
    const resolved = opts.column ?? resolveEmbeddingColumn(undefined, cfg ?? { engine: 'postgres' } as GBrainConfig);
    const actual = await readContentChunksColumnDim(engine, resolved.name);
    const column: ResolvedColumn = { ...resolved, dimensions: actual.dims ?? resolved.dimensions };
    const base = { column: column.name, column_type: `${column.type}(${column.dimensions})`, docs: DOCS };
    if (!hnswIndexExpected(column.type, column.dimensions)) {
      return { name: NAME, status: 'ok', message: `Skipped: ${column.name} is ${column.type}(${column.dimensions}), wider than pgvector's HNSW cap, so vector search is an exact scan by design.`,
        details: { ...base, outcome: 'skipped', reason: 'not_indexed' } };
    }
    const embedded = await embeddedChunkEstimate(engine, column.name);
    if (embedded < VECTOR_PLAN_MIN_CHUNKS) {
      return { name: NAME, status: 'ok', message: `Skipped: about ${embedded} embedded chunk(s) in ${column.name}; below ${VECTOR_PLAN_MIN_CHUNKS} a sequential scan is the right plan.`,
        details: { ...base, outcome: 'skipped', reason: 'small_brain', embedded_chunks_estimate: embedded } };
    }

    const indexes = await engine.executeRaw<{ name: string; valid: boolean }>(
      `SELECT c.relname AS name, i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_am am ON am.oid = c.relam
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = to_regclass('content_chunks') AND am.amname = 'hnsw' AND a.attname = $1
        ORDER BY c.relname`, [column.name]);
    const plan = await (engine as PostgresEngine).explainVectorSearch(new Float32Array(column.dimensions), {
      limit: 20, embeddingColumn: column, vectorLegacyGuard: guard.enabled,
    });
    const scans = describeChunkScans(planNodes(plan.Plan as PlanNode));
    const usesHnsw = indexes.some(index => scans.some(scan => scan.endsWith(` using ${index.name}`)));
    const stale = column.name === 'embedding' ? await staleFraction(engine, embedded) : null;
    const staleNote = stale && stale.fraction > STALE_WARN
      ? ` About ${(stale.fraction * 100).toFixed(1)}% of sampled embedded chunks have stale text; run \`gbrain embed --stale\` to re-embed them.` : '';
    const details = { ...base, embedded_chunks_estimate: embedded, plan_scans: scans, hnsw_indexes: indexes, legacy_guard: guard,
      stale_fraction: stale?.fraction ?? null, stale_sampled_chunks: stale?.sampled ?? null };

    if (guard.enabled) {
      const via = guard.via === 'env' ? `${VECTOR_LEGACY_GUARD_ENV} (unset it)` : `${VECTOR_LEGACY_GUARD_KEY} (gbrain config set ${VECTOR_LEGACY_GUARD_KEY} false)`;
      return { name: NAME, status: 'warn', details: { ...details, outcome: 'legacy_guard' },
        message: `Vector legacy guard configured via ${via}; active after restarting the owning service (serve, autopilot, workers). `
          + `It restores the pre-#5824 statement, which large brains plan as ${scans.join(', ') || 'a sequential scan'}. `
          + `Legacy guard active; remove after upgrade unless it rolled back a regression, then restart the service. See ${DOCS}.${staleNote}` };
    }
    if (usesHnsw) {
      return { name: NAME, status: 'ok', details: { ...details, outcome: 'ok' },
        message: `Vector search uses its HNSW index (${scans.join(', ')}) on ${column.name}.${staleNote}` };
    }
    const indexState = indexes.length === 0
      ? `no HNSW index exists on content_chunks.${column.name}; create it on the brain host: CREATE INDEX CONCURRENTLY idx_chunks_${column.name} ON content_chunks USING hnsw (${column.name} ${column.type}_cosine_ops)`
      : indexes.every(index => !index.valid)
        ? `${indexes.map(index => index.name).join(', ')} is INVALID (an interrupted build); rebuild it on the brain host: REINDEX INDEX CONCURRENTLY ${indexes[0].name}`
        : `${indexes.filter(index => index.valid).map(index => index.name).join(', ')} exists and is valid`;
    return { name: NAME, status: 'warn', details: { ...details, outcome: 'index_unused' },
      message: `Vector search plan does not use the HNSW index on content_chunks.${column.name}: the planner chose ${scans.join(', ') || 'a non-index plan'}. `
        + `Risk: vector candidates may hit the 8 s budget on large brains, and hybrid search then returns keyword-only results (vector_candidates_incomplete). `
        + `Index: ${indexState}. Fix: upgrade gbrain on the brain host (gbrain upgrade) and rerun gbrain doctor; `
        + `if this started right after an upgrade, roll back with ${VECTOR_LEGACY_GUARD_KEY} and report it on #5824. See ${DOCS}.${staleNote}` };
  } catch (error) {
    return { name: NAME, status: 'warn', message: `Vector plan could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown', docs: DOCS } };
  }
}

/** Embedded rows from planner statistics; a never-analyzed table falls back to a count bounded at the threshold. */
async function embeddedChunkEstimate(engine: BrainEngine, column: string): Promise<number> {
  const [stats] = await engine.executeRaw<{ reltuples: number; null_frac: number | null }>(
    `SELECT c.reltuples::float8 AS reltuples, s.null_frac::float8 AS null_frac
       FROM pg_class c
       LEFT JOIN pg_stats s ON s.schemaname = 'public' AND s.tablename = 'content_chunks' AND s.attname = $1
      WHERE c.oid = to_regclass('content_chunks')`, [column]);
  if (stats && stats.reltuples >= 0 && stats.null_frac !== null) return Math.round(stats.reltuples * (1 - stats.null_frac));
  const [bounded] = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM content_chunks WHERE "${column.replaceAll('"', '""')}" IS NOT NULL LIMIT ${VECTOR_PLAN_MIN_CHUNKS}) bounded`);
  return Number(bounded?.n ?? 0);
}

/** Share of embedded chunks whose text changed after embedding, from a page sample of about 5,000 rows. */
async function staleFraction(engine: BrainEngine, embedded: number): Promise<{ fraction: number; sampled: number } | null> {
  const percent = Math.min(100, Math.max(0.01, (STALE_SAMPLE * 2 * 100) / Math.max(embedded, 1)));
  const [row] = await engine.executeRaw<{ sampled: number; stale: number }>(
    `SELECT count(*)::int AS sampled,
            (count(*) FILTER (WHERE embedded_text_hash IS NOT NULL AND embedded_text_hash <> md5(chunk_text)))::int AS stale
       FROM (SELECT embedded_text_hash, chunk_text FROM content_chunks TABLESAMPLE SYSTEM (${percent.toFixed(4)})
              WHERE embedding IS NOT NULL LIMIT ${STALE_SAMPLE}) sampled`);
  if (!row || !row.sampled) return null;
  return { fraction: row.stale / row.sampled, sampled: row.sampled };
}

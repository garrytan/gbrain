/**
 * #5088: deferred ANN (HNSW) index build for `gbrain migrate embeddings`.
 *
 * The schema transition drops `content_chunks.embedding` and used to recreate
 * its HNSW indexes before the bulk re-embed, so every vector write inserted
 * into a live HNSW graph (measured 4x slower on PGLite; the reporter's PGLite
 * run stalled). The transition now restores only the non-ANN dependent
 * indexes (the stale drain needs them) and records the HNSW definitions in
 * the migration marker (`deferred_ann_indexes`). This phase builds them after
 * the drain and before the marker clears, one at a time, removing each from
 * the marker once it is valid, so a killed run resumes where it stopped.
 *
 * The worklist covers every text-embedding column the transition rebuilds
 * (`content_chunks` plus the dim-pinned tables). Postgres builds with CREATE
 * INDEX CONCURRENTLY on a reserved connection (writes continue) and drops an
 * INVALID remnant of an interrupted build first; PGLite builds plainly. The
 * per-type cap policy (vector 2,000, halfvec 4,000 dimensions) is applied
 * again at build time.
 */
import type { BrainEngine } from './engine.ts';
import { chunkEmbeddingIndexSql, hnswIndexExpected, withHnswBuildMemory } from './vector-index.ts';

export interface DeferredAnnIndex { name: string; def: string }

export const ANN_BUILD_MESSAGE = 'building vector index after re-embed (search runs unindexed until done)';

const HNSW_TARGET = / ON (?:ONLY )?(?:public\.)?([a-z_][a-z0-9_]*) USING hnsw \(([a-z_][a-z0-9_]*) /;
const ANN_DEF = /^CREATE INDEX (?:IF NOT EXISTS )?([a-z_][a-z0-9_]{0,62}) ON (?:public\.)?([a-z_][a-z0-9_]*) USING hnsw \(embedding (?:vector|halfvec)_(?:cosine|l2|ip)_ops\)(?: WITH \([a-z_]+ ?= ?'?[0-9]+'?(?:, ?[a-z_]+ ?= ?'?[0-9]+'?)*\))?(?: WHERE [A-Za-z0-9_ ().,:<>=!'-]+)?$/;

/**
 * Only HNSW definitions over the `embedding` column of the given tables are
 * accepted: the marker lives in the config table, so a planted row must never
 * become DDL. Whitespace is normalized.
 */
export function parseDeferredAnnIndexes(raw: unknown, tables: readonly string[] = ['content_chunks']): DeferredAnnIndex[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): DeferredAnnIndex[] => {
    if (!entry || typeof entry.name !== 'string' || typeof entry.def !== 'string' || entry.def.includes(';')) return [];
    const def = entry.def.replace(/\s+/g, ' ').trim();
    const match = ANN_DEF.exec(def);
    return match && match[1] === entry.name && tables.includes(match[2]!) ? [{ name: entry.name, def }] : [];
  });
}

/** The canonical chunk ANN index definition, in pg_get_indexdef form. */
export function canonicalChunkAnnIndex(): DeferredAnnIndex {
  return { name: 'idx_chunks_embedding', def: chunkEmbeddingIndexSql(1).replace(/;\s*$/, '') };
}

export function mergeDeferredAnnIndexes(a: DeferredAnnIndex[], b: DeferredAnnIndex[]): DeferredAnnIndex[] {
  const byName = new Map<string, DeferredAnnIndex>();
  for (const entry of [...a, ...b]) byName.set(entry.name, entry);
  return [...byName.values()];
}

/** null = absent; otherwise whether the index is valid (an interrupted CONCURRENTLY build leaves it invalid). */
export async function annIndexValidity(engine: Pick<BrainEngine, 'executeRaw'>, name: string): Promise<boolean | null> {
  const rows = await engine.executeRaw<{ valid: boolean }>(
    `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relkind = 'i'`, [name]);
  return rows.length ? rows[0]!.valid === true : null;
}

export interface AnnBuildResult { built: string[]; already_valid: string[]; skipped_over_cap: string[] }

/**
 * Build every pending ANN index recorded in the marker. `readPending` and
 * `writePending` keep this module independent of the marker's full shape.
 */
export async function buildDeferredAnnIndexes(
  engine: BrainEngine,
  io: {
    targetDims: number;
    readPending: () => Promise<DeferredAnnIndex[]>;
    writePending: (pending: DeferredAnnIndex[]) => Promise<void>;
    assertOwned?: () => Promise<void>;
    log?: (line: string) => void;
    monitorIntervalMs?: number;
  },
): Promise<AnnBuildResult> {
  const log = io.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const result: AnnBuildResult = { built: [], already_valid: [], skipped_over_cap: [] };
  let pending = await io.readPending();
  const total = pending.length;
  let index = 0;
  while (pending.length > 0) {
    const next = pending[0]!;
    index++;
    await io.assertOwned?.();
    const validity = await annIndexValidity(engine, next.name);
    if (!hnswIndexExpected(/halfvec_/.test(next.def) ? 'halfvec' : 'vector', io.targetDims)) {
      result.skipped_over_cap.push(next.name);
    } else if (validity === true) {
      result.already_valid.push(next.name);
    } else {
      log(`[migrate] ${ANN_BUILD_MESSAGE}: ${next.name} (${index}/${total})`);
      const started = Date.now();
      if (engine.kind === 'postgres') {
        await engine.withReservedConnection(async conn => {
          if (validity === false) await conn.executeRaw(`DROP INDEX CONCURRENTLY IF EXISTS ${next.name}`);
          // CONCURRENTLY cannot run in a transaction, so SET LOCAL is unavailable: lift the session timeout on this reserved backend and restore it below.
          await conn.executeRaw('SET statement_timeout = 0');
          const build = conn.executeRaw(next.def.replace(/^CREATE INDEX (?:IF NOT EXISTS )?/, 'CREATE INDEX CONCURRENTLY IF NOT EXISTS '));
          const timer = setInterval(() => {
            void engine.executeRaw<{ blocks_done: number; blocks_total: number; phase: string }>(
              `SELECT p.blocks_done, p.blocks_total, p.phase FROM pg_stat_progress_create_index p
                 JOIN pg_class c ON c.oid = p.relid WHERE c.relname = 'content_chunks' LIMIT 1`)
              .then(rows => {
                const row = rows[0];
                const pct = row && Number(row.blocks_total) > 0 ? ` ${Math.round(100 * Number(row.blocks_done) / Number(row.blocks_total))}%` : '';
                log(`[migrate] building ${next.name}: ${Math.round((Date.now() - started) / 1000)}s${row ? ` (${row.phase}${pct})` : ''}`);
              })
              .catch(() => {});
          }, io.monitorIntervalMs ?? 30_000);
          try { await build; } finally { clearInterval(timer); await conn.executeRaw('RESET statement_timeout').catch(() => {}); }
        });
      } else {
        if (validity === false) await engine.executeRaw(`DROP INDEX IF EXISTS ${next.name}`);
        const create = () => engine.executeRaw(next.def.replace(/^CREATE INDEX (?:IF NOT EXISTS )?/, 'CREATE INDEX IF NOT EXISTS '));
        // Graduation also defers non-HNSW indexes through here; only an HNSW build is sized.
        const hnsw = HNSW_TARGET.exec(next.def);
        await (hnsw ? withHnswBuildMemory(engine, hnsw[1]!, hnsw[2]!, create) : create());
      }
      if (await annIndexValidity(engine, next.name) !== true) {
        throw new Error(`vector index ${next.name} is not valid after its build; rerun the migration to rebuild it`);
      }
      log(`[migrate] vector index ${next.name} ready (${Math.round((Date.now() - started) / 1000)}s)`);
      result.built.push(next.name);
    }
    pending = pending.slice(1);
    await io.writePending(pending);
  }
  return result;
}

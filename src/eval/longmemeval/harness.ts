/**
 * v0.28.1: LongMemEval benchmark harness — reset-in-place over one in-memory PGLite.
 *
 * The benchmark is sequential: 500 questions × independent haystacks. Instead
 * of building a fresh PGLite per question (snapshot fast-path complexity, env
 * mutation, unverified restore semantics), we connect ONE in-memory engine
 * for the whole run and TRUNCATE all public tables between questions.
 *
 * Tables are enumerated at runtime via pg_tables so a future schema migration
 * (a new takes/oauth/dream table) doesn't silently leak across questions.
 */

import { PGLiteEngine } from '../../core/pglite-engine.ts';

interface PgTablesRow {
  tablename: string;
}

/**
 * Tables that initSchema() seeds rows into and FK-depends on. TRUNCATEing
 * them between benchmark questions either nukes seeded rows (sources.'default'
 * which pages.source_id FK-points to) or coordination state that should
 * survive across the run. Everything else is content + can be cleared.
 */
const PRESERVE_TABLES: ReadonlySet<string> = new Set([
  // FK target for pages.source_id; seeded as 'default' by pglite-schema.ts.
  'sources',
  // Key-value config; empty in a benchmark run, but config is infrastructure.
  'config',
  // Coordination locks; not content.
  'gbrain_cycle_locks',
  'subagent_rate_leases',
]);

export async function createBenchmarkBrain(): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  await engine.connect({}); // in-memory; no database_path, no file lock acquired
  await engine.initSchema();
  return engine;
}

export async function resetTables(engine: PGLiteEngine): Promise<void> {
  const rows = await engine.executeRaw<PgTablesRow>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
  if (targets.length === 0) return;
  // Quote each tablename as an identifier so reserved words and mixed-case
  // names work. RESTART IDENTITY resets serial sequences; CASCADE handles
  // FK dependencies so we don't have to topologically sort.
  const list = targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ');
  await engine.executeRaw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function withBenchmarkBrain<T>(
  fn: (engine: PGLiteEngine) => Promise<T>,
): Promise<T> {
  const engine = await createBenchmarkBrain();
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

/** #5092: questions per harness-owned benchmark brain before it is replaced. */
export const LME_BRAIN_RECYCLE_EVERY = 40;

/**
 * #5092 — TRUNCATE between questions never returns PGLite's WASM memory,
 * which grows with every question's vectors (~30 MB per 500-chunk question)
 * until a long single-process run stalls at 100% CPU around question 90-120.
 * `next()` hands out the brain for the next question, replacing it with a
 * fresh, re-configured one every `every` questions (0 = never). `close()`
 * disconnects a replacement; the first brain stays its owner's to close.
 */
export function brainRecycler(
  first: PGLiteEngine,
  every: number,
  create: () => Promise<PGLiteEngine>,
  configure: (engine: PGLiteEngine) => Promise<void>,
): { next(): Promise<PGLiteEngine>; close(): Promise<void> } {
  let brain = first;
  let served = 0;
  return {
    async next() {
      if (every > 0 && served === every) {
        await brain.disconnect();
        brain = await create();
        await configure(brain);
        served = 0;
      }
      served++;
      return brain;
    },
    async close() {
      if (brain !== first) await brain.disconnect();
    },
  };
}

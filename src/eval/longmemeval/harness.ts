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
import type { AIGatewayConfig } from '../../core/ai/types.ts';

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

export async function createBenchmarkBrain(gatewayConfig?: AIGatewayConfig): Promise<PGLiteEngine> {
  const engine = new PGLiteEngine();
  // Configure gateway BEFORE connect+initSchema — initSchema reads embedding dims
  // from the gateway to size the pgvector column. If we initSchema first with
  // the default 1536d and then switch to a 1024d provider, every embed call fails.
  if (gatewayConfig) {
    const { configureGateway } = await import('../../core/ai/gateway.ts');
    configureGateway(gatewayConfig);
  }
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
  gatewayConfig?: AIGatewayConfig,
): Promise<T> {
  const engine = await createBenchmarkBrain(gatewayConfig);
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

/**
 * Child for test/pglite-checkpoint-guard.test.ts: stamps extraction watermarks
 * through `markPagesExtractedBatch` (an engine-sql autocommit UPDATE, never
 * engine.transaction() or executeRaw) in 100-page batches until about 150 MB
 * of WAL has been written into a file-backed PGLite whose max_wal_size is
 * 64 MB. Before engine-sql writes took the checkpoint guard, the crossing
 * UPDATE ran Postgres's automatic checkpoint inline and spun forever (#5449,
 * the GBRA-69 stamp wedge), so the parent kills this child on a timeout.
 * argv[2]: an empty directory for the brain. Prints `done <batches>`.
 */
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';

configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const path = join(process.argv[2]!, 'brain.pglite');
let engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: path } as never);
await engine.initSchema();
await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth)
  SELECT 'notes/page-' || g, 'note', 'Page ' || g, repeat('body ', 200) FROM generate_series(1, 1000) g`);
await engine.executeRaw("ALTER SYSTEM SET max_wal_size = '64MB'");
await engine.disconnect();
engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: path } as never);
const refs = await engine.listAllPageRefs();
const [start] = await engine.executeRaw<{ lsn: string }>('SELECT pg_current_wal_lsn()::text AS lsn');
let batches = 0;
for (;;) {
  const [w] = await engine.executeRaw<{ wal: number }>('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::float8 AS wal', [start!.lsn]);
  if (w!.wal > 150 * 1024 * 1024) break;
  const at = (batches * 100) % refs.length;
  await engine.markPagesExtractedBatch(refs.slice(at, at + 100), new Date(Date.UTC(2026, 0, 1, 0, 0, batches)).toISOString());
  batches++;
}
await engine.disconnect();
console.log(`done ${batches}`);
process.exit(0);

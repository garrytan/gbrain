/** Existing heavy query corpus; public mutation implementation and metrics live in the shared harness. */
import { runReadLatencyWorkload } from '../../scripts/persistence/read-workload.ts';

const engine = process.env.GBRAIN_TEST_PERF_ENGINE ?? 'pglite';
if (engine !== 'pglite' && engine !== 'postgres') throw new Error('Invalid performance engine');
const result = await runReadLatencyWorkload({ engine, databaseUrl: process.env.DATABASE_URL,
  pages: Number(process.env.BRAIN_PAGES ?? 500), queries: Number(process.env.NUM_QUERIES ?? 200),
  writers: Number(process.env.NUM_WRITERS ?? 4), writesPerWriter: Number(process.env.WRITES_PER_WRITER ?? 25) });
const threshold = Number(process.env.THRESHOLD_PCT ?? 50);
result.threshold_pct = threshold;
result.verdict = result.ok && result.delta_p99_pct <= threshold ? 'pass' : 'fail';
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = !result.ok || process.env.STRICT === '1' && result.verdict !== 'pass' ? 1 : 0;

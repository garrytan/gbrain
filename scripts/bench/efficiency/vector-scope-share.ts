#!/usr/bin/env bun
/**
 * Vector search latency and recall per source scope, against an existing
 * brain. Opt-in, never run in CI, not shipped in the CLI; reads only.
 *
 *   bun scripts/bench/efficiency/vector-scope-share.ts <postgres-url | pglite-dir> <scope>... \
 *     [--queries 25] [--limit 20] [--remote] [--window] [--json]
 *
 * A scope is a source id, several joined with `+`, or `all` (unscoped). Query
 * vectors are stored chunk embeddings plus fixed noise (the same chunks every
 * run, by md5 of the chunk id), so two builds compare on identical queries.
 * Each scope runs one warm-up search, then every query through the engine's
 * `searchVector`, and reports p50/p95 latency (nearest rank), the mean result
 * count, recall of result pages against the exact statement (`exactSql`, no
 * index; `--window` bounds it to the candidate window instead of every
 * candidate), the share of pages the scope holds per planner statistics, and
 * underfilled exits. `--remote` adds the private-page rule (`excludePrivate`).
 */
import { PostgresEngine } from '../../../src/core/postgres-engine.ts';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { buildVectorSearchStatement, PAGE_SOURCE_STATS_SQL, sourceScope, type PageSourceStats } from '../../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../../src/core/types.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const positional = args.filter((arg, i) => !arg.startsWith('--') && !['--queries', '--limit'].includes(args[i - 1] ?? ''));
const [target, ...scopes] = positional;
if (!target || scopes.length === 0) {
  console.error('usage: bun scripts/bench/efficiency/vector-scope-share.ts <postgres-url | pglite-dir> <scope>... [--queries N] [--limit N] [--remote] [--window] [--json]');
  process.exit(2);
}
const queries = option('queries', 25);
const limit = option('limit', 20);
const pglite = !/^postgres(ql)?:\/\//.test(target);
const engine = pglite ? new PGLiteEngine() : new PostgresEngine();
await engine.connect(pglite ? { engine: 'pglite', database_path: target } : { engine: 'postgres', database_url: target });

const vectors: Float32Array[] = [];
let seed = 1;
const noise = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
for (const { v } of await engine.executeRaw<{ v: string }>(`SELECT embedding::text AS v FROM content_chunks WHERE embedding IS NOT NULL ORDER BY md5(id::text) LIMIT ${queries}`)) {
  vectors.push(Float32Array.from(JSON.parse(v) as number[], x => x + noise() * 0.8));
}
const [stats] = await engine.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!.toFixed(1);
};

const rows = [];
for (const scope of scopes) {
  const opts: SearchOpts = { limit, ...(flag('remote') ? { excludePrivate: true } : {}), ...(scope === 'all' ? {} : { sourceIds: scope.split('+') }) };
  let underfilled = 0;
  await engine.searchVector(vectors[0]!, opts);
  const ms: number[] = [];
  const results: number[][] = [];
  for (const vector of vectors) {
    const start = performance.now();
    const hits = await engine.searchVector(vector, { ...opts, onVectorPoolMeta: () => { underfilled++; } });
    ms.push(performance.now() - start);
    results.push(hits.map(hit => hit.page_id));
  }
  let hit = 0, total = 0;
  for (const [k, vector] of vectors.entries()) {
    const stmt = buildVectorSearchStatement({ dialect: pglite ? 'pglite' : 'postgres', embedding: vector, limit, offset: 0, opts });
    const bound = [...stmt.params];
    bound[stmt.innerLimitIdx] = flag('window') ? stmt.innerLimit : null;
    const truth = new Set((await engine.executeRaw<{ page_id: number | null }>(stmt.exactSql, bound)).filter(row => row.page_id != null).map(row => Number(row.page_id)));
    total += truth.size;
    hit += results[k]!.filter(id => truth.has(id)).length;
  }
  const routed = await (engine as unknown as { vectorScope: (o: SearchOpts) => Promise<{ chunks?: number } | undefined> }).vectorScope(opts);
  rows.push({
    scope, share: scope === 'all' ? 1 : +(sourceScope(stats, opts)?.share ?? NaN).toFixed(4), chunks: routed?.chunks === undefined ? null : Math.round(routed.chunks), n: ms.length,
    p50_ms: percentile(ms, 0.5), p95_ms: percentile(ms, 0.95),
    results: +(results.reduce((sum, r) => sum + r.length, 0) / results.length).toFixed(1),
    recall: +(hit / Math.max(1, total)).toFixed(3), underfilled,
  });
}
await engine.disconnect();
if (flag('json')) console.log(JSON.stringify(rows));
else console.table(rows);

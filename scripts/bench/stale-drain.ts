#!/usr/bin/env bun
/**
 * Stale link-extraction drain bench. Opt-in, never run in CI, not shipped in the CLI.
 *
 *   bun scripts/bench/stale-drain.ts [--pages 3000] [--managed] [--analyze-seed] [--json]
 *   DATABASE_URL=postgresql://... bun scripts/bench/stale-drain.ts --postgres [--pages 3000]
 *
 * Seeds `--pages` pages through engine.putPage (each links to three other
 * pages and carries two dated timeline bullets) without running any planner
 * upkeep, so the brain looks like one that grew by single writes since its
 * last ANALYZE. Every page is link-stale (never extracted). Then it drains
 * them with `extractStaleFromDB` (catch-up, no time budget) and reports
 * ms/page, plus the readPageSnapshot plan before and after the drain.
 * `--managed` flips persistence_brain.enabled so the drain takes the managed
 * `extractManagedStaleLinks` path; `--analyze-seed` runs a full ANALYZE after
 * seeding (the shape a fresh `gbrain import` leaves). PGLite runs in a
 * file-backed temp directory; `--postgres` creates and drops
 * `gbrain_bench_stale_drain_<hex>` on the DATABASE_URL server.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

function flag(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}
const PAGES = flag('pages', 3000);
const MANAGED = process.argv.includes('--managed');
const ANALYZE_SEED = process.argv.includes('--analyze-seed');
const POSTGRES = process.argv.includes('--postgres');
const JSON_OUT = process.argv.includes('--json');
const log = (message: string) => console.error(`[stale-drain ${new Date().toISOString().slice(11, 19)}] ${message}`);

configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });

let engine: BrainEngine;
let cleanup: () => Promise<void>;
if (POSTGRES) {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('Set DATABASE_URL to a Postgres server where this role may CREATE DATABASE.');
  const dbName = `gbrain_bench_stale_drain_${randomBytes(6).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const pg = new PostgresEngine();
  await pg.connect({ database_url: url.toString(), poolSize: 2 });
  engine = pg;
  cleanup = async () => { await pg.disconnect(); await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await admin.end(); };
} else {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-stale-drain-'));
  const pglite = new PGLiteEngine();
  await pglite.connect({ database_path: dir });
  engine = pglite;
  cleanup = async () => { await pglite.disconnect(); rmSync(dir, { recursive: true, force: true }); };
}

const SNAPSHOT_EXPLAIN = `EXPLAIN SELECT p.* FROM pages p WHERE p.slug=$1 AND p.source_id=$2 AND p.deleted_at IS NULL
  ORDER BY (p.slug=$1) DESC, (p.source_id=$3) DESC, p.source_id ASC LIMIT 1`;
async function snapshotPlan(): Promise<string> {
  const rows = await engine.executeRaw<{ 'QUERY PLAN': string }>(SNAPSHOT_EXPLAIN, ['notes/page-1', 'default', 'default']);
  const plan = rows.map(r => r['QUERY PLAN']).join('\n');
  return /pages_source_slug_key/.test(plan) ? 'pages_source_slug_key' : (plan.match(/(?:Index|Bitmap Index) Scan(?: Backward)? using (\w+)/)?.[1] ?? 'seq scan');
}

try {
  await engine.initSchema();
  const seedStart = performance.now();
  const words = ['ledger', 'harbor', 'quartz', 'meadow', 'signal', 'lantern', 'orbit', 'canvas'];
  for (let i = 0; i < PAGES; i++) {
    const links = [1, 7, 31].map(k => `[[notes/page-${(i + k) % PAGES}]]`).join(', ');
    await engine.putPage(`notes/page-${i}`, {
      type: 'note', title: `Page ${i}`, frontmatter: {},
      compiled_truth: `Page ${i} is about ${words[i % words.length]} and ${words[(i * 3) % words.length]}. Related: ${links}.`,
      timeline: `- **2026-0${1 + (i % 9)}-1${i % 10}** | Met about ${words[i % words.length]}\n- **2026-0${1 + ((i + 4) % 9)}-2${i % 8}** | Follow-up on page ${i}`,
    });
    if ((i + 1) % 1000 === 0) log(`seeded ${i + 1}/${PAGES}`);
  }
  const seedMs = performance.now() - seedStart;
  if (ANALYZE_SEED) await engine.executeRaw('ANALYZE');
  if (MANAGED) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const planBefore = await snapshotPlan();
  log(`seeded ${PAGES} pages in ${(seedMs / 1000).toFixed(1)} s; snapshot plan before drain: ${planBefore}`);

  const start = performance.now();
  const r = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
  const drainMs = performance.now() - start;
  const planAfter = await snapshotPlan();
  const [links] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links');
  const result = {
    engine: engine.kind, pages: PAGES, managed: MANAGED, analyze_seed: ANALYZE_SEED,
    processed: r.pagesProcessed, links: links!.n, stale_remaining: r.staleRemaining,
    drain_s: +(drainMs / 1000).toFixed(2), ms_per_page: +(drainMs / Math.max(1, r.pagesProcessed)).toFixed(2),
    plan_before: planBefore, plan_after: planAfter,
  };
  log(`drained ${r.pagesProcessed} pages in ${result.drain_s} s = ${result.ms_per_page} ms/page; links ${links!.n}; plan after: ${planAfter}`);
  console.log(JSON_OUT ? JSON.stringify(result) : result);
} finally {
  await disposePersistenceConsumer(engine).catch(() => undefined);
  await cleanup();
}

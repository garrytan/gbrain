#!/usr/bin/env bun
/**
 * #6803: the projection drain at production scale, with a pass criterion. A bench, not a test (not in CI).
 *
 *   bun scripts/bench/projection-drain.ts --engine pglite [--images 93000] [--text 0] [--reimport 0] [--protected 0] [--out receipt.json]
 *   bun scripts/bench/projection-drain.ts --url <postgres-url> [--admin-url <url>] [same counts]
 *
 * Postgres: --admin-url (default --url) creates a scratch database `gbrain_bench_drain_<n>` on --url's host with
 * the same credentials and drops it afterwards. PGLite: a scratch data dir, removed afterwards.
 *
 * Fixture (initSchema, one source): --images image pages exactly as the importer leaves them (chunker_version at
 * the safe-chunk fence, one `image_asset` chunk at index 0 holding the file name, a 1024-dim visual vector), so
 * every one is `sealable`; --text Markdown notes of about 3 KB (`pending`); --reimport pre-fence images; --protected
 * images whose text holds a protected fence. The visual HNSW index is dropped before seeding: the drain neither
 * reads nor writes it, and inserting 93K identical bench vectors into it is superlinear (40K took 280 s to seed).
 * The per-row generation trigger (bump_page_generation_trg) is off while the bulk INSERTs run and each row takes a
 * distinct generation from the INSERT itself: inside one multi-row statement its MAX(generation) index scan walks
 * every row that statement already inserted, so a 10K-row batch costs O(batch^2) (12 s, 21 s, 26 s per batch at
 * 30K). The importer writes one page per statement and never hits this.
 * Then migration v153's activation (PAGE_PROJECTION_ACTIVATION_SQL)
 * unseals every page and queues it, with no planner statistics refreshed first (a PGLite brain has none).
 *
 * Measured, in order, each on a freshly activated queue:
 *   1. the doctor fix's run: drainProjections({ media: true, limit: projectionDrainLimit(pending) }), wall time
 *      and pages taken (it runs first, before any statistics refresh, the worst case);
 *   2. a full drainProjections({ media: true }) after re-running the activation (the planner statistics run 1
 *      refreshed stay): wall time, pages sealed and rebuilt, pages/s over both, and seal pages/s (sealed / wall)
 *      when --text is 0.
 *
 * Pass: run 1 finishes within AGENT_TOOL_LIMIT_MS / 2 (the half the limit is sized to). Exit 0 on pass, 1 on
 * fail. Prints the receipt and one Markdown row.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { AGENT_TOOL_LIMIT_MS } from '../../src/core/agent-output.ts';
import { PAGE_PROJECTION_ACTIVATION_SQL } from '../../src/core/page-state/projection-schema.ts';
import { drainProjections, projectionBacklog } from '../../src/core/page-state/projections.ts';
import { IMAGE_SEAL_PAGES_PER_SECOND, TEXT_REBUILD_PAGES_PER_SECOND, projectionDrainLimit } from '../../src/core/page-state/image-seal.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../../src/core/search/safe-chunks.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const url = flag('--url');
const engineKind = (flag('--engine', url ? 'postgres' : 'pglite')) as 'postgres' | 'pglite';
const adminUrl = flag('--admin-url', url);
const images = Number(flag('--images', '93000'));
const text = Number(flag('--text', '0'));
const reimport = Number(flag('--reimport', '0'));
const guarded = Number(flag('--protected', '0'));
const out = flag('--out');
if (engineKind === 'postgres' && !url) { console.error('--url <postgres-url> is required with --engine postgres'); process.exit(2); }

const cleanups: Array<() => Promise<void>> = [];
const benchStart = performance.now();
const phases: Record<string, number> = {};
/** Run one phase, record its wall time and print a timestamped stderr line, so a slow phase is visible while it runs. */
async function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  console.error(`[bench +${((started - benchStart) / 1000).toFixed(1)}s] ${name} ...`);
  const result = await run();
  phases[name] = Math.round(performance.now() - started);
  console.error(`[bench +${((performance.now() - benchStart) / 1000).toFixed(1)}s] ${name} ${phases[name]} ms`);
  return result;
}
const BATCH = 10_000;
const PROTECTED = '<!--- gbrain:takes:begin -->\nbench protected text\n<!--- gbrain:takes:end -->';
const NOTE = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} of an example note about acme-example and alice-example with enough words to chunk.`).join('\n\n');
const VECTOR = '[' + Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)).join(',') + ']';

async function openEngine(): Promise<BrainEngine> {
  const { createEngine } = await import('../../src/core/engine-factory.ts');
  if (engineKind === 'pglite') {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-drain-'));
    cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
    const engine = await createEngine({ engine: 'pglite' });
    await engine.connect({ database_path: join(dir, 'brain.pglite') });
    return engine;
  }
  const name = `gbrain_bench_drain_${Date.now()}`;
  const admin = postgres(adminUrl!, { max: 1, prepare: false });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  cleanups.push(async () => { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); });
  const target = new URL(url!);
  target.pathname = `/${name}`;
  const engine = await createEngine({ engine: 'postgres' });
  await engine.connect({ database_url: target.toString() });
  return engine;
}

let generation = 0;
/** Insert `count` image pages (`prefix` slugs) with their importer chunk, in batches. */
async function seedImages(engine: BrainEngine, prefix: string, count: number, chunkerVersion: number, body: string): Promise<void> {
  for (let from = 1; from <= count; from += BATCH) {
    const to = Math.min(count, from + BATCH - 1);
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth,timeline,chunker_version,generation)
      SELECT 'default',$1||lpad(g::text,6,'0')||'.png','image','image',$1||lpad(g::text,6,'0')||'.png',$4,'',$5,$6::bigint+g
      FROM generate_series($2::int,$3::int) g`, [prefix, from, to, body, chunkerVersion, generation]);
    await engine.executeRaw(`INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source,modality,embedding_image)
      SELECT p.id,0,COALESCE(NULLIF(p.compiled_truth,''),p.title),'image_asset','image',$4::vector FROM pages p
      WHERE p.slug BETWEEN $1||lpad($2::text,6,'0')||'.png' AND $1||lpad($3::text,6,'0')||'.png'`, [prefix, from, to, VECTOR]);
  }
  generation += count;
}

async function seed(engine: BrainEngine): Promise<void> {
  await phase('schema', async () => {
    await engine.initSchema();
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding_image');
    await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER bump_page_generation_trg');
  });
  await phase('seed_images', async () => {
    await seedImages(engine, 'images/sealable-', images, SAFE_FENCE_CHUNKER_VERSION, '');
    await seedImages(engine, 'images/reimport-', reimport, 0, '');
    await seedImages(engine, 'images/protected-', guarded, SAFE_FENCE_CHUNKER_VERSION, PROTECTED);
  });
  await phase('seed_text', async () => { for (let from = 1; from <= text; from += BATCH) {
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,page_kind,title,compiled_truth,timeline,chunker_version,generation)
      SELECT 'default','notes/note-'||lpad(g::text,6,'0'),'note','markdown','Note '||g,$3,'',$4,$5::bigint+g FROM generate_series($1::int,$2::int) g`,
      [from, Math.min(text, from + BATCH - 1), NOTE, SAFE_FENCE_CHUNKER_VERSION, generation]);
  } });
  await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER bump_page_generation_trg');
}

async function activate(engine: BrainEngine): Promise<void> {
  for (const statement of PAGE_PROJECTION_ACTIVATION_SQL.split(';').map(part => part.trim()).filter(Boolean)) await engine.executeRaw(statement);
}

async function main(): Promise<number> {
  const engine = await openEngine();
  cleanups.unshift(async () => { await engine.disconnect(); });
  await seed(engine);
  await phase('activate', () => activate(engine));
  const before = await phase('backlog', () => projectionBacklog(engine));
  const limit = projectionDrainLimit(before.pending);
  const limited = await phase('limit_drain', () => drainProjections(engine, { media: true, limit }));
  const limitMs = phases.limit_drain!;

  await phase('reactivate', () => activate(engine));
  const full = await phase('full_drain', () => drainProjections(engine, { media: true }));
  const fullMs = phases.full_drain!;
  const after = await projectionBacklog(engine);

  const pass = limitMs <= AGENT_TOOL_LIMIT_MS / 2;
  const sealRate = Math.round((full.sealed ?? 0) / (fullMs / 1000));
  const receipt = {
    engine: engineKind, images, text, reimport, protected: guarded, phases_ms: phases,
    queued: before, constants: { IMAGE_SEAL_PAGES_PER_SECOND, TEXT_REBUILD_PAGES_PER_SECOND, AGENT_TOOL_LIMIT_MS },
    limit_run: { limit, wall_ms: limitMs, sealed: limited.sealed ?? 0, rebuilt: limited.rebuilt, failed: limited.failed.length, limited: limited.limited,
      pages_per_second: Math.round(((limited.sealed ?? 0) + limited.rebuilt) / (limitMs / 1000)) },
    full_run: { wall_ms: fullMs, sealed: full.sealed ?? 0, rebuilt: full.rebuilt, failed: full.failed.length, statistics_refreshed: full.statistics_refreshed ?? false,
      seal_pages_per_second: text ? null : sealRate, pages_per_second: Math.round(((full.sealed ?? 0) + full.rebuilt) / (fullMs / 1000)) },
    remaining: after,
    pass, budget_ms: AGENT_TOOL_LIMIT_MS / 2,
  };
  if (out) writeFileSync(out, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`| ${engineKind} | ${images} img + ${text} text | limit ${limit}: ${limitMs} ms (${receipt.limit_run.pages_per_second} p/s) | full: ${fullMs} ms (${receipt.full_run.pages_per_second} p/s) | ${pass ? 'pass' : 'FAIL'} |`);
  return pass ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} finally {
  for (const cleanup of cleanups) await cleanup().catch(error => console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
}
process.exit(code);

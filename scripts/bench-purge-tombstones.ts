/**
 * Purge tombstone write-path benchmark (GBRA-69 setup): a brain of 50,000
 * pages, then 1,000 page / 10,000 fact / 1,000 take purge tombstones, a third
 * of the fact and take ones subject '*'. Reports p50/p95 of a page snapshot
 * read, an import of one changed page (importFromContent) and a put_page
 * operation, with and without the tombstones, so a run shows how far the
 * tombstones move the write path off the no-tombstone line.
 *
 * Usage: bun scripts/bench-purge-tombstones.ts [--pages 50000] [--iterations 40] [--json]
 *        DATABASE_URL=postgres://... bun scripts/bench-purge-tombstones.ts --engine postgres
 * The Postgres run creates and drops its own schema-isolated database objects on the target: use a scratch database.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import type { WriteAttribution } from '../src/core/persistence/attribution.ts';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const PAGES = Number(arg('pages', '50000'));
const ITERATIONS = Number(arg('iterations', '40'));
const ENGINE = arg('engine', 'pglite');
const ATTRIBUTION: WriteAttribution = { requestId: null, principal: { kind: 'application', id: 'bench:purge-tombstones' } };

const fence = (n: number) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Bench claim ${n} for the measured page | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
| 2 | Bench preference ${n} | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const pageContent = (slug: string, n: number) => `---\ntitle: Bench ${slug}\ntype: person\n---\n# Bench\n\nEdit ${n}.\n\n## Facts\n\n${fence(n)}\n`;

async function connect(): Promise<BrainEngine> {
  if (ENGINE === 'postgres') {
    const { PostgresEngine } = await import('../src/core/postgres-engine.ts');
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL! } as never);
    await engine.initSchema();
    return engine;
  }
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  return engine;
}

async function seedPages(engine: BrainEngine): Promise<void> {
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
    SELECT 'default', 'bench/page-' || g, 'note', 'Bench page ' || g, 'Bench body ' || g || ' with some prose about example topics.', '', '{}'::jsonb
      FROM generate_series(1, $1::int) AS g ON CONFLICT DO NOTHING`, [PAGES]), ATTRIBUTION));
}

async function seedTombstones(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash)
    SELECT 'default', CASE WHEN g % 2 = 0 THEN 'world' ELSE 'private' END,
           CASE WHEN g % 3 = 0 THEN '*' ELSE 'bench/page-' || (1 + g % $1::int) END, encode(sha256(('fact-' || g)::bytea), 'hex')
      FROM generate_series(1, 10000) AS g ON CONFLICT DO NOTHING`, [PAGES]);
  await engine.executeRaw(`INSERT INTO take_purges (source_id, subject, claim_hash)
    SELECT 'default', CASE WHEN g % 3 = 0 THEN '*' ELSE 'bench/page-' || (1 + g % $1::int) END, encode(sha256(('take-' || g)::bytea), 'hex')
      FROM generate_series(1, 1000) AS g ON CONFLICT DO NOTHING`, [PAGES]);
  await engine.executeRaw(`INSERT INTO page_purges (source_id, content_hash, slug)
    SELECT 'default', encode(sha256(('page-' || g)::bytea), 'hex'), 'bench/purged-' || g FROM generate_series(1, 1000) AS g ON CONFLICT DO NOTHING`);
  await engine.executeRaw('ANALYZE fact_purges');
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };

async function measure(engine: BrainEngine, label: string) {
  const ctx = { engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as OperationContext;
  const put = operationsByName.put_page!;
  const slug = `people/bench-${label}`;
  await importFromContent(engine, slug, pageContent(slug, 0), { noEmbed: true, sourceId: 'default' });
  const snapshot: number[] = [], imported: number[] = [], putPage: number[] = [];
  for (let i = 0; i < 5; i++) await engine.readPageSnapshot(slug, { sourceId: 'default' });
  for (let i = 1; i <= ITERATIONS; i++) {
    let t = performance.now();
    await engine.readPageSnapshot(slug, { sourceId: 'default' });
    snapshot.push(performance.now() - t);
    t = performance.now();
    await importFromContent(engine, slug, pageContent(slug, i), { noEmbed: true, sourceId: 'default' });
    imported.push(performance.now() - t);
    t = performance.now();
    await put.handler(ctx, { slug: `${slug}-put`, content: pageContent(`${slug}-put`, i), request_id: randomUUID(), force: true });
    putPage.push(performance.now() - t);
  }
  const row = (xs: number[]) => ({ p50: Number(pct(xs, 0.5).toFixed(2)), p95: Number(pct(xs, 0.95).toFixed(2)) });
  return { label, snapshot_ms: row(snapshot), import_one_page_ms: row(imported), put_page_ms: row(putPage) };
}

async function main() {
  const engine = await connect();
  await seedPages(engine);
  const before = await measure(engine, 'no-tombstones');
  await seedTombstones(engine);
  const after = await measure(engine, 'tombstones');
  const [counts] = await engine.executeRaw<Record<string, number>>(`SELECT (SELECT count(*)::int FROM pages) AS pages,
    (SELECT count(*)::int FROM fact_purges) AS fact_purges, (SELECT count(*)::int FROM fact_purges WHERE subject='*') AS fact_purges_all_subjects,
    (SELECT count(*)::int FROM take_purges) AS take_purges, (SELECT count(*)::int FROM page_purges) AS page_purges`);
  const result = { engine: engine.kind, iterations: ITERATIONS, counts, runs: [before, after] };
  if (process.argv.includes('--json')) console.log(JSON.stringify(result));
  else {
    console.log(`${engine.kind}: ${JSON.stringify(counts)}`);
    for (const r of result.runs) console.log(`${r.label.padEnd(14)} snapshot p50 ${r.snapshot_ms.p50} ms (p95 ${r.snapshot_ms.p95}) | import one page p50 ${r.import_one_page_ms.p50} ms (p95 ${r.import_one_page_ms.p95}) | put_page p50 ${r.put_page_ms.p50} ms (p95 ${r.put_page_ms.p95})`);
  }
  await engine.disconnect();
}

await main();

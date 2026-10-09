#!/usr/bin/env bun
/**
 * Per-page cost of automatic link preparation (prepareAutomaticLinks), the
 * step every managed sync drain and put_page publication runs for each page.
 *
 *   bun scripts/bench/link-preparation.ts --engine pglite --pages 1000,3000,10000
 *   DATABASE_URL=postgresql://... bun scripts/bench/link-preparation.ts --engine postgres
 *
 * Seeds a synthetic source of N pages (dir-qualified and bare wikilinks,
 * markdown links, frontmatter refs, plus links to slugs that exist only in a
 * second source), then times prepareAutomaticLinks over a sample of pages in
 * two loops: `read_only` (nothing changes between pages, like a re-derive of
 * stale pages) and `with_writes` (a new page is inserted into the source
 * before every preparation, like a first-sync drain). Statements are counted
 * on the PGLite connection, or with pg_stat_statements on Postgres (the
 * server must preload it). Writes JSON to --out.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import postgres from '#postgres';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { prepareAutomaticLinks } from '../../src/core/persistence/links-preparation.ts';

const BENCH_SQL = '/* gbrain-bench */';
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const engineKind = (args.get('engine') ?? 'pglite') as 'pglite' | 'postgres';
const sizes = (args.get('pages') ?? '1000,3000,10000').split(',').map(Number);
const samples = Number(args.get('samples') ?? 200);
const label = args.get('label') ?? 'run';
const out = args.get('out') ?? `${process.env.HOME}/.capy/work/bench/link-preparation-${engineKind}-${label}.json`;
const pad = (i: number) => String(i).padStart(5, '0');

function body(i: number, n: number): { compiled_truth: string; frontmatter: Record<string, unknown> } {
  const a = (i * 7 + 3) % n, b = (i * 13 + 5) % n, c = (i * 31 + 11) % n;
  return {
    frontmatter: { title: `Note ${i}`, related: [`notes/n${pad(c)}`] },
    compiled_truth: `Observation ${i} about routine work. See [[notes/n${pad(a)}]] and [[Note ${b}]].\n`
      + `Background in [the earlier note](notes/n${pad(b)}) and [[shared/s${pad(i % 50)}]], which lives in another source.\n`
      + `An unwritten idea: [[ideas/i${pad(i)}]].\n`,
  };
}

async function seed(engine: BrainEngine, n: number) {
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES('other','other','{}') ON CONFLICT (id) DO NOTHING`);
  const rows = Array.from({ length: n }, (_, i) => ({ slug: `notes/n${pad(i)}`, title: `Note ${i}`, ...body(i, n) }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,frontmatter)
      SELECT 'default', r->>'slug', 'note', r->>'title', r->>'compiled_truth', r->'frontmatter' FROM jsonb_array_elements($1::text::jsonb) r`, [JSON.stringify(chunk)]);
  }
  await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth)
    SELECT 'other', 'shared/s' || lpad(g::text, 5, '0'), 'note', 'Shared ' || g, 'shared' FROM generate_series(0, 49) g`);
  await engine.executeRaw('ANALYZE pages');
}

interface Counter { reset: () => Promise<void>; read: () => Promise<number>; close: () => Promise<void> }

function pgliteCounter(engine: PGLiteEngine): Counter {
  const db = (engine as unknown as { _db: Record<'query' | 'exec', (...a: unknown[]) => Promise<unknown>> })._db;
  const original = { query: db.query, exec: db.exec };
  let n = 0;
  db.query = (...a) => { n++; return original.query.apply(db, a); };
  db.exec = (...a) => { n++; return original.exec.apply(db, a); };
  return { reset: async () => { n = 0; }, read: async () => n, close: async () => { db.query = original.query; db.exec = original.exec; } };
}

function postgresCounter(url: string): Counter {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = new URL(url).pathname.slice(1);
  return {
    reset: async () => { await sql.unsafe(`${BENCH_SQL} SELECT pg_stat_statements_reset(0, (SELECT oid FROM pg_database WHERE datname=$1), 0)`, [db]); },
    read: async () => {
      const [row] = await sql.unsafe(`${BENCH_SQL} SELECT coalesce(sum(calls),0)::int AS n FROM pg_stat_statements
        WHERE dbid=(SELECT oid FROM pg_database WHERE datname=$1) AND query NOT LIKE '%gbrain-bench%'`, [db]);
      return Number(row!.n);
    },
    close: async () => { await sql.end(); },
  };
}

async function measure(engine: BrainEngine, counter: Counter, n: number, writes: boolean) {
  const picks = Array.from({ length: samples }, (_, k) => Math.floor((k * n) / samples));
  const snapshots = [];
  for (const i of picks) snapshots.push((await engine.readPageSnapshot(`notes/n${pad(i)}`, { sourceId: 'default' }))!);
  let ms = 0, statements = 0, keys = 0, extra = 0;
  for (const snapshot of snapshots) {
    if (writes) await engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth) VALUES('default',$1,'note',$2,'new')`,
      [`notes/new-${label}-${n}-${extra}`, `New ${extra++}`]);
    await counter.reset();
    const started = performance.now();
    const prepared = await prepareAutomaticLinks(engine, snapshot.page.slug, { ...snapshot.page, frontmatter: snapshot.page.frontmatter ?? {} }, 'default');
    ms += performance.now() - started;
    statements += await counter.read();
    keys += prepared.pageKeys.length;
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { ms_per_page: r2(ms / samples), statements_per_page: r2(statements / samples), page_keys_total: keys };
}

const results: Record<string, unknown>[] = [];
for (const n of sizes) {
  let engine: BrainEngine, counter: Counter, close: () => Promise<void>;
  if (engineKind === 'pglite') {
    const e = new PGLiteEngine(); await e.connect({}); await e.initSchema();
    engine = e; counter = pgliteCounter(e); close = async () => { await counter.close(); await e.disconnect(); };
  } else {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL is required for --engine postgres');
    const db = `gbrain_bench_links_${n}_${Date.now()}`;
    const admin = postgres(base, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${db}`);
    const url = new URL(base); url.pathname = `/${db}`;
    const e = new PostgresEngine(); await e.connect({ database_url: url.toString(), poolSize: 4 }); await e.initSchema();
    await e.executeRaw('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    engine = e; counter = postgresCounter(url.toString());
    close = async () => { await counter.close(); await e.disconnect(); await admin.unsafe(`DROP DATABASE ${db} WITH (FORCE)`); await admin.end(); };
  }
  try {
    await seed(engine, n);
    await measure(engine, counter, n, false);
    const readOnly = await measure(engine, counter, n, false);
    const withWrites = await measure(engine, counter, n, true);
    const row = { engine: engineKind, label, pages: n, samples, read_only: readOnly, with_writes: withWrites };
    console.log(JSON.stringify(row));
    results.push(row);
  } finally { await close(); }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ engine: engineKind, label, bun: Bun.version, results }, null, 2) + '\n');
console.log(`wrote ${out}`);
